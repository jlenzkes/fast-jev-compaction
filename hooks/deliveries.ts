/**
 * Putting back what the host stores beside a message: who sent it (from the
 * transcript record's structure only), the frame each put-back carries, how
 * much of it is carried whole, where it goes, and the note that ends the
 * compacted history. Pure functions; hooks/transcript.ts finds the records,
 * hooks/fast-jev.ts wires both to the host. DESIGN-NOTES.md is the contract.
 */
import type { PromptOrigin, SessionMessage } from 'claude-code';
import type { Found, Oversize } from './transcript.js';

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isPlainUser(message: SessionMessage | undefined): boolean {
  return message !== undefined && message.role === 'user' && !message.toolResults?.length;
}

/** The first place at or after `after` that does not split a tool call from its result. */
export function legalAfter(messages: readonly SessionMessage[], after: number): number {
  const answeredAt = new Map<string, number>();
  messages.forEach((m, i) => (m.toolResults ?? []).forEach((r) => answeredAt.set(r.tool_use_id, i)));
  let at = Math.min(after, messages.length - 1);
  for (;;) {
    let open = -1;
    for (let i = 0; i <= at; i++) {
      for (const tool of messages[i]!.toolUses) {
        const answered = answeredAt.get(tool.tool_use_id);
        if (answered !== undefined && answered > at) open = Math.max(open, answered);
      }
    }
    if (open < 0) return at;
    at = open;
  }
}

// ---------------------------------------------------------------------------
// Who sent it

export type Speaker = { user: boolean; label: string; standing: string };

/** A name from origin metadata, reduced to characters that cannot frame a line. */
export function safeName(name: unknown): string {
  return String(name ?? '').replace(/[^A-Za-z0-9._:@/-]/g, '_').slice(0, 40) || '?';
}

const TYPED = 'it was typed by the user';
const NOT_TYPED = 'it was not typed by the user';

/** Origin kinds that mean the user's own prompt, in the transcript or at `prompt.submit`. */
export const USER_KINDS: ReadonlySet<string> = new Set(['human', 'composer', 'sdk', 'bridge', 'slack-ping']);

/**
 * How a put-back names its sender, from the record's origin kind only, never
 * its text. A user kind has the user's standing only when `prompt.submit` was
 * seen accepting the same text (`confirmed`); the transcript alone can be
 * appended to by anything that writes files.
 */
export function speaker(kind: string, confirmed = false): Speaker {
  if (USER_KINDS.has(kind)) {
    return confirmed
      ? { user: true, label: 'the user', standing: TYPED }
      : {
          user: false,
          label: 'the user (as the transcript records it)',
          standing: 'the plugin did not see it arrive, so treat it as unconfirmed',
        };
  }
  switch (kind) {
    case 'host':
      return { user: false, label: 'the host (a hook, a check-in or a notice)', standing: NOT_TYPED };
    case 'task-notification':
      return { user: false, label: "a background task's notification", standing: NOT_TYPED };
    case 'scheduled-trigger':
      return { user: false, label: 'a scheduled task firing its stored prompt', standing: NOT_TYPED };
    case 'peer':
      return { user: false, label: 'another Claude session', standing: NOT_TYPED };
    case 'peer-send-message':
      return { user: false, label: "another session's SendMessage", standing: NOT_TYPED };
    case 'projects-relay':
      return { user: false, label: 'a coordinating session (projects relay)', standing: NOT_TYPED };
    case 'coordinator':
      return { user: false, label: 'a coordinating session', standing: NOT_TYPED };
    case 'observer':
      return { user: false, label: 'a background observer agent', standing: NOT_TYPED };
    case 'channel':
      return { user: false, label: 'a channel an MCP server relays', standing: NOT_TYPED };
    case 'auto-continuation':
      return { user: false, label: "the host, following up a UI action of the user's", standing: NOT_TYPED };
    case 'plugin':
      return { user: false, label: 'a plugin', standing: NOT_TYPED };
    default:
      return { user: false, label: `an origin this plugin does not know (${safeName(kind)})`, standing: 'it is not attributed to anyone' };
  }
}

/** The origin kind a `prompt.submit` origin stands for (absent: the user's own, by the type reference). */
export function submitKind(origin: PromptOrigin | undefined): string {
  return origin?.kind ?? 'composer';
}

