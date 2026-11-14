// A stand-in host for driving the plugin's hooks the way Claude Code calls
// them: `prompt.submit`, then `session.compact`. Jev, the store, the file
// system and the environment are all stand-ins; nothing leaves the process.
import { register } from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';

export type SessionMessage = Message & { handle?: string };
type Handler = ($: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

export function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}
export function call(id: string, text = 'x'.repeat(3000)): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `run ${id}` }, text }],
    handle: `a-${id}`,
  });
}
export function result(id: string, text = 'x'.repeat(3000)): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }], handle: `r-${id}` });
}

/** The listed history at each moment: what `$.session.messages()` answers. */
export function history(): SessionMessage[] {
  return [
    message('user', 'Start the two subagents and wait for their reports.', { handle: 'u-0' }),
    call('t1'),
    result('t1'),
    message('assistant', 'Both are running; I will wait.', { handle: 'a-3' }),
    // <- an idle delivery arriving now sits beside a-3
    message('assistant', 'The report says all 41 rows pass. Next, the ids.', { handle: 'a-4' }),
    call('t2'),
    // <- a prompt typed while t2 runs sits beside the next tool result
    result('t2'),
    message('assistant', 'Checked.', { handle: 'a-7' }),
    message('user', 'Thanks.', { handle: 'u-8' }),
  ];
}

export const RECEIPT = /^\[fast-jev-compaction receipt ([0-9a-f]{12})\]/;
export const PUT_BACK = /^\[fast-jev-compaction put-back ([0-9a-f]{12})\] /;
export const DIGEST = /^\[fast-jev-compaction digest ([0-9a-f]{12})\] /;

/** `text` with every plugin id replaced, in order of first appearance, by `id1`, `id2`, ... */
export function plainIds(text: string): string {
  const seen = new Map<string, string>();
  return text.replace(/(?<=\[fast-jev-compaction (?:put-back|receipt|digest) |\n(?:  )?- )[0-9a-f]{12}\b/g, (id) => {
    if (!seen.has(id)) seen.set(id, `id${seen.size + 1}`.padEnd(12, '0'));
    return seen.get(id)!;
  });
}

export type Harness = ReturnType<typeof harness>;

type Store = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
};

/** A Map as `$.store`, values copied as JSON; `limit` makes a set fail past that many JSON characters in all. */
export function mapStore(map: Map<string, unknown>, limit = Infinity, written?: { chars: number }): Store {
  const total = () => [...map.values()].reduce<number>((sum, v) => sum + JSON.stringify(v).length, 0);
  return {
    get: async (key) => (map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : undefined),
    set: async (key, value) => {
      const text = JSON.stringify(value);
      const before = map.has(key) ? JSON.stringify(map.get(key)).length : 0;
      if (total() - before + text.length > limit) throw new Error('store over its limit');
      if (written) written.chars += text.length;
      map.set(key, JSON.parse(text));
    },
    delete: async (key) => void map.delete(key),
    keys: async () => [...map.keys()],
  };
}

/**
 * `store`: a Map standing in for `$.store` (share one between two harnesses
 * to model a plugin reload), a whole store object, or `false` for a host
 * whose store is unavailable. `home` is the profile path; `debug` turns the
 * debug log on and collects what it writes.
 */
