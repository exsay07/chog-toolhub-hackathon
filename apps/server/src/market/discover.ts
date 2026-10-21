import { NETWORK_IDS, NETWORKS, type NetworkId, type PairSummary } from '@chog/shared';
import type { Cached } from '../lib/cache.js';
import { dsPairs } from './providers.js';
import type { MarketService } from './service.js';

/**
 * Token Terminal → Discover / Pulse data (Axiom-style tables).
 *
 * Ranking comes from GeckoTerminal (trending pools per timeframe, top pools by volume, newest pools),
 * cached for a minute or so because its free tier is ~30 calls/min. The numbers in each row are then
 * refreshed from Dexscreener in one batch call per list every few seconds (300 calls/min budget), which
 * also brings token logos and project links. Every viewer shares the same cache entries.
 */

export type DiscoverView = 'trending' | 'top';
export type DiscoverTf = '5m' | '1h' | '6h' | '24h';

const LIST_TTL: Record<'trending' | 'top' | 'new', number> = {
  trending: 180_000,
  top: 240_000,
  new: 180_000,
};
const LIVE_TTL = 6_000;
/**
 * Answer with whatever is ready by then: a chain whose GeckoTerminal list is still queued behind the
 * free-tier rate limit keeps loading in the background (single-flight cache) and shows up on the next poll.
 */
const ANSWER_WITHIN_MS = 3500;

