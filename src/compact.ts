import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState, goalFromMessages, isPinned } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  dropCalls: true,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    dropCalls: typeof options.dropCalls === 'boolean' ? options.dropCalls : DEFAULT_OPTIONS.dropCalls,
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * `alreadyStub` marks a call an earlier compaction already cut to a stub
 * (see `alreadyStubbed`). Stubbing it again would cut nothing, so when Jev
 * still rates it as no longer needed it is deleted: a stub lasts one
 * compaction. Without this, stubs pile up across compactions, each pass has
 * less it can cut, and a long session's compaction ends below
 * `minReductionRatio` and falls back to the built-in summary.
 */
export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'> & Partial<Pick<ResolvedCompactOptions, 'dropCalls'>>,
  alreadyStub = false,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  if (options.dropCalls === false) {
    if (alreadyStub) return { ...base, action: 'drop_call', reason: 'stub_dropped' };
    return { ...base, action: 'stub_call', reason: 'call_stubbed' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

const RESULT_NOTE = /\[fast-jev-compaction (?:truncated \d+ chars of this tool result|stub\])/;

/** Appended to a stubbed result too short to truncate, so `alreadyStubbed` knows it. */
const STUB_NOTE = '[fast-jev-compaction stub]';

/**
 * The ids of calls an earlier compaction already cut: the result carries this
 * plugin's truncation note, and the input is either already cut to
 * `input_head` and `note` or short enough that stubbing leaves it as it is.
 */
export function alreadyStubbed(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  headChars: number,
): Set<string> {
  const results = new Map<string, string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, result.text);
    for (const tool of message.toolUses) {
      if (tool.text !== undefined && !results.has(tool.tool_use_id)) results.set(tool.tool_use_id, tool.text);
    }
  }
  const ids = new Set<string>();
  for (const call of calls) {
    if (!RESULT_NOTE.test(results.get(call.tool_use_id) ?? '')) continue;
    const keys = Object.keys(call.input).sort().join(',');
    if (keys === 'input_head,note' || truncatedInput(call.input, headChars) === call.input) {
      ids.add(call.id);
    }
  }
  return ids;
}

function truncatedResultText(text: string, isError: boolean, headChars: number, stub = false): string {
  if (text.length <= headChars + 120) {
    return stub && !RESULT_NOTE.test(text) ? `${text}${text ? '\n' : ''}${STUB_NOTE}` : text;
  }
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

function truncatedInput(input: Record<string, unknown>, headChars: number): Record<string, unknown> {
  const json = JSON.stringify(input);
  if (json.length <= headChars + 120) return input;
  return {
    input_head: json.slice(0, headChars),
    note: `[fast-jev-compaction truncated ${json.length - headChars} chars of this tool input]`,
  };
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note;
 * a stubbed call keeps its tool name with input and result both cut to a head.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        const action = actions.get(tool.tool_use_id);
        if (action !== 'drop_result' && action !== 'stub_call') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
          action === 'stub_call' && tool.text !== undefined,
        );
        const input = action === 'stub_call' ? truncatedInput(tool.input, headChars) : tool.input;
        if ((tool.text ?? '') === text && input === tool.input) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        const action = actions.get(result.tool_use_id);
        if (action !== 'drop_result' && action !== 'stub_call') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars, action === 'stub_call');
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

type StateGroup = { state: ReturnType<typeof fitState>; calls: ToolCall[] };

function tooLarge(error: unknown): boolean {
  return String((error as Error)?.message).startsWith('history too large for Jev');
}

/**
 * One state for all candidates when the history fits `maxStateTokens`. When it
 * does not (long sessions), the candidates are split into contiguous windows,
 * halved until each window's state fits: a window's state keeps the goal, the
 * first message, the pinned newest messages and its own messages in full, and
 * leaves the rest of the history out. Relevance of an old call depends mostly
 * on the goal and the recent turns, which every window carries. A call whose
 * window cannot fit even alone is returned in `unasked`; it gets no answer and
 * therefore stays, like any call Jev was not asked about.
 */
export function stateGroups(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  candidates: readonly ToolCall[],
  options: ResolvedCompactOptions,
): { groups: StateGroup[]; unasked: ToolCall[]; stage: string } {
  try {
    const state = fitState(messages, calls, options);
    return { groups: [{ state, calls: [...candidates] }], unasked: [], stage: state.stage };
  } catch (error) {
    if (!tooLarge(error)) throw error;
  }
  const windowOptions = { ...options, goal: options.goal || goalFromMessages(messages) };
  const groups: StateGroup[] = [];
  const unasked: ToolCall[] = [];
  const fit = (group: ToolCall[]): void => {
    const lo = Math.min(...group.map((call) => call.callIndex));
    const hi = Math.max(...group.map((call) => call.resultIndex));
    const inWindow = new Set(group.map((call) => call.id));
    const view = messages.map((message, i) =>
      (i >= lo && i <= hi) || isPinned(i, messages.length, options.preserveRecentMessages)
        ? message
        : { ...message, text: '' },
    );
    try {
      const state = fitState(view, calls.filter((call) => call.pinned || inWindow.has(call.id)), windowOptions);
      groups.push({ state, calls: group });
    } catch (error) {
      if (!tooLarge(error)) throw error;
      if (group.length === 1) {
        unasked.push(group[0]!);
        return;
      }
      const half = Math.ceil(group.length / 2);
      fit(group.slice(0, half));
      fit(group.slice(half));
    }
  };
  const half = Math.ceil(candidates.length / 2);
  fit(candidates.slice(0, half));
  if (candidates.length > half) fit(candidates.slice(half));
  const stage = `windows:${groups.length}${unasked.length > 0 ? ` unasked:${unasked.length}` : ''}`;
  return { groups, unasked, stage };
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions; when it cannot be fitted, the
 * calls are asked in windows (see `stateGroups`). Throws when Jev fails; the
 * caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let requests = 0;
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const { groups, stage } = stateGroups(messages, calls, candidates, resolved);
    fitted = { tokens: Math.max(0, ...groups.map((group) => group.state.tokens)), stage };
    const jobs = groups.flatMap((group) =>
      batchCalls(group.calls, group.state.tokens, resolved).map((batch) => ({ state: group.state.state, batch })),
    );
    requests = jobs.length;
    const answered = await Promise.all(jobs.map((job) => askBatch(asker, job.state, job.batch)));
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const stale = alreadyStubbed(messages, calls, resolved.truncateHeadChars);
  const decisions = calls.map((call) =>
    decideCall(
      call,
      answers.get(call.id) ?? { keepCall: 1, keepResult: 1 },
      resolved,
      stale.has(call.id),
    ),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      callsStubbed: count(decisions, 'call_stubbed'),
      stubsDropped: count(decisions, 'stub_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests,
      ms: Date.now() - started,
    },
  };
}