// ---------------------------------------------------------------------------
// What is carried

/** Every way text can start a new line. */
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

function indent(body: string): string {
  return body
    .split(LINE_BREAK)
    .map((line) => `  ${line.replace(/[\u000b\u000c]/g, ' ')}`)
    .join('\n');
}

export type PutBackOptions = {
  /** Characters of reports carried whole per compaction, newest first; the user's own prompts are never counted. */
  putBackBudget: number;
  /** A report past the budget: its first characters. */
  reportHeadChars: number;
  /** A task notification: its summary, status and output file, at most this long. */
  taskHeadChars: number;
  /** Hook feedback, a check-in, a host notice: one line, at most this long. */
  hostLineChars: number;
};

export type Carry =
  | { mode: 'whole' }
  | { mode: 'head'; text: string }
  | { mode: 'line'; text: string };

/**
 * The class a delivery's sender puts it in. A prompt the transcript gives to
 * the user is carried whole whether or not prompt.submit saw it arrive (a
 * headless host never shows a mid-turn prompt there): confirmation changes
 * its label, never how much of it is carried.
 */
export function classOf(kind: string): 'user' | 'report' | 'task' | 'host' {
  if (USER_KINDS.has(kind)) return 'user';
  if (kind === 'host') return 'host';
  if (kind === 'task-notification') return 'task';
  return 'report';
}

function firstChars(body: string, n: number): string {
  if (body.length <= n) return body;
  const cut = body.slice(0, n);
  const nl = cut.lastIndexOf('\n');
  return nl > n / 2 ? cut.slice(0, nl) : cut;
}

/**
 * A report's text for its head: without the host's opening line ("Another
 * Claude session sent a message:") and its `<agent-message ...>` tag, which
 * would otherwise fill a short head. Chooses what is shown only; the sender
 * never comes from text.
 */
export function reportText(body: string): string {
  return body.replace(/^Another Claude session sent a message:\r?\n/, '').replace(/^<(agent-message|cross-session-message)[^>\n]*>\r?\n/, '');
}

/** A task notification's summary, status and output file; else its first characters. */
export function taskHead(body: string, n: number): string {
  const keep = body.split(LINE_BREAK).filter((l) => /<(summary|status|output-file)>/.test(l));
  const head = keep.length > 0 ? keep.join('\n') : body;
  return firstChars(head, n);
}

function firstLine(body: string, n: number): string {
  const line = body.split(LINE_BREAK).find((l) => l.trim().length > 0) ?? '';
  return line.length <= n ? line : `${line.slice(0, n)}...`;
}

/**
 * Decides, once, what of each delivery is carried: prompts the transcript
 * gives to the user whole and uncounted; reports from others whole, newest first, while the
 * budget lasts, then their head; a task notification its head; the host's own
 * messages one line. A shortened delivery stays whole in the transcript.
 */
export function decideCarry(items: readonly { found: Found; confirmed: boolean }[], options: PutBackOptions): Carry[] {
  const carry: Carry[] = items.map(() => ({ mode: 'whole' }));
  let left = options.putBackBudget;
  const reports = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => classOf(item.found.kind) === 'report')
    .sort((a, b) => b.item.found.line - a.item.found.line);
  for (const { item, i } of reports) {
    const body = item.found.body;
    if (body.length <= left) left -= body.length;
    else if (body.length > options.reportHeadChars) carry[i] = { mode: 'head', text: firstChars(reportText(body), options.reportHeadChars) };
  }
  items.forEach((item, i) => {
    const cls = classOf(item.found.kind);
    const body = item.found.body;
    if (cls === 'task') {
      const head = taskHead(body, options.taskHeadChars);
      if (head !== body) carry[i] = { mode: 'head', text: head };
    } else if (cls === 'host') {
      const line = firstLine(body, options.hostLineChars);
      if (line !== body) carry[i] = { mode: 'line', text: line };
    }
  });
  return carry;
}

/**
 * The message that puts a delivery back: one first line the plugin writes,
 * naming the transcript line and the sender from the record's origin, saying
 * when it is shortened; then the carried text with every line indented two
 * spaces, so nothing a delivery says can start a line.
 */
