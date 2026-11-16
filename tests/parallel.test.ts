// Parallel tool calls. The host lists one message per transcript record, and it
// writes one record per tool_use block, so one assistant turn that made three
// calls is listed as three assistant messages, then three tool-result messages.
// A message the hook hands back without a handle is built afresh, with an id of
// its own, so the host no longer joins the three; before each request it pairs
// an assistant message's calls with the message right after it only, and fills
// every call not answered there with "[Tool result missing due to internal
// error]". The model then reads a call that succeeded as one that failed.
import { describe, expect, it } from 'vitest';
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
