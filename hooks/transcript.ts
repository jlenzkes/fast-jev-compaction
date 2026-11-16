/**
 * Reading the host's transcript at a compaction. The host process only
 * transports bytes: a constant script prints the file's size and one slice of
 * it in base64. Everything else - lines, UTF-8, JSON, the boundary, the
 * handles, the walk - happens once, here, on parsed records. Stateless: the
 * plugin keeps nothing between compactions. DESIGN-NOTES.md is the contract.
 */

/**
 * The Windows transport (Windows PowerShell 5.1 or later), run with
 * -EncodedCommand. A constant: the path, offset and length come in FJC_PATH,
 * FJC_OFFSET and FJC_LENGTH. Prints the file's size, then those bytes in
 * base64 on one line. Nothing else.
 */
export const SLICE_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$path = $env:FJC_PATH",
  "$off = [long]$env:FJC_OFFSET",
  "$len = [int]$env:FJC_LENGTH",
  "$fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)",
  "try {",
  "  $size = $fs.Length",
  "  $buf = New-Object byte[] $len",
  "  $n = 0",
  "  if ($off -lt $size) {",
  "    [void]$fs.Seek($off, [System.IO.SeekOrigin]::Begin)",
  "    while ($n -lt $len) { $r = $fs.Read($buf, $n, $len - $n); if ($r -le 0) { break }; $n += $r }",
  "  }",
  "} finally { $fs.Dispose() }",
  "$w = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))",
  "$w.NewLine = \"`n\"",
  "$w.WriteLine(\"$size\")",
  "$w.WriteLine([Convert]::ToBase64String($buf, 0, $n))",
  "$w.Flush()",
].join(String.fromCharCode(10));

/**
 * The POSIX transport, run as `sh -c SLICE_SH`. A constant: the path, offset
 * and length come in FJC_PATH, FJC_OFFSET and FJC_LENGTH. Prints the file's
 * size, then those bytes in base64 on one line. Nothing else.
 */
export const SLICE_SH = [
  'set -e',
  'size=$(wc -c < "$FJC_PATH" | tr -d " ")',
  'printf "%s\\n" "$size"',
  'if [ "$FJC_OFFSET" -lt "$size" ]; then',
  '  tail -c +"$((FJC_OFFSET + 1))" "$FJC_PATH" | head -c "$FJC_LENGTH" | base64 | tr -d "\\n\\r"',
  'fi',
  'printf "\\n"',
].join(String.fromCharCode(10));

/** Raw bytes per run: 4,000,000 base64 characters, under the host's 4,194,304-character output cut. */
export const SLICE_BYTES = 3_000_000;
/** Runs in flight at once. */
export const IN_FLIGHT = 4;
/** A window needing more runs than this stands down: about 24 MB, twice the largest real window. */
export const MAX_RUNS = 8;
/** What `$.fs.read` can return whole. */
export const FS_READ_LIMIT = 4 * 1024 * 1024;
/** Per run: a slice took 1.2 to 1.4 s with the start of PowerShell itself. */
export const READER_TIMEOUT_MS = 30_000;
/** A delivery with more text than this is not carried; it is named as too large. */
export const DELIVERY_MAX_CHARS = 1_048_576;

export class ReaderError extends Error {}

/** PowerShell's -EncodedCommand: the script as UTF-16LE, in base64. */
export function encodePs(script: string): string {
  let bytes = '';
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes += String.fromCharCode(c & 0xff, c >> 8);
  }
  return btoa(bytes);
}

// ---------------------------------------------------------------------------
// Bytes

