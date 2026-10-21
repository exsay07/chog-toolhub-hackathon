import {
  addressFamilies,
  groupPairsToTokens,
  NETWORKS,
  type NetworkId,
  type PairSummary,
  type ProviderHealth,
  type SearchResult,
} from '@chog/shared';
import { TtlCache, type Cached } from '../lib/cache.js';
import { sanitizeError } from '../lib/log.js';
import {
  dsPair,
  dsSearch,
  dsTokenAnyChain,
  dsTokenPairs,
  dsTokens,
  GeckoTerminal,
  goplusSecurity,
} from './providers.js';

type Provider = 'dexscreener' | 'geckoterminal' | 'goplus';

/**
 * Shared market-data layer. All browsers read through this cache, so N viewers of a token cost one
 * upstream request per TTL instead of N.
 */
export class MarketService {
  readonly cache = new TtlCache(10_000);
  readonly gecko: GeckoTerminal;
  readonly health: Record<Provider, ProviderHealth> = {
    dexscreener: { ok: true, lastOkAt: null, lastError: null, consecutiveFailures: 0 },
    geckoterminal: { ok: true, lastOkAt: null, lastError: null, consecutiveFailures: 0 },
    goplus: { ok: true, lastOkAt: null, lastError: null, consecutiveFailures: 0 },
  };

  constructor(geckoProKey = '') {
    this.gecko = new GeckoTerminal(geckoProKey);
  }

  private async track<T>(p: Provider, fn: () => Promise<T>): Promise<T> {
    try {
      const v = await fn();
      this.health[p] = { ok: true, lastOkAt: Date.now(), lastError: null, consecutiveFailures: 0 };
      return v;
    } catch (e) {
      const h = this.health[p];
      this.health[p] = {
        ok: h.consecutiveFailures + 1 < 3,
        lastOkAt: h.lastOkAt,
        lastError: sanitizeError(e),
        consecutiveFailures: h.consecutiveFailures + 1,
      };
      throw e;
    }
  }

  trackDs<T>(fn: () => Promise<T>) {
    return this.track('dexscreener', fn);
  }

  trackGecko<T>(fn: () => Promise<T>) {
    return this.track('geckoterminal', fn);
  }

  /** Most liquid pair per token (≤ 30 tokens per upstream call). */
  async bestPairs(network: NetworkId, tokens: string[]): Promise<PairSummary[]> {
    const best = new Map<string, PairSummary>();
    for (let i = 0; i < tokens.length; i += 30) {
      for (const p of await dsTokens(network, tokens.slice(i, i + 30))) {
        const k = p.base.address.toLowerCase();
        const cur = best.get(k);
        if (!cur || (p.liquidityUsd ?? 0) > (cur.liquidityUsd ?? 0)) best.set(k, p);
      }
    }
    return [...best.values()];
  }

  /**
   * Dexscreener-style search: one row per token. A pasted token or pair address resolves directly
   * (`exact`) so the UI can open it without an intermediate list.
   */
  search(q: string): Promise<Cached<SearchResult>> {
    const query = q.trim().slice(0, 64);
    return this.cache.get(`search:${query.toLowerCase()}`, 20_000, () =>
      this.track('dexscreener', async () => {
        const isAddr = addressFamilies(query).length > 0;
        if (!isAddr) return { hits: groupPairsToTokens(await dsSearch(query)).slice(0, 40), exact: null };

        const ql = query.toLowerCase();
        // 1) Token address (any chain). 2) Otherwise it may be a pair/pool address.
        let pairs = (await dsTokenAnyChain(query)).filter(
          (p) => p.base.address.toLowerCase() === ql || p.quote.address.toLowerCase() === ql,
        );
        let pairHit: PairSummary | undefined;
        if (pairs.length === 0) {
          const s = await dsSearch(query);
          pairHit = s.find((p) => p.pairAddress.toLowerCase() === ql);
          pairs = s.filter((p) =>
            [p.base.address, p.quote.address, p.pairAddress].some((x) => x.toLowerCase() === ql),
          );
        }
        if (pairHit) {
          const hits = groupPairsToTokens(pairs);
          return {
            hits,
            exact: { network: pairHit.network, token: pairHit.base.address, pair: pairHit.pairAddress },
          };
        }
        const hits = groupPairsToTokens(pairs, query);
        const nets = new Set(hits.map((h) => h.network));
        const top = hits[0];
        return {
          hits,
          // Same address on several EVM chains is possible: only auto-open when unambiguous.
          exact:
            top && nets.size === 1 ? { network: top.network, token: top.address, pair: top.bestPair } : null,
        };
      }),
    );
  }

