import { useEffect, useState } from 'react';
import { isNetworkId, type NetworkId } from '@chog/shared';
import { uid } from '../api';
import { readKv, writeKv } from '../userKv';
import type { Priority } from './engine';

/**
 * Limit / take-profit / stop-loss orders. DEX swaps have no order book, so an order is a price
 * trigger watched in this browser (lib/automation/limitOrders.ts) that sends an ordinary swap when
 * hit. Stored in the account (term.orders) so they show up on any device, but they only execute
 * while a tab is open and the trading wallet is unlocked.
 */

export type OrderStatus = 'open' | 'executing' | 'done' | 'failed' | 'cancelled';

export interface LimitOrder {
  id: string;
  network: NetworkId;
  token: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** Fires when the USD price crosses `priceUsd` in this direction. */
  when: 'below' | 'above';
  priceUsd: number;
  /** buy: native amount. sell: percent of the token balance at execution time. */
  amount: number;
  slippagePct: number;
  priority: Priority;
  /** EVM: vault wallet that trades (null/absent = Main). */
  wallet?: string | null;
  /** Orders sharing a group cancel each other once one fills (TP + SL placed together). */
  group: string | null;
  createdAt: number;
  expiresAt: number | null;
  status: OrderStatus;
  hash?: string;
  error?: string;
  doneAt?: number;
}

export function orderKind(o: Pick<LimitOrder, 'side' | 'when'>) {
  if (o.side === 'buy') return o.when === 'below' ? 'Limit buy' : 'Breakout buy';
  return o.when === 'above' ? 'Take profit' : 'Stop loss';
}

/** Pure trigger check (exported for tests). */
export function isTriggered(o: LimitOrder, priceUsd: number | null | undefined) {
  if (o.status !== 'open' || priceUsd === null || priceUsd === undefined || !(priceUsd > 0)) return false;
  return o.when === 'below' ? priceUsd <= o.priceUsd : priceUsd >= o.priceUsd;
}

const STATUSES: OrderStatus[] = ['open', 'executing', 'done', 'failed', 'cancelled'];
const PRIOS: Priority[] = ['none', 'low', 'medium', 'high'];
const num = (x: unknown, lo: number, hi: number) =>
  typeof x === 'number' && Number.isFinite(x) && x > lo && x <= hi;

/**
 * Orders come back from the account store (another device, an older version): each one is checked on
 * its own and a malformed one is dropped instead of breaking the list or being executed half-valid.
 */
export function isValidOrder(o: unknown): o is LimitOrder {
  const x = o as LimitOrder;
  return (
    !!x &&
    typeof x.id === 'string' &&
    x.id.length <= 40 &&
    isNetworkId(x.network) &&
    typeof x.token === 'string' &&
    x.token.length >= 32 &&
    x.token.length <= 64 &&
    typeof x.symbol === 'string' &&
    (x.side === 'buy' || x.side === 'sell') &&
    (x.when === 'below' || x.when === 'above') &&
    num(x.priceUsd, 0, 1e12) &&
    num(x.amount, 0, x.side === 'sell' ? 100 : 1e7) &&
    num(x.slippagePct, 0, 50) &&
    PRIOS.includes(x.priority) &&
    STATUSES.includes(x.status) &&
    (x.wallet == null || /^0x[0-9a-fA-F]{40}$/.test(x.wallet))
  );
}
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

const listeners = new Set<() => void>();
export const readOrders = (): LimitOrder[] =>
  readKv<unknown[]>('term.orders', [], isArr).filter(isValidOrder);

/** Finished orders kept for the history list. With MAX_OPEN_ORDERS this stays under the 32 KB account slot. */
export const KEEP_PAST = 15;

function save(list: LimitOrder[]) {
  const live = list.filter((o) => o.status === 'open' || o.status === 'executing');
  const past = list
    .filter((o) => o.status !== 'open' && o.status !== 'executing')
    .sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt))
    .slice(0, KEEP_PAST)
    .map((o) => (o.error && o.error.length > 120 ? { ...o, error: `${o.error.slice(0, 119)}…` } : o));
  writeKv('term.orders', [...live, ...past]);
  listeners.forEach((l) => l());
}

export function updateOrders(fn: (list: LimitOrder[]) => LimitOrder[]) {
  save(fn(readOrders()));
}

export const MAX_OPEN_ORDERS = 40;

export function placeOrders(
  orders: Array<Omit<LimitOrder, 'id' | 'createdAt' | 'status' | 'group'>>,
): LimitOrder[] {
  const group = orders.length > 1 ? uid('grp') : null;
  const made = orders.map((o) => ({
    ...o,
    id: uid('ord'),
    group,
    createdAt: Date.now(),
    status: 'open' as const,
  }));
  updateOrders((list) => {
    if (list.filter((o) => o.status === 'open').length + made.length > MAX_OPEN_ORDERS)
      throw new Error(`At most ${MAX_OPEN_ORDERS} open orders`);
    return [...made, ...list];
  });
  return made;
}

export function cancelOrder(id: string) {
  updateOrders((list) =>
    list.map((o) =>
      o.id === id && o.status === 'open' ? { ...o, status: 'cancelled', doneAt: Date.now() } : o,
    ),
  );
}

export function useOrders() {
  const [v, setV] = useState(readOrders);
  useEffect(() => {
    const on = () => setV(readOrders());
    listeners.add(on);
    // Another tab (or the account sync) changed them.
    window.addEventListener('storage', on);
    const t = setInterval(on, 5_000);
    return () => {
      listeners.delete(on);
      window.removeEventListener('storage', on);
      clearInterval(t);
    };
  }, []);
  return v;
}
