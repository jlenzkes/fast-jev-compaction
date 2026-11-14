/**
 * The record of delivered prompts, per session, in the plugin's own store
 * (`$.store`: a JSON file under the user's Claude Code configuration
 * directory). It holds a delivery's text only until the delivery is put back;
 * after that, an id and a SHA-256 are enough to recognise its put-back. Where
 * the store fails, the same rules run in memory and the receipt says so.
 *
 * Keys, schema 2 (`fjc2:` prefix):
 * - `fjc2:d:<session>:<seq>:<bytes>:<u|o>` one pending delivery (`u` from the
 *   user, `o` from anyone else), so recording one writes only that delivery
 *   and a timestamp, and the bounds are read off the key names;
 * - `fjc2:t:<session>` when the session last wrote, for eviction;
 * - `fjc2:s:<session>` what the plugin wrote and still needs to recognise, and
 *   what it dropped, until the next receipt names it;
 * - `fjc2:evicted` sessions dropped to keep the store within its bounds, with
 *   what went with them, until each is reported.
 * Keys of the earlier `deliveries:` schema are removed when found and counted.
 *
 * Every value is validated when read; a bad one is deleted and counted for
 * the receipt. Bounds count serialized UTF-8 bytes. A new value is written
 * before anything it replaces is deleted, so a failed write loses nothing
 * stored.
 */
import type { Anchor, Delivery, Ident } from './deliveries.js';
import { excerptOf, fnv1a, speaker } from './deliveries.js';

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

/*
 * Sizes. Basis: the largest window of a real session's transcript (replayed
 * on 14 Nov 2026) recorded 198 deliveries, 573 KiB serialized, 82 of them idle
 * notices the host lists as its own message (which no longer take a slot).
 * The per-session bounds give that window twice its count and close to twice
 * its size; the store-wide bound keeps every session's pending text under the
 * host's 4 MiB limit for the plugin's whole store.
 */
export const LEDGER_MAX_ENTRIES = 400;
export const LEDGER_MAX_BYTES = 1024 * 1024;
export const LEDGER_MAX_STORE_BYTES = 3 * 1024 * 1024;
export const LEDGER_MAX_SESSIONS = 8;
const MAX_OURS = 512;
const MAX_RECEIPTS = 16;
const MAX_PLACED = 400;
const MAX_NAMED = 50;
const PREFIX = 'fjc2:';
const OLD_PREFIX = 'deliveries:';

export type Placed = Ident & { seq: number };

/** A delivery dropped at a bound: what the next receipt names it by. */
export type Dropped = { id: string; kind: string; words: string };

type Index = {
  v: 2;
  receipts: Ident[];
  ours: Ident[];
  placed: Placed[];
  dropped: number;
  named: Dropped[];
  unreadable: number;
  old: number;
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
  named: Dropped[];
  unreadable: number;
  old: number;
  missing: number;
  durable: boolean;
};

/** What a compaction changes in the record. */
export type Change = {
  /** Pending deliveries the listing shows, the host keeps, or a placed digest names: their text goes. */
  retire: number[];
  /** Put-backs (and digests) of an installed compaction: kept as an id and a hash only. */
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
  /** Counters and names the receipt just reported. */
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
  return { id: i.id, sha: i.sha, ...(i.user === true ? { user: true } : {}), ...(i.digest === true ? { digest: true } : {}) };
}

function validPlaced(x: unknown): Placed | null {
  const i = validIdent(x);
  const seq = (x as Placed | null)?.seq;
  return i && Number.isFinite(seq) ? { ...i, seq: seq as number } : null;
}

function validDropped(x: unknown): Dropped | null {
  const d = x as Dropped;
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID.test(d.id)) return null;
  if (typeof d.kind !== 'string' || d.kind.length > 64 || typeof d.words !== 'string' || d.words.length > 200) return null;
  return { id: d.id, kind: d.kind, words: d.words };
}

function emptyIndex(): Index {
  return { v: 2, receipts: [], ours: [], placed: [], dropped: 0, named: [], unreadable: 0, old: 0, missing: 0 };
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
  take(raw.named, validDropped, index.named);
  index.dropped += count(raw.dropped);
  index.unreadable += count(raw.unreadable);
  index.old += count(raw.old);
  index.missing += count(raw.missing);
  return index;
}

