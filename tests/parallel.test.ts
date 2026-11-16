// Parallel tool calls. The host lists one message per transcript record, and it
// writes one record per tool_use block, so one assistant turn that made three
// calls is listed as three assistant messages, then three tool-result messages.
// A message the hook hands back without a handle is built afresh, with an id of
// its own, so the host no longer joins the three (it joins consecutive user
// messages, not these); before each request it pairs an assistant message's
// calls with the message right after it only, and fills every call not
// answered there with "[Tool result missing due to internal error]". The model
// then reads a call that succeeded as one that failed. The tests hold the
// handed-back list to the API's own rule, which needs no help from the host:
// every call answered in the very next message.
import { describe, expect, it } from 'vitest';
import * as hook from '../hooks/fast-jev.ts';
import { harness, message, result, type SessionMessage, uuid } from './harness.ts';

const RESULT = 'y'.repeat(3000);
const OWN_NOTE = /\[fast-jev-compaction (?:truncated \d+ chars of this tool result(?: \(error\))?; re-run the tool if needed|stub)\]$/;

function use(id: string, text = RESULT): SessionMessage {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `src/${id}.ts` }, text }] });
}

/** A prompt, one turn of three parallel calls as the host lists it, a reply, a plain user message. */
function parallel(ids = ['p1', 'p2', 'p3']): SessionMessage[] {
  return [
    message('user', 'Read the three files.'),
    message('assistant', 'Reading them together.'),
    ...ids.map((id) => use(id)),
    ...ids.map((id) => result(id, RESULT)),
    message('assistant', 'All three read.'),
    message('user', 'Thanks.'),
  ];
}

/**
 * What the API requires of a history: every tool_use of an assistant message is
 * answered by a tool_result in the message right after it, and every tool_result
 * answers a tool_use of the message right before it. Returns each breach by id.
 */
function unpaired(messages: readonly SessionMessage[]): { unanswered: string[]; orphaned: string[] } {
  const unanswered: string[] = [];
  const orphaned: string[] = [];
  messages.forEach((m, i) => {
    const next = messages[i + 1];
    const answered = new Set(next?.role === 'user' ? (next.toolResults ?? []).map((r) => r.tool_use_id) : []);
    for (const t of m.toolUses) if (!answered.has(t.tool_use_id)) unanswered.push(t.tool_use_id);
    const prev = messages[i - 1];
    const asked = new Set(prev?.role === 'assistant' ? prev.toolUses.map((t) => t.tool_use_id) : []);
    for (const r of m.toolResults ?? []) if (!asked.has(r.tool_use_id)) orphaned.push(r.tool_use_id);
  });
  return { unanswered, orphaned };
}

const resultOf = (messages: readonly SessionMessage[], id: string) =>
  messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === id);

