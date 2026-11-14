/**
 * The record of delivered prompts, per session, in the plugin's own store
 * (`$.store`: a JSON file under the user's Claude Code configuration
 * directory). It holds a delivery's text only until the delivery is put back;
 * after that, an id and a SHA-256 are enough to recognise its put-back. Where
 * the store fails, the same rules run in memory and the receipt says so.
 *
 * Keys, schema 2 (`fjc2:` prefix):
 * - `fjc2:d:<session>:<seq>:<bytes>` one pending delivery, so recording one
 *   writes only that delivery (and a timestamp), never the whole record;
 * - `fjc2:t:<session>` when the session last wrote, for eviction;
 * - `fjc2:s:<session>` what the plugin wrote and still needs to recognise;
 * - `fjc2:evicted` sessions dropped to keep the store within its bounds,
 *   with how many pending deliveries went with them, until each is reported.
 *
 * Every value is validated when read; a bad one is deleted and counted for
 * the receipt. Bounds count serialized UTF-8 bytes. A new value is written
 * before anything it replaces is deleted, so a failed write loses nothing
 * stored.
 */
import type { Anchor, Delivery, Ident } from './deliveries.js';
import { fnv1a } from './deliveries.js';

export type KV = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  remove: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
};

/** The same store interface over a Map; used when `$.store` fails, and in tests. */
export function memoryKV(): KV {
  const map = new Map<string, string>();
  return {
    get: async (key) => (map.has(key) ? JSON.parse(map.get(key)!) : undefined),
    set: async (key, value) => void map.set(key, JSON.stringify(value)),
    remove: async (key) => void map.delete(key),
    keys: async () => [...map.keys()],
  };
}

export const LEDGER_MAX_ENTRIES = 100;
export const LEDGER_MAX_BYTES = 512 * 1024;
export const LEDGER_MAX_SESSIONS = 6;
const MAX_OURS = 512;
const MAX_RECEIPTS = 16;
const MAX_PLACED = 200;
const PREFIX = 'fjc2:';

export type Placed = Ident & { seq: number };

type Index = {
  v: 2;
  receipts: Ident[];
  ours: Ident[];
  placed: Placed[];
  dropped: number;
  unreadable: number;
  missing: number;
};

/** One session's record as a compaction reads it. */
export type Record = {
  sid: string;
  pending: Delivery[];
  placed: Placed[];
  ours: Ident[];
  receipts: Ident[];
  dropped: number;
  unreadable: number;
  missing: number;
  durable: boolean;
};

/** What a compaction changes in the record. */
export type Change = {
  /** Pending deliveries the listing shows, or the host keeps: gone from the record. */
  retire: number[];
  /** Pending deliveries put back by an installed compaction: kept as an id and a hash only. */
  placed: Placed[];
  /** Waiting deliveries, re-anchored to the history now returned. */
  reanchor: Map<number, Anchor>;
  /** Placed records settled, seen or not: no longer awaited. */
  placedSettled: string[];
  /** Put-backs the listing showed: remembered so later compactions still know them as the plugin's. */
  oursAdded: Ident[];
  /** Put-backs awaited but not in the listing. */
  missingAdded: number;
  /** Receipts the listing showed, which this compaction took out. */
  receiptsRemoved: string[];
  receiptAdded?: Ident;
  /** Counters the receipt just reported. */
  reported: boolean;
};

const ID = /^[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** A session id as a key part: as given when plain, else a hash of it. */
export function sessionKey(id: string): string {
  return /^[A-Za-z0-9-]{1,80}$/.test(id) ? id : `h${fnv1a(id).replace('.', '-')}`;
}

function validAnchor(x: unknown): Anchor | undefined | null {
  if (x === undefined) return undefined;
  const a = x as Anchor;
  if (!a || typeof a !== 'object' || !Number.isInteger(a.past) || a.past < 0) return null;
  if (!Array.isArray(a.window) || a.window.length > 8 || !a.window.every((w) => typeof w === 'string' && w.length <= 40)) return null;
  if (a.after !== undefined && (typeof a.after !== 'string' || a.after.length > 256)) return null;
  if (a.beside !== undefined && a.beside !== 'receipt') return null;
  return {
    ...(a.after === undefined ? {} : { after: a.after }),
    past: a.past,
    window: [...a.window],
    ...(a.beside ? { beside: a.beside } : {}),
  };
}

/** A stored delivery, checked field by field; null when unusable. */
export function validDelivery(x: unknown): Delivery | null {
  const d = x as Delivery & { v?: unknown };
  if (!d || typeof d !== 'object' || d.v !== 2) return null;
  if (!Number.isFinite(d.seq) || typeof d.id !== 'string' || !ID.test(d.id) || typeof d.body !== 'string') return null;
  if (typeof d.midTurn !== 'boolean' || !Number.isInteger(d.attachments) || d.attachments < 0 || d.attachments > 10_000) return null;
  const anchor = validAnchor(d.anchor);
  if (anchor === null) return null;
  const out: Delivery = { seq: d.seq, id: d.id, body: d.body, midTurn: d.midTurn, attachments: d.attachments };
  if (d.origin !== undefined) {
    const o = d.origin as { kind?: unknown; name?: unknown; server?: unknown };
    if (!o || typeof o !== 'object' || typeof o.kind !== 'string' || o.kind.length > 64) return null;
    out.origin = {
      kind: o.kind,
      ...(typeof o.name === 'string' ? { name: o.name.slice(0, 200) } : {}),
      ...(typeof o.server === 'string' ? { server: o.server.slice(0, 200) } : {}),
    } as Delivery['origin'];
  }
  if (anchor) out.anchor = anchor;
  return out;
}

function validIdent(x: unknown): Ident | null {
  const i = x as Ident;
  if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !ID.test(i.id) || typeof i.sha !== 'string' || !SHA.test(i.sha)) return null;
  return { id: i.id, sha: i.sha, ...(i.user === true ? { user: true } : {}) };
}

