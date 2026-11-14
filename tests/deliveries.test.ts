import { describe, expect, it } from 'vitest';
import { call, harness, history, holding, indented, indexHolding, INDENT_NOTE, message, plainIds, PUT_BACK, receipts, result } from './harness.ts';

// Drives the plugin only through the hooks Claude Code calls.
//
// The engine stores a subagent's report, a prompt typed while a turn ran and
// a hook's feedback BESIDE a message, not as one: `session.compact` never
// lists them, and they survive only when the message they sit beside goes
// back with its handle. Every message but a plain user message goes back
// without one, so on 14 Nov 2026 a compaction listing 778 messages dropped
// 7 subagent reports, 14 prompts typed mid-turn, 15 task notifications and 4
// hook messages (40 of the 42 such records it held) while its banner read
// "kept 778/778 messages".

const REPORT = 'Another Claude session sent a message:\n<agent-message from="a1">REPORT-ALPHA: 41 of 41 rows pass</agent-message>';
const TYPED = 'Also check the ids, please';

describe('deliveries the engine stores beside a message', () => {
  it('puts a subagent report back after the message that was newest when it arrived', async () => {
    const t = harness();
    await t.submit(history().slice(0, 4), REPORT, 'peer');
    const out = await t.compact();
    const at = indexHolding(out, '<agent-message from="a1">REPORT-ALPHA: 41 of 41 rows pass</agent-message>');
    expect(at).toBeGreaterThan(0);
    expect(out[at]!.handle).toBeUndefined();
    expect(out[at]!.text.split('\n').slice(1).join('\n')).toBe(indented(REPORT));
    expect(out[at]!.text.split('\n')[0]).toContain('between turns; it was not typed by the user.');
    expect(out[at - 1]!.text).toBe('Both are running; I will wait.');
    expect(out[at + 1]!.text).toBe('The report says all 41 rows pass. Next, the ids.');
  });

  it('puts a prompt typed mid-turn back after the tool round it arrived in', async () => {
    const t = harness();
    await t.submit(history().slice(0, 6), TYPED, 'composer', { turnId: 'turn-2' });
    const out = await t.compact();
    const at = indexHolding(out, TYPED);
    expect(out[at]!.text.replace(PUT_BACK, '[fast-jev-compaction put-back M] ')).toBe(
      `[fast-jev-compaction put-back M] Sent by the user while you were working; it was typed by the user.${INDENT_NOTE}\n  ${TYPED}`,
    );
    expect(out[at - 1]!.toolResults?.[0]?.tool_use_id).toBe('t2');
  });

  it('leaves to the host a delivery beside a plain user message it hands back whole', async () => {
    // Measured: 159 of 159 such deliveries survived when that message did.
    const t = harness();
    await t.submit(history(), REPORT, 'peer');
    const out = await t.compact();
    expect(out.filter((m) => m.text.includes('REPORT-ALPHA'))).toHaveLength(0);
  });

  it('puts it back, labelled, when the plain message it sat beside is gone', async () => {
    const t = harness();
    await t.submit(history(), REPORT, 'peer');
    const out = await t.compact(history().slice(0, 8));
    const put = out.find((m) => m.text.includes('REPORT-ALPHA'))!;
    expect(put.text.split('\n')[0]).toContain('earlier in this conversation');
    expect(put.text.split('\n')[0]).toContain('may also appear elsewhere');
  });

  it('leaves alone a delivery that became a message of its own', async () => {
    const t = harness();
    await t.submit(history().slice(0, 8), 'Thanks.', 'task-notification');
    expect(holding(await t.compact(), 'Thanks.')).toHaveLength(1);
  });

  it('puts back a report whose place is followed by a different delivery the host listed', async () => {
    // Transcript line 9943: the next listed message was a task notification, not the report.
    const listed = [...history().slice(0, 4), message('user', '<task-notification>other</task-notification>', { handle: 'n' }), ...history().slice(4)];
    const t = harness();
    await t.submit(history().slice(0, 4), 'REPORT-9943', 'peer');
    expect(holding(await t.compact(listed), 'REPORT-9943')).toHaveLength(1);
  });

  it('puts a report back once over repeated compactions of the history as returned', async () => {
    const t = harness();
    await t.submit(history().slice(0, 4), REPORT, 'peer');
    const first = await t.compact();
    const second = await t.compact(first);
    const third = await t.compact(second);
    expect(third.filter((m) => m.text.includes('REPORT-ALPHA'))).toHaveLength(1);
    expect(receipts(third)).toHaveLength(1);
  });

  it('says in the banner how many listed messages were rebuilt or deleted and how many deliveries were put back', async () => {
    const t = harness();
    await t.submit(history().slice(0, 4), REPORT, 'peer');
    await t.compact();
    expect(t.toasts.at(-1)).toMatch(
      /^kept 9\/9 listed messages \(7 rebuilt and 0 deleted, without what the host stores beside them; 1 delivered prompt\(s\) put back\), no summary \(\d+% smaller as returned; 2 call_stubbed; /,
    );
  });

  it('ends the history with a receipt of what was cut, what was put back and where the transcript is', async () => {
    const t = harness();
    await t.submit(history().slice(0, 4), REPORT, 'peer');
    const out = await t.compact();
    const last = out.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.handle).toBeUndefined();
    expect(plainIds(last.text).split('\n')).toEqual([
      '[fast-jev-compaction receipt id1000000000] This conversation was just compacted without a summary: 9 of 9 listed messages kept, their text verbatim; 2 tool call(s) cut to a stub (tool name, head of input and result). Re-run a tool for anything cut.',
      'Not carried: 7 message(s) were rebuilt and 0 deleted, and whatever the host had stored beside them and never shows a plugin (Stop hook feedback, goal check-ins, notices) is gone, except the delivered prompts put back below.',
      'Put back as messages of their own (1), each after the tool round it arrived in, as near as the plugin can tell. Each opens with a line "[fast-jev-compaction put-back <id>] ..." the plugin wrote, and every line of the delivered text under it is indented two spaces:',
      '- id2000000000 from another Claude session: "REPORT-ALPHA: 41 of 41 rows pass"',
      'Full transcript: C:/Users/me/.claude/projects/c--dev-proj/sess-1.jsonl',
      'A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the transcript before stating it.',
    ]);
  });

  it('names no transcript it has not found', async () => {
    const t = harness();
    t.session('no-such-file');
    const text = (await t.compact()).at(-1)!.text;
    expect(text).toContain('The full transcript is the session file under projects/');
    expect(text).not.toContain('Full transcript:');
  });

  it('writes no receipt when the receipt option is off', async () => {
    const t = harness({ receipt: false });
    const out = await t.compact();
    expect(out).toHaveLength(9);
    expect(receipts(out)).toHaveLength(0);
  });
});

