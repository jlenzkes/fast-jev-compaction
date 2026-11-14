import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';

// Drives the plugin only through the hooks Claude Code calls, so these cases
// read the same against any version of hooks/fast-jev.ts.
//
// The engine stores a subagent's report, a prompt typed while a turn ran and
// a hook's feedback BESIDE a message, not as one: `session.compact` never
// lists them, and they survive only when the message they sit beside goes
// back with its handle. Every message but a plain user message goes back
// without one, so on 14 Nov 2026 a compaction listing 778 messages dropped
// six subagent reports, fourteen prompts the user typed mid-turn and
// twenty-five other deliveries while its banner read "kept 778/778 messages".

type SessionMessage = Message & { handle?: string };
type Handler = ($: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

const REPORT = 'Another Claude session sent a message:\n<agent-message from="a1">REPORT-ALPHA: 41 of 41 rows pass</agent-message>';
const TYPED = 'Also check the ids, please';

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}
function call(id: string, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `run ${id}` }, text }],
    handle: `a-${id}`,
  });
}
function result(id: string, text: string): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }], handle: `r-${id}` });
}

const LONG = 'x'.repeat(3000);

/** The listed history at each moment: what `$.session.messages()` answers. */
function history(): SessionMessage[] {
  return [
    message('user', 'Start the two subagents and wait for their reports.', { handle: 'u-0' }),
    call('t1', LONG),
    result('t1', LONG),
    message('assistant', 'Both are running; I will wait.', { handle: 'a-3' }),
    // <- the subagent's report arrives here, idle, stored beside a-3
    message('assistant', 'The report says all 41 rows pass. Next, the ids.', { handle: 'a-4' }),
    call('t2', LONG),
    // <- the user types while t2 runs; stored beside the next tool result
    result('t2', LONG),
    message('assistant', 'Checked.', { handle: 'a-7' }),
    message('user', 'Thanks.', { handle: 'u-8' }),
  ];
}

