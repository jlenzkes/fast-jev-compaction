/**
 * Prompts Claude Code stores BESIDE a message rather than as one, and the
 * receipt a compaction leaves.
 *
 * A prompt typed while a turn runs, a subagent's report that starts a turn of
 * its own, a background task's notice: the engine keeps each next to the
 * message before it. `session.compact` never lists them, and they survive a
 * compaction only when that message goes back with its handle, which only a
 * plain user message does (see `keepsHandle` in fast-jev.ts). This module
 * records each such prompt when `prompt.submit` sees it, works out where it
 * belongs in a compaction's list, builds the message that puts it back, and
 * writes the receipt. It holds no state; fast-jev.ts keeps the ledger.
 */
import type { PromptOrigin, SessionMessage } from 'claude-code';

// ---------------------------------------------------------------------------
// Where a prompt arrived

/** How many trailing messages identify the point a prompt arrived at. */
const WINDOW = 8;

/**
 * A message's identity across a compaction: its role, text and tool ids,
 * which a rebuild keeps (inputs and outputs it may cut). A thinking-only
 * message the plugin hands back with empty text is written by the host as the
 * text `(no content)` (180 such records after one compaction on 14 Nov 2026),
 * so the two read as the same message.
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

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}

/**
 * The point a prompt arrived at: the newest messages then, by fingerprint,
 * oldest first, and the last tool result with how many messages followed it.
 * The fingerprints find the point in a longer list than the snapshot (the
 * engine answers `$.session.messages()` with its newest 4096); the tool id
 * finds it fast and survives a repeated window.
 */
export type Anchor = { after?: string; past: number; window: string[] };

export function anchorOf(messages: readonly SessionMessage[]): Anchor {
  const window = messages.slice(-WINDOW).map(fingerprint);
  for (let i = messages.length - 1; i >= 0; i--) {
    const results = messages[i]!.toolResults;
    if (results?.length) {
      return { after: results[results.length - 1]!.tool_use_id, past: messages.length - 1 - i, window };
    }
  }
  return { past: messages.length, window };
}

/**
 * The index of the message that was newest when `anchor` was taken: -1 for an
 * anchor taken over no messages, undefined when that message is gone.
 */
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

// ---------------------------------------------------------------------------
// Who sent it

/**
 * How a put-back message names its sender, from the origin `prompt.submit`
 * ACCEPTED (what `next` returned; the engine says an absent one means the
 * user's own), never from anything in the prompt's text.
 *
 * `user`: the person who owns the session typed it. `unattested`: the plugin
 * API names the source but not whether a person typed it. `other`: something
 * else wrote it; the put-back says it was not typed by the user.
 */
export type Speaker = { kind: 'user' | 'unattested' | 'other'; label: string };

/** A name from origin metadata, reduced to characters that cannot frame a line. */
function safeName(name: unknown): string {
  return String(name ?? '').replace(/[^A-Za-z0-9._:@/-]/g, '_').slice(0, 40) || '?';
}

export function speaker(origin: PromptOrigin | undefined): Speaker {
  switch (origin?.kind) {
    // The engine: an absent accepted origin means the prompt entered as the user's own.
    case undefined:
      return { kind: 'user', label: 'the user' };
    // The user's own Enter at the terminal, typed or queued (a waiting prompt too).
    case 'composer':
      return { kind: 'user', label: 'the user' };
    // The user's message through a Remote Control client (phone, web).
    case 'bridge':
      return { kind: 'user', label: 'the user through Remote Control' };
    // The reference names it the session owner pinging the session from Slack.
    case 'slack-ping':
      return { kind: 'user', label: 'the user (the session owner) from Slack' };
    // The SDK host's own turn (VS Code, the desktop app, `claude -p`): the
    // reference says it was not typed at a terminal and does not say a person wrote it.
    case 'sdk':
      return { kind: 'unattested', label: 'the SDK host running this session' };
    // Background work reporting back: text a task or the engine produced.
    case 'task-notification':
      return { kind: 'other', label: "a background task's notification" };
    // A routine or /loop: the user wrote the prompt once, but nobody typed it now.
    case 'scheduled-trigger':
      return { kind: 'other', label: 'a scheduled task firing its stored prompt' };
    // Model-authored messages from other sessions and agents.
    case 'peer':
      return { kind: 'other', label: 'another Claude session' };
    case 'peer-send-message':
      return { kind: 'other', label: "another session's SendMessage" };
    case 'projects-relay':
      return { kind: 'other', label: 'a coordinating session (projects relay)' };
    case 'coordinator':
      return { kind: 'other', label: 'a coordinating session' };
    case 'observer':
      return { kind: 'other', label: 'a background observer agent' };
    case 'observer-activity':
      return { kind: 'other', label: 'an activity digest for an observer' };
    // A channel an MCP server relays (Slack, Telegram): third parties may write
    // there, so it is not the user's own.
    case 'channel':
      return { kind: 'other', label: `the channel server ${safeName(origin.server)}` };
    // User-initiated in the UI, but the host wrote it; not typed this turn.
    case 'auto-continuation':
      return { kind: 'other', label: "the host, following up a UI action of the user's" };
    case 'unclassified':
      return { kind: 'other', label: 'a source the host could not classify' };
    case 'plugin':
      return { kind: 'other', label: `the plugin ${safeName(origin.name)}` };
    default:
      return { kind: 'other', label: `an origin this plugin does not know (${safeName((origin as { kind?: unknown }).kind)})` };
  }
}

