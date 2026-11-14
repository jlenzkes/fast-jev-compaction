import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
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

/**
 * A prompt that reached the session from anywhere but the user's own Enter at
 * an idle prompt, as `prompt.submit` saw it: one typed or delivered while a
 * turn ran (`midTurn`), or a delivery that started a turn of its own, such as
 * a subagent's report. The engine stores such a prompt beside a message
 * rather than as one, so no `session.compact` list holds it, and it survives
 * a compaction only when the message it sits beside goes back whole, with its
 * handle (see `withDeliveries`). `after` is the last tool result the session
 * held when it arrived, and `past` how many messages followed that result
 * (or, with no tool result yet, how many messages there were).
 */
export type Delivery = {
  text: string;
  origin: string;
  midTurn: boolean;
  after?: string;
  past: number;
};

/** Where a prompt arriving now sits: past the last tool result, or past the start. */
export function anchorOf(messages: readonly SessionMessage[]): { after?: string; past: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const results = messages[i]!.toolResults;
    if (results?.length) {
      return { after: results[results.length - 1]!.tool_use_id, past: messages.length - 1 - i };
    }
  }
  return { past: messages.length };
}

/** Origins that are the user's own typing; anything else is a delivery. */
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk']);

/** A plain user message: the only kind handed back with its handle (`keepsHandle`). */
function isPlainUser(message: SessionMessage | undefined): boolean {
  return message !== undefined && message.role === 'user' && !message.toolResults?.length;
}

function deliveryText(delivery: Delivery): string {
  return USER_ORIGINS.has(delivery.origin)
    ? `The user sent a new message while you were working:\n${delivery.text}`
    : `[fast-jev-compaction: a message delivered to this session (origin: ${delivery.origin}) while it ran, put back after compaction; it was not typed by the user]\n${delivery.text}`;
}

/**
 * Puts deliveries back as plain user messages where the engine had them.
 *
 * The engine hangs a delivery on the message before it: a prompt that arrived
 * mid-turn on the first tool result after it, a delivery that started its own
 * turn on the last message of the turn before. A message handed back without
 * its handle is built afresh and loses what hung on it, and every message but
 * a plain user message goes back without one (`keepsHandle`). So a delivery is
 * placed again unless it is already a message of its own (a plain user
 * message after its anchor starts with its text) or it hangs on a plain user
 * message, which the engine keeps whole. A mid-turn delivery with no tool
 * result after it yet is still queued and comes back as `waiting`; one whose
 * anchor was compacted away is kept before the newest message rather than lost.
 */