function jevFetch(answer: number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

function setup(options: Record<string, unknown> = {}) {
  const handlers: Record<string, Handler> = {};
  (register as unknown as (on: unknown, options: unknown) => void)(
    (name: string, handler: Handler) => (handlers[name] = handler),
    { apiKey: 'k', preserveRecentMessages: 1, minReductionRatio: 0, ...options },
  );
  const toasts: string[] = [];
  let listed = history();
  const $ = {
    env: {
      get: async (name: string) => (name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined),
    },
    settings: { read: async () => ({}) },
    session: {
      messages: async () => listed,
      id: async () => 'sess-1',
      cwd: async () => 'c:\\dev\\proj',
    },
    fs: { exists: async (path: string) => path === 'C:/Users/me/.claude/projects/c--dev-proj/sess-1.jsonl' },
    http: { fetch: jevFetch(0.1) },
    ui: { log: () => {}, toast: (text: string) => toasts.push(text) },
  };
  const passThrough = async (e: unknown) => e;
  return {
    toasts,
    /** A prompt entering while the history is its first `upTo` messages. */
    async submit(upTo: number, text: string, origin: string, turnId?: string) {
      listed = history().slice(0, upTo);
      const event = { text, origin: { kind: origin }, wait: false, ...(turnId ? { turnId } : {}) };
      await (handlers['prompt.submit'] ?? (($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => next(e)))(
        $,
        event,
        passThrough,
      );
      listed = history();
    },
    async compact(messages: SessionMessage[] = history()) {
      const out = (await handlers['session.compact']!($, { trigger: 'manual', messages }, async () => {
        throw new Error('built-in summary');
      })) as { messages: SessionMessage[] };
      return out.messages;
    },
  };
}

describe('deliveries the engine stores beside a message', () => {
  it('puts a subagent report back where it arrived, though the engine never listed it', async () => {
    const t = setup();
    await t.submit(4, REPORT, 'peer');
    const out = await t.compact();
    const at = out.findIndex((m) => m.text.includes('REPORT-ALPHA'));
    expect(at).toBeGreaterThan(0);
    expect(out[at]!.role).toBe('user');
    expect(out[at]!.handle).toBeUndefined();
    expect(out[at]!.text).toContain(REPORT);
    expect(out[at]!.text).toContain('not typed by the user');
    expect(out[at - 1]!.text).toBe('Both are running; I will wait.');
    expect(out[at + 1]!.text).toBe('The report says all 41 rows pass. Next, the ids.');
  });

  it('puts a prompt typed mid-turn back after the tool result it arrived with', async () => {
    const t = setup();
    await t.submit(6, TYPED, 'composer', 'turn-2');
    const out = await t.compact();
    const at = out.findIndex((m) => m.text.includes(TYPED));
    expect(out[at]!.text).toBe(`The user sent a new message while you were working:\n${TYPED}`);
    expect(out[at - 1]!.toolResults?.[0]?.tool_use_id).toBe('t2');
  });

  it('leaves alone a delivery that sits beside a plain user message, which the engine keeps whole', async () => {
    const t = setup();
    await t.submit(9, REPORT, 'peer');
    const out = await t.compact();
    expect(out.filter((m) => m.text.includes('REPORT-ALPHA'))).toHaveLength(0);
  });

  it('leaves alone a delivery that became a message of its own', async () => {
    const t = setup();
    await t.submit(8, 'Thanks.', 'task-notification');
    const out = await t.compact();
    expect(out.filter((m) => m.text.includes('Thanks.'))).toHaveLength(1);
  });

  it('leaves alone a delivery that started a turn as a plain message in other words', async () => {
    const t = setup();
    // The engine may wrap a delivery when it makes it a message; position, not wording, decides.
    await t.submit(8, 'task 7 finished', 'task-notification');
    const out = await t.compact();
    expect(out.filter((m) => m.text.includes('task 7 finished'))).toHaveLength(0);
  });

  it('puts a report back once, not again at the next compaction', async () => {
    const t = setup();
    await t.submit(4, REPORT, 'peer');
    const first = await t.compact();
    const second = await t.compact(first.filter((m) => !m.text.startsWith('[fast-jev-compaction receipt]')));
    expect(second.filter((m) => m.text.includes('REPORT-ALPHA'))).toHaveLength(1);
  });

  it('says in the banner how many listed messages were rebuilt and how many deliveries were put back', async () => {
    const t = setup();
    await t.submit(4, REPORT, 'peer');
    await t.compact();
    expect(t.toasts.at(-1)).toMatch(
      /^kept 9\/9 listed messages \(7 rebuilt, without what the host stores beside them; 1 delivered prompt\(s\) put back\), no summary \(/,
    );
  });

  it('ends the history with a receipt of what was cut, what was put back and where the transcript is', async () => {
    const t = setup();
    await t.submit(4, REPORT, 'peer');
    const out = await t.compact();
    const last = out.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.handle).toBeUndefined();
    expect(last.text.split('\n')).toEqual([
      '[fast-jev-compaction receipt] This conversation was just compacted without a summary. Every text message was kept verbatim; 2 tool call(s) cut to a stub (tool name, head of input and result). Re-run a tool for anything cut.',
      'Not carried: 7 message(s) were rebuilt, and whatever the host had stored beside them and never shows a plugin (Stop hook feedback, goal check-ins, notices) did not survive, except the delivered prompts put back below.',
      'Put back as messages of their own (1), each where it arrived:',
      '- peer a1: REPORT-ALPHA: 41 of 41 rows pass',
      'Full transcript: C:/Users/me/.claude/projects/c--dev-proj/sess-1.jsonl',
      'A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the transcript before stating it.',
    ]);
  });

  it('writes no receipt when the receipt option is off', async () => {
    const t = setup({ receipt: false });
    const out = await t.compact();
    expect(out).toHaveLength(9);
    expect(out.some((m) => m.text.startsWith('[fast-jev-compaction receipt]'))).toBe(false);
  });
});