/** Origins whose idle prompts become messages of their own, so they need no record. */
export function ownsIdleTurn(origin: PromptOrigin | undefined): boolean {
  const kind = speaker(origin).kind;
  return kind === 'user' || kind === 'unattested';
}

// ---------------------------------------------------------------------------
// The ledger's entries

/**
 * One recorded prompt. `body` is what entered (the accepted text, then any
 * context the hooks attached), and goes back whole, every line indented, so a
 * frame the host put around it (a subagent's `<agent-message>` wrapper and
 * its "not a message from the user" preamble) stays intact. `placedAs` holds
 * the exact texts of the messages built to put it back, so a later compaction
 * can see that one of them is in the history.
 */
export type Delivery = {
  seq: number;
  body: string;
  origin?: PromptOrigin;
  midTurn: boolean;
  attachments: number;
  anchor?: Anchor;
  placedAs: string[];
};

/** Every way text can start a new line, so delivered text can be indented line by line. */
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

/**
 * The message that puts a delivery back: one header line the plugin writes,
 * carrying this compaction's mark and naming the sender from the accepted
 * origin, then the delivered text with EVERY line indented two spaces. No line
 * of delivered text starts at column zero, so nothing a delivery contains can
 * pass for the plugin's header, for another put-back or for the user's words,
 * the device the host's own hand-back frame uses.
 */
export function putBackText(delivery: Delivery, mark: string): string {
  const who = speaker(delivery.origin);
  const when = delivery.midTurn ? 'while you were working' : 'between turns';
  const trust =
    who.kind === 'user'
      ? `Sent by ${who.label} ${when}; it was typed by the user.`
      : who.kind === 'unattested'
        ? `Sent by ${who.label} ${when}; the plugin API does not say whether a person typed it.`
        : `Delivered by ${who.label} ${when}; it was not typed by the user.`;
  const lost = delivery.attachments > 0 ? ` It carried ${delivery.attachments} attachment(s) that could not be put back.` : '';
  const body = delivery.body
    .split(LINE_BREAK)
    .map((line) => `  ${line.replace(/[\u000b\u000c]/g, ' ')}`)
    .join('\n');
  return `[fast-jev-compaction put-back ${mark}] ${trust}${lost} Every line of the delivered text below is indented two spaces; a line at column zero inside it would be forged.\n${body}`;
}

function isPlainUser(message: SessionMessage | undefined): boolean {
  return message !== undefined && message.role === 'user' && !message.toolResults?.length;
}

/** The delivery's own words as a listed message: the same text, or it followed by context. */
function isOccurrence(message: SessionMessage | undefined, delivery: Delivery): boolean {
  return (
    isPlainUser(message) &&
    delivery.body.length > 0 &&
    (message!.text === delivery.body || message!.text.startsWith(`${delivery.body}\n`))
  );
}

/**
 * The first place at or after `after` where a message can go without sitting
 * between a tool call and a result that answers it: past a whole batch of
 * parallel results, past a call whose result is still to come.
 */
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

