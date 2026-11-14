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
import {
  anchorOf,
  fnv1a,
  type Anchor,
  type Delivery,
  fingerprint,
  insertPlaced,
  newMark,
  type Outcome,
  operatorGoal,
  ownsIdleTurn,
  plan,
  receipt,
  type ReceiptRecord,
  withoutReceipts,
} from './deliveries.js';
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
/** Delivery order: taken when `prompt.submit` starts, before anything it awaits. */
function nextSeq(): number {
  lastSeq = Math.max(Date.now() * 1000, lastSeq + 1);
  return lastSeq;
}

/** One session's record of deliveries, and of the receipts this plugin wrote. */
export type LedgerData = { entries: Delivery[]; receipts: ReceiptRecord[]; dropped: number };
type LedgerView = LedgerData & { sid: string; durable: boolean };

/** Bounds on one session's record, and how many sessions the store keeps. */
export const LEDGER_MAX_ENTRIES = 100;
export const LEDGER_MAX_CHARS = 512 * 1024;
export const LEDGER_MAX_SESSIONS = 6;
const LEDGER_PREFIX = 'deliveries:';

/**
 * What the record needs of the host, as closures. The host's module checker
 * requires `$` to be spelled `$.noun.event(...)` where it is used, so `$`
 * itself is never handed to the record; `ledgerHost` builds these at the
 * hook. A host without `$.store` makes them reject, and the record then lives
 * in memory.
 */
export type LedgerHost = {
  sessionId: () => Promise<string>;
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  remove: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
};

function ledgerHost($: {
  session: { id: () => Promise<string> };
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
    keys: () => Promise<string[]>;
  };
}): LedgerHost {
  return {
    sessionId: async () => $.session.id(),
    get: async (key) => $.store.get(key),
    set: async (key, value) => $.store.set(key, value),
    remove: async (key) => $.store.delete(key),
    keys: async () => $.store.keys(),
  };
}

function isLedger(value: unknown): value is LedgerData {
  const v = value as LedgerData | undefined;
  return !!v && Array.isArray(v.entries) && Array.isArray(v.receipts) && typeof v.dropped === 'number';
}

/**
 * The record of delivered prompts, one per session id, kept in the plugin's
 * own store (`$.store`, a JSON file under the Claude Code configuration
 * directory) so that a plugin reload or a reopened session still has it.
 * Where the store cannot be read or written it lives in memory only, and the
 * receipt says that prompts delivered before a reload may be missing. Each
 * session keeps at most LEDGER_MAX_ENTRIES deliveries and LEDGER_MAX_CHARS of
 * their text, oldest dropped first and counted for the receipt; the store
 * keeps the LEDGER_MAX_SESSIONS most recently written sessions. Changes run
 * one at a time.
 */
export class Ledgers {
  private memory = new Map<string, LedgerData>();
  private durable = true;
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async sid(host: LedgerHost): Promise<string> {
    try {
      return await host.sessionId();
    } catch {
      return '';
    }
  }

  private async load(host: LedgerHost, sid: string): Promise<LedgerData> {
    const cached = this.memory.get(sid);
    if (cached) return cached;
    let data: LedgerData = { entries: [], receipts: [], dropped: 0 };
    try {
      const stored = await host.get(LEDGER_PREFIX + sid);
      if (isLedger(stored)) data = stored;
    } catch {
      this.durable = false;
    }
    this.memory.set(sid, data);
    return data;
  }

  private async save(host: LedgerHost, sid: string, data: LedgerData): Promise<void> {
    let chars = data.entries.reduce((sum, d) => sum + d.body.length, 0);
    while (data.entries.length > LEDGER_MAX_ENTRIES || chars > LEDGER_MAX_CHARS) {
      chars -= data.entries.shift()!.body.length;
      data.dropped++;
    }
    if (!this.durable) return;
    try {
      // Deleted then set, so the store's key order is the order last written.
      await host.remove(LEDGER_PREFIX + sid);
      await host.set(LEDGER_PREFIX + sid, data);
      const ours = (await host.keys()).filter((key) => key.startsWith(LEDGER_PREFIX));
      for (const key of ours.slice(0, Math.max(0, ours.length - LEDGER_MAX_SESSIONS))) await host.remove(key);
    } catch {
      this.durable = false;
    }
  }

