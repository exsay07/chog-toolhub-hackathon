import { useEffect, useState } from 'react';
import type { UserKvKey } from '@chog/shared';
import { get, put } from './api';

/**
 * Per-user state synced to the server (/api/kv) so it follows the user to any device and survives a
 * cleared browser: terminal quick-buy amounts, filters, chains, view, timeframe, recent tokens and
 * the sniper's entry prices (used for its take-profit / stop-loss).
 *
 * localStorage stays the instant local copy (pages read it synchronously, before any network). After
 * sign-in, `syncUserKv` pulls the server copy over it; values that only exist locally (from before
 * this sync existed) are uploaded once — but only if this browser's copy belongs to the same wallet.
 */

const LS: Record<UserKvKey, string> = {
  'term.quick': 'chog.term.quick',
  'term.filters': 'chog.term.filters',
  'term.chains': 'chog.term.chains.v2',
  'term.view': 'chog.term.view',
  'term.tf': 'chog.term.tf',
  'term.recent': 'chog.recentTokens',
  'sniper.entries': 'chog.sniper.entries',
  'term.presets': 'chog.term.presets',
  'term.orders': 'chog.term.orders',
};
const OWNER = 'chog.kv.owner';

const listeners = new Set<() => void>();
const timers = new Map<UserKvKey, number>();
let synced = false;

function lsGet(k: string): unknown {
  try {
    const raw = localStorage.getItem(k);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}
function lsSet(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

export function readKv<T>(key: UserKvKey, fallback: T, ok: (v: unknown) => v is T): T {
  const v = lsGet(LS[key]);
  return ok(v) ? v : fallback;
}

/** Saves locally at once and to the server shortly after (writes are coalesced per key). */
export function writeKv(key: UserKvKey, value: unknown) {
  lsSet(LS[key], value);
  if (!synced) return; // before the first sync the server copy wins; local edits are uploaded by the sync
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      void put(`/api/kv/${key}`, { value }).catch(() => {});
    }, 600),
  );
}

/** Pulls the signed-in user's state; call once per sign-in. */
export async function syncUserKv(address: string) {
  const me = address.toLowerCase();
  const sameOwner = lsGet(OWNER) === me;
  let server: Record<string, unknown>;
  try {
    server = await get<Record<string, unknown>>('/api/kv');
  } catch {
    return; // offline: keep the local copy, retry on the next sign-in
  }
  for (const key of Object.keys(LS) as UserKvKey[]) {
    if (key in server) lsSet(LS[key], server[key]);
    else if (sameOwner) {
      const local = lsGet(LS[key]);
      if (local !== undefined) void put(`/api/kv/${key}`, { value: local }).catch(() => {});
    } else {
      // Another wallet's leftovers on this browser: never carry them over.
      try {
        localStorage.removeItem(LS[key]);
      } catch {
        /* ignore */
      }
    }
  }
  lsSet(OWNER, me);
  synced = true;
  listeners.forEach((l) => l());
}

/** React state backed by the synced store; picks up the server copy when it arrives. */
export function useKv<T>(key: UserKvKey, fallback: T, ok: (v: unknown) => v is T) {
  const [v, setV] = useState<T>(() => readKv(key, fallback, ok));
  useEffect(() => {
    const on = () => setV(readKv(key, fallback, ok));
    listeners.add(on);
    return () => void listeners.delete(on);
    // fallback / ok are stable per call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (next: T | ((prev: T) => T)) =>
    setV((prev) => {
      const val = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      writeKv(key, val);
      return val;
    });
  return [v, set] as const;
}
