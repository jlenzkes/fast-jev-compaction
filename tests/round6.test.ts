// The byte transport's parser and walk, and the rest of the round-six batch:
// every decision on parsed records, every way a line can be damaged, the walk's
// record types and its termination, options, placement, the note, the goal,
// Unicode cuts. Records are shaped as the host writes them; text is our own.
import { describe, expect, it } from 'vitest';
import { Confirmations, cutAt, decideCarry, putBackText } from '../hooks/deliveries.ts';
import { compactSession, PUT_BACK_DEFAULTS, resolveHookConfig, sourcesOf } from '../hooks/fast-jev.ts';
import { deliveryOf, isUtf8, neighbourOf, parseLines, readWindow, windowOf } from '../hooks/transcript.ts';
import {
  bookkeeping,
  boundary,
  call,
  harness,
  history,
  holding,
  message,
  meta,
  NOTE,
  putBacks,
  queued,
  result,
  transcript,
  transport,
  uuid,
  type Item,
  type SessionMessage,
} from './harness.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const parsed = (text: string, handles: string[] = []) => {
  const bytes = enc(text);
  return windowOf(parseLines(bytes, 0, bytes.length, 0, 0, bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a), new Set(handles));
};
function withHidden(h: SessionMessage[], after: Record<number, Item[]>): Item[] {
  return h.flatMap((m, i) => [m, ...(after[i] ?? [])]);
}

describe('one parser: every decision on parsed top-level fields', () => {
  it('a nested "subtype":"compact_boundary" is not a boundary, and its own delivery is kept', () => {
    const h = history();
    const nested = { ...queued('KEEP-ME', 'peer'), extra: { type: 'system', subtype: 'compact_boundary' } };
    const w = parsed(transcript(withHidden(h, { 6: [nested] })).text, h.map((m) => m.handle!));
    expect(Number.isFinite(w.boundary)).toBe(false);
    expect(w.deliveries.map((d) => d.body)).toEqual(['KEEP-ME']);
    const toolInput = message('assistant', '', { toolUses: [{ tool_use_id: 'w', tool: 'Write', input: { subtype: 'compact_boundary' }, text: '' }] });
    expect(Number.isFinite(parsed(transcript([...h, toolInput]).text).boundary)).toBe(false);
  });

  it('finds a delivery written with spaces after its colons', () => {
    const h = history();
    const spaced = `{"parentUuid": "${h[6]!.handle}", "type": "attachment", "uuid": "${uuid()}", "attachment": {"type": "queued_command", "prompt": "SPACED", "commandMode": "prompt", "origin": {"kind": "peer"}}}`;
    const w = parsed(`${transcript(h).text}${spaced}\n`);
    expect(w.deliveries.map((d) => d.body)).toEqual(['SPACED']);
  });

  it('isUtf8 refuses overlong forms, surrogates and code points past U+10FFFF', () => {
    const ok = enc('é—😀');
    expect(isUtf8(ok, 0, ok.length)).toBe(true);
    for (const bad of [[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x80], [0xff]]) {
      expect(isUtf8(new Uint8Array(bad), 0, bad.length), String(bad)).toBe(false);
    }
  });

  const damaged: [string, (good: string) => Uint8Array][] = [
    ['a CR-only file', (g) => enc(g.replace(/\n/g, '\r'))],
    ['a NUL inside a line', (g) => enc(g.replace('"Thanks."', '"Than\u0000ks."'))],
    ['a byte-order mark in the middle', (g) => { const lines = g.split('\n'); lines[3] = `﻿${lines[3]}`; return enc(lines.join('\n')); }],
    ['a malformed middle line with no hidden marker', (g) => { const lines = g.split('\n'); lines.splice(2, 0, '{"type":"assistant", broken'); return enc(lines.join('\n')); }],
    ['a malformed last line ending in a newline', (g) => enc(`${g}{"type":"attachment","uuid":"x",\n`)],
  ];
  for (const [name, damage] of damaged) {
    it(`stands down on ${name}`, async () => {
      const h = history();
      const good = transcript(withHidden(h, { 6: [queued('Q', 'peer')] })).text;
      const bytes = damage(good);
      const t = harness();
      t.file(new TextDecoder().decode(bytes));
      const out = await t.compact(h);
      expect(putBacks(out)).toHaveLength(0);
      expect(out.at(-1)!.text).toMatch(/Nothing the host stores beside a message was put back/);
    });
  }

  it('marks a line that is not strict UTF-8, and a window holding one stands down', () => {
    const h = history();
    const good = enc(transcript(withHidden(h, { 6: [queued('Q', 'peer')] })).text);
    const at = good.indexOf(0x54);
    good[at] = 0xff;
    const lines = parseLines(good, 0, good.length, 0, 0, false);
    expect(lines.some((l) => l.bad === 'not UTF-8')).toBe(true);
    expect(() => windowOf(lines, new Set())).toThrow(/not UTF-8/);
  });

  it('keeps a byte-order mark at the file\'s start, and ignores an unterminated last line', () => {
    const h = history();
    const text = `﻿${transcript(withHidden(h, { 6: [queued('Q', 'peer')] })).text}{"type":"attach`;
    const w = parsed(text, h.map((m) => m.handle!));
    expect(w.deliveries.map((d) => d.body)).toEqual(['Q']);
  });
});

