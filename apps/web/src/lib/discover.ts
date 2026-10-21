import { NETWORK_IDS, isNetworkId, type NetworkId, type PairSummary } from '@chog/shared';
import { get } from './api';

/**
 * Token Terminal → Discover query, shared by the page and the app-wide prefetch. The last answer is
 * also kept in this browser so the table paints instantly (then refreshes) even after a reload.
 */

export type DiscoverView = 'trending' | 'top';
export type DiscoverTf = '5m' | '1h' | '6h' | '24h';
export interface DiscoverResp {
  data: PairSummary[];
  errors: NetworkId[];
  fetchedAt: number;
  stale: boolean;
}

export const CHAINS_KEY = 'chog.term.chains.v2';
export const VIEW_KEY = 'chog.term.view';
export const TF_KEY = 'chog.term.tf';

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

/** The terminal's saved chain / view / timeframe (same defaults as the page). */
export function terminalPrefs(): { chains: NetworkId[]; view: DiscoverView; tf: DiscoverTf } {
  const c = read(CHAINS_KEY);
  const v = read(VIEW_KEY);
  const t = read(TF_KEY);
  return {
    chains:
      Array.isArray(c) && c.length && c.every((x) => isNetworkId(x as string))
        ? (c as NetworkId[])
        : [...NETWORK_IDS],
    view: v === 'top' ? 'top' : 'trending',
    tf: t === '5m' || t === '6h' || t === '24h' ? t : '1h',
  };
}

const snapKey = (chains: NetworkId[], view: DiscoverView, tf: DiscoverTf) =>
  `chog.term.snap:${chains.join(',')}:${view}:${tf}`;

export function readSnapshot(
  chains: NetworkId[],
  view: DiscoverView,
  tf: DiscoverTf,
): DiscoverResp | undefined {
  const s = read(snapKey(chains, view, tf)) as DiscoverResp | null;
  return s && Array.isArray(s.data) ? s : undefined;
}

function writeSnapshot(chains: NetworkId[], view: DiscoverView, tf: DiscoverTf, r: DiscoverResp) {
  try {
    localStorage.setItem(snapKey(chains, view, tf), JSON.stringify({ ...r, data: r.data.slice(0, 80) }));
  } catch {
    /* quota / private mode: the snapshot is only a speed-up */
  }
}

export interface PulseResp {
  data: { fresh: PairSummary[]; trending: PairSummary[] };
  errors: NetworkId[];
  fetchedAt: number;
}

/** Pulse query (same snapshot trick: last answer paints instantly). */
export function pulseQuery(chains: NetworkId[]) {
  const key = `chog.term.pulse:${chains.join(',')}`;
  const snap = read(key) as PulseResp | null;
  return {
    queryKey: ['pulse', chains.join(',')] as const,
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      const r = await get<PulseResp>(`/api/discover/pulse?networks=${chains.join(',')}`, signal);
      try {
        if (r.data.fresh.length || r.data.trending.length) localStorage.setItem(key, JSON.stringify(r));
      } catch {
        /* the snapshot is only a speed-up */
      }
      return r;
    },
    initialData: snap?.data ? snap : undefined,
    initialDataUpdatedAt: snap ? 0 : undefined,
  };
}

export function discoverQuery(chains: NetworkId[], view: DiscoverView, tf: DiscoverTf) {
  const snap = readSnapshot(chains, view, tf);
  return {
    queryKey: ['discover', chains.join(','), view, tf] as const,
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      const r = await get<DiscoverResp>(
        `/api/discover?networks=${chains.join(',')}&view=${view}&tf=${tf}`,
        signal,
      );
      if (r.data.length) writeSnapshot(chains, view, tf, r);
      return r;
    },
    // Paint the last known table immediately; it is marked old so a fresh fetch starts at once.
    initialData: snap,
    initialDataUpdatedAt: snap ? 0 : undefined,
  };
}
