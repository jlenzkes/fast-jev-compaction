/**
 * Reading the host's transcript at a compaction: which hidden records (queued
 * prompts, isMeta messages) sit beside which listed message. Stateless: the
 * plugin keeps nothing between compactions. DESIGN-NOTES.md is the contract.
 */

/** The Windows reader (Windows PowerShell 5.1 or later), run with -EncodedCommand. A constant: the path comes in FJC_PATH. */
export const READER_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$enc = New-Object System.Text.UTF8Encoding($false)",
  "$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $enc)",
  "$out.NewLine = \"`n\"",
  "$path = $env:FJC_PATH",
  "$from = [int]$env:FJC_FROM",
  "$budget = [int]$env:FJC_BUDGET",
  "$cap = [int]$env:FJC_LINE_CAP",
  "$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $enc)",
  "$want = New-Object 'System.Collections.Generic.HashSet[string]'",
  "foreach ($h in $stdin.ReadToEnd().Split(\"`n\")) { $t = $h.Trim(); if ($t) { [void]$want.Add($t) } }",
  "$rxUuid = New-Object System.Text.RegularExpressions.Regex('\"uuid\":\"([0-9a-f-]{36})\",\"timestamp\":\"|\"timestamp\":\"[^\"]*\",\"uuid\":\"([0-9a-f-]{36})\"')",
  "$rxImage = New-Object System.Text.RegularExpressions.Regex('\"data\":\"[A-Za-z0-9+/=]{64,}\"')",
  "$rxParent = New-Object System.Text.RegularExpressions.Regex('^\\{\"parentUuid\":(?:null|\"([^\"]*)\")')",
  "$found = New-Object 'System.Collections.Generic.Dictionary[string,int]'",
  "$cand = New-Object 'System.Collections.Generic.List[object]'",
  "$n = 0; $lastB = 0; $bText = $null",
  "foreach ($l in [System.IO.File]::ReadLines($path, $enc)) {",
  "  $n++",
  "  if ($want.Count -gt $found.Count -and $l.Contains('\"uuid\":\"')) {",
  "    foreach ($m in $rxUuid.Matches($l)) { $u = $m.Groups[1].Value; if (-not $u) { $u = $m.Groups[2].Value }; if ($want.Contains($u) -and -not $found.ContainsKey($u)) { $found[$u] = $n } }",
  "  }",
  "  if ($l.Contains('\"subtype\":\"compact_boundary\"')) { $lastB = $n; $bText = $l }",
  "  if ($l.Contains('\"type\":\"attachment\"') -or $l.Contains('\"isMeta\":true') -or $l.Contains('\"type\":\"system\"')) { $cand.Add(@($n, $l)) }",
  "}",
  "$start = $lastB; if ($start -eq 0) { $start = 1 }",
  "foreach ($v in $found.Values) { if ($v -lt $start) { $start = $v } }",
  "if ($from -gt 0) { $start = $from }",
  "$out.WriteLine(\"META`t$n`t$lastB`t$start\")",
  "if ($bText -ne $null) { $out.WriteLine(\"B`t$lastB`t$bText\") }",
  "foreach ($k in $found.Keys) { $out.WriteLine(\"H`t$k`t$($found[$k])\") }",
  "$size = 0; $last = $start - 1; $more = 'done'",
  "foreach ($c in $cand) {",
  "  $ln = $c[0]",
  "  if ($ln -lt $start -or $ln -eq $lastB) { continue }",
  "  $t = $rxImage.Replace($c[1], '\"data\":\"\"')",
  "  if ($t.Length -gt $cap) {",
  "    $p = $rxParent.Match($t); $s = $rxUuid.Match($t); $su = $s.Groups[1].Value; if (-not $su) { $su = $s.Groups[2].Value }",
  "    $kind = 'other'",
  "    if ($t.Contains('\"queued_command\"') -or $t.Contains('\"isMeta\":true')) { $kind = 'delivery' }",
  "    $row = \"X`t$ln`t$($t.Length)`t$su`t$($p.Groups[1].Value)`t$kind\"",
  "  } else { $row = \"L`t$ln`t$t\" }",
  "  if ($size + $row.Length -gt $budget) { $more = 'more'; break }",
  "  $out.WriteLine($row); $size += $row.Length + 1; $last = $ln",
  "}",
  "$out.WriteLine(\"END`t$n`t$last`t$more\")",
  "$out.Flush()",
].join(String.fromCharCode(10));