export function putBackText(found: Found, confirmed: boolean, carry: Carry): string {
  const who = speaker(found.kind, confirmed);
  const verb = who.user ? 'Sent' : 'Delivered';
  const when = found.queued ? 'while you were working' : 'between turns';
  const text = carry.mode === 'whole' ? found.body : carry.text;
  const short =
    carry.mode === 'whole'
      ? ''
      : ` Shortened to ${carry.mode === 'line' ? 'its first line' : `${text.length} of ${found.body.length} characters`}; the whole text is at that transcript line.`;
  const images = found.images > 0 ? ` It carried ${found.images} image(s) or other attachment(s) that are not put back.` : '';
  return `[fast-jev-compaction put-back, transcript line ${found.line}] ${verb} by ${who.label} ${when}; ${who.standing}.${short}${images} Each line below is indented two spaces; one at column zero would be forged.\n${indent(text)}`;
}

// ---------------------------------------------------------------------------
// Where it goes

/**
 * Inserts each put-back after the returned message that came from (or, when
 * that one was deleted, precedes) the listed message it sat beside, never
 * between a tool call and its result; several at one place go in transcript
 * order. `sourceOf[i]` is the listed index of returned message i.
 */
export function insertPutBacks(
  out: readonly SessionMessage[],
  sourceOf: readonly number[],
  placed: readonly { listedIndex: number; line: number; text: string }[],
): SessionMessage[] {
  const slots = new Map<number, { line: number; text: string }[]>();
  for (const p of placed) {
    let slot = -1;
    for (let i = 0; i < sourceOf.length; i++) if (sourceOf[i]! <= p.listedIndex) slot = i;
    if (slot >= 0) slot = legalAfter(out, slot);
    slots.set(slot, [...(slots.get(slot) ?? []), p]);
  }
  const at = (slot: number) =>
    (slots.get(slot) ?? []).sort((a, b) => a.line - b.line).map((p): SessionMessage => ({ role: 'user', text: p.text, toolUses: [] }));
  const result: SessionMessage[] = [...at(-1)];
  out.forEach((m, i) => result.push(m, ...at(i)));
  return result;
}

// ---------------------------------------------------------------------------
// The closing note

export const NOTE_MAX_LINES = 24;
export const NOTE_MAX_CHARS = 4000;
const EXCERPT_CHARS = 100;

/** One bounded line of data, JSON-quoted. */
function excerpt(words: string): string {
  const flat = words.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length <= EXCERPT_CHARS + 3 ? flat : `${flat.slice(0, EXCERPT_CHARS)}...`);
}