  tokenPairs(network: NetworkId, token: string) {
    return this.cache.get(`tp:${network}:${token.toLowerCase()}`, 15_000, () =>
      this.track('dexscreener', async () =>
        (await dsTokenPairs(network, token))
          .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
          .slice(0, 30),
      ),
    );
  }

  pair(network: NetworkId, pair: string) {
    return this.cache.get(`pair:${network}:${pair.toLowerCase()}`, 5_000, () =>
      this.track('dexscreener', () => dsPair(network, pair)),
    );
  }

  /** Best-liquidity USD price per token (third-party estimate). */
  async prices(network: NetworkId, tokens: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const missing: string[] = [];
    for (const t of tokens) {
      const hit = this.cache.peek<number | null>(`px:${network}:${t.toLowerCase()}`);
      if (hit && !hit.stale) out.set(t.toLowerCase(), hit.value);
      else missing.push(t);
    }
    for (let i = 0; i < missing.length; i += 30) {
      const chunk = missing.slice(i, i + 30);
      try {
        const pairs = await this.track('dexscreener', () => dsTokens(network, chunk));
        const best = new Map<string, PairSummary>();
        for (const p of pairs) {
          const k = p.base.address.toLowerCase();
          const cur = best.get(k);
          if (!cur || (p.liquidityUsd ?? 0) > (cur.liquidityUsd ?? 0)) best.set(k, p);
        }
        for (const t of chunk) {
          const v = best.get(t.toLowerCase())?.priceUsd ?? null;
          this.cache.set(`px:${network}:${t.toLowerCase()}`, v, 30_000);
          out.set(t.toLowerCase(), v);
        }
      } catch {
        for (const t of chunk)
          out.set(
            t.toLowerCase(),
            this.cache.peek<number | null>(`px:${network}:${t.toLowerCase()}`)?.value ?? null,
          );
      }
    }
    return out;
  }

  async nativePriceUsd(network: NetworkId): Promise<number | null> {
    const w = NETWORKS[network].wrappedNative;
    return (await this.prices(network, [w])).get(w.toLowerCase()) ?? null;
  }

  ohlcv(network: NetworkId, pool: string, tf: 'minute' | 'hour' | 'day', agg: number) {
    const ttl = tf === 'minute' ? 30_000 : tf === 'hour' ? 120_000 : 600_000;
    return this.cache.get(`ohlcv:${network}:${pool.toLowerCase()}:${tf}:${agg}`, ttl, () =>
      this.track('geckoterminal', () => this.gecko.ohlcv(network, pool, tf, agg)),
    );
  }

  trades(network: NetworkId, pool: string) {
    return this.cache.get(`trades:${network}:${pool.toLowerCase()}`, 15_000, () =>
      this.track('geckoterminal', () => this.gecko.trades(network, pool)),
    );
  }

  newPools(network: NetworkId) {
    return this.cache.get(`newpools:${network}`, 25_000, () =>
      this.track('geckoterminal', () => this.gecko.newPools(network)),
    );
  }

  security(network: NetworkId, token: string) {
    return this.cache.get(`sec:${network}:${token.toLowerCase()}`, 5 * 60_000, () =>
      this.track('goplus', () => goplusSecurity(network, token)),
    );
  }
}