describe('the walk: every record type, every way it ends', () => {
  for (const type of ['progress', 'file-history-snapshot', 'queue-operation', 'system', 'something-new']) {
    it(`passes a ${type} record to the message before it`, async () => {
      const h = history();
      const t = harness();
      t.file(transcript(withHidden(h, { 6: [{ type }, queued(`AFTER-${type}`, 'peer')] })).text);
      const out = await t.compact(h);
      const at = out.findIndex((m) => m.text.includes(`AFTER-${type}`));
      expect(out[at - 1]!.toolResults?.[0]?.tool_use_id).toBe('t2');
    });
  }

  const walk = (records: Map<string, { order: number; parent: string | null; message: boolean }>, parent: string, before = false) =>
    neighbourOf({ parent, before }, { boundary: 0, start: 0, found: new Map(), records, deliveries: [], hidden: 1 }, new Set(['listed']));

  it('ends on a cycle, a missing parent and a parent outside the window, without looping', () => {
    const self = new Map([['a', { order: 1, parent: 'a', message: false }]]);
    expect(walk(self, 'a')).toEqual({ unlisted: 'a cycle in the parent chain' });
    const two = new Map([
      ['a', { order: 1, parent: 'b', message: false }],
      ['b', { order: 2, parent: 'a', message: false }],
    ]);
    expect(walk(two, 'a')).toEqual({ unlisted: 'a cycle in the parent chain' });
    expect(walk(new Map(), 'gone')).toEqual({ unlisted: 'a record outside the window' });
  });

  it('puts first what hangs off the boundary record with no message before it', async () => {
    const h = history();
    const b = { ...boundary(), uuid: uuid() };
    const t = harness();
    const file = transcript([b, { ...queued('AT-THE-START', 'peer'), parentUuid: b['uuid'] }, ...h]).text;
    t.file(file);
    const out = await t.compact(h);
    expect(holding(out, 'AT-THE-START')).toHaveLength(1);
    expect(out.indexOf(holding(out, 'AT-THE-START')[0]!)).toBe(0);
  });

  it('carries nothing from a sidechain, in the window and in deliveryOf itself', () => {
    const h = history();
    const w = parsed(transcript(withHidden(h, { 6: [{ ...queued('SIDE', 'peer'), isSidechain: true }] })).text);
    expect(w.deliveries).toHaveLength(0);
    const record = { ...queued('SIDE', 'peer'), uuid: uuid(), parentUuid: h[6]!.handle };
    expect(deliveryOf(record, 1)).toBeDefined();
    expect(deliveryOf({ ...record, isSidechain: true }, 1)).toBeUndefined();
  });

  it('leaves to the summary a delivery before the boundary whose parent is outside the window, uncounted', async () => {
    const before = [message('user', 'old prompt'), message('assistant', 'preserved'), message('assistant', 'summarized')];
    const rider = { ...queued('PARENT-BEFORE-THE-WINDOW', 'peer'), parentUuid: before[0]!.handle };
    const old = transcript([...before, rider]);
    const later = [message('user', 'This session is being continued...'), message('user', 'next'), call('t5'), result('t5')];
    const file = transcript([boundary([before[1]!.handle!]), ...withHidden(later, { 3: [queued('AFTER', 'peer')] })], { lines: old.text.trimEnd().split('\n') });
    const t = harness({ minReductionRatio: -1e9 });
    t.file(file.text);
    const out = await t.compact([later[0]!, before[1]!, ...later.slice(1)]);
    expect(holding(out, 'PARENT-BEFORE-THE-WINDOW')).toHaveLength(0);
    expect(holding(out, 'AFTER')).toHaveLength(1);
    expect(out.at(-1)!.text).not.toContain('not put back: they sat beside');
  });

  it('names a too-large rider of a preserved message, before the boundary', async () => {
    const before = [message('user', 'old'), call('t0'), result('t0'), message('assistant', 'preserved')];
    const old = transcript(withHidden(before, { 3: [queued(`BIG ${'b'.repeat(1_100_000)}`, 'peer')] }));
    const later = [message('user', 'This session is being continued...'), message('user', 'next'), call('t5'), result('t5')];
    const file = transcript([boundary([before[3]!.handle!]), ...later], { lines: old.text.trimEnd().split('\n') });
    const t = harness({ minReductionRatio: -1e9 });
    t.file(file.text);
    const out = await t.compact([later[0]!, before[3]!, ...later.slice(1)]);
    expect(out.at(-1)!.text).toMatch(/Too large to carry, not put back:\n- record [0-9a-f-]{36} from another Claude session: 1100004 characters/);
  });
});