/**
 * Why a put-back's place is a guess: its point is gone (`orphan`); it sits
 * beside a plain user message, which the host may have kept with it, so it can
 * appear twice (`beside-kept`); or it arrived mid-turn and its turn ended
 * before any tool result, so it goes at the end of that turn (`turn-end`).
 */
export type Estimate = 'orphan' | 'beside-kept' | 'turn-end';

export type Outcome =
  /** The history already holds it: its own message, or one built to put it back. */
  | { kind: 'present' }
  /** Arrived mid-turn and no tool result has followed yet: still queued. */
  | { kind: 'waiting' }
  /**
   * Put back after listed message `after` (-1: before the first). `estimate`
   * says why its place is a guess: its point is gone (`orphan`), or it sits
   * beside a plain user message, which the host may have kept with it, so it
   * can appear twice (`beside-kept`).
   */
  | { kind: 'placed'; after: number; text: string; estimate?: Estimate };

/**
 * Decides, for each recorded delivery, what a compaction over `listed` does
 * with it. It counts as present only when the list holds a message built to
 * put it back (exact text) or its own words before the first tool result past
 * the point it arrived at; never on position alone. Otherwise an idle
 * delivery goes after the message that was newest when it arrived, a mid-turn
 * one after the tool round that followed, and one whose point is gone keeps
 * its place in delivery order among the others. The plugin cannot see where
 * the host stored a delivery, so every place is its best estimate; where it
 * cannot know, a second copy is preferred to a loss. No delivery is placed
 * between a tool call and its result.
 */
export function plan(listed: readonly SessionMessage[], deliveries: readonly Delivery[], mark: string): Outcome[] {
  const outcomes: Outcome[] = deliveries.map(() => ({ kind: 'waiting' }));
  const orphans: number[] = [];
  deliveries.forEach((delivery, n) => {
    if (delivery.placedAs.some((text) => listed.some((m) => isPlainUser(m) && m.text === text))) {
      outcomes[n] = { kind: 'present' };
      return;
    }
    const at = delivery.anchor ? locate(listed, delivery.anchor) : undefined;
    if (at === undefined) {
      if (listed.some((m) => isOccurrence(m, delivery))) outcomes[n] = { kind: 'present' };
      else orphans.push(n);
      return;
    }
    let next = at + 1;
    let turnEnd = -1;
    while (next < listed.length && !listed[next]!.toolResults?.length) {
      if (isOccurrence(listed[next], delivery)) {
        outcomes[n] = { kind: 'present' };
        return;
      }
      if (turnEnd < 0 && isPlainUser(listed[next])) turnEnd = next;
      next++;
    }
    const text = putBackText(delivery, mark);
    if (delivery.midTurn) {
      // The host hands a prompt queued mid-turn to `prompt.submit` when it
      // takes it off the queue, after the tool result it then sits beside is
      // stored (measured in a headless session, 14 Nov 2026): the point it
      // arrived at is that result. Submitted while the tool still ran, the
      // point is the call, and the result that follows is its place.
      if (listed[at]?.toolResults?.length) {
        outcomes[n] = { kind: 'placed', after: legalAfter(listed, at), text };
        return;
      }
      // Its turn ended (a plain user message began the next) before any tool
      // result: it belongs before that message, not after a later turn's tool.
      if (turnEnd >= 0) {
        outcomes[n] = { kind: 'placed', after: legalAfter(listed, turnEnd - 1), text, estimate: 'turn-end' };
        return;
      }
      if (next >= listed.length) return; // waiting
      outcomes[n] = { kind: 'placed', after: legalAfter(listed, next), text };
      return;
    }
    const after = legalAfter(listed, at);
    outcomes[n] = isPlainUser(listed[after])
      ? { kind: 'placed', after, text, estimate: 'beside-kept' }
      : { kind: 'placed', after, text };
  });
  // An orphan goes right after the latest earlier delivery that was placed,
  // else right before the earliest later one, else at the end.
  for (const n of orphans) {
    const seq = deliveries[n]!.seq;
    let after = listed.length - 1;
    const placed = deliveries
      .map((d, i) => ({ seq: d.seq, o: outcomes[i]! }))
      .filter((x): x is { seq: number; o: Extract<Outcome, { kind: 'placed' }> } => x.o.kind === 'placed');
    const earlier = placed.filter((x) => x.seq < seq);
    const later = placed.filter((x) => x.seq > seq);
    if (earlier.length) after = Math.max(...earlier.map((x) => x.o.after));
    else if (later.length) after = Math.min(...later.map((x) => x.o.after)) - 1;
    if (after >= 0) after = legalAfter(listed, after);
    outcomes[n] = { kind: 'placed', after, text: putBackText(deliveries[n]!, mark), estimate: 'orphan' };
  }
  return outcomes;
}