const dKey = (sid: string, seq: number, size: number, user: boolean) => `${PREFIX}d:${sid}:${seq}:${size}:${user ? 'u' : 'o'}`;
const tKey = (sid: string) => `${PREFIX}t:${sid}`;
const sKey = (sid: string) => `${PREFIX}s:${sid}`;
const EVICTED = `${PREFIX}evicted`;

type DKey = { key: string; sid: string; seq: number; size: number; user: boolean };

/** Delivery keys, oldest first; `sid` undefined means every session's. */
function deliveryKeys(keys: readonly string[], sid?: string): DKey[] {
  const head = `${PREFIX}d:`;
  return keys
    .filter((k) => k.startsWith(head))
    .map((key) => {
      const [s, seq, size, who] = key.slice(head.length).split(':');
      return { key, sid: s ?? '', seq: Number(seq), size: Number(size), user: who === 'u' };
    })
    .filter((k) => (sid === undefined || k.sid === sid) && Number.isFinite(k.seq) && Number.isFinite(k.size))
    .sort((a, b) => a.seq - b.seq);
}

function droppedOf(d: Delivery | null, fallbackId: string): Dropped {
  return d
    ? { id: d.id, kind: d.origin?.kind ?? 'own', words: excerptOf(d.body) }
    : { id: ID.test(fallbackId) ? fallbackId : '000000000000', kind: 'unknown', words: '' };
}

type Evicted = { v: 2; sessions: { [sid: string]: { count: number; named: Dropped[] } } };