function validPlaced(x: unknown): Placed | null {
  const i = validIdent(x);
  const seq = (x as Placed | null)?.seq;
  return i && Number.isFinite(seq) ? { ...i, seq: seq as number } : null;
}

function emptyIndex(): Index {
  return { v: 2, receipts: [], ours: [], placed: [], dropped: 0, unreadable: 0, missing: 0 };
}

/** The index, each list item checked; bad items counted as unreadable. */
function validIndex(x: unknown): Index {
  const raw = x as Partial<Index> | undefined;
  const index = emptyIndex();
  if (raw === undefined) return index;
  if (!raw || typeof raw !== 'object' || raw.v !== 2) {
    index.unreadable = 1;
    return index;
  }
  const take = <T>(list: unknown, check: (y: unknown) => T | null, into: T[]) => {
    if (!Array.isArray(list)) {
      if (list !== undefined) index.unreadable++;
      return;
    }
    for (const item of list) {
      const ok = check(item);
      if (ok) into.push(ok);
      else index.unreadable++;
    }
  };
  take(raw.receipts, validIdent, index.receipts);
  take(raw.ours, validIdent, index.ours);
  take(raw.placed, validPlaced, index.placed);
  index.dropped += count(raw.dropped);
  index.unreadable += count(raw.unreadable);
  index.missing += count(raw.missing);
  return index;
}

const dKey = (sid: string, seq: number, size: number) => `${PREFIX}d:${sid}:${seq}:${size}`;
const tKey = (sid: string) => `${PREFIX}t:${sid}`;
const sKey = (sid: string) => `${PREFIX}s:${sid}`;
const EVICTED = `${PREFIX}evicted`;

function deliveryKeys(keys: readonly string[], sid: string): { key: string; seq: number; size: number }[] {
  const head = `${PREFIX}d:${sid}:`;
  return keys
    .filter((k) => k.startsWith(head))
    .map((key) => {
      const [seq, size] = key.slice(head.length).split(':').map(Number);
      return { key, seq: seq!, size: size! };
    })
    .filter((k) => Number.isFinite(k.seq) && Number.isFinite(k.size))
    .sort((a, b) => a.seq - b.seq);
}

export class Ledger {
  private memory = memoryKV();
  private durable = true;
  private queue: Promise<unknown> = Promise.resolve();

