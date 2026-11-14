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
  type Carry,
  classOf,
  Confirmations,
  decideCarry,
  fnv1a,
  insertPutBacks,
  noteText,
  type PutBackOptions,
  putBackText,
  sha256,
  submitKind,
  taskListText,
  USER_KINDS,
  withoutPluginMessages,
} from './deliveries.js';
import { type Found, neighbourOf, type Oversize, readWindow, type Window } from './transcript.js';
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
  /** End the compacted history with a note of what was cut and put back. */
  note: boolean;
} & PutBackOptions;

/**
 * Put-back defaults, set from the seven windows of a real session (DESIGN-NOTES.md,
 * "The budget"): put-backs cost about a tenth of what a compaction saves.
 */
export const PUT_BACK_DEFAULTS: PutBackOptions = {
  putBackBudget: 15_000,
  reportHeadChars: 400,
  taskHeadChars: 200,
  hostLineChars: 120,
  unconfirmedBudget: 20_000,
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
    note: typeof options['note'] === 'boolean' ? options['note'] : true,
    putBackBudget: optionNumber(options, 'putBackBudget', PUT_BACK_DEFAULTS.putBackBudget),
    reportHeadChars: optionNumber(options, 'reportHeadChars', PUT_BACK_DEFAULTS.reportHeadChars),
    taskHeadChars: optionNumber(options, 'taskHeadChars', PUT_BACK_DEFAULTS.taskHeadChars),
    hostLineChars: optionNumber(options, 'hostLineChars', PUT_BACK_DEFAULTS.hostLineChars),
    unconfirmedBudget: optionNumber(options, 'unconfirmedBudget', PUT_BACK_DEFAULTS.unconfirmedBudget),
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

/**
 * A maintainer's aid, off unless the environment variable FAST_JEV_DEBUG_LOG
 * names a file: each `session.compact` dispatch appends one JSON line of
 * values the plugin computed (lengths, 32-bit hashes, tool ids, roles, counts,
 * transcript line numbers, its own fixed strings), never text from a message.
 * The file is cut back to its newest half past 1 MiB.
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

/** Every message of a list, as values the plugin computed. */
function listSummary(messages: readonly SessionMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    chars: m.text.length,
    hash: fnv1a(m.text),
    ...(m.toolUses.length ? { uses: m.toolUses.map((t) => t.tool_use_id) } : {}),
    ...(m.toolResults?.length ? { results: m.toolResults.map((r) => r.tool_use_id) } : {}),
    handle: m.handle ?? null,
  }));
}

function chars(messages: readonly SessionMessage[]): number {
  return messages.reduce((sum, m) => sum + messageChars(m as unknown as Message), 0);
}

export type PutBackReport = {
  placed: { listedIndex: number; line: number; text: string }[];
  /** Put back whole: the user's confirmed prompts, and everything else. */
  wholeUser: number;
  whole: number;
  /** Task notifications carried as lines of the one task list. */
  tasks: number;
  shortened: { found: Found; confirmed: boolean; carry: Carry }[];
  leftToHost: number;
  unlisted: number;
  oversize: Oversize[];
  since?: number;
  stoodDown?: string;
  readerMs?: number;
  via?: string;
};

export function emptyReport(): PutBackReport {
  return { placed: [], wholeUser: 0, whole: 0, tasks: 0, shortened: [], leftToHost: 0, unlisted: 0, oversize: [] };
}

/**
 * What to put back, from a window the reader returned: each delivery whose
 * neighbour went back without its handle (rebuilt or deleted), carried as
 * `decideCarry` says; task notifications as one list after the last of their
 * neighbours. User-attributed records claim confirmations in transcript order,
 * all of them, whatever their fate, so a later record cannot take an entry an
 * earlier one owns. Stands down, reporting why, when a listed handle is not in
 * the file, or when a window with a rebuilt tool round holds no hidden record
 * at all (the format may have changed; and if it has not, there was nothing to
 * put back).
 */