describe('the record of deliveries across hooks', () => {
  it("keeps a subagent's compaction free of the main loop's deliveries and of a receipt", async () => {
    const t = harness();
    await t.submit(history().slice(0, 4), 'MAIN-REPORT', 'peer');
    const sub = await t.compact(history(), { agentId: 'sub-1' });
    expect(holding(sub, 'MAIN-REPORT')).toHaveLength(0);
    expect(receipts(sub)).toHaveLength(0);
    expect(holding(await t.compact(), 'MAIN-REPORT')).toHaveLength(1);
  });

  it('keeps a delivery that arrives while a compaction runs', async () => {
    const t = harness();
    t.during(() => t.submit(history().slice(0, 4), 'ARRIVED-DURING', 'peer'));
    const first = await t.compact();
    expect(holding(first, 'ARRIVED-DURING')).toHaveLength(0);
    expect(holding(await t.compact(), 'ARRIVED-DURING')).toHaveLength(1);
  });

  it('does not record a prompt the hooks dropped', async () => {
    const t = harness();
    const entered = await t.submit(history().slice(0, 4), 'REFUSED', 'peer', { turnId: 'turn' }, async () => ({ drop: 'refused' }));
    expect(entered).toEqual({ drop: 'refused' });
    await t.submit(history().slice(0, 4), 'REFUSED-IDLE', 'peer', {}, async () => ({ drop: 'refused' }));
    const out = await t.compact();
    expect(holding(out, 'REFUSED')).toHaveLength(0);
    expect(holding(out, 'REFUSED-IDLE')).toHaveLength(0);
  });

  it('puts a prompt still waiting at a fallback back after the next tool round', async () => {
    const t = harness({ receipt: false });
    await t.submit(history(), 'WAITING-THEN-RESULT', 'composer', { turnId: 'turn' });
    t.jev('fail');
    const summary = [message('user', 'BUILT-IN SUMMARY', { handle: 's' })];
    await t.compact(history(), {}, async () => ({ messages: summary }));
    t.jev(() => 0.1);
    const later = [...summary, call('t9'), result('t9'), message('assistant', 'Done.', { handle: 'd' })];
    const out = await t.compact(later);
    expect(out[indexHolding(out, 'WAITING-THEN-RESULT') - 1]!.toolResults?.[0]?.tool_use_id).toBe('t9');
  });
});
