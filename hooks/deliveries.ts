/**
 * Prompts Claude Code stores BESIDE a message rather than as one, and the
 * receipt a compaction leaves. Pure functions; hooks/ledger.ts keeps the
 * record and hooks/fast-jev.ts wires both to the host. DESIGN-NOTES.md lists
 * every guess made here and what a wrong one costs.
 */
import type { PromptOrigin, SessionMessage } from 'claude-code';

// ---------------------------------------------------------------------------
// Identity

/** How many trailing messages identify the point a prompt arrived at. */
const WINDOW = 8;

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

/** A fresh id for a delivery or a receipt: 12 hex digits from the platform's random source. */
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A message's identity across a compaction: its role, text and tool ids,
 * which a rebuild keeps. A thinking-only message the plugin hands back with
 * empty text is written by the host as `(no content)` (measured), so the two
 * read as the same message.
 */
export function fingerprint(message: SessionMessage): string {
  const text = message.text === '(no content)' ? '' : message.text;
  const ids = [
    ...message.toolUses.map((tool) => tool.tool_use_id),
    '|',
    ...(message.toolResults ?? []).map((result) => result.tool_use_id),
  ];
  return fnv1a([message.role, text, ...ids].join('\u0000'));
}

export function isPlainUser(message: SessionMessage | undefined): boolean {
  return message !== undefined && message.role === 'user' && !message.toolResults?.length;
}

// ---------------------------------------------------------------------------
// Where a prompt arrived

/**
 * The point a prompt arrived at: fingerprints of the newest messages then,
 * oldest first, and the last tool result with how many messages followed it.
 * `skip` are indices of the plugin's own receipts, which the next compaction
 * takes out; what arrived after one arrived after the message before it.
 */
export type Anchor = { after?: string; past: number; window: string[]; beside?: 'receipt' };

export function anchorOf(messages: readonly SessionMessage[], skip: ReadonlySet<number> = new Set()): Anchor {
  const kept = skip.size ? messages.filter((_, i) => !skip.has(i)) : messages;
  // The message it arrived beside is a receipt the next compaction takes out,
  // and what the host stored beside the receipt goes with it.
  const beside = skip.has(messages.length - 1) ? { beside: 'receipt' as const } : {};
  const window = kept.slice(-WINDOW).map(fingerprint);
  for (let i = kept.length - 1; i >= 0; i--) {
    const results = kept[i]!.toolResults;
    if (results?.length) return { after: results[results.length - 1]!.tool_use_id, past: kept.length - 1 - i, window, ...beside };
  }
  return { past: kept.length, window, ...beside };
}

