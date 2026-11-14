// A stand-in host for driving the plugin's hooks the way Claude Code calls them,
// with a transcript file built in memory: listed messages carry their record's
// uuid as their handle (measured in a headless probe), and hidden records
// (queued prompts, isMeta messages, system records) sit in the parentUuid chain
// between them. Jev, the file system and processes are stand-ins.
import { register } from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';

export type SessionMessage = Message & { handle?: string };
type Handler = ($: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
type Json = { [key: string]: unknown };

let counter = 0;
/** A fresh uuid-shaped id, as the transcript and the reader expect. */
export function uuid(): string {
  counter++;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], handle: uuid(), ...extra };
}
export function call(id: string, text = 'x'.repeat(3000)): SessionMessage {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `run ${id}` }, text }] });
}
export function result(id: string, text = 'x'.repeat(3000)): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] });
}

/** A listed history: a prompt, two tool rounds, a reply, a plain user message. */
export function history(): SessionMessage[] {
  return [
    message('user', 'Start the two subagents and wait for their reports.'),
    call('t1'),
    result('t1'),
    message('assistant', 'Both are running; I will wait.'),
    message('assistant', 'The report says all 41 rows pass. Next, the ids.'),
    call('t2'),
    result('t2'),
    message('assistant', 'Checked.'),
    message('user', 'Thanks.'),
  ];
}

// ---------------------------------------------------------------------------
// Transcript records

const TS = '2026-11-14T12:00:00.000Z';

/** The record the host writes for a listed message. */
export function recordOf(m: SessionMessage, parent: string | null): Json {
  const content =
    m.role === 'assistant'
      ? [
          ...(m.text ? [{ type: 'text', text: m.text }] : []),
          ...m.toolUses.map((t) => ({ type: 'tool_use', id: t.tool_use_id, name: t.tool, input: t.input })),
        ]
      : m.toolResults?.length
        ? m.toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text }))
        : m.text;
  return { parentUuid: parent, isSidechain: false, type: m.role, message: { role: m.role, content }, uuid: m.handle, timestamp: TS };
}

/** A prompt queued while a turn ran; no origin is what a headless host writes for the user's own. */
export function queued(text: string | Json[], origin?: string): Json {
  return {
    attachment: { type: 'queued_command', prompt: text, commandMode: origin === 'task-notification' ? 'task-notification' : 'prompt', ...(origin ? { origin: { kind: origin } } : {}) },
    type: 'attachment',
  };
}
/** An isMeta user record: a subagent's report (`peer`), or the host's own (no origin). */
export function meta(text: string, origin?: string): Json {
  return { type: 'user', message: { role: 'user', content: text }, isMeta: true, ...(origin ? { origin: { kind: origin } } : {}) };
}
export function stopHookSummary(): Json {
  return { type: 'system', subtype: 'stop_hook_summary', hasOutput: false };
}
/** Another hidden record the host writes after a tool result, not a delivery. */
export function bookkeeping(): Json {
  return { attachment: { type: 'total_tokens_reminder' }, type: 'attachment' };
}

export type Item = SessionMessage | Json;
const isMessage = (x: Item): x is SessionMessage => 'role' in x && 'toolUses' in x;

/**
 * The transcript text for items in order, each record's parentUuid the one
 * before it, as the host chains them. Hidden items get a fresh uuid, returned
 * in `uuids` in item order.
 */
export function transcript(items: readonly Item[], start: { parent?: string | null; lines?: string[] } = {}): { text: string; uuids: string[] } {
  const lines = [...(start.lines ?? [])];
  const uuids: string[] = [];
  let parent = start.parent ?? null;
  for (const item of items) {
    let rec: Json;
    if (isMessage(item)) rec = recordOf(item, parent);
    else {
      const { parentUuid, ...rest } = item as Json & { parentUuid?: string | null };
      rec = { parentUuid: parentUuid !== undefined ? parentUuid : parent, isSidechain: false, ...rest, uuid: (item['uuid'] as string) ?? uuid(), timestamp: TS };
    }
    uuids.push(rec['uuid'] as string);
    lines.push(JSON.stringify(rec));
    parent = rec['uuid'] as string;
  }
  return { text: `${lines.join('\n')}\n`, uuids };
}