export function withDeliveries(
  messages: readonly SessionMessage[],
  deliveries: readonly Delivery[],
): { messages: SessionMessage[]; waiting: Delivery[]; restored: Delivery[] } {
  const placed = new Map<number, SessionMessage[]>();
  const waiting: Delivery[] = [];
  const restored: Delivery[] = [];
  for (const delivery of deliveries) {
    if (!delivery.text) continue;
    const anchor =
      delivery.after === undefined
        ? -1
        : messages.findIndex((m) => m.toolResults?.some((r) => r.tool_use_id === delivery.after));
    const own = messages.some(
      (m, i) =>
        i > anchor &&
        isPlainUser(m) &&
        (m.text === delivery.text || m.text.startsWith(`${delivery.text}\n`) || m.text === deliveryText(delivery)),
    );
    if (own) continue;
    let at: number;
    if (delivery.after !== undefined && anchor < 0) {
      // Its anchor was compacted away: keep the words, before the newest message.
      at = Math.max(0, messages.length - 2);
    } else {
      if (delivery.midTurn) {
        at = anchor + 1;
        while (at < messages.length && !messages[at]!.toolResults?.length) at++;
        if (at >= messages.length) {
          waiting.push(delivery);
          continue;
        }
      } else {
        at = Math.min(messages.length - 1, (anchor < 0 ? -1 : anchor) + delivery.past);
        // A delivery that started a turn as a plain user message is that message,
        // whatever words the engine wrapped around it.
        if (isPlainUser(messages[at + 1])) continue;
      }
      // Hung on a plain user message, which goes back whole: the engine keeps it.
      if (isPlainUser(messages[at])) continue;
    }
    if (at < 0) continue;
    placed.set(at, [...(placed.get(at) ?? []), { role: 'user', text: deliveryText(delivery), toolUses: [] }]);
    restored.push(delivery);
  }
  return { messages: messages.flatMap((m, i) => [m, ...(placed.get(i) ?? [])]), waiting, restored };
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

/**
 * What one compaction did to the messages: `listed` is what the engine handed
 * over and `kept` how many of those came back; `whole` of them went back with
 * their handle and `rebuilt` without one; `restored` are the deliveries put
 * back (see `withDeliveries`).
 */
export type Accounting = {
  listed: number;
  kept: number;
  whole: number;
  rebuilt: number;
  restored: Delivery[];
};

/** Counts what `messages` (the list handed back) holds of `listed` and of the restored deliveries. */
export function account(listed: readonly SessionMessage[], messages: readonly SessionMessage[], restored: Delivery[]): Accounting {
  const kept = messages.length - restored.length;
  const whole = messages.filter((m) => m.handle !== undefined).length;
  return { listed: listed.length, kept, whole, rebuilt: kept - whole, restored };
}

/**
 * The banner's first clause. A rebuilt message loses what the engine stores
 * beside it (hook feedback, notices), which no plugin is shown, so the count
 * says how many were rebuilt rather than claim every message survived whole.
 */
export function keptClause(a: Accounting): string {
  const parts = [
    a.rebuilt > 0 ? `${a.rebuilt} rebuilt, without what the host stores beside them` : '',
    a.restored.length > 0 ? `${a.restored.length} delivered prompt(s) put back` : '',
  ].filter(Boolean);
  return `kept ${a.kept}/${a.listed} listed messages${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

/** First line of a receipt. */
export const RECEIPT_HEAD = '[fast-jev-compaction receipt]';

const RECEIPT_MAX_LINES = 12;

/** A delivery's sender and its words without the engine's frame around a peer's message. */
function unframe(delivery: Delivery): { sender: string; words: string } {
  let words = delivery.text.replace(/^Another Claude session sent a message:\s*/, '');
  let sender = delivery.origin;
  const tag = /^<agent-message from="([^"]*)">\s*/.exec(words);
  if (tag) {
    sender = `${sender} ${tag[1]}`;
    words = words.slice(tag[0].length).replace(/\s*<\/agent-message>\s*$/, '');
  }
  // A background task's notification says what it is in its summary.
  const summary = /^<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(words);
  if (summary) words = summary[1]!;
  return { sender, words: words.replace(/\s+/g, ' ').trim() };
}

/** Length of the prefix all `texts` share, cut back to a word boundary; 0 for fewer than two. */
function sharedPrefix(texts: readonly string[]): number {
  if (texts.length < 2) return 0;
  const first = texts[0]!;
  let common = first.length;
  for (const text of texts) {
    let i = 0;
    while (i < common && i < text.length && text[i] === first[i]) i++;
    common = i;
  }
  return common > 0 ? first.lastIndexOf(' ', common) + 1 : 0;
}

/**
 * One line per delivery, its sender and its first words. Deliveries of one
 * origin often open with the same frame (a hand-back preamble, a notification
 * header), so their words start where they stop sharing a prefix.
 */
function deliveryLines(deliveries: readonly Delivery[], max = 100): string[] {
  const items = deliveries.map((d) => ({ origin: d.origin, ...unframe(d) }));
  const common = new Map<string, number>();
  for (const origin of new Set(items.map((i) => i.origin))) {
    common.set(origin, sharedPrefix(items.filter((i) => i.origin === origin).map((i) => i.words)));
  }
  return items.map(({ origin, sender, words }) => {
    const skip = common.get(origin) ?? 0;
    const rest = words.slice(skip);
    return `- ${sender}: ${skip > 0 ? '...' : ''}${rest.length <= max ? rest : `${rest.slice(0, max)}...`}`;
  });
}

/**
 * The message a compaction appends to the history it hands back, so the
 * session reads what was cut instead of inferring it from gaps: how many tool
 * calls were stubbed or deleted, what could not be carried, which delivered
 * prompts were put back, and where the full transcript is. Plain text in a
 * plain user message, which the engine keeps like any other.
 */
export function receipt(result: CompactResult, a: Accounting, transcript?: string): string {
  const { stats } = result;
  const cut = [
    stats.callsStubbed > 0 ? `${stats.callsStubbed} tool call(s) cut to a stub (tool name, head of input and result)` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} result(s) cut to a head` : '',
    stats.callsDropped + stats.stubsDropped > 0
      ? `${stats.callsDropped + stats.stubsDropped} call(s) deleted with their results`
      : '',
  ].filter(Boolean);
  const lines = [
    `${RECEIPT_HEAD} This conversation was just compacted without a summary. Every text message was kept verbatim; ${
      cut.length ? cut.join(', ') : 'no tool call was cut'
    }. Re-run a tool for anything cut.`,
  ];
  if (a.rebuilt > 0) {
    lines.push(
      `Not carried: ${a.rebuilt} message(s) were rebuilt, and whatever the host had stored beside them and never shows a plugin (Stop hook feedback, goal check-ins, notices) did not survive${
        a.restored.length ? ', except the delivered prompts put back below' : ''
      }.`,
    );
  }
  if (a.restored.length > 0) {
    lines.push(`Put back as messages of their own (${a.restored.length}), each where it arrived:`);
    lines.push(...deliveryLines(a.restored).slice(0, RECEIPT_MAX_LINES));
    if (a.restored.length > RECEIPT_MAX_LINES) lines.push(`- and ${a.restored.length - RECEIPT_MAX_LINES} more`);
  }
  lines.push(transcript ? `Full transcript: ${transcript}` : 'The full transcript is the session file under projects/ in the Claude Code config directory.');
  lines.push(
    'A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the transcript before stating it.',
  );
  return lines.join('\n');
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

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  // A host that runs Claude Code as an SDK session (VS Code, the desktop app,
  // `claude -p`) refuses $.session.compact. There the hook nudges instead of
  // failing on every turn: once when context crosses compactAtPercent, then
  // again each NUDGE_STEP points, so the user picks the moment to /compact.
  let cannotCompact = false;
  const nudges: NudgeState = { nudgedAt: Number.NEGATIVE_INFINITY };
  // Prompts delivered beside a message rather than as one, since the last
  // compaction; see `Delivery`. Held in memory: a reload of the plugin forgets
  // them, and the next compaction then cannot put those back.
  let deliveries: Delivery[] = [];

  on('prompt.submit', async ($, event, next) => {
    const midTurn = event.turnId !== undefined && !event.wait;
    const origin = event.origin.kind;
    if (!midTurn && USER_ORIGINS.has(origin)) return next(event);
    const anchor = await $.session.messages().then(anchorOf, () => undefined);
    const entered = await next(event);
    if (anchor && !entered.drop && entered.text) {
      deliveries.push({ text: entered.text, origin, midTurn, ...anchor });
    }
    return entered;
  });

  on('session.compact', async ($, event, next) => {
    nudges.nudgedAt = Number.NEGATIVE_INFINITY;
    // A subagent's transcript never holds the main loop's deliveries.
    const main = event.agentId === undefined;
    const seen = deliveries.length;
    const merged = main
      ? withDeliveries(event.messages, deliveries.slice(0, seen))
      : { messages: [...event.messages], waiting: [], restored: [] };
    // Placed deliveries are now messages (or in the built-in summary); waiting
    // ones arrive after the last tool result of the new transcript.
    const settle = (kept?: readonly SessionMessage[]): void => {
      if (!main) return;
      const anchor = anchorOf(kept ?? []);
      deliveries = [
        ...merged.waiting.map((d) => (kept ? { ...d, ...anchor } : d)),
        ...deliveries.slice(seen),
      ];
    };
    const builtIn = async () => {
      const compacted = await next(event);
      if (!compacted.skip) settle();
      return compacted;
    };
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(merged.messages, config, async (url, init) => {
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
      const accounting = account(event.messages, messages, merged.restored);
      notify($, `${keptClause(accounting)}, no summary (${summarize(result)})`);
      settle(messages);
      if (config.receipt) {
        messages.push({ role: 'user', text: receipt(result, accounting, await transcriptPath($)), toolUses: [] });
      }
      return { messages };
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