/** The index of the message that was newest at `anchor`: -1 for none then, undefined when it is gone. */
export function locate(messages: readonly SessionMessage[], anchor: Anchor): number | undefined {
  const { window } = anchor;
  if (window.length === 0) return -1;
  const last = window.length - 1;
  const matches = (i: number): boolean =>
    i - last >= 0 && window.every((fp, k) => fingerprint(messages[i - last + k]!) === fp);
  if (anchor.after !== undefined) {
    const t = messages.findIndex((m) => m.toolResults?.some((r) => r.tool_use_id === anchor.after));
    if (t >= 0 && t + anchor.past < messages.length && matches(t + anchor.past)) return t + anchor.past;
  }
  for (let i = messages.length - 1; i >= 0; i--) if (matches(i)) return i;
  return undefined;
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

/**
 * How a put-back names its sender, from the origin `prompt.submit` ACCEPTED
 * (what `next` returned; absent means the user's own, by the type reference),
 * never from the prompt's text. `user` gives the prompt the standing the host
 * gives the user's own words; the plugin cannot attest more than the host does.
 */
export type Speaker = { user: boolean; label: string; standing: string };

/** A name from origin metadata, reduced to characters that cannot frame a line. */
export function safeName(name: unknown): string {
  return String(name ?? '').replace(/[^A-Za-z0-9._:@/-]/g, '_').slice(0, 40) || '?';
}

const TYPED = 'it was typed by the user';
const NOT_TYPED = 'it was not typed by the user';

export function speaker(origin: PromptOrigin | undefined): Speaker {
  switch (origin?.kind) {
    // The type reference: an absent accepted origin means the prompt entered as the user's own.
    case undefined:
    // The user's own Enter at the terminal, typed or queued (a waiting prompt too).
    case 'composer':
      return { user: true, label: 'the user', standing: TYPED };
    case 'bridge':
      return { user: true, label: 'the user through Remote Control', standing: TYPED };
    // The reference names it the session owner pinging the session from Slack.
    case 'slack-ping':
      return { user: true, label: 'the user (the session owner) from Slack', standing: 'it was sent by the user' };
    // The SDK host's own turn (VS Code, the desktop app, `claude -p`). The host
    // renders such a prompt mid-turn as "The user sent a new message while you
    // were working" and lists an idle one as a plain user message (measured in
    // headless probes), so it stands as the user's, as the host gives it.
    case 'sdk':
      return {
        user: true,
        label: 'the user through the SDK host running this session',
        standing: "the host gives it the standing of the user's own message",
      };
    // Background work reporting back: text a task or the engine produced.
    case 'task-notification':
      return { user: false, label: "a background task's notification", standing: NOT_TYPED };
    // A routine or /loop: the user wrote the prompt once, but nobody typed it now.
    case 'scheduled-trigger':
      return { user: false, label: 'a scheduled task firing its stored prompt', standing: NOT_TYPED };
    // Model-authored messages from other sessions and agents.
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
    case 'observer-activity':
      return { user: false, label: 'an activity digest for an observer', standing: NOT_TYPED };
    // A channel an MCP server relays (Slack, Telegram): third parties may write there.
    case 'channel':
      return { user: false, label: `the channel server ${safeName(origin.server)}`, standing: NOT_TYPED };
    // User-initiated in the UI, but the host wrote it; not typed this turn.
    case 'auto-continuation':
      return { user: false, label: "the host, following up a UI action of the user's", standing: NOT_TYPED };
    case 'unclassified':
      return { user: false, label: 'a source the host could not classify', standing: 'it is not attributed to anyone' };
    case 'plugin':
      return { user: false, label: `the plugin ${safeName(origin.name)}`, standing: NOT_TYPED };
    default:
      return {
        user: false,
        label: `an origin this plugin does not know (${safeName((origin as { kind?: unknown }).kind)})`,
        standing: 'it is not attributed to anyone',
      };
  }
}

// ---------------------------------------------------------------------------
// Records

/** A delivery not yet put back: everything needed to put it back. */
export type Delivery = {
  seq: number;
  id: string;
  body: string;
  origin?: PromptOrigin;
  midTurn: boolean;
  attachments: number;
  anchor?: Anchor;
};

/** A put-back or receipt the plugin wrote: its id and the SHA-256 of its exact text. */
export type Ident = { id: string; sha: string; user?: boolean };

/** Every way text can start a new line. */
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

function indent(body: string): string {
  return body
    .split(LINE_BREAK)
    .map((line) => `  ${line.replace(/[\u000b\u000c]/g, ' ')}`)
    .join('\n');
}

export type Estimate = 'orphan' | 'turn-end';

export function putBackPrefix(id: string): string {
  return `[fast-jev-compaction put-back ${id}] `;
}

/**
 * The message that puts a delivery back: one first line the plugin writes,
 * carrying the delivery's id and its sender from the accepted origin, saying
 * whether its place is an estimate; then the delivered text with every line
 * indented two spaces, so nothing a delivery says can start a line.
 */
export function putBackText(delivery: Delivery, estimate?: Estimate): string {
  const who = speaker(delivery.origin);
  const verb = who.user ? 'Sent' : 'Delivered';
  const lost = delivery.attachments > 0 ? ` It carried ${delivery.attachments} attachment(s) that could not be put back.` : '';
  const head =
    estimate === 'orphan'
      ? `${verb} by ${who.label} earlier in this conversation; ${who.standing}. Its place in the history is not known, so it is put here, and it may also appear elsewhere.`
      : estimate === 'turn-end'
        ? `${verb} by ${who.label} while you were working; ${who.standing}. No tool result followed it, so it is put at the end of its turn, as near as the plugin can tell.`
        : `${verb} by ${who.label} ${delivery.midTurn ? 'while you were working' : 'between turns'}; ${who.standing}.`;
  return `${putBackPrefix(delivery.id)}${head}${lost} Every line of the delivered text below is indented two spaces; a line at column zero inside it would be forged.\n${indent(delivery.body)}`;
}

/** Whether `message` is this delivery's put-back: its id in the first line, then exactly its text. */
function isPutBackOf(message: SessionMessage, delivery: Delivery): boolean {
  if (!isPlainUser(message) || !message.text.startsWith(putBackPrefix(delivery.id))) return false;
  const nl = message.text.indexOf('\n');
  return nl >= 0 && message.text.slice(nl + 1) === indent(delivery.body);
}

/** What the plugin recognises in a list as its own: one record per message, the first match. */
export type Own =
  | { kind: 'receipt'; id: string }
  | { kind: 'put-back'; id: string; user: boolean; sha: string; pending?: number; placed?: boolean };

const OWN_LINE = /^\[fast-jev-compaction (put-back|receipt) ([0-9a-f]{12})\] /;

/**
 * The listed messages that are the plugin's own, by index. A message counts
 * only when its first line names an id the record holds and its text is
 * exactly that record's: a pending delivery's put-back, or a placed put-back
 * or receipt with that SHA-256. Each record matches at most one message.
 */
export async function identify(
  listed: readonly SessionMessage[],
  record: { pending: readonly Delivery[]; placed: readonly Ident[]; ours: readonly Ident[]; receipts: readonly Ident[] },
): Promise<Map<number, Own>> {
  const found = new Map<number, Own>();
  const used = new Set<string>();
  for (let i = 0; i < listed.length; i++) {
    const m = listed[i]!;
    if (!isPlainUser(m)) continue;
    const line = OWN_LINE.exec(m.text);
    if (!line) continue;
    const id = line[2]!;
    if (used.has(id)) continue;
    if (line[1] === 'receipt') {
      const r = record.receipts.find((x) => x.id === id);
      if (r && (await sha256(m.text)) === r.sha) {
        found.set(i, { kind: 'receipt', id });
        used.add(id);
      }
      continue;
    }
    const pending = record.pending.find((d) => d.id === id);
    if (pending && isPutBackOf(m, pending)) {
      found.set(i, { kind: 'put-back', id, user: speaker(pending.origin).user, sha: await sha256(m.text), pending: pending.seq });
      used.add(id);
      continue;
    }
    const known = [...record.placed.map((x) => ({ x, placed: true })), ...record.ours.map((x) => ({ x, placed: false }))].find(
      (k) => k.x.id === id,
    );
    if (known && (await sha256(m.text)) === known.x.sha) {
      found.set(i, { kind: 'put-back', id, user: known.x.user === true, sha: known.x.sha, placed: known.placed });
      used.add(id);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// What a compaction does with each pending delivery

export type Outcome =
  /** The listing shows its put-back. */
  | { kind: 'seen' }
  /** The listing shows the delivery itself, exactly. */
  | { kind: 'listed' }
  /** It sits beside a plain user message, which the plugin hands back whole: the host keeps it. */
  | { kind: 'kept-by-host' }
  /** Mid-turn, and no tool result has followed yet: still queued. */
  | { kind: 'waiting' }
  /** Put back after listed message `after` (-1: first). */
  | { kind: 'placed'; after: number; text: string; estimate?: Estimate };

/**
 * Decides each pending delivery against a listing. Present only on exact
 * evidence: its own put-back (`identify`), or a listed plain user message
 * whose whole text equals the delivered text, after its point and before the
 * next tool result, each such message standing for at most one delivery. A
 * delivery beside a plain user message is the host's to keep. Otherwise it is
 * put back: after its point (idle), after the tool round it came with
 * (mid-turn), at the end of its turn when no tool result followed, or, when
 * its point is gone, in delivery order among the others, labelled.
 */
export function plan(listed: readonly SessionMessage[], pending: readonly Delivery[], own: ReadonlyMap<number, Own>): Outcome[] {
  const outcomes: Outcome[] = pending.map(() => ({ kind: 'waiting' }));
  const consumed = new Set<number>(own.keys());
  const seenSeq = new Set([...own.values()].flatMap((o) => (o.kind === 'put-back' && o.pending !== undefined ? [o.pending] : [])));
  const orphans: number[] = [];
  const order = pending.map((_, n) => n).sort((a, b) => pending[a]!.seq - pending[b]!.seq);
  for (const n of order) {
    const d = pending[n]!;
    if (seenSeq.has(d.seq)) {
      outcomes[n] = { kind: 'seen' };
      continue;
    }
    const at = d.anchor ? locate(listed, d.anchor) : undefined;
    if (at === undefined) {
      orphans.push(n);
      continue;
    }
    let next = at + 1;
    let turnEnd = -1;
    let listedAt = -1;
    while (next < listed.length && !listed[next]!.toolResults?.length) {
      const m = listed[next]!;
      if (isPlainUser(m) && !consumed.has(next)) {
        if (listedAt < 0 && m.text === d.body && d.body.length > 0) listedAt = next;
        if (turnEnd < 0 && !own.has(next)) turnEnd = next;
      }
      next++;
    }
    if (listedAt >= 0) {
      consumed.add(listedAt);
      outcomes[n] = { kind: 'listed' };
      continue;
    }
    if (d.midTurn) {
      if (listed[at]?.toolResults?.length) {
        outcomes[n] = { kind: 'placed', after: legalAfter(listed, at), text: putBackText(d) };
      } else if (turnEnd >= 0) {
        outcomes[n] = { kind: 'placed', after: legalAfter(listed, turnEnd - 1), text: putBackText(d, 'turn-end'), estimate: 'turn-end' };
      } else if (next < listed.length) {
        outcomes[n] = { kind: 'placed', after: legalAfter(listed, next), text: putBackText(d) };
      }
      continue;
    }
    // Measured: a delivery beside a plain user message survives when that
    // message is handed back whole (159 of 159, DESIGN-NOTES.md).
    if (at >= 0 && isPlainUser(listed[at]) && d.anchor?.beside !== 'receipt') {
      outcomes[n] = { kind: 'kept-by-host' };
      continue;
    }
    outcomes[n] = { kind: 'placed', after: legalAfter(listed, at), text: putBackText(d) };
  }
  for (const n of orphans) {
    const seq = pending[n]!.seq;
    const placed = pending
      .map((d, i) => ({ seq: d.seq, o: outcomes[i]! }))
      .filter((x): x is { seq: number; o: Extract<Outcome, { kind: 'placed' }> } => x.o.kind === 'placed');
    const earlier = placed.filter((x) => x.seq < seq);
    const later = placed.filter((x) => x.seq > seq);
    let after = listed.length - 1;
    if (earlier.length) after = Math.max(...earlier.map((x) => x.o.after));
    else if (later.length) after = Math.min(...later.map((x) => x.o.after)) - 1;
    if (after >= 0) after = legalAfter(listed, after);
    outcomes[n] = { kind: 'placed', after, text: putBackText(pending[n]!, 'orphan'), estimate: 'orphan' };
  }
  return outcomes;
}

/**
 * `messages` with the placed deliveries inserted. `sourceOf[i]` is the listed
 * index output message `i` came from; one placed after a deleted message goes
 * after the nearest surviving one before it. Deliveries at one place keep
 * delivery order.
 */
export function insertPlaced(
  messages: readonly SessionMessage[],
  sourceOf: readonly number[],
  pending: readonly Delivery[],
  outcomes: readonly Outcome[],
): SessionMessage[] {
  const slots = new Map<number, { seq: number; message: SessionMessage }[]>();
  outcomes.forEach((o, n) => {
    if (o.kind !== 'placed') return;
    let slot = -1;
    for (let i = 0; i < sourceOf.length; i++) if (sourceOf[i]! <= o.after) slot = i;
    const list = slots.get(slot) ?? [];
    list.push({ seq: pending[n]!.seq, message: { role: 'user', text: o.text, toolUses: [] } });
    slots.set(slot, list);
  });
  const sorted = (slot: number) => (slots.get(slot) ?? []).sort((a, b) => a.seq - b.seq).map((x) => x.message);
  return [...sorted(-1), ...messages.flatMap((m, i) => [m, ...sorted(i)])];
}

/** The listed messages, the plugin's own receipts taken out. */
export function withoutReceipts(listed: readonly SessionMessage[], own: ReadonlyMap<number, Own>): SessionMessage[] {
  return listed.filter((_, i) => own.get(i)?.kind !== 'receipt');
}

/**
 * The messages the library's default goal is taken from, when the history
 * holds a message the plugin wrote: its put-backs of others' words left out,
 * a put-back of the user's own words read as those words. Nothing else is
 * inferred about who wrote what.
 */
export function goalMessages(listed: readonly SessionMessage[], own: ReadonlyMap<number, Own>): SessionMessage[] {
  const out: SessionMessage[] = [];
  listed.forEach((m, i) => {
    const o = own.get(i);
    if (!o) out.push(m);
    else if (o.kind === 'put-back' && o.user) {
      const lines = m.text.split('\n').slice(1).map((l) => l.replace(/^ {2}/, ''));
      out.push({ ...m, text: lines.join('\n') });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The receipt

export const RECEIPT_MAX_LINES = 20;
export const RECEIPT_MAX_CHARS = 4000;
const EXCERPT_CHARS = 100;

/** One bounded line of data: control characters and line breaks gone, JSON-quoted. */
function excerpt(words: string): string {
  const flat = words.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}...`);
}

/** What a delivery says, for its receipt line: a task notice's summary; a report under the host's frame; else the text. */
function gist(body: string): string {
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

export type ReceiptInput = {
  id: string;
  listed: number;
  kept: number;
  rebuilt: number;
  deleted: number;
  stubbed: number;
  resultsCut: number;
  callsDeleted: number;
  restored: readonly { delivery: Delivery; estimate?: Estimate }[];
  /** Pending deliveries dropped at the record's bound, or with an evicted session. */
  dropped: number;
  /** Stored records that could not be read and were ignored. */
  unreadable: number;
  /** Put-backs of an earlier compaction that the history no longer shows. */
  missing: number;
  durable: boolean;
  transcript?: string;
};

/**
 * The receipt: a plain user message ending the compacted history. Every line
 * is the plugin's own; a delivery appears only as one quoted, bounded excerpt
 * with its id and its sender from the origin. At most RECEIPT_MAX_LINES lines
 * and RECEIPT_MAX_CHARS characters in all.
 */
export function receipt(input: ReceiptInput): string {
  const cut = [
    input.stubbed > 0 ? `${input.stubbed} tool call(s) cut to a stub (tool name, head of input and result)` : '',
    input.resultsCut > 0 ? `${input.resultsCut} result(s) cut to a head` : '',
    input.callsDeleted > 0 ? `${input.callsDeleted} call(s) deleted with their results` : '',
  ].filter(Boolean);
  const head = [
    `[fast-jev-compaction receipt ${input.id}] This conversation was just compacted without a summary: ${input.kept} of ${input.listed} listed messages kept, their text verbatim; ${
      cut.length ? cut.join(', ') : 'no tool call was cut'
    }. Re-run a tool for anything cut.`,
  ];
  if (input.rebuilt + input.deleted > 0) {
    head.push(
      `Not carried: ${input.rebuilt} message(s) were rebuilt and ${input.deleted} deleted, and whatever the host had stored beside them and never shows a plugin (Stop hook feedback, goal check-ins, notices) is gone${
        input.restored.length ? ', except the delivered prompts put back below' : ''
      }.`,
    );
  }
  if (input.dropped > 0) {
    head.push(`${input.dropped} delivered prompt(s) were dropped from the plugin's record to keep it within its bounds and could not be put back.`);
  }
  if (input.unreadable > 0) head.push(`${input.unreadable} stored record(s) could not be read and were ignored.`);
  if (input.missing > 0) {
    head.push(`${input.missing} put-back(s) from the previous compaction are not in the history; their text is no longer held.`);
  }
  if (!input.durable) {
    head.push('The plugin could not keep its record of delivered prompts on disk, so prompts delivered before a plugin reload may be missing.');
  }
  const path = input.transcript?.split(LINE_BREAK).join(' ');
  const tail = [
    path ? `Full transcript: ${path}` : 'The full transcript is the session file under projects/ in the Claude Code config directory.',
    'A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the transcript before stating it.',
  ];
  const items: string[] = [];
  if (input.restored.length > 0) {
    head.push(
      `Put back as messages of their own (${input.restored.length}), each after the tool round it arrived in, as near as the plugin can tell. Each opens with a line "[fast-jev-compaction put-back <id>] ..." the plugin wrote, and every line of the delivered text under it is indented two spaces:`,
    );
    for (const { delivery: d, estimate } of input.restored) {
      const more = d.attachments > 0 ? ` (+${d.attachments} attachment(s) not carried)` : '';
      const guess =
        estimate === 'orphan'
          ? ' (placed by estimate: its place was not found)'
          : estimate === 'turn-end'
            ? ' (placed by estimate: its turn ended before a tool result came)'
            : '';
      items.push(`- ${d.id} from ${speaker(d.origin).label}${more}${guess}: ${excerpt(gist(d.body))}`);
    }
  }
  const lines = [...head];
  let size = [...head, ...tail].join('\n').length;
  const room = RECEIPT_MAX_LINES - head.length - tail.length - 1;
  let shown = 0;
  for (const item of items) {
    if (shown >= room || size + item.length + 40 > RECEIPT_MAX_CHARS) break;
    lines.push(item);
    size += item.length + 1;
    shown++;
  }
  if (shown < items.length) lines.push(`- and ${items.length - shown} more`);
  lines.push(...tail);
  let text = lines.join('\n');
  if (text.length > RECEIPT_MAX_CHARS && path) {
    // Only the path can make the fixed lines too long: keep its end.
    const over = text.length - RECEIPT_MAX_CHARS + 3;
    const short = `...${path.slice(Math.min(path.length, over))}`;
    text = text.replace(`Full transcript: ${path}`, `Full transcript: ${short}`);
  }
  return text.length <= RECEIPT_MAX_CHARS ? text : `${text.slice(0, RECEIPT_MAX_CHARS - 3)}...`;
}