/** A compact_boundary record; `preserved` names the uuids of a built-in summary's preserved segment. */
export function boundary(preserved?: string[]): Json {
  return {
    parentUuid: null,
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: {
      trigger: 'manual',
      ...(preserved ? { preservedSegment: { headUuid: preserved[0], tailUuid: preserved.at(-1) }, preservedMessages: { uuids: preserved } } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The host

export type Run = (
  argv: readonly string[],
  init?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const HOME = 'C:\\Users\\me';
export const PATH = 'C:/Users/me/.claude/projects/c--dev-proj/sess-1.jsonl';

/**
 * `file`: the transcript text (undefined: no file). `size` forces what stat
 * answers (past 4 MiB the plugin runs a reader through `run`). `windows`
 * makes `$.env.get('OS')` answer Windows_NT.
 */
export function harness(options: Record<string, unknown> = {}, host: { run?: Run; windows?: boolean; debug?: string[] } = {}) {
  const handlers: Record<string, Handler> = {};
  (register as unknown as (on: unknown, options: unknown) => void)(
    (name: string, handler: Handler) => (handlers[name] = handler),
    { apiKey: 'k', preserveRecentMessages: 1, minReductionRatio: 0, ...options },
  );
  const toasts: string[] = [];
  const bodies: string[] = [];
  const fallbacks: { messages: SessionMessage[] }[] = [];
  const runs: { argv: readonly string[]; env?: Record<string, string>; stdin?: string }[] = [];
  let file: string | undefined;
  let size: number | undefined;
  let jev: ((key: string) => number) | 'fail' = () => 0.1;
  const files = new Map<string, string>();
  const $ = {
    env: {
      get: async (name: string) =>
        name === 'USERPROFILE' ? HOME : name === 'OS' && host.windows ? 'Windows_NT' : name === 'FAST_JEV_DEBUG_LOG' && host.debug ? 'debug.jsonl' : undefined,
    },
    settings: { read: async () => ({}) },
    session: { messages: async () => [], id: async () => 'sess-1', cwd: async () => 'c:\\dev\\proj' },
    fs: {
      exists: async (path: string) => (path === PATH && file !== undefined) || files.has(path),
      stat: async (path: string) => {
        if (path !== PATH || file === undefined) throw new Error('ENOENT');
        return { kind: 'file', size: size ?? new TextEncoder().encode(file).length, mtimeMs: 0 };
      },
      read: async (path: string) => {
        if (path === PATH && file !== undefined) return file;
        if (files.has(path)) return files.get(path)!;
        throw new Error('ENOENT');
      },
      write: async (path: string, text: string) => {
        files.set(path, text);
        if (host.debug) host.debug.splice(0, host.debug.length, ...text.split('\n').filter(Boolean));
      },
    },
    process: {
      run: async (argv: readonly string[], init?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number }) => {
        runs.push({ argv, ...(init?.env ? { env: init.env } : {}), ...(init?.stdin !== undefined ? { stdin: init.stdin } : {}) });
        if (!host.run) throw new Error('no process in this host');
        return host.run(argv, init);
      },
    },
    http: {
      fetch: async (_url: string, init?: { body?: string }) => {
        if (jev === 'fail') return { status: 500, ok: false, text: 'stand-in failure' };
        bodies.push(init?.body ?? '');
        const answer = jev;
        const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
        const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]));
        return { status: 200, ok: true, text: JSON.stringify({ answers }) };
      },
    },
    ui: { log: () => {}, toast: (text: string) => toasts.push(text) },
  };
  return {
    toasts,
    bodies,
    fallbacks,
    runs,
    /** Sets the transcript file's text (undefined: no file) and what stat reports as its size. */
    file: (text: string | undefined, forcedSize?: number) => {
      file = text;
      size = forcedSize;
    },
    jev: (answer: ((key: string) => number) | 'fail') => void (jev = answer),
    /** A prompt `prompt.submit` sees accepted; `origin` a kind. */
    async submit(text: string, origin = 'composer', extra: Record<string, unknown> = {}) {
      const event = { text, origin: { kind: origin }, wait: false, ...extra };
      return handlers['prompt.submit']!($, event, async (e) => ({ text: (e as { text: string }).text, origin: (e as { origin: unknown }).origin }));
    },
    /** One compaction; the fallback (`next`) answers a summary unless `builtIn` says otherwise. */
    async compact(
      messages: SessionMessage[],
      extra: Record<string, unknown> = {},
      builtIn: (e: { messages: SessionMessage[] }) => Promise<unknown> = async () => ({ messages: [message('user', 'BUILT-IN SUMMARY')] }),
    ): Promise<SessionMessage[]> {
      const out = (await handlers['session.compact']!($, { trigger: 'manual', messages, ...extra }, async (e) => {
        fallbacks.push(e as { messages: SessionMessage[] });
        return builtIn(e as { messages: SessionMessage[] });
      })) as { messages?: SessionMessage[] };
      return out.messages ?? [];
    },
  };
}

export const PUT_BACK = /^\[fast-jev-compaction put-back, transcript line (\d+)\] /;
export const NOTE = /^\[fast-jev-compaction note\] /;

/** The put-backs in a history. */
export function putBacks(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages.filter((m) => PUT_BACK.test(m.text));
}

/** The put-backs carrying `words` as one of their (indented) lines. */
export function holding(messages: readonly SessionMessage[], words: string): SessionMessage[] {
  return putBacks(messages).filter((m) => m.text.split('\n').slice(1).includes(`  ${words}`));
}