describe('parallel tool calls in a compacted history', () => {
  it('answers every stubbed call of one turn in the next message, with the plugin\'s own note', async () => {
    const h = harness();
    const out = await h.compact(parallel());
    expect(h.fallbacks).toHaveLength(0);
    expect(unpaired(out)).toEqual({ unanswered: [], orphaned: [] });
    const calls = out.filter((m) => m.toolUses.length > 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolUses.map((t) => t.tool_use_id)).toEqual(['p1', 'p2', 'p3']);
    for (const id of ['p1', 'p2', 'p3']) expect(resultOf(out, id)?.text).toMatch(OWN_NOTE);
  });

  it('pairs the calls Jev keeps whole, too: every handed-back call is rebuilt', async () => {
    const h = harness();
    // One large call before the turn is cut (t1), so the compaction saves something; the turn's three are kept.
    h.jev((key) => (key.endsWith('_t1') ? 0.1 : 0.9));
    const [prompt, ...rest] = parallel();
    const out = await h.compact([prompt!, use('big', 'z'.repeat(20_000)), result('big', 'z'.repeat(20_000)), ...rest]);
    expect(h.fallbacks).toHaveLength(0);
    expect(resultOf(out, 'big')?.text).toMatch(OWN_NOTE);
    expect(unpaired(out)).toEqual({ unanswered: [], orphaned: [] });
    for (const id of ['p1', 'p2', 'p3']) expect(resultOf(out, id)?.text).toBe(RESULT);
  });

  it('keeps a single call as it was: one call, its result next', async () => {
    const h = harness();
    const out = await h.compact(parallel(['s1']));
    expect(unpaired(out)).toEqual({ unanswered: [], orphaned: [] });
    expect(resultOf(out, 's1')?.text).toMatch(OWN_NOTE);
  });

  it('deletes an already-stubbed call and its result together at the next compaction', async () => {
    const h = harness();
    const first = await h.compact(parallel());
    // The host lists the stored history again, each message with a handle of its own,
    // one record per tool_use block as before.
    const relisted = first.flatMap((m): SessionMessage[] =>
      m.toolUses.length > 1 ? m.toolUses.map((t) => ({ ...m, text: '', toolUses: [t], handle: uuid() })) : [{ ...m, handle: m.handle ?? uuid() }],
    );
    const second = await h.compact([...relisted, message('assistant', 'Next.'), message('user', 'Go on.')]);
    expect(h.fallbacks).toHaveLength(0);
    expect(unpaired(second)).toEqual({ unanswered: [], orphaned: [] });
    const ids = second.flatMap((m) => [...m.toolUses.map((t) => t.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)]);
    expect(ids).toEqual([]);
  });
});

// Text between a turn's results, and lists the API rule cannot be met for.
const STUB = '[fast-jev-compaction stub]';
const BIG = 'z'.repeat(20_000);
/** A call an earlier compaction cut to a stub; `text` on its result message. */
const oldUse = (id: string) => use(id, STUB);
const oldResult = (id: string, text = '') => message('user', text, { toolResults: [{ tool_use_id: id, text: STUB, isError: false }] });
const bare = (m: SessionMessage): SessionMessage => ({ ...m, handle: undefined });
/** A large call to cut first (t1), so a compaction saves well past the 25% minimum. */
const opening = (): SessionMessage[] => [message('user', 'Start.'), use('big', BIG), result('big', BIG)];

