import { describe, expect, it } from 'vitest';
import {
  anchorOf,
  compactSession,
  decisionLog,
  decisionLogLines,
  register,
  resolveHookConfig,
  summarize,
  receipt,
  toSessionMessages,
  type Delivery,
  type Anchor,
  type Outcome,
} from '../hooks/fast-jev.ts';
import { legalAfter, locate, plan } from '../hooks/deliveries.ts';
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
  const at = (i: number, text: string, extra: Partial<SessionMessage> = {}) => message(i % 2 ? 'assistant' : 'user', text, extra);
  const delivery = (body: string, anchor: Anchor | undefined, extra: Partial<Delivery> = {}): Delivery => ({
    seq: 1,
    body,
    midTurn: false,
    attachments: 0,
    placedAs: [],
    ...(anchor ? { anchor } : {}),
    ...extra,
  });
  const where = (outcome: Outcome | undefined) => (outcome?.kind === 'placed' ? outcome.after : outcome?.kind);

  it('anchors a prompt arriving now past the last tool result, and finds that point again', () => {
    const messages = transcript();
    const anchor = anchorOf(messages.slice(0, 6));
    expect(anchor).toMatchObject({ after: 'tool-2', past: 1 });
    expect(locate(messages, anchor)).toBe(5);
    expect(locate([message('user', 'other')], anchor)).toBeUndefined();
    expect(locate(messages, anchorOf([]))).toBe(-1);
  });

  it('holds back a mid-turn delivery no tool result has followed yet', () => {
    const messages = transcript();
    const [o] = plan(messages, [delivery('later', anchorOf(messages), { midTurn: true })], 'm');
    expect(o?.kind).toBe('waiting');
  });

  it('puts a mid-turn delivery after the first tool round past its point, not the last', () => {
    const messages = transcript();
    const [o] = plan(messages, [delivery('queued', anchorOf(messages.slice(0, 2)), { midTurn: true })], 'm');
    expect(where(o)).toBe(2);
  });

  it('never puts a delivery between a parallel batch of calls and their results', () => {
    const batch = [
      message('user', 'go'),
      message('assistant', '', {
        toolUses: ['p1', 'p2', 'p3'].map((id) => ({ tool_use_id: id, tool: 'Agent', input: {} })),
      }),
      ...['p1', 'p2', 'p3'].map((id) => message('user', '', { toolResults: [{ tool_use_id: id, text: 'done', isError: false }] })),
      message('assistant', 'All three are back.'),
    ];
    const [o] = plan(batch, [delivery('typed during the batch', anchorOf(batch.slice(0, 2)), { midTurn: true })], 'm');
    expect(where(o)).toBe(4);
    expect(legalAfter(batch, 2)).toBe(4);
    expect(legalAfter(batch, 1)).toBe(4);
    expect(legalAfter(batch, 5)).toBe(5);
  });

  it('keeps an unanchored delivery out of a tool pair at the end of the history', () => {
    const messages = transcript().slice(0, 4); // ends in call tool-2 and its result
    const [o] = plan(messages, [delivery('orphan', { after: 'tool-0', past: 0, window: ['nowhere'] })], 'm');
    expect(where(o)).toBe(3);
    expect(o).toMatchObject({ estimate: 'orphan' });
  });

  it('does not take a later message with the same words for a mid-turn delivery', () => {
    const messages = [...transcript(), message('assistant', 'ok'), message('user', 'yes')];
    const [o] = plan(messages, [delivery('yes', anchorOf(messages.slice(0, 2)), { midTurn: true })], 'm');
    expect(where(o)).toBe(2);
  });

  it('marks a delivery beside a plain user message as placed by estimate, rather than drop it', () => {
    const messages = transcript();
    const [o] = plan(messages, [delivery('report', anchorOf(messages))], 'm');
    expect(o).toMatchObject({ kind: 'placed', after: 6, estimate: 'beside-kept' });
  });

  it('lists each put-back by its sender and its own words, one quoted line each, capped', () => {
    const frame = (n: number) =>
      `Another Claude session sent a message:\n<agent-message from="a${n}">\n[Hand-back] The report follows:\n  Report ${n} says ${'ok '.repeat(n + 1)}\n</agent-message>`;
    const restored = Array.from({ length: 30 }, (_, n) => ({ delivery: delivery(frame(n), undefined, { origin: { kind: 'peer' } }) }));
    const text = receipt({
      mark: 'abcdef12',
      listed: 7,
      kept: 7,
      rebuilt: 4,
      deleted: 0,
      stubbed: 3,
      resultsCut: 0,
      callsDeleted: 0,
      restored,
      droppedAtBound: 0,
      durable: true,
    });
    const lines = text.split('\n');
    expect(lines[0]).toContain('3 tool call(s) cut to a stub');
    expect(lines).toContain('- from another Claude session: "Report 0 says ok"');
    expect(lines.filter((l) => l.startsWith('- ')).every((l) => /^- (from [^"]+: ".*"|and \d+ more)$/.test(l))).toBe(true);
    expect(lines.some((l) => /^- and \d+ more$/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^A figure you recall that is not in your visible text/);
    expect(lines.length).toBeLessThanOrEqual(20);
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