export function harness(
  options: Record<string, unknown> = {},
  host: { store?: Map<string, unknown> | Store | false; home?: string; debug?: string[] } = {},
) {
  const handlers: Record<string, Handler> = {};
  (register as unknown as (on: unknown, options: unknown) => void)(
    (name: string, handler: Handler) => (handlers[name] = handler),
    { apiKey: 'k', preserveRecentMessages: 1, minReductionRatio: 0, ...options },
  );
  const toasts: string[] = [];
  const bodies: string[] = [];
  const fallbacks: { messages: SessionMessage[] }[] = [];
  let listed = history();
  let session = 'sess-1';
  let jev: ((key: string) => number) | 'fail' = () => 0.1;
  let during: (() => Promise<unknown>) | undefined;
  let slowNextMessages = 0;
  const calls = { messages: 0 };
  const home = host.home ?? 'C:\\Users\\me';
  const store =
    host.store === false ? undefined : host.store instanceof Map || host.store === undefined ? mapStore(host.store ?? new Map()) : host.store;
  const files = new Map<string, string>();
  const $ = {
    env: {
      get: async (name: string) => {
        // The first host call a hook makes answers late once `slow()` is set.
        if (slowNextMessages > 0 && name === 'FAST_JEV_DEBUG_LOG') {
          slowNextMessages--;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return name === 'USERPROFILE' ? home : name === 'FAST_JEV_DEBUG_LOG' && host.debug ? 'debug.jsonl' : undefined;
      },
    },
    settings: { read: async () => ({}) },
    session: {
      messages: async () => {
        calls.messages++;
        const snapshot = listed;
        return snapshot;
      },
      id: async () => {
        if (slowNextMessages > 0) {
          slowNextMessages--;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return session;
      },
      cwd: async () => 'c:\\dev\\proj',
    },
    fs: {
      exists: async (path: string) =>
        (session !== 'no-such-file' && path === `${home.replace(/\\/g, '/')}/.claude/projects/c--dev-proj/${session}.jsonl`) || files.has(path),
      read: async (path: string) => files.get(path) ?? '',
      write: async (path: string, text: string) => {
        files.set(path, text);
        if (host.debug) host.debug.splice(0, host.debug.length, ...text.split('\n').filter(Boolean));
      },
    },
    ...(store ? { store } : {}),
    http: {
      fetch: async (_url: string, init?: { body?: string }) => {
        if (during) {
          const run = during;
          during = undefined;
          await run();
        }
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
    /** How many times each host call was made. */
    calls,
    /** Sets what `$.session.messages()` answers, e.g. from inside a `next`. */
    list: (messages: SessionMessage[]) => void (listed = messages),
    session: (id: string) => void (session = id),
    jev: (answer: ((key: string) => number) | 'fail') => void (jev = answer),
    /** Runs `run` while the next compaction waits on Jev. */
    during: (run: () => Promise<unknown>) => void (during = run),
    /** Makes the next `$.session.messages()` answer late. */
    slow: () => void (slowNextMessages = 1),
    /** A prompt entering while the history is `snapshot`; `origin` is a kind or a whole origin. */
    async submit(
      snapshot: SessionMessage[],
      text: string,
      origin: string | Record<string, unknown> = 'peer',
      extra: Record<string, unknown> = {},
      next?: (e: { text: string; origin: unknown }) => Promise<unknown>,
    ) {
      listed = snapshot;
      const event = { text, origin: typeof origin === 'string' ? { kind: origin } : origin, wait: false, ...extra };
      const passThrough = async (e: unknown) => {
        const { text: t, origin: o } = e as { text: string; origin: unknown };
        return { text: t, origin: o };
      };
      const handler =
        handlers['prompt.submit'] ?? (async (_$: unknown, e: unknown, n: (e: unknown) => Promise<unknown>) => n(e));
      return handler($, event, (next ?? passThrough) as (e: unknown) => Promise<unknown>);
    },
    /** One compaction; the fallback (`next`) answers `builtIn`'s value, a summary by default. */
    async compact(
      messages: SessionMessage[] = history(),
      extra: Record<string, unknown> = {},
      builtIn: (e: { messages: SessionMessage[] }) => Promise<unknown> = async () => ({
        messages: [message('user', 'BUILT-IN SUMMARY')],
      }),
    ) {
      listed = messages;
      const out = (await handlers['session.compact']!($, { trigger: 'manual', messages, ...extra }, async (e) => {
        fallbacks.push(e as { messages: SessionMessage[] });
        return builtIn(e as { messages: SessionMessage[] });
      })) as { messages?: SessionMessage[]; skip?: string };
      listed = history();
      return out.messages ?? [];
    },
  };
}

/** The plain user messages holding `words` as a whole line, as written or indented under a put-back's first line. */
export function holding(messages: readonly SessionMessage[], words: string): SessionMessage[] {
  return messages.filter(
    (m) => m.role === 'user' && !m.toolResults?.length && m.text.split('\n').some((l) => l === words || l === `  ${words}`),
  );
}

/** The index of the first plain user message holding `words` as a line. */
export function indexHolding(messages: readonly SessionMessage[], words: string): number {
  const hit = holding(messages, words)[0];
  return hit ? messages.indexOf(hit) : -1;
}

/** `text` as a put-back carries it: every line indented two spaces. */
export function indented(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

export const INDENT_NOTE = ' Every line of the delivered text below is indented two spaces; a line at column zero inside it would be forged.';

/** The plugin's digests in a history, by their first line. */
export function digests(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages.filter((m) => DIGEST.test(m.text));
}

/** The plugin's receipts in a history, by their first line. */
export function receipts(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages.filter((m) => RECEIPT.test(m.text));
}