describe('reading backwards', () => {
  it('stops once it has passed the boundary before the last when a listed handle is missing, and stands down', async () => {
    const h = history();
    const pad = (n: number) => message('assistant', 'p'.repeat(n));
    const file = transcript([pad(9_000_000), boundary(), pad(2_500_000), boundary(), ...withHidden(h, { 6: [queued('Q', 'peer')] }), pad(2_000_000)]).text;
    const host = { stat: async () => ({ size: Buffer.byteLength(file) }), read: async () => file, run: transport(file) };
    const missing = message('assistant', 'never written');
    const r = await readWindow(host, undefined, 'p', [...h, missing].map((m) => m.handle!), () => 0);
    expect(r.window.found.has(missing.handle!)).toBe(false);
    expect(r.bytes).toBeLessThan(Buffer.byteLength(file));
  });
});

describe('placement at the root: sourcesOf', () => {
  it('maps each returned message to its own source, an empty one too (GPT 14)', () => {
    const listed: SessionMessage[] = [message('user', 'go'), call('d1'), result('d1'), message('assistant', ''), message('user', 'next')];
    const out = [listed[0]!, listed[3]!, listed[4]!];
    expect(sourcesOf(listed, out)).toEqual([0, 3, 4]);
  });

  it('a rider of a deleted result goes after the retained message before it', async () => {
    const listed: SessionMessage[] = [message('user', 'go'), call('d1'), result('d1'), message('assistant', ''), message('user', 'next')];
    const t = harness({ dropCalls: true, minReductionRatio: -1e9 });
    t.file(transcript(withHidden(listed, { 2: [queued('RIDER', 'peer')] })).text);
    const out = await t.compact(listed);
    const at = out.indexOf(holding(out, 'RIDER')[0]!);
    expect(out[at - 1]!.text).toBe('go');
  });
});