/** The POSIX reader (sh and awk), run as `sh -c READER_SH`. A constant: the path comes in FJC_PATH. */
export const READER_SH = [
  "LC_ALL=C",
  "export LC_ALL",
  "exec awk -v cap=\"${FJC_LINE_CAP:-1048576}\" -v budget=\"${FJC_BUDGET:-3500000}\" -v from=\"${FJC_FROM:-0}\" '",
  "function blank(s,   out, m) {",
  "  out = \"\"",
  "  while (match(s, /\"data\":\"[A-Za-z0-9+\\/=]+\"/)) {",
  "    m = substr(s, RSTART, RLENGTH)",
  "    out = out substr(s, 1, RSTART - 1) (RLENGTH > 72 ? \"\\\"data\\\":\\\"\\\"\" : m)",
  "    s = substr(s, RSTART + RLENGTH)",
  "  }",
  "  return out s",
  "}",
  "function selfuuid(s) {",
  "  if (match(s, /\"uuid\":\"[0-9a-f-]+\",\"timestamp\":\"/)) return substr(s, RSTART + 8, 36)",
  "  if (match(s, /\"timestamp\":\"[^\"]*\",\"uuid\":\"[0-9a-f-]+\"/)) return substr(s, RSTART + RLENGTH - 37, 36)",
  "  return \"\"",
  "}",
  "function want_found(s, n,   u) {",
  "  while (match(s, /\"uuid\":\"[0-9a-f-]+\",\"timestamp\":\"/)) {",
  "    u = substr(s, RSTART + 8, 36)",
  "    if ((u in want) && !(u in found)) { found[u] = n; nfound++ }",
  "    s = substr(s, RSTART + RLENGTH)",
  "  }",
  "  while (match(s, /\"timestamp\":\"[^\"]*\",\"uuid\":\"[0-9a-f-]+\"/)) {",
  "    u = substr(s, RSTART + RLENGTH - 37, 36)",
  "    if ((u in want) && !(u in found)) { found[u] = n; nfound++ }",
  "    s = substr(s, RSTART + RLENGTH)",
  "  }",
  "}",
  "FILENAME == \"-\" { if ($0 != \"\") { want[$0] = 1; nwant++ } ; next }",
  "{",
  "  n++",
  "  line = $0",
  "  if (nfound < nwant && index(line, \"\\\"uuid\\\":\\\"\")) want_found(line, n)",
  "  if (index(line, \"\\\"subtype\\\":\\\"compact_boundary\\\"\")) { lastb = n; btext = line }",
  "  if (index(line, \"\\\"type\\\":\\\"attachment\\\"\") || index(line, \"\\\"isMeta\\\":true\") || index(line, \"\\\"type\\\":\\\"system\\\"\")) { cn++; cl[cn] = n; ct[cn] = line }",
  "}",
  "END {",
  "  start = lastb + 0; if (start == 0) start = 1",
  "  for (u in found) if (found[u] < start) start = found[u]",
  "  if (from + 0 > 0) start = from + 0",
  "  printf \"META\\t%d\\t%d\\t%d\\n\", n, lastb, start",
  "  if (lastb > 0) printf \"B\\t%d\\t%s\\n\", lastb, btext",
  "  for (u in found) printf \"H\\t%s\\t%d\\n\", u, found[u]",
  "  size = 0; last = start - 1; more = \"done\"",
  "  for (i = 1; i <= cn; i++) {",
  "    ln = cl[i]",
  "    if (ln < start || ln == lastb) continue",
  "    t = blank(ct[i])",
  "    if (length(t) > cap + 0) {",
  "      p = \"\"",
  "      if (match(t, /^\\{\"parentUuid\":\"[^\"]*\"/)) p = substr(t, 16, RLENGTH - 16)",
  "      kind = (index(t, \"\\\"queued_command\\\"\") || index(t, \"\\\"isMeta\\\":true\")) ? \"delivery\" : \"other\"",
  "      row = \"X\\t\" ln \"\\t\" length(t) \"\\t\" selfuuid(t) \"\\t\" p \"\\t\" kind",
  "    } else row = \"L\\t\" ln \"\\t\" t",
  "    if (size + length(row) > budget + 0) { more = \"more\"; break }",
  "    print row",
  "    size += length(row) + 1; last = ln",
  "  }",
  "  printf \"END\\t%d\\t%d\\t%s\\n\", n, last, more",
  "}' - \"$FJC_PATH\"",
].join(String.fromCharCode(10));