  /** Applies `change` to this session's record and keeps it. */
  update(host: LedgerHost, change: (data: LedgerData) => void): Promise<void> {
    return this.serial(async () => {
      const sid = await this.sid(host);
      const data = await this.load(host, sid);
      change(data);
      await this.save(host, sid, data);
    });
  }

  /** A copy of this session's record, as a compaction starts. */
  read(host: LedgerHost): Promise<LedgerView> {
    return this.serial(async () => {
      const sid = await this.sid(host);
      const data = await this.load(host, sid);
      return { ...structuredCopy(data), sid, durable: this.durable };
    });
  }

  /**
   * What a compaction's outcome does to the record. A delivery the history
   * already holds is retired. One put back is kept, with the text it was put
   * back as, until a later compaction sees that text in the history; one
   * handed to the built-in summary is retired. A waiting one is re-anchored to
   * the history now returned. A speculative compaction only learns the texts
   * it put back; the host keeps its result for a compaction that may come.
   */
  settle(
    host: LedgerHost,
    entries: readonly Delivery[],
    outcomes: readonly Outcome[],
    mode: 'installed' | 'speculative' | 'summarized',
    returned: readonly SessionMessage[],
    record?: ReceiptRecord,
  ): Promise<void> {
    return this.update(host, (data) => {
      const anchor: Anchor = anchorOf(returned);
      const retire = new Set<number>();
      entries.forEach((entry, n) => {
        const o = outcomes[n]!;
        const live = data.entries.find((d) => d.seq === entry.seq);
        if (!live) return;
        if (o.kind === 'present') retire.add(entry.seq);
        else if (o.kind === 'placed') {
          if (mode === 'summarized') retire.add(entry.seq);
          else live.placedAs = [...live.placedAs, o.text].slice(-3);
        } else if (mode !== 'speculative') live.anchor = anchor;
      });
      data.entries = data.entries.filter((d) => !retire.has(d.seq));
      if (record) data.receipts = [...data.receipts, record].slice(-3);
      if (record && mode === 'installed') data.dropped = 0;
    });
  }
}

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export { anchorOf, fingerprint, insertPlaced, plan, receipt, withoutReceipts } from './deliveries.js';
export type { Anchor, Delivery, Outcome, ReceiptRecord } from './deliveries.js';

/**
 * A maintainer's aid, off unless the environment variable FAST_JEV_DEBUG_LOG
 * names a file: each `prompt.submit` and `session.compact` dispatch appends
 * one JSON line to it, with the origin as given and as accepted, `turnId`,
 * `wait`, the text's length and a short hash (never the text), the listed
 * history's length and its newest message's role and tool ids, the trigger
 * and the session and agent ids. It settles when and how the host dispatches
 * these hooks. The file is cut back to its newest half past 1 MiB.
 */
