// The transport scripts run for real: SLICE_PS under Windows PowerShell,
// SLICE_SH under a POSIX sh where one exists. They know nothing of the
// transcript's format; the only thing to test is that each returns exactly the
// bytes asked for, and the file's size, whatever the bytes and the path are.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePs, fromBase64, SLICE_PS, SLICE_SH } from '../hooks/transcript.ts';

const windows = process.platform === 'win32';
const GIT_SH = 'C:/Program Files/Git/usr/bin/sh.exe';
const sh = windows ? (existsSync(GIT_SH) ? GIT_SH : undefined) : '/bin/sh';
const PS = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function slice(kind: 'ps' | 'sh', path: string, offset: number, length: number): { size: number; bytes: Uint8Array; chars: number } {
  const [exe, args] = kind === 'ps' ? [PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(SLICE_PS)]] : [sh!, ['-c', SLICE_SH]];
  const r = spawnSync(exe, args, { env: { ...process.env, FJC_PATH: path, FJC_OFFSET: String(offset), FJC_LENGTH: String(length) }, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr?.toString()).toBe(0);
  const out = r.stdout.toString('latin1');
  const nl = out.indexOf('\n');
  return { size: Number(out.slice(0, nl).trim()), bytes: fromBase64(out.slice(nl + 1)), chars: out.length };
}

const dirs: string[] = [];
function fileAt(folder: string, bytes: Uint8Array): string {
  const root = mkdtempSync(join(tmpdir(), 'fjc-slice-'));
  dirs.push(root);
  mkdirSync(join(root, folder), { recursive: true });
  const path = join(root, folder, 'sess.jsonl');
  writeFileSync(path, bytes);
  return path;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const enc = (s: string) => new TextEncoder().encode(s);
const join2 = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const FILES: [string, Uint8Array][] = [
  ['a byte-order mark', join2(new Uint8Array([0xef, 0xbb, 0xbf]), enc('{"a":1}\n{"b":"\u00e9\u2014\u00ab"}\n'))],
  ['CR-only line endings', enc('{"a":1}\r{"b":2}\r{"c":3}\r')],
  ['a NUL', join2(enc('{"a":"x'), new Uint8Array([0]), enc('y"}\n'))],
  ['invalid UTF-8', join2(enc('{"a":"'), new Uint8Array([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80]), enc('"}\n'))],
  ['a 5 MiB line', enc(`{"big":"${'\u65e5'.repeat(1_800_000)}"}\n`)],
];

for (const kind of ['ps', 'sh'] as const) {
  const available = kind === 'ps' ? windows && existsSync(PS) : sh !== undefined;
  describe.skipIf(!available)(`${kind === 'ps' ? 'SLICE_PS (Windows PowerShell)' : 'SLICE_SH (sh)'} run for real`, () => {
    for (const [name, bytes] of FILES) {
      it(`returns exactly the bytes asked for, and the size, from a file with ${name}`, () => {
        const path = fileAt('plain', bytes);
        for (const [offset, length] of [
          [0, bytes.length],
          [1, Math.min(7, bytes.length - 1)],
          [Math.max(0, bytes.length - 3_000_000), Math.min(3_000_000, bytes.length)],
        ] as const) {
          const got = slice(kind, path, offset, length);
          expect(got.size).toBe(bytes.length);
          expect(Buffer.from(got.bytes).equals(Buffer.from(bytes.subarray(offset, offset + length)))).toBe(true);
        }
      });
    }

    it('keeps one run of 3,000,000 bytes under the host\'s 4,194,304-character cut', () => {
      const bytes = enc('x'.repeat(3_100_000));
      const got = slice(kind, fileAt('cut', bytes), 100_000, 3_000_000);
      expect(got.bytes.length).toBe(3_000_000);
      expect(got.chars).toBeLessThan(4_194_304);
    });

    it('reads within the size taken first while the file grows', () => {
      const first = enc('{"a":1}\n'.repeat(1000));
      const path = fileAt('grow', first);
      const before = slice(kind, path, 0, first.length);
      appendFileSync(path, '{"late":true}\n');
      const after = slice(kind, path, 0, first.length);
      expect(Buffer.from(after.bytes).equals(Buffer.from(before.bytes))).toBe(true);
      expect(after.size).toBe(first.length + 14);
    });

    it('takes the path as data, whatever the folder is called', () => {
      const bytes = enc('{"a":"\u00e9"}\n');
      for (const name of ['with space', "O'Brien", 'dollar $HOME $(x)', 'semi; echo pwned', `it'; Write-Output INJECTED; '`, '\u00fcn\u00efc\u00f6d\u00e9 \u2014 \u00abdir\u00bb']) {
        const got = slice(kind, fileAt(name, bytes), 0, bytes.length);
        expect(Buffer.from(got.bytes).equals(Buffer.from(bytes)), name).toBe(true);
      }
    });
  });
}