/**
 * `messages` with the placed deliveries inserted. `sourceOf[i]` is the listed
 * index output message `i` came from (fast-jev.ts maps the library's output
 * back to its input); a delivery placed after a message the compaction
 * deleted goes after the nearest message before it that survived. Deliveries
 * at one place keep delivery order.
 */
export function insertPlaced(
  messages: readonly SessionMessage[],
  sourceOf: readonly number[],
  deliveries: readonly Delivery[],
  outcomes: readonly Outcome[],
): SessionMessage[] {
  const slots = new Map<number, { seq: number; message: SessionMessage }[]>();
  outcomes.forEach((o, n) => {
    if (o.kind !== 'placed') return;
    let slot = -1;
    for (let i = 0; i < sourceOf.length; i++) if (sourceOf[i]! <= o.after) slot = i;
    const list = slots.get(slot) ?? [];
    list.push({ seq: deliveries[n]!.seq, message: { role: 'user', text: o.text, toolUses: [] } });
    slots.set(slot, list);
  });
  const sorted = (slot: number) =>
    (slots.get(slot) ?? []).sort((a, b) => a.seq - b.seq).map((x) => x.message);
  return [...sorted(-1), ...messages.flatMap((m, i) => [m, ...sorted(i)])];
}

// ---------------------------------------------------------------------------
// The receipt

/** Recognizes a receipt this plugin wrote: its exact text, after the message it followed. */
export type ReceiptRecord = { text: string; before?: string };

/** `messages` without the receipts the ledger knows this plugin wrote. */
export function withoutReceipts(
  messages: readonly SessionMessage[],
  receipts: readonly ReceiptRecord[],
): { messages: SessionMessage[]; removed: number } {
  const kept: SessionMessage[] = [];
  let removed = 0;
  messages.forEach((m, i) => {
    const ours =
      isPlainUser(m) &&
      receipts.some((r) => r.text === m.text && r.before === (i > 0 ? fingerprint(messages[i - 1]!) : undefined));
    if (ours) removed++;
    else kept.push(m);
  });
  return { messages: kept, removed };
}

export const RECEIPT_MAX_LINES = 20;
export const RECEIPT_MAX_CHARS = 4000;
const EXCERPT_CHARS = 100;