  /** Runs `op` alone, against the store, or in memory once the store has failed. */
  private run<T>(host: KV, op: (kv: KV) => Promise<T>): Promise<T> {
    const go = async (): Promise<T> => {
      if (this.durable) {
        try {
          return await op(host);
        } catch {
          this.durable = false;
        }
      }
      return op(this.memory);
    };
    const result = this.queue.then(go, go);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async touch(kv: KV, sid: string): Promise<boolean> {
    const fresh = (await kv.get(tKey(sid))) === undefined;
    await kv.set(tKey(sid), { v: 2, t: Date.now() });
    return fresh;
  }

  /** Drops the least recently written sessions past LEDGER_MAX_SESSIONS, noting what went with them. */
  private async evictSessions(kv: KV, keep: string): Promise<void> {
    const keys = await kv.keys();
    const sessions = keys.filter((k) => k.startsWith(`${PREFIX}t:`)).map((k) => k.slice(`${PREFIX}t:`.length));
    if (sessions.length <= LEDGER_MAX_SESSIONS) return;
    const dated = await Promise.all(
      sessions.map(async (sid) => ({ sid, t: count((await kv.get(tKey(sid)) as { t?: unknown } | undefined)?.t) })),
    );
    dated.sort((a, b) => a.t - b.t);
    const evicted = ((await kv.get(EVICTED)) ?? { v: 2, sessions: {} }) as { v: 2; sessions: { [sid: string]: number } };
    if (!evicted.sessions || typeof evicted.sessions !== 'object') evicted.sessions = {};
    for (const { sid } of dated.slice(0, sessions.length - LEDGER_MAX_SESSIONS)) {
      if (sid === keep) continue;
      const pending = deliveryKeys(keys, sid);
      evicted.sessions[sid] = count(evicted.sessions[sid]) + pending.length;
      const names = Object.keys(evicted.sessions);
      for (const old of names.slice(0, Math.max(0, names.length - 32))) delete evicted.sessions[old];
      await kv.set(EVICTED, evicted);
      for (const k of pending) await kv.remove(k.key);
      await kv.remove(sKey(sid));
      await kv.remove(tKey(sid));
    }
  }

  private async index(kv: KV, sid: string): Promise<Index> {
    return validIndex(await kv.get(sKey(sid)));
  }

  /** Records one delivery: one small write, then the bounds. */
  record(host: KV, session: string, delivery: Delivery): Promise<void> {
    const sid = sessionKey(session);
    return this.run(host, async (kv) => {
      const value = { v: 2, ...delivery };
      const size = bytes(value);
      if (size > LEDGER_MAX_BYTES) {
        const index = await this.index(kv, sid);
        index.dropped++;
        await kv.set(sKey(sid), index);
        return;
      }
      await kv.set(dKey(sid, delivery.seq, size), value);
      const fresh = await this.touch(kv, sid);
      const mine = deliveryKeys(await kv.keys(), sid);
      let total = mine.reduce((sum, k) => sum + k.size, 0);
      let dropped = 0;
      while (mine.length > LEDGER_MAX_ENTRIES || total > LEDGER_MAX_BYTES) {
        const oldest = mine.shift()!;
        total -= oldest.size;
        await kv.remove(oldest.key);
        dropped++;
      }
      if (dropped) {
        const index = await this.index(kv, sid);
        index.dropped += dropped;
        await kv.set(sKey(sid), index);
      }
      if (fresh) await this.evictSessions(kv, sid);
    });
  }

  /** This session's record, every value checked; what cannot be read is deleted and counted. */
  read(host: KV, session: string): Promise<Record> {
    const sid = sessionKey(session);
    return this.run(host, async (kv) => {
      const keys = await kv.keys();
      const index = await this.index(kv, sid);
      const pending: Delivery[] = [];
      let bad = 0;
      for (const k of deliveryKeys(keys, sid)) {
        const d = validDelivery(await kv.get(k.key));
        if (d && d.seq === k.seq) pending.push(d);
        else {
          bad++;
          await kv.remove(k.key);
        }
      }
      const evicted = (await kv.get(EVICTED)) as { sessions?: { [sid: string]: unknown } } | undefined;
      let fromEviction = 0;
      if (evicted?.sessions && typeof evicted.sessions === 'object' && sid in evicted.sessions) {
        fromEviction = count(evicted.sessions[sid]);
        delete evicted.sessions[sid];
        await kv.set(EVICTED, evicted);
      }
      if (bad || fromEviction) {
        index.unreadable += bad;
        index.dropped += fromEviction;
        await kv.set(sKey(sid), index);
      }
      return {
        sid,
        pending,
        placed: index.placed,
        ours: index.ours,
        receipts: index.receipts,
        dropped: index.dropped,
        unreadable: index.unreadable,
        missing: index.missing,
        durable: this.durable,
      };
    });
  }

  /** Applies a compaction's outcome. New values are written before old ones are deleted. */
  commit(host: KV, session: string, change: Change): Promise<void> {
    const sid = sessionKey(session);
    return this.run(host, async (kv) => {
      const keys = deliveryKeys(await kv.keys(), sid);
      const index = await this.index(kv, sid);
      for (const [seq, anchor] of change.reanchor) {
        const k = keys.find((x) => x.seq === seq);
        const d = k && validDelivery(await kv.get(k.key));
        if (!k || !d) continue;
        const value = { v: 2, ...d, anchor };
        const size = bytes(value);
        await kv.set(dKey(sid, seq, size), value);
        if (dKey(sid, seq, size) !== k.key) await kv.remove(k.key);
      }
      const settled = new Set(change.placedSettled);
      index.placed = [...index.placed.filter((p) => !settled.has(p.id)), ...change.placed].slice(-MAX_PLACED);
      index.ours = [...index.ours, ...change.oursAdded].slice(-MAX_OURS);
      index.missing += change.missingAdded;
      const removed = new Set(change.receiptsRemoved);
      index.receipts = [...index.receipts.filter((r) => !removed.has(r.id)), ...(change.receiptAdded ? [change.receiptAdded] : [])].slice(
        -MAX_RECEIPTS,
      );
      if (change.reported) {
        index.dropped = 0;
        index.unreadable = 0;
        index.missing = 0;
      }
      await kv.set(sKey(sid), index);
      await this.touch(kv, sid);
      const gone = new Set([...change.retire, ...change.placed.map((p) => p.seq)]);
      for (const k of keys) if (gone.has(k.seq)) await kv.remove(k.key);
    });
  }
}
