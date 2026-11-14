// The host-process readers run for real: READER_PS under Windows PowerShell,
// READER_SH under a POSIX sh where one exists. Each must print exactly the
// rows scanTranscript prints, byte for byte, whatever the path holds.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePs, parseRows, READER_PS, READER_SH, scanTranscript } from '../hooks/transcript.ts';
import { boundary, call, history, message, meta, queued, result, stopHookSummary, transcript, type Item, type SessionMessage } from './harness.ts';

const windows = process.platform === 'win32';
const GIT_SH = 'C:/Program Files/Git/usr/bin/sh.exe';
const sh = windows ? (existsSync(GIT_SH) ? GIT_SH : undefined) : '/bin/sh';

function runReader(kind: 'ps' | 'sh', path: string, handles: readonly string[], env: Record<string, string> = {}): string {
  const argv = kind === 'ps' ? ['powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(READER_PS)]] : [sh!, ['-c', READER_SH]];
  const r = spawnSync(argv[0] as string, argv[1] as string[], {
    env: { ...process.env, FJC_PATH: path, FJC_FROM: '0', FJC_BUDGET: '3500000', FJC_LINE_CAP: '1048576', ...env },
    input: Buffer.from(handles.join('\n'), 'utf8'),
    timeout: 60_000,
  });
  expect(r.status, r.stderr?.toString()).toBe(0);
  // The bytes must be UTF-8: a decoder that rejects anything else.
  return new TextDecoder('utf-8', { fatal: true }).decode(r.stdout);
}

const rowsOf = (text: string) => {
  const rows = text.split('\n').filter(Boolean);
  return { other: rows.filter((r) => !r.startsWith('H\t')), h: rows.filter((r) => r.startsWith('H\t')).sort() };
};

const NON_ASCII = 'Mid-turn \u2014 \u00abquoted\u00bb caf\u00e9 \u2192 \ud83d\ude00 \u65e5\u672c';

function fixture(): { text: string; handles: string[]; h: SessionMessage[] } {
  const before = [message('user', 'old'), call('t0'), result('t0'), message('assistant', 'preserved')];
  const old = transcript(before);
  const h = [message('user', 'new prompt \u00e9'), call('t1'), result('t1'), message('assistant', 'ok \u2014 done')];
  const items: Item[] = [boundary([before[3]!.handle!]), ...h.slice(0, 3), queued(NON_ASCII), queued([{ type: 'text', text: 'with image' }, { type: 'image', source: { type: 'base64', data: 'B'.repeat(5000) } }]), stopHookSummary(), meta('report \u00ab\u00bb', 'peer'), h[3]!];
  const text = transcript(items, { lines: old.text.trimEnd().split('\n') }).text;
  return { text, handles: [before[3]!.handle!, ...h.map((m) => m.handle!)], h };
}

const dirs: string[] = [];
function fileAt(folderName: string, text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'fjc-reader-'));
  dirs.push(root);
  const dir = join(root, folderName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, text, 'utf8');
  return path;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

for (const kind of ['ps', 'sh'] as const) {
  const available = kind === 'ps' ? windows : sh !== undefined;
  describe.skipIf(!available)(`${kind === 'ps' ? 'READER_PS (Windows PowerShell)' : 'READER_SH (sh and awk)'} run for real`, () => {
    it('prints the rows scanTranscript prints, non-ASCII text byte for byte, images blanked', () => {
      const { text, handles } = fixture();
      const path = fileAt('plain', text);
      const got = runReader(kind, path, handles);
      const want = scanTranscript(text, handles, { budget: 3_500_000, lineCap: 1_048_576 });
      expect(rowsOf(got)).toEqual(rowsOf(want));
      const w = parseRows(got);
      expect(w.deliveries.map((d) => d.body)).toEqual([NON_ASCII, 'with image', 'report \u00ab\u00bb']);
      expect(w.deliveries[1]!.images).toBe(1);
      expect(got).not.toContain('BBBBBBBB');
      expect(w.start).toBeLessThan(w.boundary);
    });

    it('D2: takes the path as data, whatever the folder is called', () => {
      const { text, handles } = fixture();
      const want = rowsOf(scanTranscript(text, handles, { budget: 3_500_000, lineCap: 1_048_576 }));
      for (const name of ['with space', "O'Brien", 'dollar $HOME $(x)', 'semi; echo pwned', `all '"$; \u00e9`.replace('"', windows ? '_' : '"')]) {
        expect(rowsOf(runReader(kind, fileAt(name, text), handles)), name).toEqual(want);
      }
    });

    it('continues from FJC_FROM after a budget cut, and caps a long line', () => {
      const { text, handles } = fixture();
      const path = fileAt('budget', text);
      const first = runReader(kind, path, handles, { FJC_BUDGET: '400' });
      expect(first.trimEnd().split('\n').at(-1)).toMatch(/^END\t\d+\t\d+\tmore$/);
      const last = Number(first.trimEnd().split('\n').at(-1)!.split('\t')[2]);
      const second = runReader(kind, path, handles, { FJC_FROM: String(last + 1) });
      expect(rowsOf(second)).toEqual(rowsOf(scanTranscript(text, handles, { from: last + 1, budget: 3_500_000, lineCap: 1_048_576 })));
      const capped = runReader(kind, path, handles, { FJC_LINE_CAP: '300' });
      expect(rowsOf(capped)).toEqual(rowsOf(scanTranscript(text, handles, { budget: 3_500_000, lineCap: 300 })));
      expect(capped).toMatch(/\nX\t\d+\t\d+\t[0-9a-f-]{36}\t[0-9a-f-]{36}\tdelivery\n/);
    });

    it('prints a cut-off last line, which the parser ignores', () => {
      const { text, handles } = fixture();
      const path = fileAt('partial', `${text}{"parentUuid":"x","type":"attachment","isMeta":true,"mess`);
      const w = parseRows(runReader(kind, path, handles));
      expect(w.deliveries).toHaveLength(3);
    });
  });
}

describe('scanTranscript, the reference', () => {
  it('starts at the last boundary, or at the first line before it holding a listed handle', () => {
    const { text, handles } = fixture();
    const meta = scanTranscript(text, handles, { budget: 1e9, lineCap: 1e9 }).split('\n')[0]!.split('\t');
    expect(Number(meta[3])).toBeLessThan(Number(meta[2]));
    const noPreserved = scanTranscript(text, handles.slice(1), { budget: 1e9, lineCap: 1e9 }).split('\n')[0]!.split('\t');
    expect(noPreserved[3]).toBe(noPreserved[2]);
  });

  it('decides on parsed fields: a message quoting "type":"attachment" in a tool input is not a delivery', () => {
    const h = history();
    const tricky = message('assistant', '', { toolUses: [{ tool_use_id: 'tq', tool: 'Bash', input: { type: 'attachment', attachment: { type: 'queued_command', prompt: 'FAKE' } }, text: '' }] });
    const text = transcript([...h, tricky]).text;
    const w = parseRows(scanTranscript(text, [...h, tricky].map((m) => m.handle!), { budget: 1e9, lineCap: 1e9 }));
    expect(w.deliveries).toHaveLength(0);
    expect(w.records.get(tricky.handle!)?.message).toBe(true);
  });
});
