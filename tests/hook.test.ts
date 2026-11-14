import { describe, expect, it } from 'vitest';
import {
  account,
  anchorOf,
  compactSession,
  decisionLog,
  decisionLogLines,
  register,
  resolveHookConfig,
  summarize,
  receipt,
  toSessionMessages,
  withDeliveries,
  type Delivery,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest', dropCalls: false, receipt: true });
    expect(resolveHookConfig({ dropCalls: true }).dropCalls).toBe(true);
    expect(resolveHookConfig({ receipt: false }).receipt).toBe(false);
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      dropCalls: false,
      receipt: true,
    });
  });
});

describe('session message mapping', () => {
  it('keeps the engine object only for a plain user message; every other message is a handle-less copy', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    // Untouched, but not a plain user message: same content, no handle, so a
    // reopen cannot follow the handle back to the uncompacted transcript.
    expect(out[3]?.handle).toBeUndefined();
    expect(out[3]?.toolUses[0]).toBe(messages[3]!.toolUses[0]);
    expect(out[4]?.handle).toBeUndefined();
    expect(out[4]?.toolResults?.[0]).toBe(messages[4]!.toolResults![0]);
  });

  it('keeps short dropped-result content unchanged, without its handle', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]?.toolUses[0]).toBe(messages[1]!.toolUses[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]).toBe(messages[2]!.toolResults![0]);
    expect(out[2]?.handle).toBeUndefined();
  });
});

