/**
 * PnL methodology (also documented in docs/PRODUCT_SPEC.md#pnl):
 *
 * - Only reconciled, confirmed swap fills from the user's trading wallet count. Deposits, withdrawals
 *   and plain transfers move balances but are never PnL.
 * - Cost basis: weighted average cost per (network, token), in USD at fill time.
 * - Realized PnL on a sell = proceedsUsd − avgCost × qtySold. Network/DEX fees are tracked separately
 *   and subtracted in `netRealizedUsd`.
 * - A fill whose USD value is unknown makes the position "unpriced": subsequent realized PnL for that
 *   token is reported as `null` (incomplete) instead of guessed.
 * - Selling more than the tracked quantity (tokens that arrived by transfer) only realizes PnL for the
 *   tracked part; the excess is reported as `untrackedQty`.
 * - Daily buckets use the user's IANA time zone.
 */

export interface Fill {
  id: string;
  at: number; // ms epoch (block time)
  network: string;
  token: string;
  symbol?: string;
  side: 'buy' | 'sell';
  qty: number; // token units (decimals applied)
  /** USD spent (buy) or received (sell), excluding fees. null = unknown. */
  usd: number | null;
  feeUsd: number | null;
}

export interface PositionState {
  key: string;
  network: string;
  token: string;
  symbol?: string;
  qty: number;
  costUsd: number;
  priced: boolean;
  realizedUsd: number | null;
  untrackedQty: number;
}

export interface RealizedEvent {
  fillId: string;
  at: number;
  key: string;
  realizedUsd: number | null;
  feeUsd: number | null;
}

export function computePositions(fills: Fill[]): {
  positions: Map<string, PositionState>;
  events: RealizedEvent[];
} {
  const positions = new Map<string, PositionState>();
  const events: RealizedEvent[] = [];
  const sorted = [...fills].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  for (const f of sorted) {
    if (!(f.qty > 0)) continue;
    const key = `${f.network}:${f.token.toLowerCase()}`;
    let p = positions.get(key);
    if (!p) {
      p = {
        key,
        network: f.network,
        token: f.token,
        symbol: f.symbol,
        qty: 0,
        costUsd: 0,
        priced: true,
        realizedUsd: 0,
        untrackedQty: 0,
      };
      positions.set(key, p);
    }
    if (f.side === 'buy') {
      p.qty += f.qty;
      if (f.usd === null) p.priced = false;
      else p.costUsd += f.usd;
      events.push({ fillId: f.id, at: f.at, key, realizedUsd: 0, feeUsd: f.feeUsd });
    } else {
      const tracked = Math.min(f.qty, p.qty);
      p.untrackedQty += f.qty - tracked;
      let realized: number | null = null;
      if (p.priced && f.usd !== null && p.qty > 0) {
        const avg = p.costUsd / p.qty;
        const proceedsTracked = f.usd * (tracked / f.qty);
        realized = proceedsTracked - avg * tracked;
        p.costUsd -= avg * tracked;
      } else if (p.qty > 0) {
        p.costUsd -= (p.costUsd / p.qty) * tracked;
      }
      p.qty -= tracked;
      if (p.qty < 1e-12) {
        p.qty = 0;
        p.costUsd = 0;
      }
      if (tracked === 0) realized = f.usd === null ? null : 0;
      p.realizedUsd = p.realizedUsd === null || realized === null ? null : p.realizedUsd + realized;
      events.push({ fillId: f.id, at: f.at, key, realizedUsd: realized, feeUsd: f.feeUsd });
    }
  }
  return { positions, events };
}

export function unrealizedUsd(p: PositionState, priceUsd: number | null): number | null {
  if (!p.priced || priceUsd === null || p.qty === 0) return p.qty === 0 ? 0 : null;
  return p.qty * priceUsd - p.costUsd;
}

/** YYYY-MM-DD in the given IANA zone. */
export function dayKey(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export interface DailyPnl {
  day: string;
  realizedUsd: number;
  feesUsd: number;
  netRealizedUsd: number;
  trades: number;
  /** True when at least one event that day had unknown USD value. */
  incomplete: boolean;
}

export function dailyRealized(events: RealizedEvent[], timeZone: string): Map<string, DailyPnl> {
  const out = new Map<string, DailyPnl>();
  for (const e of events) {
    const day = dayKey(e.at, timeZone);
    const d = out.get(day) ?? {
      day,
      realizedUsd: 0,
      feesUsd: 0,
      netRealizedUsd: 0,
      trades: 0,
      incomplete: false,
    };
    d.trades += 1;
    if (e.realizedUsd === null) d.incomplete = true;
    else d.realizedUsd += e.realizedUsd;
    if (e.feeUsd === null) d.incomplete = true;
    else d.feesUsd += e.feeUsd;
    d.netRealizedUsd = d.realizedUsd - d.feesUsd;
    out.set(day, d);
  }
  return out;
}

export interface PnlSummary {
  netRealizedUsd: number;
  realizedUsd: number;
  feesUsd: number;
  winDays: number;
  lossDays: number;
  bestDay: DailyPnl | null;
  worstDay: DailyPnl | null;
  trades: number;
  incomplete: boolean;
}

export function summarize(days: DailyPnl[]): PnlSummary {
  let best: DailyPnl | null = null;
  let worst: DailyPnl | null = null;
  const s: PnlSummary = {
    netRealizedUsd: 0,
    realizedUsd: 0,
    feesUsd: 0,
    winDays: 0,
    lossDays: 0,
    bestDay: null,
    worstDay: null,
    trades: 0,
    incomplete: false,
  };
  for (const d of days) {
    s.netRealizedUsd += d.netRealizedUsd;
    s.realizedUsd += d.realizedUsd;
    s.feesUsd += d.feesUsd;
    s.trades += d.trades;
    s.incomplete ||= d.incomplete;
    if (d.netRealizedUsd > 0) s.winDays++;
    if (d.netRealizedUsd < 0) s.lossDays++;
    if (!best || d.netRealizedUsd > best.netRealizedUsd) best = d;
    if (!worst || d.netRealizedUsd < worst.netRealizedUsd) worst = d;
  }
  s.bestDay = best;
  s.worstDay = worst;
  return s;
}