function validEvicted(x: unknown): Evicted {
  const raw = x as Evicted | undefined;
  const out: Evicted = { v: 2, sessions: {} };
  if (!raw || typeof raw !== 'object' || !raw.sessions || typeof raw.sessions !== 'object') return out;
  for (const [sid, e] of Object.entries(raw.sessions)) {
    if (!e || typeof e !== 'object') continue;
    out.sessions[sid] = {
      count: count(e.count),
      named: Array.isArray(e.named) ? e.named.map(validDropped).filter((d): d is Dropped => d !== null).slice(0, 20) : [],
    };
  }
  return out;
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

  private async touch(kv: KV, sid: string): Promise<void> {
    await kv.set(tKey(sid), { v: 2, t: Date.now() });
  }

  private async index(kv: KV, sid: string): Promise<Index> {
    return validIndex(await kv.get(sKey(sid)));
  }

  /**
   * Drops sessions, least recently written first, while there are more than
   * LEDGER_MAX_SESSIONS or their pending text passes LEDGER_MAX_STORE_BYTES,
   * noting what went with each for that session's next receipt.
   */
  private async evictSessions(kv: KV, keep: string): Promise<void> {
    for (;;) {
      const keys = await kv.keys();
      const sessions = keys.filter((k) => k.startsWith(`${PREFIX}t:`)).map((k) => k.slice(`${PREFIX}t:`.length));
      const total = deliveryKeys(keys).reduce((sum, k) => sum + k.size, 0);
      if (sessions.length <= LEDGER_MAX_SESSIONS && total <= LEDGER_MAX_STORE_BYTES) return;
      const dated = await Promise.all(
        sessions
          .filter((s) => s !== keep)
          .map(async (sid) => ({ sid, t: count(((await kv.get(tKey(sid))) as { t?: unknown } | undefined)?.t) })),
      );
      if (dated.length === 0) return;
      dated.sort((a, b) => a.t - b.t);
      const sid = dated[0]!.sid;
      const pending = deliveryKeys(keys, sid);
      const named: Dropped[] = [];
      for (const k of pending.slice(0, 20)) named.push(droppedOf(validDelivery(await kv.get(k.key)), ''));
      const evicted = validEvicted(await kv.get(EVICTED));
      const prior = evicted.sessions[sid] ?? { count: 0, named: [] };
      evicted.sessions[sid] = { count: prior.count + pending.length, named: [...prior.named, ...named].slice(0, 20) };
      const names = Object.keys(evicted.sessions);
      for (const old of names.slice(0, Math.max(0, names.length - 32))) delete evicted.sessions[old];
      await kv.set(EVICTED, evicted);
      for (const k of pending) await kv.remove(k.key);
      await kv.remove(sKey(sid));
      await kv.remove(tKey(sid));
    }
  }

  /** The receipts this session's record holds: all `prompt.submit` needs to anchor. */
  receipts(host: KV, session: string): Promise<Ident[]> {
    const sid = sessionKey(session);
    return this.run(host, async (kv) => (await this.index(kv, sid)).receipts);
  }

  /**
   * Records one delivery: one small write, then the bounds. Past a bound the
   * oldest delivery from anyone but the user goes first; the user's own go
   * only when nothing else is left. Each drop is named for the next receipt.
   */
  record(host: KV, session: string, delivery: Delivery): Promise<void> {
    const sid = sessionKey(session);
    const user = speaker(delivery.origin).user;
    return this.run(host, async (kv) => {
      const value = { v: 2, ...delivery };
      const size = bytes(value);
      const index = await this.index(kv, sid);
      let changed = false;
      const drop = (d: Delivery | null, id: string) => {
        index.dropped++;
        if (index.named.length < MAX_NAMED) index.named.push(droppedOf(d, id));
        changed = true;
      };
      if (size > LEDGER_MAX_BYTES) drop(delivery, delivery.id);
      else {
        await kv.set(dKey(sid, delivery.seq, size, user), value);
        const mine = deliveryKeys(await kv.keys(), sid);
        let total = mine.reduce((sum, k) => sum + k.size, 0);
        while (mine.length > LEDGER_MAX_ENTRIES || total > LEDGER_MAX_BYTES) {
          const at = mine.findIndex((k) => !k.user);
          const victim = mine.splice(at >= 0 ? at : 0, 1)[0]!;
          total -= victim.size;
          drop(validDelivery(await kv.get(victim.key)), '');
          await kv.remove(victim.key);
        }
      }
      if (changed) await kv.set(sKey(sid), index);
      await this.touch(kv, sid);
      await this.evictSessions(kv, sid);
    });
  }

  /** This session's record, every value checked; what cannot be read is deleted and counted. */
  read(host: KV, session: string): Promise<Record> {
    const sid = sessionKey(session);
    return this.run(host, async (kv) => {
      const keys = await kv.keys();
      const index = await this.index(kv, sid);
      let changed = false;
      const pending: Delivery[] = [];
      for (const k of deliveryKeys(keys, sid)) {
        const d = validDelivery(await kv.get(k.key));
        if (d && d.seq === k.seq) pending.push(d);
        else {
          index.unreadable++;
          changed = true;
          await kv.remove(k.key);
        }
      }
      for (const k of keys.filter((key) => key.startsWith(OLD_PREFIX))) {
        await kv.remove(k);
        index.old++;
        changed = true;
      }
      const evicted = validEvicted(await kv.get(EVICTED));
      const mine = evicted.sessions[sid];
      if (mine) {
        index.dropped += mine.count;
        index.named = [...index.named, ...mine.named].slice(0, MAX_NAMED);
        delete evicted.sessions[sid];
        await kv.set(EVICTED, evicted);
        changed = true;
      }
      if (changed) await kv.set(sKey(sid), index);
      return {
        sid,
        pending,
        placed: index.placed,
        ours: index.ours,
        receipts: index.receipts,
        dropped: index.dropped,
        named: index.named,
        unreadable: index.unreadable,
        old: index.old,
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
        const key = dKey(sid, seq, size, k.user);
        await kv.set(key, value);
        if (key !== k.key) await kv.remove(k.key);
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
        index.named = [];
        index.unreadable = 0;
        index.old = 0;
        index.missing = 0;
      }
      await kv.set(sKey(sid), index);
      await this.touch(kv, sid);
      const gone = new Set([...change.retire, ...change.placed.map((p) => p.seq)]);
      for (const k of keys) if (gone.has(k.seq)) await kv.remove(k.key);
    });
  }
}