// ---------------------------------------------------------------------------
// The reader protocol (one row per line of output, fields tab-separated):
//   META <lines in the file> <line of the last compact_boundary, 0 if none> <first line read>
//   B    <line> <the last boundary record, whole>
//   H    <listed handle> <the first line it occurs on as a "uuid">
//   L    <line> <a candidate record, whole, base64 image data blanked>
//   X    <line> <length> <its uuid> <its parentUuid> <delivery|other>   (a candidate over the line cap)
//   END  <lines in the file> <last line printed> <done|more>
// A candidate is any line holding `"type":"attachment"`, `"isMeta":true` or
// `"type":"system"` as text: every hidden record and every system record, plus
// a few messages that quote such a key in a nested object, which the parser
// tells apart by their parsed top-level fields. Lines escaped inside a string
// cannot match. The window read starts at the last boundary, or earlier at the
// first line holding a listed handle (a built-in summary's preserved segment).

export type ReaderOptions = {
  /** Start at this line instead (a second run after `more`). */
  from?: number;
  /** Characters of rows per run; under the host's 4,194,304-character output cut. */
  budget: number;
  /** A candidate line longer than this is reported as an X row, not printed. */
  lineCap: number;
};

export const READER_BUDGET = 3_500_000;
export const READER_LINE_CAP = 1_048_576;

const IMAGE_DATA = /"data":"[A-Za-z0-9+/=]{64,}"/g;
/**
 * A record's own uuid: the one beside its timestamp key, in either order. On a
 * real transcript this finds every record's uuid and never a second one (11,969
 * of 11,969 records); a nested object holding a uuid and a timestamp side by
 * side would also match, and is the rule's stated limit.
 */