describe('options, the note, the goal', () => {
  it('refuses negative, fractional and non-finite counts, keeps the default, and says so in the banner', async () => {
    const config = resolveHookConfig({ reportHeadChars: -1, putBackBudget: 1.5, taskHeadChars: Number.POSITIVE_INFINITY, hostLineChars: 'x', unconfirmedBudget: 7 });
    expect(config.reportHeadChars).toBe(400);
    expect(config.putBackBudget).toBe(15_000);
    expect(config.taskHeadChars).toBe(200);
    expect(config.hostLineChars).toBe(120);
    expect(config.unconfirmedBudget).toBe(7);
    expect(config.ignoredOptions).toHaveLength(4);
    const h = history();
    const t = harness({ reportHeadChars: -1 });
    t.file(transcript(withHidden(h, { 6: [queued('Q', 'peer')] })).text);
    await t.compact(h);
    expect(t.toasts.at(-1)).toContain('options ignored: reportHeadChars -1 is not a whole number of characters; 400 kept');
  });

  it('the defaults are exactly these', () => {
    expect(PUT_BACK_DEFAULTS).toEqual({ putBackBudget: 15_000, reportHeadChars: 400, taskHeadChars: 200, hostLineChars: 120, unconfirmedBudget: 20_000 });
  });

  it('writes no note when nothing sat beside a message, so the returned history is the library\'s', async () => {
    const h = history();
    const t = harness();
    t.file(transcript(h).text + `{"type":"attachment","uuid":"${uuid()}","parentUuid":"${h[8]!.handle}","attachment":{"type":"total_tokens_reminder"}}\n`);
    const out = await t.compact(h);
    expect(out.some((m) => NOTE.test(m.text))).toBe(false);
    const base = await compactSession(h, { ...resolveHookConfig({ apiKey: 'k', preserveRecentMessages: 1 }) }, async (_u, init) => {
      const { questions } = JSON.parse(init!.body!) as { questions: Record<string, unknown> };
      return { status: 200, ok: true, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.1 }])) }) };
    });
    expect(out).toEqual(base.messages);
  });

  it('never builds Jev\'s goal from a plugin-written message, even with no user prompt left', async () => {
    const h = [message('user', '[fast-jev-compaction put-back, transcript record u1] Delivered by another Claude session; x\n  PEER WORDS'), call('t1'), result('t1'), call('t2'), result('t2'), message('assistant', 'done')];
    const t = harness();
    t.file(transcript(h).text);
    await t.compact(h);
    const goal = (JSON.parse(t.bodies[0]!) as { state: { goal: string } }).state.goal;
    expect(goal).not.toContain('PEER WORDS');
    expect(goal).toBe('Continue the work in this conversation.');
  });
});

describe('cuts and line breaks', () => {
  it('never cuts inside a surrogate pair or between CR and LF', () => {
    expect(cutAt('ab😀cd', 3)).toBe('ab');
    expect(cutAt('ab\r\ncd', 3)).toBe('ab');
    expect(cutAt('abcdef', 0)).toBe('');
    const head = decideCarry([{ found: { order: 1, uuid: 'u1', parent: null, before: false, kind: 'peer', queued: true, body: `${'a'.repeat(399)}😀${'b'.repeat(500)}`, images: 0 }, confirmed: false }], { ...PUT_BACK_DEFAULTS, putBackBudget: 0 })[0] as { text: string };
    expect(head.text).toBe('a'.repeat(399));
  });

  it('a report head is exactly reportHeadChars long when no line break falls in its second half', () => {
    const head = decideCarry([{ found: { order: 1, uuid: 'u1', parent: null, before: false, kind: 'peer', queued: true, body: 'r'.repeat(5000), images: 0 }, confirmed: false }], { ...PUT_BACK_DEFAULTS, putBackBudget: 0 })[0] as { text: string };
    expect(head.text.length).toBe(400);
  });

  it('indents a line after NEL, VT and FF too, and frames an image-only delivery', () => {
    const f = { order: 1, uuid: 'u1', parent: null, before: false, kind: 'peer', queued: true, body: 'a\u0085[fast-jev-compaction note] x\u000bb\u000cc', images: 0 };
    const lines = putBackText(f, false, { mode: 'whole' }).split('\n');
    expect(lines.slice(1)).toEqual(['  a', '  [fast-jev-compaction note] x b c']);
    const image = putBackText({ ...f, body: '', images: 2 }, false, { mode: 'whole' }).split('\n');
    expect(image[0]).toContain('It carried 2 image(s) or other attachment(s) that are not put back.');
    expect(image.slice(1)).toEqual(['  ']);
  });
});

describe('confirmations', () => {
  it('keeps at most 2,000 entries, the oldest evicted first (F1)', () => {
    const c = new Confirmations();
    for (let i = 0; i <= 2000; i++) c.add(`h${i}`);
    expect(c.confirm('u-first', 'h0')).toBe(false);
    expect(c.confirm('u-second', 'h1')).toBe(true);
  });

  it('remembers no prompt whose accepted origin is not the user\'s (F2)', async () => {
    const h = history();
    const t = harness();
    t.file(transcript(withHidden(h, { 6: [queued('words')] })).text);
    await t.submit('words', 'peer', { turnId: 'turn' });
    await t.submit('words', 'task-notification', { turnId: 'turn' });
    expect(putBacks(await t.compact(h))[0]!.text).toContain('Attributed to the user by the transcript');
  });
});