export async function planPutBacks(
  listed: readonly SessionMessage[],
  rebuilt: ReadonlySet<string>,
  w: Window,
  confirmations: Confirmations,
  options: PutBackOptions,
): Promise<PutBackReport> {
  const handles = listed.map((m) => m.handle).filter((h): h is string => typeof h === 'string');
  const report = emptyReport();
  const missing = handles.filter((h) => !w.found.has(h));
  if (missing.length > 0) return { ...report, stoodDown: `${missing.length} listed message(s) are not in the transcript file` };
  const rebuiltToolRound = listed.some((m) => m.handle !== undefined && rebuilt.has(m.handle) && (m.toolResults?.length ?? 0) > 0);
  if (w.hidden === 0 && rebuiltToolRound) {
    return { ...report, stoodDown: 'the transcript shows no hidden record since the last compaction, though tool calls ran; its format may have changed' };
  }
  const index = new Map(handles.map((h) => [h, listed.findIndex((m) => m.handle === h)] as const));
  const handleSet = new Set(handles);
  const confirmed = new Map<string, boolean>();
  for (const d of [...w.deliveries].sort((x, y) => x.line - y.line)) {
    if (USER_KINDS.has(d.kind)) confirmed.set(d.uuid, confirmations.confirm(d.uuid, await sha256(d.body)));
  }
  const acted: { found: Found; confirmed: boolean; listedIndex: number }[] = [];
  const tasks: { found: Found; listedIndex: number }[] = [];
  for (const d of w.deliveries) {
    const nb = neighbourOf(d, w, handleSet);
    if ('summary' in nb) continue;
    if ('unlisted' in nb) {
      report.unlisted++;
      continue;
    }
    if (!rebuilt.has(nb.at)) {
      report.leftToHost++;
      continue;
    }
    if (classOf(d.kind) === 'task') tasks.push({ found: d, listedIndex: index.get(nb.at)! });
    else acted.push({ found: d, confirmed: confirmed.get(d.uuid) === true, listedIndex: index.get(nb.at)! });
  }
  const carry = decideCarry(acted, options);
  acted.forEach((a, i) => {
    report.placed.push({ listedIndex: a.listedIndex, line: a.found.line, text: putBackText(a.found, a.confirmed, carry[i]!) });
    if (carry[i]!.mode !== 'whole') report.shortened.push({ found: a.found, confirmed: a.confirmed, carry: carry[i]! });
    else if (classOf(a.found.kind) === 'user' && a.confirmed) report.wholeUser++;
    else report.whole++;
  });
  if (tasks.length > 0) {
    // One list, after the last message a notice sat beside: every notice it
    // lists had arrived by then, and none is put before its own arrival.
    const last = tasks.reduce((x, y) => (y.listedIndex > x.listedIndex || (y.listedIndex === x.listedIndex && y.found.line > x.found.line) ? y : x));
    report.placed.push({ listedIndex: last.listedIndex, line: last.found.line, text: taskListText(tasks.map((t) => t.found), options) });
    report.tasks = tasks.length;
  }
  report.oversize = w.oversize.filter((x) => x.delivery && x.line > w.boundary);
  report.since = w.start;
  return report;
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
  // The one thing the plugin remembers, in memory only: an entry per prompt
  // prompt.submit accepted from the user while a turn ran. Each confirms one
  // transcript record with the same text (Confirmations).
  const confirmations = new Confirmations();

  on('prompt.submit', async ($, event, next) => {
    const entered = await next(event);
    if (event.turnId !== undefined && entered.drop === undefined && USER_KINDS.has(submitKind(entered.origin))) {
      confirmations.add(await sha256(entered.text));
    }
    return entered;
  });

  on('session.compact', async ($, event, next) => {
    nudges.nudgedAt = Number.NEGATIVE_INFINITY;
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const listed = event.messages;
      const goal = config.goal ?? goalFromMessages(withoutPluginMessages(listed) as unknown as Message[]);
      const { result, messages } = await compactSession(listed, { ...config, goal }, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify($, `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`);
        return next(event);
      }

      // What the host stored beside a message it no longer gets back whole.
      const kept = new Set(messages.map((m) => m.handle).filter((h): h is string => typeof h === 'string'));
      const rebuilt = new Set(listed.map((m) => m.handle).filter((h): h is string => typeof h === 'string' && !kept.has(h)));
      const transcript = await transcriptPath($);
      let report = emptyReport();
      if (event.agentId !== undefined) {
        // A subagent's own transcript is not the session file this reads.
      } else if (rebuilt.size > 0) {
        if (!transcript) report.stoodDown = 'the transcript file was not found';
        else {
          try {
            // Windows PowerShell by its full path, so no PATH entry or file in the
            // working directory decides what runs; the bare name only when absent.
            const root = (await $.env.get('OS')) === 'Windows_NT' ? (await $.env.get('SystemRoot')) || 'C:\\Windows' : undefined;
            const full = root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : undefined;
            const shell = full === undefined ? undefined : (await $.fs.exists(full)) ? full : 'powershell';
            const read = await readWindow(
              {
                stat: (path) => $.fs.stat(path),
                read: (path) => $.fs.read(path),
                run: (argv, init) => $.process.run(argv, init),
              },
              shell,
              transcript,
              listed.map((m) => m.handle).filter((h): h is string => typeof h === 'string'),
              () => Date.now(),
            );
            report = { ...(await planPutBacks(listed, rebuilt, read.window, confirmations, config)), readerMs: read.ms, via: read.via };
          } catch (error) {
            report.stoodDown = `the transcript could not be read (${error instanceof Error ? error.message : String(error)})`;
          }
        }
      }
      let out = insertPutBacks(messages, sourceIndices(listed, messages), report.placed);
      const putBackChars = chars(out) - chars(messages);
      // A subagent's compaction gets no note: the transcript it would name is the main session's.
      if (config.note && event.agentId === undefined) {
        out = [
          ...out,
          {
            role: 'user',
            toolUses: [],
            text: noteText({
              listed: listed.length,
              kept: messages.length,
              rebuilt: rebuilt.size,
              stubbed: result.stats.callsStubbed,
              resultsCut: result.stats.resultsDropped,
              callsDeleted: result.stats.callsDropped + result.stats.stubsDropped,
              ...(report.since !== undefined ? { since: report.since } : {}),
              ...(report.stoodDown !== undefined ? { stoodDown: report.stoodDown } : {}),
              wholeUser: report.wholeUser,
              whole: report.whole,
              tasks: report.tasks,
              shortened: report.shortened,
              leftToHost: report.leftToHost,
              unlisted: report.unlisted,
              oversize: report.oversize,
              ...(transcript ? { transcript } : {}),
            }),
          },
        ];
      }
      const before = chars(listed);
      const saved = before - chars(messages);
      const ratio = before > 0 ? 1 - chars(out) / before : 0;
      const parts = [
        `${rebuilt.size} rebuilt or deleted`,
        report.placed.length > 0
          ? `put back: ${report.wholeUser} of the user's prompts whole, ${report.whole} others whole, ${report.shortened.length} shortened${report.tasks > 0 ? `, ${report.tasks} task notice(s) in one list` : ''}`
          : '',
        report.leftToHost > 0 ? `${report.leftToHost} left to the host` : '',
        report.unlisted > 0 ? `${report.unlisted} beside messages not listed` : '',
        report.stoodDown ? `put-backs stood down: ${report.stoodDown}` : '',
      ].filter(Boolean);
      const cost = report.placed.length > 0 && saved > 0 ? `; put-backs ${putBackChars} chars, ${percent(putBackChars / saved)} of the saving` : '';
      const reader = report.readerMs !== undefined ? `; transcript read by ${report.via} in ${report.readerMs} ms` : '';
      await debugLog($, {
        ev: 'session.compact',
        trigger: event.trigger,
        agentId: event.agentId ?? null,
        listed: listSummary(listed),
        rebuilt: rebuilt.size,
        placed: report.placed.map((p) => p.line),
        shortened: report.shortened.map((s) => s.found.line),
        tasks: report.tasks,
        leftToHost: report.leftToHost,
        unlisted: report.unlisted,
        stoodDown: report.stoodDown ?? null,
        readerMs: report.readerMs ?? null,
        via: report.via ?? null,
        putBackChars,
      });
      if (ratio < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum with put-backs: ${percent(ratio)}${cost}; ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${listed.length} listed messages (${parts.join('; ')}), no summary (${percent(ratio)} smaller as returned${
          report.placed.length > 0 ? `, ${percent(saved / before)} before put-backs` : ''
        }${cost}${reader}; ${summarize(result)})`,
      );
      return { messages: out };
    } catch (error) {
      notify($, `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
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