/** Base64 to bytes; anything that is not base64 throws. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw new ReaderError('the reader printed something that is not base64');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Whether bytes[a, b) are well-formed UTF-8 (no overlongs, no surrogates, nothing past U+10FFFF). */
export function isUtf8(bytes: Uint8Array, a: number, b: number): boolean {
  let i = a;
  while (i < b) {
    const c = bytes[i]!;
    if (c < 0x80) {
      i++;
      continue;
    }
    let n: number;
    let min: number;
    if (c >= 0xc2 && c <= 0xdf) {
      n = 1;
      min = 0x80;
    } else if (c >= 0xe0 && c <= 0xef) {
      n = 2;
      min = 0x800;
    } else if (c >= 0xf0 && c <= 0xf4) {
      n = 3;
      min = 0x10000;
    } else return false;
    if (i + n >= b) return false;
    let cp = c & (n === 1 ? 0x1f : n === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= n; k++) {
      const d = bytes[i + k];
      if (d === undefined || (d & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (d & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += n + 1;
  }
  return true;
}

const DECODER = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// Records

type Json = { [key: string]: unknown };

/** One parsed line: its order in the file (larger is later), and its top-level fields. */
export type Line = { order: number; record?: Json; bad?: string };

/**
 * The complete lines of bytes[from, to), in order, each strictly decoded and
 * parsed. `from` must start a line. A byte-order mark is dropped only where
 * `bomAt` (the file's first byte) is; anywhere else its line does not parse.
 * A last line with no `\n` after it is left out when `unterminatedEnd`.
 */
export function parseLines(bytes: Uint8Array, from: number, to: number, firstOrder: number, bomAt: number, unterminatedEnd: boolean): Line[] {
  const out: Line[] = [];
  let a = from;
  let order = firstOrder;
  while (a < to) {
    let b = bytes.indexOf(0x0a, a);
    const terminated = b !== -1 && b < to;
    if (!terminated) {
      if (unterminatedEnd) break;
      b = to;
    }
    let s = a;
    let e = b;
    if (e > s && bytes[e - 1] === 0x0d) e--;
    if (s === bomAt && bytes[s] === 0xef && bytes[s + 1] === 0xbb && bytes[s + 2] === 0xbf) s += 3;
    const line: Line = { order: order++ };
    if (s === e) {
      // An empty line carries nothing.
    } else if (bytes[s] === 0xef && bytes[s + 1] === 0xbb && bytes[s + 2] === 0xbf) {
      line.bad = 'a byte-order mark inside the file';
    } else if (!isUtf8(bytes, s, e)) {
      line.bad = 'not UTF-8';
    } else {
      try {
        const value: unknown = JSON.parse(DECODER.decode(bytes.subarray(s, e)));
        if (value && typeof value === 'object' && !Array.isArray(value)) line.record = value as Json;
        else line.bad = 'not a JSON object';
      } catch {
        line.bad = 'not JSON';
      }
    }
    out.push(line);
    a = b + 1;
  }
  return out;
}

const isBoundary = (r: Json) => r['type'] === 'system' && r['subtype'] === 'compact_boundary' && r['isSidechain'] !== true;
const isMessage = (r: Json) => (r['type'] === 'user' || r['type'] === 'assistant') && r['isMeta'] !== true;

/** A hidden record that carries words to the model: a queued prompt or an isMeta user record. */
export type Found = {
  uuid: string;
  parent: string | null;
  /** Its order in the file: larger is later. */
  order: number;
  /** It precedes the window's boundary (a built-in summary's preserved segment). */
  before: boolean;
  /** The sender, from structure only: the origin kind; `human` for a prompt-mode queued command with none; `host` for an isMeta record with none. */
  kind: string;
  /** A queued prompt arrived while a turn ran; an isMeta record starts or ends a turn. */
  queued: boolean;
  body: string;
  /** Image (or other non-text) blocks it carried, which are never carried back. */
  images: number;
};

function textOf(content: unknown): { body: string; images: number } {
  if (typeof content === 'string') return { body: content, images: 0 };
  if (!Array.isArray(content)) return { body: '', images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const b of content as Json[]) {
    if (b && typeof b === 'object' && b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'] as string);
    else images++;
  }
  return { body: parts.join('\n'), images };
}

function kindOf(origin: unknown): string | undefined {
  const k = origin && typeof origin === 'object' ? (origin as Json)['kind'] : undefined;
  return typeof k === 'string' && k.length > 0 ? k : undefined;
}

/** The delivery a parsed record carries, or undefined. Decided on top-level fields only. */
export function deliveryOf(r: Json, order: number, before = false): Found | undefined {
  if (r['isSidechain'] === true || typeof r['uuid'] !== 'string') return undefined;
  const parent = typeof r['parentUuid'] === 'string' ? (r['parentUuid'] as string) : null;
  const base = { uuid: r['uuid'] as string, parent, order, before };
  if (r['type'] === 'attachment') {
    const a = r['attachment'] as Json | undefined;
    if (!a || typeof a !== 'object' || a['type'] !== 'queued_command') return undefined;
    const { body, images } = textOf(a['prompt']);
    if (!body.trim() && images === 0) return undefined;
    const mode = typeof a['commandMode'] === 'string' ? (a['commandMode'] as string) : undefined;
    const kind = kindOf(a['origin']) ?? (mode === 'prompt' || mode === undefined ? 'human' : mode);
    return { ...base, kind, queued: true, body, images };
  }
  if (r['type'] === 'user' && r['isMeta'] === true) {
    const message = r['message'] as Json | undefined;
    const { body, images } = textOf(message && typeof message === 'object' ? message['content'] : undefined);
    if (!body.trim() && images === 0) return undefined;
    return { ...base, kind: kindOf(r['origin']) ?? 'host', queued: false, body, images };
  }
  return undefined;
}

export type Window = {
  /** Order of the last boundary record; -Infinity when the file has none. */
  boundary: number;
  start: number;
  /** The uuid of the window's first record, when it has one. */
  startUuid?: string;
  /** Each listed handle found as a record's own uuid, and its order. */
  found: Map<string, number>;
  /** Every record of the window with a uuid: its parent, and whether it is a user or assistant message. */
  records: Map<string, { order: number; parent: string | null; message: boolean }>;
  deliveries: Found[];
  /** Hidden records (attachments, isMeta) in the window, a preserved segment included. */
  hidden: number;
};

/**
 * The window from parsed lines: from the last boundary record, or the first
 * listed handle when earlier, to the end. Throws ReaderError on a line in the
 * window that does not parse.
 */
export function windowOf(lines: readonly Line[], handles: ReadonlySet<string>): Window {
  let boundary = Number.NEGATIVE_INFINITY;
  const found = new Map<string, number>();
  for (const l of lines) {
    const r = l.record;
    if (!r) continue;
    if (isBoundary(r)) boundary = Math.max(boundary, l.order);
    const u = r['uuid'];
    if (typeof u === 'string' && handles.has(u) && !found.has(u)) found.set(u, l.order);
  }
  const first = lines.length > 0 ? lines[0]!.order : 0;
  let start = Number.isFinite(boundary) ? boundary : first;
  for (const v of found.values()) if (v < start) start = v;
  const w: Window = { boundary, start, found, records: new Map(), deliveries: [], hidden: 0 };
  const at = lines.find((l) => l.order === start)?.record?.['uuid'];
  if (typeof at === 'string') w.startUuid = at;
  for (const l of lines) {
    if (l.order < start) continue;
    if (l.bad !== undefined) throw new ReaderError(`a transcript line in the window is ${l.bad}`);
    const r = l.record;
    if (!r || r['isSidechain'] === true) continue;
    if (typeof r['uuid'] === 'string') {
      w.records.set(r['uuid'] as string, { order: l.order, parent: typeof r['parentUuid'] === 'string' ? (r['parentUuid'] as string) : null, message: isMessage(r) });
    }
    if (r['type'] === 'attachment' || r['isMeta'] === true) w.hidden++;
    const d = deliveryOf(r, l.order, l.order < boundary);
    if (d) w.deliveries.push(d);
  }
  return w;
}

// ---------------------------------------------------------------------------
// Reading through the host

/** The host calls the reader makes, as closures the hook builds (`$` is never handed on). */
export type ReaderHost = {
  stat: (path: string) => Promise<{ size: number }>;
  read: (path: string) => Promise<string>;
  run: (
    argv: readonly string[],
    init?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

/** One slice through the transport: exactly `length` bytes at `offset`, or ReaderError. */
export async function readSlice(host: ReaderHost, argv: readonly string[], path: string, offset: number, length: number): Promise<Uint8Array> {
  const r = await host.run(argv, {
    env: { FJC_PATH: path, FJC_OFFSET: String(offset), FJC_LENGTH: String(length) },
    timeoutMs: READER_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) throw new ReaderError(`the reader exited ${r.exitCode}: ${r.stderr.slice(0, 200).replace(/\s+/g, ' ')}`);
  const nl = r.stdout.indexOf('\n');
  if (nl < 0 || !/^\d+\r?$/.test(r.stdout.slice(0, nl))) throw new ReaderError('the reader printed no file size');
  const bytes = fromBase64(r.stdout.slice(nl + 1));
  if (bytes.length !== length) throw new ReaderError(`the reader returned ${bytes.length} of ${length} bytes`);
  return bytes;
}

export type ReadResult = { window: Window; ms: number; runs: number; bytes: number; via: 'fs' | 'powershell' | 'sh' };

/**
 * Reads the window: the whole file through `$.fs.read` when it is small
 * enough, else slices from the end backwards through the transport, a few in
 * flight at once, until the last boundary record has been parsed and every
 * listed handle found, or the file's start is reached. The size taken first
 * bounds every read.
 */
export async function readWindow(
  host: ReaderHost,
  /** Windows PowerShell's executable on Windows; undefined elsewhere (sh). */
  powershell: string | undefined,
  path: string,
  handles: readonly string[],
  now: () => number,
): Promise<ReadResult> {
  const t0 = now();
  const want = new Set(handles);
  const size = (await host.stat(path)).size;
  if (size <= FS_READ_LIMIT) {
    const bytes = new TextEncoder().encode(await host.read(path));
    const lines = parseLines(bytes, 0, bytes.length, 0, 0, bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a);
    return { window: windowOf(lines, want), ms: now() - t0, runs: 0, bytes: bytes.length, via: 'fs' };
  }
  const argv = powershell ? [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(SLICE_PS)] : ['sh', '-c', SLICE_SH];
  const chunks: Uint8Array[] = [];
  let low = size;
  let runs = 0;
  let lines: Line[] = [];
  // Order counts down from the end: the last line read is -1, the one before -2, ...
  let parsedFrom = size;
  let firstOrder = 0;
  let lastByte = -1;
  for (;;) {
    const batch: { offset: number; length: number }[] = [];
    for (let k = 0; k < IN_FLIGHT && low > 0; k++) {
      const offset = Math.max(0, low - SLICE_BYTES);
      batch.push({ offset, length: low - offset });
      low = offset;
    }
    runs += batch.length;
    if (runs > MAX_RUNS) throw new ReaderError(`window too large to read (more than ${((MAX_RUNS * SLICE_BYTES) / 1048576).toFixed(0)} MiB)`);
    const got = await Promise.all(batch.map((s) => readSlice(host, argv, path, s.offset, s.length)));
    chunks.unshift(...got.reverse());
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      buf.set(c, o);
      o += c.length;
    }
    if (lastByte < 0) lastByte = buf[buf.length - 1]!;
    // Lines wholly inside [low, parsedFrom): the first is complete only at the file's start.
    const end = parsedFrom - low;
    let from = 0;
    if (low > 0) {
      const nl = buf.indexOf(0x0a);
      from = nl < 0 || nl >= end ? end : nl + 1;
    }
    const fresh = parseLines(buf, from, end, 0, low === 0 ? 0 : -1, parsedFrom === size && lastByte !== 0x0a);
    firstOrder -= fresh.length;
    fresh.forEach((l, i) => (l.order = firstOrder + i));
    lines = [...fresh, ...lines];
    parsedFrom = low + from;
    // Done at the last boundary once every listed handle is found; a preserved
    // message lies between it and the boundary before, so past that one a
    // missing handle is missing (the caller stands down on it).
    const boundaries = lines.filter((l) => l.record !== undefined && isBoundary(l.record)).length;
    const all = [...want].every((h) => lines.some((l) => l.record?.['uuid'] === h));
    if ((boundaries >= 1 && all) || boundaries >= 2 || low === 0) break;
  }
  return { window: windowOf(lines, want), ms: now() - t0, runs, bytes: size - low, via: powershell ? 'powershell' : 'sh' };
}

// ---------------------------------------------------------------------------
// The neighbour walk

export type Neighbour =
  /** Its chain reaches this listed handle. */
  | { at: string }
  /** Its chain reaches the root without meeting a message: it sat at the start of the history. */
  | { first: true }
  /** It precedes the boundary and its chain reaches no listed message: the summary took it. */
  | { summary: true }
  /** Its chain stops at a message the listing does not hold, a record outside the window, or a cycle. */
  | { unlisted: string };

/**
 * Walks `parentUuid` from a delivery through every record that is not a user
 * or assistant message, whatever its type, to the first listed message. Stops
 * at a message that is not listed and never climbs past one; stops on a
 * cycle; never loops.
 */
export function neighbourOf(d: { parent: string | null; before: boolean }, w: Window, handles: ReadonlySet<string>): Neighbour {
  const seen = new Set<string>();
  let p = d.parent;
  for (;;) {
    if (p === null) return d.before ? { summary: true } : { first: true };
    if (seen.has(p)) return { unlisted: 'a cycle in the parent chain' };
    seen.add(p);
    if (handles.has(p)) return { at: p };
    const rec = w.records.get(p);
    if (!rec) return d.before ? { summary: true } : { unlisted: 'a record outside the window' };
    if (rec.message) return d.before ? { summary: true } : { unlisted: 'a message the listing does not hold' };
    p = rec.parent;
  }
}