const UUID_KEY = /"uuid":"([0-9a-f-]{36})","timestamp":"|"timestamp":"[^"]*","uuid":"([0-9a-f-]{36})"/g;
const PARENT_FIRST = /^\{"parentUuid":(?:null|"([^"]*)")/;

function isCandidate(line: string): boolean {
  return line.includes('"type":"attachment"') || line.includes('"isMeta":true') || line.includes('"type":"system"');
}

/**
 * The reader, in TypeScript: the same rows READER_PS and READER_SH print. Used
 * on a file `$.fs.read` can return whole, and as their reference in tests.
 */
export function scanTranscript(text: string, handles: readonly string[], options: ReaderOptions): string {
  const want = new Set(handles);
  const found = new Map<string, number>();
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let lastB = 0;
  let bText: string | undefined;
  const cand: [number, string][] = [];
  lines.forEach((raw, i) => {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const n = i + 1;
    if (want.size > found.size && l.includes('"uuid":"')) {
      for (const m of l.matchAll(UUID_KEY)) {
        const u = m[1] ?? m[2]!;
        if (want.has(u) && !found.has(u)) found.set(u, n);
      }
    }
    if (l.includes('"subtype":"compact_boundary"')) {
      lastB = n;
      bText = l;
    }
    if (isCandidate(l)) cand.push([n, l]);
  });
  let start = lastB > 0 ? lastB : 1;
  for (const v of found.values()) if (v < start) start = v;
  if (options.from && options.from > 0) start = options.from;
  const out = [`META\t${lines.length}\t${lastB}\t${start}`];
  if (bText !== undefined) out.push(`B\t${lastB}\t${bText}`);
  for (const [k, v] of found) out.push(`H\t${k}\t${v}`);
  let size = 0;
  let last = start - 1;
  let more = 'done';
  for (const [ln, l] of cand) {
    if (ln < start || ln === lastB) continue;
    const t = l.replace(IMAGE_DATA, '"data":""');
    let row: string;
    if (t.length > options.lineCap) {
      const p = PARENT_FIRST.exec(t)?.[1] ?? '';
      const self = [...t.matchAll(UUID_KEY)][0];
      const s = self ? (self[1] ?? self[2]!) : '';
      const kind = t.includes('"queued_command"') || t.includes('"isMeta":true') ? 'delivery' : 'other';
      row = `X\t${ln}\t${t.length}\t${s}\t${p}\t${kind}`;
    } else row = `L\t${ln}\t${t}`;
    if (size + row.length > options.budget) {
      more = 'more';
      break;
    }
    out.push(row);
    size += row.length + 1;
    last = ln;
  }
  out.push(`END\t${lines.length}\t${last}\t${more}`);
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Parsing the rows

/** A hidden record that carries words to the model: a queued prompt or an isMeta user record. */
export type Found = {
  /** The transcript line it is on. */
  line: number;
  uuid: string;
  parent: string | null;
  /** The sender, from structure only: the origin kind; `human` for a prompt-mode queued command with none; `host` for an isMeta record with none. */
  kind: string;
  /** A queued prompt arrived while a turn ran; an isMeta record starts or ends a turn. */
  queued: boolean;
  body: string;
  /** Image (or other non-text) blocks it carried, which are not put back. */
  images: number;
};

/** A candidate over the line cap: never put back, named in the note. */
export type Oversize = { line: number; length: number; uuid: string; parent: string; delivery: boolean };

export type Window = {
  total: number;
  /** Line of the last compact_boundary; 0 when the file has none. */
  boundary: number;
  start: number;
  boundaryRecord?: { [key: string]: unknown };
  /** Each listed handle found in the file, and its line. */
  found: Map<string, number>;
  /** Every candidate record read: its parent, and whether it is a listed-type message. */
  records: Map<string, { line: number; parent: string | null; message: boolean }>;
  deliveries: Found[];
  oversize: Oversize[];
  /** Hidden records (attachments, isMeta) read after the boundary. */
  hidden: number;
};

type Json = { [key: string]: unknown };

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
export function deliveryOf(r: Json, line: number): Found | undefined {
  if (r['isSidechain'] === true || typeof r['uuid'] !== 'string') return undefined;
  const parent = typeof r['parentUuid'] === 'string' ? (r['parentUuid'] as string) : null;
  if (r['type'] === 'attachment') {
    const a = r['attachment'] as Json | undefined;
    if (!a || a['type'] !== 'queued_command') return undefined;
    const { body, images } = textOf(a['prompt']);
    if (!body.trim() && images === 0) return undefined;
    const mode = typeof a['commandMode'] === 'string' ? (a['commandMode'] as string) : undefined;
    const kind = kindOf(a['origin']) ?? (mode === 'prompt' || mode === undefined ? 'human' : mode);
    return { line, uuid: r['uuid'] as string, parent, kind, queued: true, body, images };
  }
  if (r['type'] === 'user' && r['isMeta'] === true) {
    const { body, images } = textOf((r['message'] as Json | undefined)?.['content']);
    if (!body.trim() && images === 0) return undefined;
    return { line, uuid: r['uuid'] as string, parent, kind: kindOf(r['origin']) ?? 'host', queued: false, body, images };
  }
  return undefined;
}

export class ReaderError extends Error {}

/** Parses the reader's rows. Throws ReaderError on a cut or a line that does not parse (except an unterminated last line). */
export function parseRows(text: string): Window & { more: boolean; last: number } {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const meta = rows[0]?.split('\t');
  const end = rows.at(-1)?.split('\t');
  if (!meta || meta[0] !== 'META' || !end || end[0] !== 'END' || end[1] !== meta[1]) {
    throw new ReaderError('the reader output is incomplete (no META or END line)');
  }
  const w: Window & { more: boolean; last: number } = {
    total: Number(meta[1]),
    boundary: Number(meta[2]),
    start: Number(meta[3]),
    found: new Map(),
    records: new Map(),
    deliveries: [],
    oversize: [],
    hidden: 0,
    more: end[3] === 'more',
    last: Number(end[2]),
  };
  for (const row of rows.slice(1, -1)) {
    const tab = row.indexOf('\t');
    const tag = row.slice(0, tab);
    if (tag === 'B') {
      const t2 = row.indexOf('\t', tab + 1);
      try {
        w.boundaryRecord = JSON.parse(row.slice(t2 + 1)) as Json;
      } catch {
        throw new ReaderError(`the boundary record at line ${w.boundary} does not parse`);
      }
    } else if (tag === 'H') {
      const [, uuid, line] = row.split('\t');
      w.found.set(uuid!, Number(line));
    } else if (tag === 'X') {
      const [, line, length, uuid, parent, kind] = row.split('\t');
      w.oversize.push({ line: Number(line), length: Number(length), uuid: uuid!, parent: parent!, delivery: kind === 'delivery' });
      if (uuid) w.records.set(uuid, { line: Number(line), parent: parent || null, message: false });
      w.hidden++;
    } else if (tag === 'L') {
      const t2 = row.indexOf('\t', tab + 1);
      const line = Number(row.slice(tab + 1, t2));
      let r: Json;
      try {
        r = JSON.parse(row.slice(t2 + 1)) as Json;
      } catch {
        if (line === w.total) continue; // the host is still writing the last line
        throw new ReaderError(`transcript line ${line} does not parse`);
      }
      if (typeof r['uuid'] !== 'string') continue;
      const message = (r['type'] === 'user' || r['type'] === 'assistant') && r['isMeta'] !== true;
      const parent = typeof r['parentUuid'] === 'string' ? (r['parentUuid'] as string) : null;
      w.records.set(r['uuid'] as string, { line, parent, message });
      if (line > w.boundary && (r['type'] === 'attachment' || r['isMeta'] === true)) w.hidden++;
      const d = deliveryOf(r, line);
      if (d) w.deliveries.push(d);
    } else {
      throw new ReaderError(`the reader printed an unknown row (${tag.slice(0, 8)})`);
    }
  }
  return w;
}

/** Merges a second run (from `last + 1`) into the first. */
export function mergeWindows(a: Window, b: Window): Window {
  for (const [k, v] of b.records) a.records.set(k, v);
  a.deliveries.push(...b.deliveries);
  a.oversize.push(...b.oversize);
  a.hidden += b.hidden;
  return a;
}

// ---------------------------------------------------------------------------
// Running a reader through the host

/** The host calls the reader makes, as closures the hook builds (`$` is never handed on). */
export type ReaderHost = {
  stat: (path: string) => Promise<{ size: number }>;
  read: (path: string) => Promise<string>;
  run: (
    argv: readonly string[],
    init?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

/** What `$.fs.read` can return whole. */
export const FS_READ_LIMIT = 4 * 1024 * 1024;
/** Per reader run: measured 2.6 to 3.4 s on a 59.6 MB transcript, PowerShell's own start 1.2 s of it. */
export const READER_TIMEOUT_MS = 30_000;
const MAX_RUNS = 4;

/** PowerShell's -EncodedCommand: the script as UTF-16LE, in base64. */
export function encodePs(script: string): string {
  let bytes = '';
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes += String.fromCharCode(c & 0xff, c >> 8);
  }
  return btoa(bytes);
}

export type ReadResult = { window: Window; ms: number; runs: number; via: 'fs' | 'powershell' | 'sh' };

/**
 * Reads the window: the file through `$.fs.read` when it is small enough,
 * else the platform's reader through `$.process.run`, again from the line
 * reached while the reader says `more`. The path and the handles reach the
 * reader as data (environment and standard input), never as script text.
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
  const size = (await host.stat(path)).size;
  if (size <= FS_READ_LIMIT) {
    const text = await host.read(path);
    const w = parseRows(scanTranscript(text, handles, { budget: Number.MAX_SAFE_INTEGER, lineCap: READER_LINE_CAP }));
    return { window: w, ms: now() - t0, runs: 0, via: 'fs' };
  }
  const argv = powershell
    ? [powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(READER_PS)]
    : ['sh', '-c', READER_SH];
  let window: (Window & { more: boolean; last: number }) | undefined;
  let from = 0;
  let runs = 0;
  for (;;) {
    runs++;
    const r = await host.run(argv, {
      env: { FJC_PATH: path, FJC_FROM: String(from), FJC_BUDGET: String(READER_BUDGET), FJC_LINE_CAP: String(READER_LINE_CAP) },
      stdin: handles.join('\n'),
      timeoutMs: READER_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) throw new ReaderError(`the reader exited ${r.exitCode}: ${r.stderr.slice(0, 200).replace(/\s+/g, ' ')}`);
    const part = parseRows(r.stdout);
    window = window ? Object.assign(mergeWindows(window, part), { more: part.more, last: part.last }) : part;
    if (!part.more) break;
    if (runs >= MAX_RUNS || part.last < (from || part.start)) throw new ReaderError('the window is larger than the reader can return');
    from = part.last + 1;
  }
  return { window, ms: now() - t0, runs, via: powershell ? 'powershell' : 'sh' };
}

// ---------------------------------------------------------------------------
// The neighbour walk

export type Neighbour =
  /** Its chain reaches this listed handle. */
  | { at: string }
  /** It arrived before the last boundary and its chain reaches no listed message: the summary took it. */
  | { summary: true }
  /** Its chain stops at a message the listing does not hold, or at a uuid not read. */
  | { unlisted: string };

/**
 * Walks `parentUuid` from a delivery through every record that is not a
 * user or assistant message (hidden records, system records such as a Stop
 * hook's summary) to the first listed message. Stops at a message that is not
 * listed, and never climbs past one.
 */
export function neighbourOf(d: { line: number; parent: string | null }, w: Window, handles: ReadonlySet<string>): Neighbour {
  const seen = new Set<string>();
  let p = d.parent;
  while (p && !seen.has(p)) {
    seen.add(p);
    if (handles.has(p)) return { at: p };
    const rec = w.records.get(p);
    if (!rec) break;
    if (rec.message) return d.line < w.boundary ? { summary: true } : { unlisted: `a message at line ${rec.line} that the listing does not hold` };
    p = rec.parent;
  }
  return d.line < w.boundary ? { summary: true } : { unlisted: p ? 'a record the reader did not return' : 'no parent' };
}
