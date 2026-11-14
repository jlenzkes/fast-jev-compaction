import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  batchCalls,
  buildJevRequest,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  estimateTokens,
  fitState,
  JevClient,
  parseJevResponse,
  reductionRatio,
  resolveOptions,
  type HistoryToolCall,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

type Seen = { state: unknown; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: 'fix the test',
};

describe('options', () => {
  it('fills in defaults and ignores non-finite values', () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 300,
    });
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
    })).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });
});

describe('token estimate', () => {
  it('charges words, digits and symbols separately and never undercounts JSON badly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('state fitting', () => {
  it('sends the whole history with tool results replaced by a note', () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit);
    expect(stage).toBe('full');
    const json = JSON.stringify(state);
    expect(json).not.toContain('export const a = 1;');
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
      id: 't1',
      tool: 'Read',
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect((state.history[4]?.tool_calls?.[0] as HistoryToolCall).result).toMatch(/^error, /);
  });

  it('defaults the goal to the latest user prompts', () => {
    const { state } = fitState(transcript(), [], { ...fit, goal: '' });
    expect(state.goal).toContain('Fix the failing test');
    expect(state.goal).toContain('go ahead');
  });

  it('truncates tool inputs before touching message text', () => {
    const messages = [
      message('user', 'start'),
      call('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) }, 'ok'),
      result('w', 'ok'),
      message('assistant', 'written'),
    ];
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 300,
    });
    expect(stage).toBe('inputs<=200');
    expect(tokens).toBeLessThanOrEqual(300);
    expect(state.history[0]?.text).toBe('start');
    expect((state.history[1]?.tool_calls?.[0] as HistoryToolCall).input.length).toBeLessThanOrEqual(200);
  });

  it('shrinks old tool calls to one line each when nothing else is left to cut', () => {
    const messages = [message('user', 'start')];
    for (let i = 0; i < 40; i += 1) {
      messages.push(call(`c${i}`, 'Read', { file_path: `/repo/src/module-${i}.ts` }, 'x'), result(`c${i}`, 'x'));
    }
    messages.push(message('assistant', 'done'));
    const calls = collectToolCalls(messages, 1);
    const full = fitState(messages, calls, { ...fit, preserveRecentMessages: 1 });
    const compacted = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.8),
    });
    expect(compacted.stage).toBe('old calls compacted');
    expect(compacted.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
    expect(compacted.tokens).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(compacted.state)));
    expect(compacted.state.history[1]?.tool_calls?.[0]).toBe(
      't1 Read file_path=/repo/src/module-0.ts → ok 1ch',
    );
    expect(compacted.state.history.at(-1)?.text).toBe('done');

    const merged = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.45),
    });
    expect(merged.stage).toBe('old calls merged');
    expect(merged.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.45));
    expect(merged.state.history).toHaveLength(3);
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
    expect(merged.state.history[1]?.tool_calls?.[39]).toMatch(/^t40 Read /);
    expect(merged.state.history[0]?.text).toBe('start');
    expect(merged.state.history[2]?.text).toBe('done');
  });

  it('abridges long texts oldest-first and collapses old messages last', () => {
    const long = (n: number) => `${n} ` + 'lorem ipsum '.repeat(300);
    const messages = [
      message('user', long(0)),
      message('assistant', long(1)),
      message('user', long(2)),
      message('assistant', long(3)),
      message('user', 'latest'),
    ];
    const abridged = fitState(messages, [], { ...fit, maxStateTokens: 1800, preserveRecentMessages: 1 });
    expect(abridged.stage).toBe('texts abridged');
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain('chars omitted');
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe('latest');

    const collapsed = fitState(messages, [], { ...fit, maxStateTokens: 420, preserveRecentMessages: 1 });
    expect(collapsed.stage).toBe('old messages collapsed');
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain('lorem');
    expect(collapsed.state.history[4]?.text).toBe('latest');
  });

  it('throws when the history cannot be fitted', () => {
    const messages = [message('user', 'a'.repeat(2000)), message('assistant', 'b')];
    expect(() => fitState(messages, [], { ...fit, maxStateTokens: 50 })).toThrow(/too large/);
  });
});

