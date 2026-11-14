import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, messageChars, reductionRatio, resolveOptions } from '../src/compact.js';
import { goalFromMessages } from '../src/state.js';
import {
  anchorOf,
  type Anchor,
  type Delivery,
  fnv1a,
  goalMessages,
  type Ident,
  identify,
  insertPlaced,
  newId,
  type Outcome,
  type Own,
  plan,
  receipt,
  sha256,
  speaker,
  withoutReceipts,
} from './deliveries.js';
import { type Change, type KV, Ledger, type Record as LedgerRecord } from './ledger.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  /** Append a receipt of what the compaction cut to the history it hands back. */
  receipt: boolean;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  // This fork: stub dropped calls unless an option says otherwise,
  // so a session never reads its own reports with no call behind them (#65).
  numbers.dropCalls = typeof options['dropCalls'] === 'boolean' ? options['dropCalls'] : false;
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    receipt: typeof options['receipt'] === 'boolean' ? options['receipt'] : true,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. A plain user message
 * that came back unchanged is the engine's own object, handle included; every
 * other message is a fresh message without a handle, reusing the engine's own
 * tool uses and results where they came back unchanged. A handle is what a
 * reopen follows back to the stored transcript, so a message that kept one
 * would bring the uncompacted history back with it (`keepsHandle`).
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own && keepsHandle(own)) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Claude Code's project folder name for a working directory. */
function projectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The session's transcript file, when the engine's usual path for it exists. */
async function transcriptPath($: {
  session: { id: () => Promise<string>; cwd: () => Promise<string> };
  env: { get: (name: string) => Promise<string | undefined> };
  fs: { exists: (path: string) => Promise<boolean> };
}): Promise<string | undefined> {
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined);
    if (!config) return undefined;
    const path = `${config}/projects/${projectFolder(await $.session.cwd())}/${await $.session.id()}.jsonl`.replace(/\\/g, '/');
    return (await $.fs.exists(path)) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.callsStubbed > 0 ? `${stats.callsStubbed} call_stubbed` : '',
    stats.stubsDropped > 0 ? `${stats.stubsDropped} stub_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Points of further context growth between two compaction nudges. */
export const NUDGE_STEP = 10;

interface NudgeState {
  /** Context percent at the last nudge; -Infinity when none is owed a repeat. */
  nudgedAt: number;
}

/** Tell the user to /compact, at most once per NUDGE_STEP points of growth. */
function nudgeCompact($: Parameters<typeof notify>[0], state: NudgeState, percent: number): void {
  if (percent < state.nudgedAt + NUDGE_STEP) return;
  state.nudgedAt = percent;
  notify(
    $,
    `context at ${Math.round(percent)}%: type /compact at a natural stopping point (auto-compact cannot run in this host)`,
  );
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/**
 * For each message the library handed back, the index of the listed message
 * it came from: the same object, or one rebuilt from it (same role and text,
 * its tool ids a subset). Messages the library deleted have no entry.
 */
export function sourceIndices(listed: readonly SessionMessage[], out: readonly SessionMessage[]): number[] {
  const ids = (m: SessionMessage) => [...m.toolUses.map((t) => t.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)];
  const from = (l: SessionMessage, o: SessionMessage) =>
    l === o || (l.role === o.role && l.text === o.text && ids(o).every((id) => ids(l).includes(id)));
  const sources: number[] = [];
  let p = 0;
  for (const o of out) {
    while (p < listed.length && !from(listed[p]!, o)) p++;
    sources.push(Math.min(p, listed.length - 1));
    p++;
  }
  return sources;
}

let lastSeq = 0;
/** Delivery order: taken when `prompt.submit` is entered, before anything it awaits. */
function nextSeq(): number {
  lastSeq = Math.max(Date.now() * 1000, lastSeq + 1);
  return lastSeq;
}

/**
 * The store as closures built at the hook: the host's module checker wants
 * `$` spelled `$.noun.event(...)` where it is used, so `$` is never handed on.
 * A host without `$.store` makes them reject, and the record runs in memory.
 */
function storeOf($: {
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
    keys: () => Promise<string[]>;
  };
}): KV {
  return {
    get: async (key) => $.store.get(key),
    set: async (key, value) => $.store.set(key, value),
    remove: async (key) => $.store.delete(key),
    keys: async () => $.store.keys(),
  };
}

async function sessionIdOf($: { session: { id: () => Promise<string> } }): Promise<string> {
  try {
    return await $.session.id();
  } catch {
    return 'unknown';
  }
}

/**
 * A maintainer's aid, off unless the environment variable FAST_JEV_DEBUG_LOG
 * names a file: each `prompt.submit` and `session.compact` dispatch appends one
 * JSON line of values the plugin computed (lengths, 32-bit hashes, tool ids,
 * roles, counts, its own fixed strings), never text from a message. A length
 * and a 32-bit hash still identify a short common prompt ("yes"). The file is
 * cut back to its newest half past 1 MiB.
 */
const DEBUG_LOG_MAX_CHARS = 1024 * 1024;

type DebugHost = {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
  };
};

let debugQueue: Promise<unknown> = Promise.resolve();
function debugLog($: DebugHost, line: { [key: string]: unknown }): Promise<void> {
  const run = async () => {
    try {
      // The host reads env names off the source, so this spells the literal.
      const path = await $.env.get('FAST_JEV_DEBUG_LOG');
      if (!path) return;
      let text = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      if (text.length > DEBUG_LOG_MAX_CHARS) text = text.slice(text.length - DEBUG_LOG_MAX_CHARS / 2).replace(/^[^\n]*\n/, '');
      await $.fs.write(path, `${text}${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`);
    } catch {
      // A debug log never gets in the way.
    }
  };
  const done = debugQueue.then(run, run);
  debugQueue = done;
  return done;
}

const KNOWN_KINDS = new Set([
  'composer', 'bridge', 'sdk', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay',
  'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'unclassified', 'slack-ping', 'plugin',
]);

/** An origin for the debug log: its kind when it is one the plugin knows, else `other`. */
function originKind(origin: unknown): string | null {
  if (!origin || typeof origin !== 'object') return null;
  const kind = (origin as { kind?: unknown }).kind;
  return typeof kind === 'string' && KNOWN_KINDS.has(kind) ? kind : 'other';
}

/** Every message of a list, as values the plugin computed; `own` marks what it recognised as its own. */
function listSummary(messages: readonly SessionMessage[], own?: ReadonlyMap<number, Own>): unknown[] {
  return messages.map((m, i) => ({
    role: m.role,
    chars: m.text.length,
    hash: fnv1a(m.text),
    ...(m.toolUses.length ? { uses: m.toolUses.map((t) => t.tool_use_id) } : {}),
    ...(m.toolResults?.length ? { results: m.toolResults.map((r) => r.tool_use_id) } : {}),
    handle: m.handle !== undefined,
    ...(own?.has(i) ? { own: own.get(i)!.kind } : {}),
  }));
}

export { anchorOf, fingerprint, identify, insertPlaced, plan, receipt } from './deliveries.js';
export type { Anchor, Delivery, Own, Outcome } from './deliveries.js';
export { LEDGER_MAX_BYTES, LEDGER_MAX_ENTRIES, LEDGER_MAX_SESSIONS } from './ledger.js';

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  // A host that runs Claude Code as an SDK session (VS Code, the desktop app,
  // `claude -p`) refuses $.session.compact. There the hook nudges instead of
  // failing on every turn: once when context crosses compactAtPercent, then
  // again each NUDGE_STEP points, so the user picks the moment to /compact.
  let cannotCompact = false;
  const nudges: NudgeState = { nudgedAt: Number.NEGATIVE_INFINITY };
  // Prompts delivered beside a message rather than as one; see DESIGN-NOTES.md.
  const ledger = new Ledger();
  // Names this registration in the debug log.
  const registration = newId();

  on('prompt.submit', async ($, event, next) => {
    const seq = nextSeq();
    const midTurn = event.turnId !== undefined;
    let snapshot: SessionMessage[] | undefined;
    let record: LedgerRecord | undefined;
    const session = await sessionIdOf($);
    try {
      snapshot = await $.session.messages();
      record = await ledger.read(storeOf($), session);
    } catch {
      // No point to anchor to: the delivery becomes an orphan if it is recorded.
    }
    const entered = await next(event);
    const recordIt = entered.drop === undefined && (midTurn || !speaker(entered.origin).user);
    let anchor: Anchor | undefined;
    if (recordIt && snapshot) {
      // Only the tail is read; the plugin's own receipts there are skipped,
      // since the next compaction takes them out.
      const tail = snapshot.slice(-64);
      const own = record ? await identify(tail, { pending: [], placed: [], ours: [], receipts: record.receipts }) : new Map();
      anchor = anchorOf(tail, new Set([...own].filter(([, o]) => o.kind === 'receipt').map(([i]) => i)));
    }
    await debugLog($, {
      ev: 'prompt.submit',
      registration,
      origin: originKind(event.origin),
      accepted: entered.drop !== undefined ? 'dropped' : originKind(entered.origin) ?? 'own',
      turnId: event.turnId ?? null,
      wait: event.wait,
      chars: event.text.length,
      hash: fnv1a(event.text),
      attachments: event.attachments?.length ?? 0,
      listed: snapshot?.length ?? null,
      recorded: recordIt,
      seq,
    });
    if (!recordIt || entered.drop !== undefined) return entered;
    const body = [entered.text, ...(entered.context ?? [])].filter((part) => part.length > 0).join('\n');
    const attachments = event.attachments?.length ?? 0;
    if (!body && attachments === 0) return entered;
    const delivery: Delivery = { seq, id: newId(), body, midTurn, attachments };
    if (entered.origin) delivery.origin = entered.origin;
    if (anchor) delivery.anchor = anchor;
    await ledger.record(storeOf($), session, delivery);
    return entered;
  });

  on('session.compact', async ($, event, next) => {
    nudges.nudgedAt = Number.NEGATIVE_INFINITY;
    // A subagent's transcript never holds the main loop's deliveries.
    const main = event.agentId === undefined;
    // A precompute installs nothing; its result is kept for a compaction that may never come.
    const speculative = event.trigger === 'precompute';
    const session = await sessionIdOf($);
    // Everything that reads the record runs inside this try; anything wrong
    // in it leaves the plugin compacting as it would with no deliveries.
    let record: LedgerRecord | undefined;
    let found: Map<number, Own> = new Map();
    let own: Map<number, Own> = new Map();
    let pending: Delivery[] = [];
    let outcomes: Outcome[] = [];
    let listed: SessionMessage[] = [...event.messages];
    let unusable = false;
    try {
      if (main) {
        record = await ledger.read(storeOf($), session);
        found = await identify(event.messages, record);
        listed = withoutReceipts(event.messages, found);
        // Indices into `listed` from here on.
        own = await identify(listed, record);
        pending = record.pending;
        outcomes = plan(listed, pending, own);
      }
    } catch {
      unusable = true;
      record = undefined;
      found = new Map();
      own = new Map();
      pending = [];
      outcomes = [];
      listed = [...event.messages];
    }
    const removed = event.messages.length - listed.length;
    const restored = pending.flatMap((delivery, n) => {
      const o = outcomes[n]!;
      return o.kind === 'placed' ? [o.estimate ? { delivery, estimate: o.estimate } : { delivery }] : [];
    });
    const tally = (kind: Outcome['kind']) => outcomes.filter((o) => o.kind === kind).length;
    await debugLog($, {
      ev: 'session.compact',
      registration,
      trigger: event.trigger,
      agentId: event.agentId ?? null,
      listed: event.messages.length,
      removed,
      recorded: pending.length,
      seen: tally('seen'),
      present: tally('listed'),
      keptByHost: tally('kept-by-host'),
      placed: tally('placed'),
      waiting: tally('waiting'),
      durable: record?.durable ?? null,
      unusable,
      messages: listSummary(event.messages, found),
    });

    /** What this compaction's outcome changes in the record; nothing for a precompute but its receipt. */
    const settle = async (installed: boolean, returned: readonly SessionMessage[], receiptId?: Ident) => {
      if (!record) return;
      const placedOwn = [...own.values()].filter((o): o is Extract<Own, { kind: 'put-back' }> => o.kind === 'put-back');
      const change: Change = {
        retire: [],
        placed: [],
        reanchor: new Map(),
        placedSettled: [],
        oursAdded: [],
        missingAdded: 0,
        receiptsRemoved: [],
        reported: false,
      };
      // What the listing shows is settled whatever this compaction becomes.
      for (const o of placedOwn) {
        if (o.pending !== undefined) change.retire.push(o.pending);
        if (o.pending !== undefined || o.placed) change.oursAdded.push({ id: o.id, sha: o.sha, ...(o.user ? { user: true } : {}) });
        if (o.placed) change.placedSettled.push(o.id);
      }
      outcomes.forEach((o, n) => {
        if (o.kind === 'listed') change.retire.push(pending[n]!.seq);
      });
      if (receiptId) change.receiptAdded = receiptId;
      if (!speculative) {
        const seenPlaced = new Set(placedOwn.filter((o) => o.placed).map((o) => o.id));
        for (const p of record.placed) {
          if (!seenPlaced.has(p.id)) {
            change.placedSettled.push(p.id);
            change.missingAdded++;
          }
        }
        change.receiptsRemoved = [...found.values()].filter((o) => o.kind === 'receipt').map((o) => o.id);
        const anchor = anchorOf(returned);
        for (const [n, o] of outcomes.entries()) {
          const d = pending[n]!;
          if (o.kind === 'waiting') change.reanchor.set(d.seq, anchor);
          if (!installed) continue;
          // Measured: the host keeps what sits beside a plain user message the plugin hands back whole.
          if (o.kind === 'kept-by-host') change.retire.push(d.seq);
          if (o.kind === 'placed') {
            change.placed.push({ id: d.id, sha: await sha256(o.text), seq: d.seq, ...(speaker(d.origin).user ? { user: true } : {}) });
          }
        }
        change.reported = installed && receiptId !== undefined;
      }
      await ledger.commit(storeOf($), session, change);
    };

    // The built-in summary is handed the history with the deliveries put back
    // and the plugin's receipts out. Nothing is retired for being handed to it:
    // a summary is no evidence that a delivery survived.
    const builtIn = async () => {
      const handed = restored.length > 0 || removed > 0 ? { ...event, messages: insertPlaced(listed, listed.map((_, i) => i), pending, outcomes) } : event;
      const compacted = await next(handed);
      if (compacted.skip === undefined) await settle(false, compacted.messages ?? []).catch(() => undefined);
      return compacted;
    };
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      // Base behaviour unless the history holds a message the plugin wrote:
      // then the goal is taken from the rest, a put-back of the user's own
      // words read as those words. A configured goal always wins.
      if (!config.goal && found.size > 0) {
        const goal = goalFromMessages(goalMessages(listed, own));
        if (goal) config.goal = goal;
      }
      // The library sees the listed messages, less the plugin's receipts;
      // put-backs are inserted afterwards.
      const { result, messages } = await compactSession(listed, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return builtIn();
      }
      const out = insertPlaced(messages, sourceIndices(listed, messages), pending, outcomes);
      const whole = messages.filter((m) => m.handle !== undefined).length;
      const counts = {
        listed: listed.length,
        kept: messages.length,
        rebuilt: messages.length - whole,
        deleted: listed.length - messages.length,
      };
      let returned = out;
      let receiptId: Ident | undefined;
      // A subagent's compaction gets no receipt: the transcript and the
      // deliveries this plugin knows are the main conversation's.
      if (config.receipt && main) {
        const missing = (record?.missing ?? 0) + (record ? record.placed.filter((p) => ![...own.values()].some((o) => o.id === p.id)).length : 0);
        const id = newId();
        const text = receipt({
          id,
          ...counts,
          stubbed: result.stats.callsStubbed,
          resultsCut: result.stats.resultsDropped,
          callsDeleted: result.stats.callsDropped + result.stats.stubsDropped,
          restored,
          dropped: record?.dropped ?? 0,
          unreadable: (record?.unreadable ?? 0) + (unusable ? 1 : 0),
          missing: speculative ? 0 : missing,
          durable: record?.durable ?? true,
          ...(await transcriptPath($).then((t) => (t ? { transcript: t } : {}))),
        });
        receiptId = { id, sha: await sha256(text) };
        returned = [...out, { role: 'user', text, toolUses: [] }];
      }
      // The reduction the banner states is of the history as returned, against
      // what the session held: the listed messages and the deliveries beside them.
      const before =
        event.messages.reduce((sum, m) => sum + messageChars(m), 0) + restored.reduce((sum, r) => sum + r.delivery.body.length, 0);
      const after = returned.reduce((sum, m) => sum + messageChars(m), 0);
      const parts = [
        `${counts.rebuilt} rebuilt and ${counts.deleted} deleted, without what the host stores beside them`,
        restored.length > 0 ? `${restored.length} delivered prompt(s) put back` : '',
        removed > 0 ? `${removed} earlier receipt(s) replaced` : '',
      ].filter(Boolean);
      notify(
        $,
        `kept ${counts.kept}/${counts.listed} listed messages (${parts.join('; ')}), no summary (${percent(
          before === 0 ? 0 : (before - after) / before,
        )} smaller as returned; ${summarize(result).replace(/^-?\d+% reduction; /, '')})`,
      );
      await settle(true, out, receiptId).catch(() => undefined);
      await debugLog($, {
        ev: 'session.compact.returned',
        registration,
        trigger: event.trigger,
        messages: listSummary(returned),
      });
      return { messages: returned };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return builtIn();
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    let percent = 0;
    try {
      const { context } = await $.session.usage();
      percent = context.percent ?? 0;
      if (percent < configured.compactAtPercent) {
        nudges.nudgedAt = Number.NEGATIVE_INFINITY;
        return next(event);
      }
      if (cannotCompact) {
        nudgeCompact($, nudges, percent);
        return next(event);
      }
      compacting = true;
      await $.session.compact();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('headless')) {
        cannotCompact = true;
        nudgeCompact($, nudges, percent);
      } else {
        $.ui.log(`auto-compact skipped (${message})`);
      }
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };

function keepsHandle(message: SessionMessage): boolean {
  return message.role === 'user' && !message.toolResults?.length;
}