function within<T>(p: Promise<T>, ms = ANSWER_WITHIN_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pending')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Stables, wrapped natives and majors are not what anyone is hunting for in a memecoin feed. */
const NOT_MEME =
  /^(W?(ETH|BTC|BNB|SOL|MON|HYPE)|[a-z]*USD[a-z0-9]*|USD[A-Z0-9]*|DAI|USDT0|EUR[A-Z0-9]*|[a-z]*EUR[A-Z]?|FDUSD|PYUSD|CBBTC|CBETH|WSTETH|STETH|JITOSOL|MSOL)$/i;

interface GtPool {
  attributes: {
    address: string;
    name: string;
    pool_created_at?: string | null;
    base_token_price_usd?: string | null;
    base_token_price_native_currency?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string | null;
    price_change_percentage?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', string | null>>;
    volume_usd?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', string | null>>;
    transactions?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>>;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}
interface GtToken {
  id: string;
  attributes: { address: string; name: string; symbol: string; image_url?: string | null };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function normalizeGtPool(
  network: NetworkId,
  p: GtPool,
  tokens: Map<string, GtToken>,
  at: number,
): PairSummary {
  const a = p.attributes;
  const strip = (id: string) => id.slice(id.indexOf('_') + 1);
  const b = tokens.get(p.relationships.base_token.data.id);
  const q = tokens.get(p.relationships.quote_token.data.id);
  const [nb, nq] = a.name.split(' / ');
  const img = b?.attributes.image_url;
  return {
    source: 'geckoterminal',
    fetchedAt: at,
    network,
    pairAddress: a.address,
    dex: p.relationships.dex.data.id,
    base: {
      address: b?.attributes.address ?? strip(p.relationships.base_token.data.id),
      symbol: clip(b?.attributes.symbol ?? nb, 20),
      name: clip(b?.attributes.name ?? nb, 48),
    },
    quote: {
      address: q?.attributes.address ?? strip(p.relationships.quote_token.data.id),
      symbol: clip(q?.attributes.symbol ?? nq?.split(' ')[0], 20),
      name: clip(q?.attributes.name ?? nq, 48),
    },
    priceUsd: num(a.base_token_price_usd),
    priceNative: num(a.base_token_price_native_currency),
    liquidityUsd: num(a.reserve_in_usd),
    fdvUsd: num(a.fdv_usd),
    marketCapUsd: num(a.market_cap_usd),
    volume: {
      m5: num(a.volume_usd?.m5),
      h1: num(a.volume_usd?.h1),
      h6: num(a.volume_usd?.h6),
      h24: num(a.volume_usd?.h24),
    },
    change: {
      m5: num(a.price_change_percentage?.m5),
      h1: num(a.price_change_percentage?.h1),
      h6: num(a.price_change_percentage?.h6),
      h24: num(a.price_change_percentage?.h24),
    },
    txns: {
      m5: a.transactions?.m5 ?? null,
      h1: a.transactions?.h1 ?? null,
      h6: a.transactions?.h6 ?? null,
      h24: a.transactions?.h24 ?? null,
    },
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    url: `https://dexscreener.com/${NETWORKS[network].dexscreenerId}/${a.address}`,
    imageUrl: img && /^https:\/\//.test(img) && !img.includes('missing') ? img : null,
    socials: { website: null, twitter: null, telegram: null },
  };
}

/** Live numbers from Dexscreener on top of the ranked row; ranking/identity stay from the list. */
export function overlay(row: PairSummary, live: PairSummary | undefined): PairSummary {
  if (!live) return row;
  return {
    ...row,
    source: 'dexscreener',
    fetchedAt: live.fetchedAt,
    priceUsd: live.priceUsd ?? row.priceUsd,
    priceNative: live.priceNative ?? row.priceNative,
    liquidityUsd: live.liquidityUsd ?? row.liquidityUsd,
    fdvUsd: live.fdvUsd ?? row.fdvUsd,
    marketCapUsd: live.marketCapUsd ?? live.fdvUsd ?? row.marketCapUsd,
    volume: live.volume,
    change: live.change,
    txns: { ...row.txns, ...Object.fromEntries(Object.entries(live.txns).filter(([, v]) => v)) },
    createdAt: row.createdAt ?? live.createdAt,
    imageUrl: live.imageUrl ?? row.imageUrl,
    socials: live.socials ?? row.socials,
    url: live.url ?? row.url,
  };
}

export function isMemeCandidate(p: PairSummary) {
  return (
    !NOT_MEME.test(p.base.symbol) &&
    p.base.address.toLowerCase() !== NETWORKS[p.network].wrappedNative.toLowerCase()
  );
}

export class Discover {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly market: MarketService) {}

  /**
   * Keeps the default Discover view (trending · 1h) and Pulse (newest + 5m trending) warm for every
   * chain, so opening the terminal never waits on GeckoTerminal. A list refreshes only once its TTL has
   * expired: 9 chains × 3 lists / 3 min ≈ 9 calls/min, well inside the free tier; after a 429 the
   * GeckoTerminal client pauses for a minute and the cached lists keep being served.
   */
  startWarming(everyMs = 20_000) {
    const tick = () => {
      for (const n of NETWORK_IDS) void this.rows(n, 'trending', '1h').catch(() => {});
      for (const n of NETWORK_IDS) {
        void this.rows(n, 'new', '5m').catch(() => {});
        void this.rows(n, 'trending', '5m').catch(() => {});
      }
    };
    tick();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  stopWarming() {
    if (this.timer) clearInterval(this.timer);
  }

  private gecko() {
    return this.market.gecko;
  }

  /** One GeckoTerminal page of pools (20), normalized. */
  private list(network: NetworkId, kind: 'trending' | 'top' | 'new', tf: DiscoverTf = '24h') {
    const g = this.gecko();
    const id = NETWORKS[network].geckoterminalId;
    const path =
      kind === 'trending'
        ? `/networks/${id}/trending_pools?duration=${tf}&include=base_token,quote_token&page=1`
        : kind === 'top'
          ? `/networks/${id}/pools?sort=h24_volume_usd_desc&include=base_token,quote_token&page=1`
          : `/networks/${id}/new_pools?include=base_token,quote_token&page=1`;
    const key = `disc:${network}:${kind}:${kind === 'trending' ? tf : ''}`;
    const load = () =>
      this.market.cache.get(key, LIST_TTL[kind], () =>
        this.market.trackGecko(async () => {
          const r = await g.raw<{ data?: GtPool[]; included?: GtToken[] }>(path);
          const tokens = new Map((r.included ?? []).map((t) => [t.id, t]));
          const at = Date.now();
          return (r.data ?? []).map((p) => normalizeGtPool(network, p, tokens, at)).filter(isMemeCandidate);
        }),
      );
    // Stale-while-revalidate: an expired list is still served (its rows get live numbers anyway)
    // while the refresh waits its turn under GeckoTerminal's rate limit.
    const hit = this.market.cache.peek<PairSummary[]>(key);
    if (hit) {
      if (hit.stale) void load().catch(() => {});
      return Promise.resolve(hit);
    }
    return load();
  }

  /** Dexscreener refresh for a set of pairs (≤ 30), cached briefly. */
  private async live(network: NetworkId, key: string, pairs: string[]): Promise<Map<string, PairSummary>> {
    if (pairs.length === 0) return new Map();
    try {
      const r = await this.market.cache.get(`live:${network}:${key}`, LIVE_TTL, () =>
        this.market.trackDs(() => dsPairs(network, pairs)),
      );
      return new Map(r.value.map((p) => [p.pairAddress.toLowerCase(), p]));
    } catch {
      return new Map();
    }
  }

  private async rows(network: NetworkId, kind: 'trending' | 'top' | 'new', tf: DiscoverTf) {
    const list = await this.list(network, kind, tf);
    const rows = list.value.slice(0, 30);
    const live = await this.live(
      network,
      `${kind}:${tf}`,
      rows.map((r) => r.pairAddress),
    );
    return { rows: rows.map((r) => overlay(r, live.get(r.pairAddress.toLowerCase()))), list };
  }

  /** Discover table: per-network ranking merged (round-robin keeps every chain represented). */
  async discover(networks: NetworkId[], view: DiscoverView, tf: DiscoverTf) {
    // Errors list = chains still loading or failing; the UI shows them as "loading…".
    const settled = await Promise.allSettled(networks.map((n) => within(this.rows(n, view, tf))));
    const per: PairSummary[][] = [];
    const errors: NetworkId[] = [];
    let fetchedAt = Date.now();
    let stale = false;
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        per.push(s.value.rows);
        fetchedAt = Math.min(fetchedAt, s.value.list.fetchedAt);
        stale ||= s.value.list.stale;
      } else errors.push(networks[i]!);
    });
    const merged: PairSummary[] = [];
    for (let i = 0; per.some((l) => i < l.length); i++)
      for (const l of per) {
        const r = l[i];
        if (r) merged.push(r);
      }
    return { rows: merged, errors, fetchedAt, stale };
  }

  /** Pulse: the newest pools + what is trending in the last 5 minutes, per network. */
  async pulse(networks: NetworkId[]) {
    const [fresh, hot] = await Promise.all([
      Promise.allSettled(networks.map((n) => within(this.rows(n, 'new', '5m')))),
      Promise.allSettled(networks.map((n) => within(this.rows(n, 'trending', '5m')))),
    ]);
    const ok = (s: PromiseSettledResult<{ rows: PairSummary[] }>[]) =>
      s.flatMap((x) => (x.status === 'fulfilled' ? x.value.rows : []));
    const errors = networks.filter(
      (_, i) => fresh[i]!.status === 'rejected' && hot[i]!.status === 'rejected',
    );
    return { fresh: ok(fresh), trending: ok(hot), errors, fetchedAt: Date.now() };
  }

  /** Live rows for an arbitrary token list (watchlist): best-liquidity pair per token. */
  tokens(network: NetworkId, tokens: string[]): Promise<Cached<PairSummary[]>> {
    const key = tokens
      .map((t) => t.toLowerCase())
      .sort()
      .join(',');
    return this.market.cache.get(`disc-tokens:${network}:${key}`, LIVE_TTL, () =>
      this.market.trackDs(() => this.market.bestPairs(network, tokens)),
    );
  }
}