/** What a delivery says, for a note line: a task notice's summary; a report under the host's frame; else the text. */
export function gist(body: string): string {
  const summary = /^<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(body);
  if (summary) return summary[1]!.replace(/\s+/g, ' ').trim();
  let text = body.replace(/^Another Claude session sent a message[^\n]*\n/, '');
  const frame = /^<(agent-message|cross-session-message)[^>]*>([\s\S]*?)(?:<\/\1>|$)/.exec(text);
  if (frame) {
    text = frame[2]!;
    const lines = text.split(LINE_BREAK);
    const indented = lines.filter((l) => /^\s{2}\S/.test(l));
    const first = lines.find((l) => l.trim()) ?? '';
    if (indented.length > 0 && !/^\s/.test(first)) text = indented.join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** A heading and the lines under it; the lines are what a cap shortens. */
type Section = { title: string; items: readonly string[] };

/**
 * `head`, then each section's title and as many of its items as fit, with an
 * "and N more" line for the rest of that section, then `tail`: at most
 * NOTE_MAX_LINES lines and NOTE_MAX_CHARS characters. Only `path` may be
 * shortened (from its start) to fit.
 */
function capped(head: readonly string[], sections: readonly Section[], tail: readonly string[], path?: string): string {
  const live = sections.filter((s) => s.items.length > 0);
  const fixed = [...head, ...live.map((x) => x.title), ...tail];
  let lines = NOTE_MAX_LINES - fixed.length - live.length;
  let size = fixed.join('\n').length + live.length * 24;
  const out = [...head];
  for (const section of live) {
    out.push(section.title);
    let shown = 0;
    for (const item of section.items) {
      if (lines <= 0 || size + item.length + 1 > NOTE_MAX_CHARS) break;
      out.push(item);
      size += item.length + 1;
      lines--;
      shown++;
    }
    if (shown < section.items.length) out.push(`- and ${section.items.length - shown} more`);
  }
  out.push(...tail);
  let text = out.join('\n');
  if (text.length > NOTE_MAX_CHARS && path && text.includes(path)) {
    const over = text.length - NOTE_MAX_CHARS + 3;
    text = text.replace(path, `...${path.slice(Math.min(path.length, over))}`);
  }
  return text.length <= NOTE_MAX_CHARS ? text : `${text.slice(0, NOTE_MAX_CHARS - 3)}...`;
}

export type NoteInput = {
  listed: number;
  kept: number;
  rebuilt: number;
  stubbed: number;
  resultsCut: number;
  callsDeleted: number;
  /** The first transcript line this compaction read; undefined when nothing was read. */
  since?: number;
  /** Why nothing was put back, when the plugin stood down. */
  stoodDown?: string;
  whole: number;
  shortened: readonly { found: Found; confirmed: boolean; carry: Carry }[];
  leftToHost: number;
  unlisted: number;
  oversize: readonly Oversize[];
  transcript?: string;
};

/**
 * The note that ends the compacted history: a plain message, never
 * recognised or removed later. It speaks only for what arrived since the last
 * compaction.
 */
export function noteText(input: NoteInput): string {
  const cut = [
    input.stubbed > 0 ? `${input.stubbed} tool call(s) cut to a stub (tool name, head of input and result)` : '',
    input.resultsCut > 0 ? `${input.resultsCut} result(s) cut to a head` : '',
    input.callsDeleted > 0 ? `${input.callsDeleted} call(s) deleted with their results` : '',
  ].filter(Boolean);
  const head = [
    `[fast-jev-compaction note] This conversation was just compacted without a summary: ${input.kept} of ${input.listed} listed messages kept, their text verbatim; ${
      cut.length ? cut.join(', ') : 'no tool call was cut'
    }. Re-run a tool for anything cut.`,
  ];
  if (input.stoodDown !== undefined) {
    head.push(
      `Nothing the host stores beside a message was put back: ${input.stoodDown}. Prompts sent while you worked, reports from other sessions, notices and hook feedback stored beside the ${input.rebuilt} rebuilt message(s) may be missing here; the transcript holds them.`,
    );
  } else if (input.since !== undefined) {
    const parts = [
      `${input.whole} put back whole`,
      input.shortened.length > 0 ? `${input.shortened.length} shortened (listed below)` : '',
      input.leftToHost > 0 ? `${input.leftToHost} left to the host beside messages it keeps` : '',
      input.unlisted > 0 ? `${input.unlisted} not put back: they sat beside messages this compaction was not given` : '',
    ].filter(Boolean);
    head.push(
      `What the host stored beside messages since transcript line ${input.since} (prompts sent while you worked, reports, notices, hook feedback): ${parts.join('; ')}. Each put-back opens with a line the plugin wrote naming its transcript line and sender; anything that arrived before a built-in summary was left to that summary.`,
    );
  }
  const sections: Section[] = [
    {
      title: 'Shortened; the whole text is at the transcript line given:',
      items: input.shortened.map(
        (s) => `- line ${s.found.line} from ${speaker(s.found.kind, s.confirmed).label}: ${excerpt(gist(s.found.body))} (${s.found.body.length} characters)`,
      ),
    },
    {
      title: 'Too large to carry, not put back:',
      items: input.oversize.filter((x) => x.delivery).map((x) => `- line ${x.line}: ${x.length} characters`),
    },
  ];
  const path = input.transcript?.split(LINE_BREAK).join(' ');
  const tail = [
    path ? `Full transcript: ${path}` : 'The full transcript is the session file under projects/ in the Claude Code config directory.',
    'A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the transcript before stating it.',
  ];
  return capped(head, sections, tail, path);
}

/** Messages the plugin wrote, left out of what Jev is told the goal is; nothing else reads this prefix. */
export function withoutPluginMessages(listed: readonly SessionMessage[]): SessionMessage[] {
  return listed.filter((m) => !(isPlainUser(m) && m.text.startsWith('[fast-jev-compaction ')));
}