// The host reads env names off the source, so each call spells 'FAST_JEV_DEBUG_LOG'.
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
function debugLog($: DebugHost, line: Record<string, unknown>): Promise<void> {
  const run = async () => {
    try {
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

function originSummary(origin: unknown): unknown {
  if (!origin || typeof origin !== 'object') return origin ?? null;
  const { kind, name, server } = origin as { kind?: unknown; name?: unknown; server?: unknown };
  return { kind, ...(name !== undefined ? { name } : {}), ...(server !== undefined ? { server } : {}) };
}

function newestSummary(messages: readonly SessionMessage[]): unknown {
  const m = messages[messages.length - 1];
  if (!m) return null;
  return {
    role: m.role,
    textChars: m.text.length,
    uses: m.toolUses.map((t) => t.tool_use_id),
    results: (m.toolResults ?? []).map((r) => r.tool_use_id),
    handle: m.handle !== undefined,
  };
}

/**
 * Every message of a list, for the debug log: role, length and hash of its
 * text (never the text), tool ids, whether it has a handle, and the first line
 * of a message the plugin wrote (a put-back's header or a receipt's first
 * line, both the plugin's own words).
 */
function listSummary(messages: readonly SessionMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    chars: m.text.length,
    hash: fnv1a(m.text),
    ...(m.toolUses.length ? { uses: m.toolUses.map((t) => t.tool_use_id) } : {}),
    ...(m.toolResults?.length ? { results: m.toolResults.map((r) => r.tool_use_id) } : {}),
    handle: m.handle !== undefined,
    ...(m.text.startsWith('[fast-jev-compaction ') ? { plugin: m.text.split('\n')[0]!.slice(0, 160) } : {}),
  }));
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  // A host that runs Claude Code as an SDK session (VS Code, the desktop app,
  // `claude -p`) refuses $.session.compact. There the hook nudges instead of
  // failing on every turn: once when context crosses compactAtPercent, then
  // again each NUDGE_STEP points, so the user picks the moment to /compact.
  let cannotCompact = false;
  const nudges: NudgeState = { nudgedAt: Number.NEGATIVE_INFINITY };
  // Prompts delivered beside a message rather than as one; see hooks/deliveries.ts.
  const ledgers = new Ledgers();
  // Names this registration in the debug log, to see whether one lives from a
  // delivery to the compaction that follows it.
  const registration = newMark();

  on('prompt.submit', async ($, event, next) => {
    // Every prompt submitted while a turn runs is queued beside a message,
    // whether or not it asked to wait its turn (`wait` is a hint for hooks).
    const midTurn = event.turnId !== undefined;
    const debug = (await $.env.get('FAST_JEV_DEBUG_LOG').catch(() => undefined)) !== undefined;
    const given = {
      ev: 'prompt.submit',
      registration,
      origin: originSummary(event.origin),
      turnId: event.turnId ?? null,
      wait: event.wait,
      chars: event.text.length,
      hash: fnv1a(event.text),
      attachments: event.attachments?.length ?? 0,
    };
    if (!midTurn && ownsIdleTurn(event.origin)) {
      if (debug) {
        const listed = await $.session.messages().catch(() => []);
        await debugLog($, { ...given, listed: listed.length, newest: newestSummary(listed), recorded: false });
      }
      return next(event);
    }
    const seq = nextSeq();
    const snapshot = await $.session.messages().catch(() => undefined);
    const anchor = snapshot ? anchorOf(snapshot) : undefined;
    const entered = await next(event);
    if (debug) {
      await debugLog($, {
        ...given,
        listed: snapshot?.length ?? null,
        newest: snapshot ? newestSummary(snapshot) : null,
        accepted: entered.drop !== undefined ? 'dropped' : originSummary(entered.origin),
        enteredHash: entered.drop !== undefined ? null : fnv1a(entered.text),
        context: entered.drop !== undefined ? 0 : (entered.context?.length ?? 0),
        seq,
      });
    }
    if (entered.drop !== undefined) return entered;
    // The origin that entered; absent, the engine says the prompt is the user's own.
    const origin = entered.origin;
    if (!midTurn && ownsIdleTurn(origin)) return entered;
    const body = [entered.text, ...(entered.context ?? [])].filter((part) => part.length > 0).join('\n');
    const attachments = event.attachments?.length ?? 0;
    if (!body && attachments === 0) return entered;
    const delivery: Delivery = { seq, body, midTurn, attachments, placedAs: [] };
    if (origin) delivery.origin = origin;
    if (anchor) delivery.anchor = anchor;
    await ledgers.update(ledgerHost($), (ledger) => {
      ledger.entries.push(delivery);
      ledger.entries.sort((a, b) => a.seq - b.seq);
    });
    return entered;
  });

  on('session.compact', async ($, event, next) => {
    nudges.nudgedAt = Number.NEGATIVE_INFINITY;
    // A subagent's transcript never holds the main loop's deliveries.
    const main = event.agentId === undefined;
    // A precompute installs nothing (its result is kept for a compaction that
    // may never come), so it may not retire or move a pending delivery.
    const mode = event.trigger === 'precompute' ? 'speculative' : 'installed';
    const ledger = main ? await ledgers.read(ledgerHost($)) : undefined;
    const mark = newMark();
    const { messages: listed, removed } = ledger
      ? withoutReceipts(event.messages, ledger.receipts)
      : { messages: [...event.messages], removed: 0 };
    const entries = ledger?.entries ?? [];
    const outcomes = plan(listed, entries, mark);
    const restored = entries.flatMap((delivery, n) => {
      const o = outcomes[n]!;
      return o.kind === 'placed' ? [o.estimate ? { delivery, estimate: o.estimate } : { delivery }] : [];
    });
    const tally = (kind: Outcome['kind']) => outcomes.filter((o) => o.kind === kind).length;
    await debugLog($, {
      ev: 'session.compact',
      registration,
      trigger: event.trigger,
      agentId: event.agentId ?? null,
      session: ledger?.sid ?? null,
      listed: event.messages.length,
      newest: newestSummary(event.messages),
      handles: event.messages.filter((m) => m.handle !== undefined).length,
      receiptsSeen: removed,
      recorded: entries.length,
      present: tally('present'),
      placed: tally('placed'),
      waiting: tally('waiting'),
      durable: ledger?.durable ?? null,
      seqs: entries.map((d, n) => ({ seq: d.seq, outcome: outcomes[n]!.kind })),
      messages: listSummary(event.messages),
    });
    // On a fallback the built-in summary is handed the history with the
    // deliveries put back and the earlier receipts out, so the summarizer reads
    // them; those it was handed are then retired, the waiting ones re-anchored
    // to what it returned. A skipped or failed fallback changes nothing.
    const builtIn = async () => {
      const handed =
        restored.length > 0 || removed > 0
          ? { ...event, messages: insertPlaced(listed, listed.map((_, i) => i), entries, outcomes) }
          : event;
      const compacted = await next(handed);
      if (ledger && !compacted.skip) {
        await ledgers.settle(ledgerHost($), entries, outcomes, mode === 'speculative' ? mode : 'summarized', compacted.messages ?? []);
      }
      return compacted;
    };
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      // Jev's goal is what the user wrote, never a delivery put back as a plain
      // message or a host notice; a configured goal still wins.
      if (!config.goal) config.goal = operatorGoal(listed) || 'No prompt from the user is in this history.';
      // The library sees what the host listed, less this plugin's own receipts:
      // put-back deliveries are inserted afterwards, so neither they nor a
      // receipt change Jev's state, its goal, the pinned messages or the
      // reduction the fallback is decided on.
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
      const out = insertPlaced(messages, sourceIndices(listed, messages), entries, outcomes);
      const whole = messages.filter((m) => m.handle !== undefined).length;
      const counts = {
        listed: listed.length,
        kept: messages.length,
        rebuilt: messages.length - whole,
        deleted: listed.length - messages.length,
      };
      let returned = out;
      let record: ReceiptRecord | undefined;
      // A subagent's compaction gets no receipt: the transcript and the
      // deliveries this plugin knows are the main conversation's.
      if (config.receipt && main) {
        const text = receipt({
          mark,
          ...counts,
          stubbed: result.stats.callsStubbed,
          resultsCut: result.stats.resultsDropped,
          callsDeleted: result.stats.callsDropped + result.stats.stubsDropped,
          restored,
          droppedAtBound: ledger?.dropped ?? 0,
          durable: ledger?.durable ?? true,
          ...(await transcriptPath($).then((t) => (t ? { transcript: t } : {}))),
        });
        record = { text, ...(out.length ? { before: fingerprint(out[out.length - 1]!) } : {}) };
        returned = [...out, { role: 'user', text, toolUses: [] }];
      }
      // The reduction the banner states is of the history as returned, against
      // what the session held: the listed messages and the deliveries beside them.
      const before =
        event.messages.reduce((sum, m) => sum + messageChars(m), 0) +
        restored.reduce((sum, r) => sum + r.delivery.body.length, 0);
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
      if (ledger) await ledgers.settle(ledgerHost($), entries, outcomes, mode, out, record);
      await debugLog($, {
        ev: 'session.compact.returned',
        registration,
        trigger: event.trigger,
        recordedAfter: ledger ? (await ledgers.read(ledgerHost($))).entries.map((d) => d.seq) : null,
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