describe('text between a turn\'s results', () => {
  it('keeps the words of a result message whose old stub was deleted, after the turn\'s results, not between them', async () => {
    const h = harness({ minReductionRatio: 0.25 });
    // t1 big: stubbed; t3 b: an old stub, deleted (stub_dropped); a and c kept.
    h.jev((key) => (/_t[13]$/.test(key) ? 0.1 : 0.9));
    const out = await h.compact([...opening(), use('a'), oldUse('b'), use('c'), result('a', RESULT), oldResult('b', 'Words that must stay.'), result('c', RESULT), message('user', 'End.')]);
    expect(h.fallbacks).toHaveLength(0);
    expect(h.toasts.at(-1)).toMatch(/1 stub_dropped/);
    expect(unpaired(out)).toEqual({ unanswered: [], orphaned: [] });
    const at = out.findIndex((m) => m.toolUses.some((t) => t.tool_use_id === 'a'));
    expect(out[at]!.toolUses.map((t) => t.tool_use_id)).toEqual(['a', 'c']);
    expect(out[at + 1]!.toolResults!.map((r) => r.tool_use_id)).toEqual(['a', 'c']);
    expect(out[at + 2]).toMatchObject({ role: 'user', text: 'Words that must stay.', toolUses: [] });
    expect(out[at + 2]!.toolResults).toBeUndefined();
  });

  it('moves a handleless text message from between results to after them, as the same object', () => {
    const words = bare(message('user', '  exact bytes\n\n'));
    const out = hook.joinToolRounds([bare(use('a')), bare(use('b')), bare(result('a', RESULT)), words, bare(result('b', RESULT))]);
    expect(unpaired(out)).toEqual({ unanswered: [], orphaned: [] });
    expect(out).toHaveLength(3);
    expect(out[2]).toBe(words);
  });

  it('falls back rather than move or merge a typed user message listed inside a turn', async () => {
    const h = harness({ minReductionRatio: 0.25 });
    h.jev((key) => (key.endsWith('_t1') ? 0.1 : 0.9));
    const typed = message('user', 'Stop after this one.');
    const out = await h.compact([...opening(), use('a'), use('b'), typed, result('a', RESULT), result('b', RESULT), message('user', 'End.')]);
    expect(h.fallbacks).toHaveLength(1);
    expect(h.fallbacks[0]!.messages).toContain(typed);
    expect(h.toasts.at(-1)).toMatch(/^fallback to built-in summary \(the history to hand back would leave 2 tool call\(s\) without their result in the next message: a, b;/);
    expect(out.map((m) => m.text)).toEqual(['BUILT-IN SUMMARY']);
  });
});

describe('lists that break the rule whatever is joined', () => {
  it('falls back when the list ends with a call that has no result', async () => {
    const h = harness({ minReductionRatio: 0.25 });
    h.jev(() => 0.1);
    const pending = message('assistant', '', { toolUses: [{ tool_use_id: 'last', tool: 'Read', input: { file_path: 'x' } }] });
    await h.compact([...opening(), message('assistant', 'Next.'), pending]);
    expect(h.fallbacks).toHaveLength(1);
    expect(h.toasts.at(-1)).toMatch(/without their result in the next message: last;/);
  });

  it('falls back when the list starts with a result that answers no call', async () => {
    const h = harness({ minReductionRatio: 0.25 });
    h.jev(() => 0.1);
    await h.compact([result('first', 'r'), ...opening(), message('assistant', 'Done.'), message('user', 'End.')]);
    expect(h.fallbacks).toHaveLength(1);
    expect(h.toasts.at(-1)).toMatch(/without their result in the next message: first;/);
  });

  it('names a call answered twice in one message, or a result given twice', () => {
    const twice = bare(message('user', '', { toolResults: [{ tool_use_id: 'a', text: 'r', isError: false }, { tool_use_id: 'a', text: 'r', isError: false }] }));
    expect(hook.unpairedTools([bare(use('a')), twice])).toEqual(['a']);
    // Two result messages for one call join into one with both: the check, not the join, refuses it.
    const joinedTwice = hook.joinToolRounds([bare(use('a')), bare(result('a', 'r')), bare(result('a', 'r'))]);
    expect(joinedTwice).toHaveLength(2);
    expect(hook.unpairedTools(joinedTwice)).toEqual(['a']);
  });

  it('names a call made twice under one id', () => {
    const one = message('assistant', '', { toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {}, text: 'r' }, { tool_use_id: 'a', tool: 'Read', input: {}, text: 'r' }] });
    expect(hook.unpairedTools([bare(one), bare(result('a', 'r'))])).toEqual(['a']);
  });

  it('falls back rather than hand back two results for one call', async () => {
    const h = harness({ minReductionRatio: 0.25 });
    h.jev((key) => (key.endsWith('_t1') ? 0.1 : 0.9));
    await h.compact([...opening(), use('a'), result('a', RESULT), result('a', RESULT), message('user', 'End.')]);
    expect(h.fallbacks).toHaveLength(1);
    expect(h.toasts.at(-1)).toMatch(/without their result in the next message: a;/);
  });

  it('names a turn split by a message with a handle, which is never joined', () => {
    const split = hook.joinToolRounds([bare(use('a')), use('b'), bare(use('c')), bare(result('a', RESULT)), bare(result('b', RESULT)), bare(result('c', RESULT))]);
    expect(hook.unpairedTools?.(split)).toEqual(['a', 'b']);
    const results = hook.joinToolRounds([bare(use('a')), bare(use('b')), bare(use('c')), bare(result('a', RESULT)), result('b', RESULT), bare(result('c', RESULT))]);
    expect(hook.unpairedTools?.(results)).toEqual(['b', 'c']);
  });
});