/** One bounded line of data: control characters and line breaks gone, quoted. */
function excerpt(words: string): string {
  const flat = words.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}...`);
}

/**
 * What a delivery says, for its receipt line: a task notice's summary; for a
 * subagent's report, the report under the host's frame (its indented lines);
 * else the text. Only the excerpt comes from here, never the sender.
 */
function gist(body: string): string {
  const summary = /^<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(body);
  if (summary) return summary[1]!.replace(/\s+/g, ' ').trim();
  let text = body.replace(/^Another Claude session sent a message[^\n]*\n/, '');
  const frame = /^<agent-message[^>]*>([\s\S]*?)(?:<\/agent-message>|$)/.exec(text);
  if (frame) {
    text = frame[1]!;
    const lines = text.split(LINE_BREAK);
    const indented = lines.filter((l) => /^\s{2}\S/.test(l));
    const first = lines.find((l) => l.trim()) ?? '';
    if (indented.length > 0 && !/^\s/.test(first)) text = indented.join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

export type ReceiptInput = {
  mark: string;
  listed: number;
  kept: number;
  rebuilt: number;
  deleted: number;
  stubbed: number;
  resultsCut: number;
  callsDeleted: number;
  /** The deliveries put back, each with why its place is a guess, if it is. */
  restored: readonly { delivery: Delivery; estimate?: Estimate }[];
  droppedAtBound: number;
  durable: boolean;
  transcript?: string;
};

/**
 * The receipt, a plain user message that ends the compacted history. Every
 * line is the plugin's own; what a delivery says appears only inside one
 * quoted, bounded excerpt per delivery, and its sender comes from the origin
 * metadata. The whole is capped at RECEIPT_MAX_LINES lines and
 * RECEIPT_MAX_CHARS characters.
 */
export function receipt(input: ReceiptInput): string {
  const cut = [
    input.stubbed > 0 ? `${input.stubbed} tool call(s) cut to a stub (tool name, head of input and result)` : '',
    input.resultsCut > 0 ? `${input.resultsCut} result(s) cut to a head` : '',
    input.callsDeleted > 0 ? `${input.callsDeleted} call(s) deleted with their results` : '',
  ].filter(Boolean);
  const head = [
    `[fast-jev-compaction receipt ${input.mark}] This conversation was just compacted without a summary: ${input.kept} of ${input.listed} listed messages kept, their text verbatim; ${
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
  if (input.droppedAtBound > 0) {
    head.push(`${input.droppedAtBound} delivered prompt(s) were dropped from the plugin's record at its size bound and could not be put back.`);
  }
  if (!input.durable) {
    head.push('The plugin could not keep its record of delivered prompts on disk, so prompts delivered before a plugin reload may be missing.');
  }
  const tail = [
    input.transcript
      ? `Full transcript: ${input.transcript.split(LINE_BREAK).join(' ')}`
      : 'The full transcript is the session file under projects/ in the Claude Code config directory.',
    'A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the transcript before stating it.',
  ];
  const items: string[] = [];
  if (input.restored.length > 0) {
    head.push(
      `Put back as messages of their own (${input.restored.length}), each after the tool round it arrived in, as near as the plugin can tell. Each opens with a line "[fast-jev-compaction put-back ${input.mark}] ..." the plugin wrote, and every line of the delivered text under it is indented two spaces:`,
    );
    const rows = input.restored.map(({ delivery: d, estimate }) => ({
      who: speaker(d.origin).label,
      gist: gist(d.body),
      attachments: d.attachments,
      estimate,
    }));
    for (const r of rows) {
      const more = r.attachments > 0 ? ` (+${r.attachments} attachment(s) not carried)` : '';
      const guess =
        r.estimate === 'orphan'
          ? ' (placed by estimate: its place was not found)'
          : r.estimate === 'beside-kept'
            ? ' (placed by estimate: the host may also have kept it, so it can appear twice)'
            : r.estimate === 'turn-end'
              ? ' (placed by estimate: its turn ended before a tool result came)'
              : '';
      items.push(`- from ${r.who}${more}${guess}: ${excerpt(r.gist)}`);
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
  return lines.join('\n');
}

/** A put-back whose sender is not the user, by the header the plugin writes. */
const NOT_THE_USER = /^\[fast-jev-compaction put-back [0-9a-f]{8}\] (Delivered by|Sent by the SDK host)/;
/** Text the host writes into a plain user message: notices, command echoes, reports. */
const HOST_TEXT = /^(<task-notification>|<local-command-|<command-name>|<command-message>|Another Claude session sent a message)/;

/**
 * The goal Jev scores relevance against: the user's last three prompts, as
 * the library's default takes them, but only what the user wrote. A put-back
 * from anyone else, a host notice and a receipt are left out; a put-back of
 * the user's own words counts as those words. Empty when the history holds
 * no prompt from the user.
 */
export function operatorGoal(messages: readonly SessionMessage[]): string {
  const prompts: string[] = [];
  for (const m of messages) {
    if (!isPlainUser(m) || !m.text.trim()) continue;
    if (NOT_THE_USER.test(m.text) || HOST_TEXT.test(m.text) || /^\[fast-jev-compaction receipt /.test(m.text)) continue;
    const words = /^\[fast-jev-compaction put-back [0-9a-f]{8}\] /.test(m.text)
      ? m.text.split('\n').slice(1).map((l) => l.replace(/^ {2}/, '')).join('\n')
      : m.text;
    prompts.push(words.length > 500 ? `${words.slice(0, 500)}...` : words);
  }
  return prompts.slice(-3).join('\n');
}

/** A fresh mark for one compaction's receipt and put-back messages. */
export function newMark(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