describe('deliveries placed back', () => {
  const delivery = (text: string, extra: Partial<Delivery> = {}): Delivery => ({
    text,
    origin: 'peer',
    midTurn: false,
    past: 0,
    ...extra,
  });

  it('anchors a prompt arriving now past the last tool result, or past the start', () => {
    expect(anchorOf(transcript())).toEqual({ after: 'tool-2', past: 2 });
    expect(anchorOf(transcript().slice(0, 1))).toEqual({ past: 1 });
  });

  it('holds back a mid-turn delivery no tool result has followed yet', () => {
    const messages = transcript();
    const out = withDeliveries(messages, [delivery('later', { midTurn: true, after: 'tool-2', past: 0 })]);
    expect(out.messages).toHaveLength(messages.length);
    expect(out.waiting.map((d) => d.text)).toEqual(['later']);
    expect(out.restored).toEqual([]);
  });

  it('keeps the words of a delivery whose anchor was compacted away, before the newest message', () => {
    const messages = transcript();
    const out = withDeliveries(messages, [delivery('orphan', { after: 'tool-0', past: 1 })]);
    expect(out.messages.map((m) => m.text).slice(-2)).toEqual([
      expect.stringContaining('\norphan'),
      'go ahead',
    ]);
  });

  it('does not take a short delivery for an earlier message that merely contains its words', () => {
    const messages = transcript();
    // 'go' is inside 'go ahead', a plain user message after the anchor, but
    // 'go ahead' is not 'go' and does not start with it as a line of its own.
    const out = withDeliveries(messages, [delivery('go', { midTurn: true, after: 'tool-1', past: 0 })]);
    expect(out.restored.map((d) => d.text)).toEqual(['go']);
  });

  it('lists each put-back delivery by sender and its own first words, capped', () => {
    const frame = 'Another Claude session sent a message:\n<agent-message from="a{n}">\n[Hand-back] The report follows:\n  Report {n} says ';
    const restored = Array.from({ length: 14 }, (_, n) =>
      delivery(`${frame.replaceAll('{n}', String(n))}${'ok '.repeat(n + 1)}\n</agent-message>`),
    );
    const messages = transcript();
    const text = receipt(
      { messages, decisions: [], stats: { messagesBefore: 7, messagesAfter: 7, charsBefore: 1, charsAfter: 1, calls: 0, kept: 0, resultsDropped: 0, callsDropped: 0, callsStubbed: 3, stubsDropped: 0, pinned: 0, stateTokens: 0, stateStage: '', requests: 0, ms: 0 } },
      account(messages, [...messages, ...restored.map((d) => ({ role: 'user' as const, text: d.text, toolUses: [] }))], restored),
    );
    const lines = text.split('\n');
    expect(lines[0]).toContain('3 tool call(s) cut to a stub');
    expect(lines).toContain('Put back as messages of their own (14), each where it arrived:');
    expect(lines).toContain('- peer a0: ...0 says ok');
    expect(lines).toContain('- peer a11: ...11 says ok ok ok ok ok ok ok ok ok ok ok ok');
    expect(lines).not.toContain('- peer a12: ...12 says ok ok ok ok ok ok ok ok ok ok ok ok ok');
    expect(lines).toContain('- and 2 more');
    expect(lines.at(-1)).toMatch(/^A figure you recall that is not in your visible text/);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['stub_call', 'keep']);
    // Only plain user messages keep their handle.
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, undefined, undefined, undefined, undefined, 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_stubbed; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:stub_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:stub_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:stub_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('auto-compact on turn.complete', () => {
  type Handler = (...args: any[]) => Promise<unknown>;
  const HEADLESS = '$.session.compact: not available in a headless (-p / SDK) session yet';

  function setup(compact: () => Promise<void>) {
    const handlers: Record<string, Handler> = {};
    const logs: string[] = [];
    const toasts: string[] = [];
    let percent = 0;
    let compactCalls = 0;
    const $ = {
      session: {
        usage: async () => ({ context: { percent } }),
        compact: () => {
          compactCalls += 1;
          return compact();
        },
      },
      ui: { log: (text: string) => logs.push(text), toast: (text: string) => toasts.push(text) },
      http: { fetch: async () => ({ status: 500, ok: false, text: 'x' }) },
    };
    (register as any)((name: string, handler: Handler) => (handlers[name] = handler), {});
    const next = async (event: unknown) => event;
    return {
      logs,
      toasts,
      compactCalls: () => compactCalls,
      turn: (at: number) => {
        percent = at;
        return handlers['turn.complete']!($, {}, next);
      },
      compactEvent: () => handlers['session.compact']!($, { messages: [] }, next),
    };
  }

  const headless = () => Promise.reject(new Error(HEADLESS));

  it('nudges once when a headless host refuses, and stops asking it to compact', async () => {
    const t = setup(headless);
    await t.turn(61);
    await t.turn(62);
    await t.turn(65);
    expect(t.toasts).toEqual([
      'context at 61%: type /compact at a natural stopping point (auto-compact cannot run in this host)',
    ]);
    expect(t.logs.some((line) => line.includes('auto-compact skipped'))).toBe(false);
    expect(t.compactCalls()).toBe(1);
  });

  it('nudges again after context grows another step', async () => {
    const t = setup(headless);
    await t.turn(61);
    await t.turn(70);
    await t.turn(71);
    await t.turn(82);
    expect(t.toasts.map((text) => text.slice(0, 14))).toEqual([
      'context at 61%',
      'context at 71%',
      'context at 82%',
    ]);
  });

  it('nudges afresh after a compaction or a drop below the threshold', async () => {
    const t = setup(headless);
    await t.turn(61);
    await t.compactEvent();
    await t.turn(62);
    await t.turn(40);
    await t.turn(63);
    // The compaction itself toasts its own outcome; only the nudges matter here.
    const nudges = t.toasts.filter((text) => text.startsWith('context at'));
    expect(nudges.map((text) => text.slice(0, 14))).toEqual([
      'context at 61%',
      'context at 62%',
      'context at 63%',
    ]);
  });

  it('stays quiet below the threshold', async () => {
    const t = setup(headless);
    await t.turn(59);
    expect(t.toasts).toEqual([]);
    expect(t.compactCalls()).toBe(0);
  });

  it('compacts without a nudge where the host allows it', async () => {
    const t = setup(async () => undefined);
    await t.turn(61);
    await t.turn(62);
    expect(t.compactCalls()).toBe(2);
    expect(t.toasts).toEqual([]);
  });

  it('logs any other refusal as before', async () => {
    const t = setup(() => Promise.reject(new Error('boom')));
    await t.turn(61);
    expect(t.logs).toEqual(['auto-compact skipped (boom)']);
    expect(t.toasts).toEqual([]);
  });
});