describe('question batching', () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));
  const options = { maxRequestTokens: 30_000 };

  it('puts everything in one request when it fits', () => {
    expect(batchCalls(calls, 1000, options)).toHaveLength(1);
  });

  it('splits questions across requests when the state leaves little room', () => {
    const batches = batchCalls(calls, 29_600, options);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it('throws when a single question does not fit', () => {
    expect(() => batchCalls(calls, 29_990, options)).toThrow(/no room/);
  });
});

describe('decisions', () => {
  const options = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('keeps, drops the result, or drops the call based on the keep probabilities', () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action).toBe('drop_call');
    expect(decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });

  it('stubs instead of dropping the call when dropCalls is false', () => {
    const noDrop = { keepThreshold: 0.5, dropCalls: false };
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, noDrop)).toMatchObject({
      action: 'stub_call',
      reason: 'call_stubbed',
    });
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, noDrop).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, { ...noDrop, dropCalls: true }).action).toBe('drop_call');
  });

  it('a stubbed call keeps its tool name and truncates input and result', () => {
    const long = 'x'.repeat(2000);
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: long }, text: long }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: long }] },
      { role: 'assistant', text: 'done', toolUses: [] },
    ];
    const calls = collectToolCalls(messages, 0);
    const decisions = calls.map((call) => decideCall(call, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5, dropCalls: false }));
    const out = applyDecisions(messages, decisions, calls, 100);
    expect(out).toHaveLength(4);
    const use = out[1]!.toolUses[0]!;
    expect(use.tool).toBe('Bash');
    expect(JSON.stringify(use.input).length).toBeLessThan(400);
    expect(String((use.input as { note?: string }).note)).toMatch(/truncated \d+ chars of this tool input/);
    expect(use.text).toMatch(/truncated \d+ chars of this tool result/);
    expect(out[2]!.toolResults![0]!.text).toMatch(/truncated \d+ chars of this tool result/);
  });

  it('deletes a call an earlier compaction already stubbed: a stub lasts one compaction', async () => {
    const long = 'x'.repeat(2000);
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: long } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: long }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u2', tool: 'Read', input: { file_path: 'a.ts' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u2', text: long }] },
      { role: 'assistant', text: 'done', toolUses: [] },
    ];
    const options = { preserveRecentMessages: 1, dropCalls: false };
    const first = await compact(messages, fakeJev(() => 0.1, []), options);
    expect(first.decisions.map((d) => d.reason)).toEqual(['call_stubbed', 'call_stubbed']);
    expect(first.messages).toHaveLength(messages.length);

    // The second pass sees the stubs: both were cut already (one input cut to
    // input_head, one short input left as it was), so neither can shrink again.
    const second = await compact(first.messages, fakeJev(() => 0.1, []), options);
    expect(second.decisions.map((d) => d.reason)).toEqual(['stub_dropped', 'stub_dropped']);
    expect(second.stats.stubsDropped).toBe(2);
    expect(second.messages.map((m) => m.text)).toEqual(['go', 'done']);
    expect(reductionRatio(second)).toBeGreaterThan(0.5);

    // A stub Jev still rates as needed stays.
    const kept = await compact(first.messages, fakeJev(() => 0.9, []), options);
    expect(kept.decisions.map((d) => d.action)).toEqual(['keep', 'keep']);

    // A short call whose result was never cut is not a stub, so it is stubbed, not deleted.
    const short: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u3', tool: 'Read', input: { file_path: 'b.ts' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u3', text: 'ok' }] },
      { role: 'assistant', text: 'done', toolUses: [] },
    ];
    const fresh = await compact(short, fakeJev(() => 0.1, []), options);
    expect(fresh.decisions.map((d) => d.reason)).toEqual(['call_stubbed']);
  });

  it('removes dropped calls and truncates dropped results', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      'a.ts looks fine; checking b.ts',
      'tool-2',
      'tool-2',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[2]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[3]).not.toBe(messages[5]);
    expect(kept[4]).toBe(messages[6]);
    expect(kept[5]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300);
    expect(shortKept[2]).toBe(shortMessages[4]);
    expect(shortKept[3]).toBe(shortMessages[5]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const kept = applyDecisions(messages, decisions, calls, 50);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[fast-jev-compaction truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[fast-jev-compaction truncated ${total} chars of this tool result; re-run the tool if needed]`,
    );
  });
});

describe('compact', () => {
  it('resends the full state with every batch and merges the answers', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: '',
      preserveRecentMessages: 1,
    }).tokens;
    const output = await compact(
      messages,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen),
      { preserveRecentMessages: 1, maxRequestTokens: stateTokens + 150 },
    );

    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.flatMap((r) => r.questions).sort()).toEqual([
      'call_t1',
      'call_t2',
      'call_t3',
      'result_t1',
      'result_t2',
      'result_t3',
    ]);
    expect(new Set(seen.map((r) => JSON.stringify(r.state))).size).toBe(1);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 3, kept: 0, callsDropped: 0, pinned: 0 });
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeJev(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: '', calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports a tiny reduction when Jev wants everything kept', async () => {
    const output = await compact(transcript(), fakeJev(() => 0.95), { preserveRecentMessages: 1 });
    expect(output.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  /** `count` Bash calls with 1000-character results, ids `u<from>` onward. */
  function bashCalls(count: number, from = 0): Message[] {
    const messages: Message[] = [];
    for (let i = from; i < from + count; i += 1) {
      const out = `line ${i} `.repeat(200).slice(0, 1000);
      messages.push(
        call(`u${i}`, 'Bash', { command: `cd /repo/packages/pkg-${i} && npm run check -- --verbose`, description: `Check package ${i}` }, out),
        result(`u${i}`, out),
      );
    }
    return messages;
  }

  it('compacts a history with more calls than the state can describe', async () => {
    const messages = [message('user', 'Run the build checks across every package.'), ...bashCalls(900), message('assistant', 'All checks ran.')];
    const output = await compact(messages, fakeJev(() => 0.1));
    expect(output.stats.stateTokens).toBeLessThanOrEqual(25_000);
    expect(output.stats.stateStage).toMatch(/^windows:\d+$/);
    expect(reductionRatio(output)).toBeGreaterThanOrEqual(0.25);
  });

  it('keeps compacting as stubs and new calls accumulate across passes', async () => {
    const options = { dropCalls: false };
    const start = [message('user', 'Run the build checks across every package.'), ...bashCalls(500)];
    const first = await compact([...start, message('assistant', 'Half done.')], fakeJev(() => 0.1), options);
    expect(first.stats.callsStubbed).toBeGreaterThan(400);
    const stubbedIds = new Set(
      first.messages.flatMap((m) => m.toolUses).filter((t) => /truncated \d+ chars of this tool result/.test(t.text ?? '')).map((t) => t.tool_use_id),
    );
    expect(stubbedIds.size).toBe(first.stats.callsStubbed);

    const grown = [...first.messages, ...bashCalls(300, 500), message('assistant', 'All checks ran.')];
    const second = await compact(grown, fakeJev(() => 0.1), options);
    expect(second.stats.stubsDropped).toBe(first.stats.callsStubbed);
    const left = new Set(second.messages.flatMap((m) => m.toolUses).map((t) => t.tool_use_id));
    expect([...stubbedIds].filter((id) => left.has(id))).toEqual([]);
  });

  it('marks a stub of a short result, so the next pass deletes it', async () => {
    const options = { preserveRecentMessages: 1, dropCalls: false };
    const short: Message[] = [
      message('user', 'go'),
      call('s1', 'Read', { file_path: 'b.ts' }, 'ok'),
      result('s1', 'ok'),
      message('assistant', 'done'),
    ];
    const first = await compact(short, fakeJev(() => 0.1), options);
    expect(first.decisions.map((d) => d.reason)).toEqual(['call_stubbed']);
    const second = await compact(first.messages, fakeJev(() => 0.1), options);
    expect(second.decisions.map((d) => d.reason)).toEqual(['stub_dropped']);
    expect(second.messages.map((m) => m.text)).toEqual(['go', 'done']);
  });

  it('never counts a stub as larger than the result it replaced', async () => {
    const messages: Message[] = [message('user', 'go')];
    for (let i = 0; i < 300; i += 1) messages.push(call(`s${i}`, 'Bash', { command: 'true' }, 'ok'), result(`s${i}`, 'ok'));
    messages.push(message('assistant', 'done'));
    const output = await compact(messages, fakeJev(() => 0.1), { dropCalls: false });
    expect(output.stats.callsStubbed).toBe(output.stats.calls - output.stats.pinned);
    expect(output.messages[1]!.toolUses[0]!.text).toMatch(/\[fast-jev-compaction stub\]$/);
    // Nothing was cut, so nothing was gained, and nothing was lost either.
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers', async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Jev answer/,
    );
  });
});

describe('HTTP client', () => {
  it('builds a System One request', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { a: 1 }, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(request.body)).toEqual({
      model: 'jev-latest',
      state: { a: 1 },
      questions: { q: { type: 'noul', instructions: 'x' } },
    });
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseJevResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseJevResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseJevResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseJevResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  it('asks over fetch and refuses to run without a key', async () => {
    const bodies: string[] = [];
    const client = new JevClient({
      apiKey: 'k',
      model: 'jev-test',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const response = await client.ask('state', { q: { type: 'noul', instructions: 'x' } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    expect(JSON.parse(bodies[0]!).model).toBe('jev-test');

    const keyless = new JevClient({ apiKey: '' });
    await expect(keyless.ask('s', {})).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactMessages(transcript(), { apiKey: '', preserveRecentMessages: 1 }),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});

describe('windowed states when the history does not fit', () => {
  function long(n: number): Message[] {
    const out: Message[] = [message('user', 'Fix the failing build; never touch src/generated.')];
    for (let i = 0; i < n; i++) {
      out.push(message('assistant', `Step ${i}: ${'checking the next module and its callers '.repeat(6)}`));
      out.push(call(`w${i}`, 'Bash', { command: `npm test -- module${i}` }, ''));
      out.push(result(`w${i}`, `module${i}: 3 passed, 1 failed (exit code 1)\n${'x'.repeat(400)}`));
    }
    out.push(message('user', 'go on'));
    return out;
  }
  const options = { maxStateTokens: 3_000, maxRequestTokens: 6_000, preserveRecentMessages: 2 };

  it('splits into windows that each fit, and every candidate is asked', async () => {
    const messages = long(400);
    const calls = collectToolCalls(messages, 2);
    expect(() => fitState(messages, calls, resolveOptions(options))).toThrow(/history too large/);
    const seen: Seen[] = [];
    const out = await compact(messages, fakeJev(() => 0.1, seen), options);
    expect(out.stats.stateStage).toMatch(/^windows:\d+$/);
    expect(out.stats.stateTokens).toBeLessThanOrEqual(options.maxStateTokens);
    const asked = new Set(seen.flatMap((s) => s.questions).filter((q) => q.startsWith('call_')));
    expect(asked.size).toBe(calls.filter((c) => !c.pinned).length);
    expect(out.stats.requests).toBe(seen.length);
  });

  it('keeps a call that no window can fit, instead of throwing', async () => {
    const messages = long(5);
    const seen: Seen[] = [];
    const out = await compact(messages, fakeJev(() => 0.1, seen), { ...options, maxStateTokens: 200, goal: 'g'.repeat(5_000) });
    expect(seen.length).toBe(0);
    expect(out.stats.stateStage).toMatch(/unasked:\d+/);
    expect(out.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(out.messages).toEqual(messages);
  });

  it('keeps the calls of a window too large to fit alone, and asks about the rest', async () => {
    const messages = long(20);
    // A tool name is never shortened, so this call's window cannot fit by itself.
    const huge = 'Z'.repeat(6_000);
    messages[3 * 7 + 2]!.toolUses[0]!.tool = huge;
    const calls = collectToolCalls(messages, 2);
    const big = calls.find((c) => c.tool === huge)!;
    const seen: Seen[] = [];
    const out = await compact(messages, fakeJev(() => 0.1, seen), { ...options, maxStateTokens: 800, dropCalls: false });
    expect(out.stats.stateStage).toMatch(/^windows:\d+ unasked:1$/);
    expect(out.stats.stateTokens).toBeLessThanOrEqual(800);
    const asked = new Set(seen.flatMap((s) => s.questions));
    expect(asked.has(`call_${big.id}`)).toBe(false);
    expect(out.decisions.find((d) => d.id === big.id)).toMatchObject({ action: 'keep', reason: 'kept' });
    expect(out.messages.some((m) => m.toolUses.some((t) => t.tool === huge && t.text === ''))).toBe(true);
    const others = out.decisions.filter((d) => d.id !== big.id && d.reason !== 'pinned');
    expect(others.length).toBe(calls.filter((c) => !c.pinned).length - 1);
    expect(others.every((d) => asked.has(`call_${d.id}`) && d.action === 'stub_call')).toBe(true);
  });
});
