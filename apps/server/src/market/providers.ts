import {
  NETWORKS,
  normalizeCandles,
  type Candle,
  type NetworkId,
  type NewPool,
  type PairSummary,
  type PoolTrade,
  type TokenSecurity,
} from '@chog/shared';
import { fetchJson, TokenBucket, UpstreamError } from '../lib/http.js';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const byDexscreenerId = new Map(Object.values(NETWORKS).map((n) => [n.dexscreenerId, n.id]));
const byGeckoId = new Map(Object.values(NETWORKS).map((n) => [n.geckoterminalId, n.id]));

/* --------------------------------- Dexscreener --------------------------------- */

// Documented limit: 300 req/min for pair/token/search endpoints. Keep headroom.
const dsBucket = new TokenBucket(20, 4);
const DS = 'https://api.dexscreener.com';

interface DsPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url?: string; label?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
}

const httpsOnly = (u: string | undefined) => (u && /^https:\/\/[^\s]{4,300}$/.test(u) ? u : null);

function socialsOf(info: DsPair['info']): PairSummary['socials'] {
  const by = (t: string) => httpsOnly(info?.socials?.find((s) => s.type === t)?.url);
  return {
    website: httpsOnly(info?.websites?.[0]?.url),
    twitter: by('twitter'),
    telegram: by('telegram'),
  };
}

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function normalizeDsPair(p: DsPair, fetchedAt: number): PairSummary | null {
  const network = byDexscreenerId.get(p.chainId);
  if (!network) return null;
  return {
    source: 'dexscreener',
    fetchedAt,
    network,
    pairAddress: p.pairAddress,
    dex: p.dexId,
    // Provider strings are untrusted and occasionally absurd (thousands of chars): bound them.
    base: {
      address: p.baseToken.address,
      symbol: clip(p.baseToken.symbol, 20),
      name: clip(p.baseToken.name, 48),
    },
    quote: {
      address: p.quoteToken.address,
      symbol: clip(p.quoteToken.symbol, 20),
      name: clip(p.quoteToken.name, 48),
    },
    priceUsd: num(p.priceUsd),
    priceNative: num(p.priceNative),
    liquidityUsd: num(p.liquidity?.usd),
    fdvUsd: num(p.fdv),
    marketCapUsd: num(p.marketCap),
    volume: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) },
    change: {
      m5: num(p.priceChange?.m5),
      h1: num(p.priceChange?.h1),
      h6: num(p.priceChange?.h6),
      h24: num(p.priceChange?.h24),
    },
    txns: {
      h24: p.txns?.h24 ?? null,
      h1: p.txns?.h1 ?? null,
      m5: p.txns?.m5 ?? null,
      h6: p.txns?.h6 ?? null,
    },
    socials: socialsOf(p.info),
    createdAt: num(p.pairCreatedAt),
    url: p.url ?? null,
    imageUrl: p.info?.imageUrl && /^https:\/\//.test(p.info.imageUrl) ? p.info.imageUrl : null,
  };
}

export async function dsSearch(q: string): Promise<PairSummary[]> {
  const r = await fetchJson<{ pairs: DsPair[] | null }>(
    `${DS}/latest/dex/search?q=${encodeURIComponent(q)}`,
    { bucket: dsBucket },
  );
  const now = Date.now();
  return (r.pairs ?? []).map((p) => normalizeDsPair(p, now)).filter((p): p is PairSummary => p !== null);
}

/** All pools containing `token` on any chain (Dexscreener resolves the chain from the address). */
export async function dsTokenAnyChain(token: string): Promise<PairSummary[]> {
  const r = await fetchJson<{ pairs: DsPair[] | null }>(
    `${DS}/latest/dex/tokens/${encodeURIComponent(token)}`,
    {
      bucket: dsBucket,
    },
  );
  const now = Date.now();
  return (r.pairs ?? []).map((p) => normalizeDsPair(p, now)).filter((p): p is PairSummary => p !== null);
}

export async function dsTokenPairs(network: NetworkId, token: string): Promise<PairSummary[]> {
  const r = await fetchJson<DsPair[]>(
    `${DS}/token-pairs/v1/${NETWORKS[network].dexscreenerId}/${encodeURIComponent(token)}`,
    {
      bucket: dsBucket,
    },
  );
  const now = Date.now();
  return (Array.isArray(r) ? r : [])
    .map((p) => normalizeDsPair(p, now))
    .filter((p): p is PairSummary => p !== null);
}

/** Up to 30 token addresses per call. Returns the most liquid pair per token. */
export async function dsTokens(network: NetworkId, tokens: string[]): Promise<PairSummary[]> {
  if (tokens.length === 0) return [];
  const r = await fetchJson<DsPair[]>(
    `${DS}/tokens/v1/${NETWORKS[network].dexscreenerId}/${tokens.slice(0, 30).map(encodeURIComponent).join(',')}`,
    { bucket: dsBucket },
  );
  const now = Date.now();
  return (Array.isArray(r) ? r : [])
    .map((p) => normalizeDsPair(p, now))
    .filter((p): p is PairSummary => p !== null);
}

/** Up to 30 pair addresses per call — live stats for a whole table row set in one request. */
export async function dsPairs(network: NetworkId, pairs: string[]): Promise<PairSummary[]> {
  if (pairs.length === 0) return [];
  const r = await fetchJson<{ pairs: DsPair[] | null }>(
    `${DS}/latest/dex/pairs/${NETWORKS[network].dexscreenerId}/${pairs.slice(0, 30).map(encodeURIComponent).join(',')}`,
    { bucket: dsBucket },
  );
  const now = Date.now();
  return (r.pairs ?? []).map((p) => normalizeDsPair(p, now)).filter((p): p is PairSummary => p !== null);
}

export async function dsPair(network: NetworkId, pair: string): Promise<PairSummary | null> {
  const r = await fetchJson<{ pairs: DsPair[] | null; pair?: DsPair | null }>(
    `${DS}/latest/dex/pairs/${NETWORKS[network].dexscreenerId}/${encodeURIComponent(pair)}`,
    { bucket: dsBucket },
  );
  const p = r.pairs?.[0] ?? r.pair;
  return p ? normalizeDsPair(p, Date.now()) : null;
}

/* -------------------------------- GeckoTerminal -------------------------------- */

export class GeckoTerminal {
  private bucket: TokenBucket;
  private base: string;
  private headers: Record<string, string>;

  constructor(proKey: string) {
    // Public API: 30 calls/min. Pro (CoinGecko on-chain): much higher, documented per plan.
    this.bucket = proKey ? new TokenBucket(30, 8) : new TokenBucket(5, 0.45, 60);
    this.base = proKey
      ? 'https://pro-api.coingecko.com/api/v3/onchain'
      : 'https://api.geckoterminal.com/api/v2';
    this.headers = proKey ? { 'x-cg-pro-api-key': proKey } : {};
  }

  get queueDepth() {
    return this.bucket.pending;
  }

  /** After a 429 the whole client pauses: retrying into a rate limit only extends it. */
  private coolUntil = 0;
  static readonly COOLDOWN_MS = 60_000;

  get coolingDown() {
    return Date.now() < this.coolUntil;
  }

  private async get<T>(path: string) {
    if (this.coolingDown) throw new UpstreamError('GeckoTerminal rate limit — cooling down', 429, false);
    try {
      return await fetchJson<T>(`${this.base}${path}`, {
        bucket: this.bucket,
        headers: this.headers,
        retries: 0,
      });
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 429)
        this.coolUntil = Date.now() + GeckoTerminal.COOLDOWN_MS;
      throw e;
    }
  }

  /** Any GeckoTerminal path (same rate limiter); callers normalize the JSON:API payload. */
  raw<T>(path: string) {
    return this.get<T>(path);
  }

  async ohlcv(
    network: NetworkId,
    pool: string,
    tf: 'minute' | 'hour' | 'day',
    aggregate: number,
    limit = 300,
  ): Promise<Candle[]> {
    const r = await this.get<{ data: { attributes: { ohlcv_list: number[][] } } }>(
      `/networks/${NETWORKS[network].geckoterminalId}/pools/${encodeURIComponent(pool)}/ohlcv/${tf}?aggregate=${aggregate}&limit=${limit}&currency=usd`,
    );
    return normalizeCandles(
      (r.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, v]) => ({
        time: t!,
        open: o!,
        high: h!,
        low: l!,
        close: c!,
        volume: v ?? 0,
      })),
    );
  }

  async trades(network: NetworkId, pool: string): Promise<PoolTrade[]> {
    const r = await this.get<{ data: Array<{ attributes: Record<string, string | null> }> }>(
      `/networks/${NETWORKS[network].geckoterminalId}/pools/${encodeURIComponent(pool)}/trades`,
    );
    return (r.data ?? []).slice(0, 100).map(({ attributes: a }) => {
      const side = a.kind === 'sell' ? 'sell' : 'buy';
      return {
        hash: a.tx_hash ?? '',
        at: a.block_timestamp ? Date.parse(a.block_timestamp) : 0,
        side,
        priceUsd: num(side === 'buy' ? a.price_to_in_usd : a.price_from_in_usd),
        volumeUsd: num(a.volume_in_usd),
        tokenAmount: num(side === 'buy' ? a.to_token_amount : a.from_token_amount),
        maker: a.tx_from_address ?? null,
      } satisfies PoolTrade;
    });
  }

  async newPools(network: NetworkId): Promise<NewPool[]> {
    const r = await this.get<{
      data: Array<{
        attributes: Record<string, unknown> & {
          volume_usd?: Record<string, string>;
          transactions?: Record<string, { buys: number; sells: number }>;
        };
        relationships: {
          base_token: { data: { id: string } };
          quote_token: { data: { id: string } };
          dex: { data: { id: string } };
        };
      }>;
      included?: Array<{ id: string; attributes: { symbol: string } }>;
    }>(`/networks/${NETWORKS[network].geckoterminalId}/new_pools?include=base_token,quote_token`);
    const sym = new Map((r.included ?? []).map((t) => [t.id, t.attributes.symbol]));
    const now = Date.now();
    return (r.data ?? []).map((d) => {
      const a = d.attributes;
      const strip = (id: string) => id.slice(id.indexOf('_') + 1);
      const bId = d.relationships.base_token.data.id;
      const qId = d.relationships.quote_token.data.id;
      return {
        source: 'geckoterminal',
        fetchedAt: now,
        network,
        poolAddress: String(a.address),
        name: String(a.name ?? ''),
        dex: d.relationships.dex.data.id,
        baseToken: strip(bId),
        quoteToken: strip(qId),
        baseSymbol: sym.get(bId) ?? String(a.name ?? '').split(' / ')[0] ?? '?',
        quoteSymbol:
          sym.get(qId) ??
          String(a.name ?? '')
            .split(' / ')[1]
            ?.split(' ')[0] ??
          '?',
        priceUsd: num(a.base_token_price_usd),
        liquidityUsd: num(a.reserve_in_usd),
        fdvUsd: num(a.fdv_usd),
        volume5mUsd: num(a.volume_usd?.m5),
        buys5m: a.transactions?.m5?.buys ?? null,
        sells5m: a.transactions?.m5?.sells ?? null,
        createdAt: typeof a.pool_created_at === 'string' ? Date.parse(a.pool_created_at) : null,
      } satisfies NewPool;
    });
  }
}

export const geckoNetworkFor = (id: string) => byGeckoId.get(id);

/* ------------------------------------ GoPlus ----------------------------------- */

const statusFlag = (v: unknown): boolean | null => {
  const st = (v as { status?: string } | undefined)?.status;
  return st === '1' ? true : st === '0' ? false : null;
};

const ADDR = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
function creatorOf(e: Record<string, unknown>): string | null {
  const evm = typeof e.creator_address === 'string' ? e.creator_address : null;
  const sol = Array.isArray(e.creators) ? (e.creators[0] as { address?: string } | undefined)?.address : null;
  const a = evm ?? sol ?? null;
  return a && ADDR.test(a) ? a : null;
}

const BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);
/** LP share that is locked or burned, from GoPlus `lp_holders` (percent is a 0–1 fraction). */
function lpLocked(v: unknown): number | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  let sum = 0;
  for (const h of v as Array<{ address?: string; percent?: string; is_locked?: number | string }>) {
    const locked = String(h.is_locked) === '1' || BURN.has((h.address ?? '').toLowerCase());
    if (locked) sum += num(h.percent) ?? 0;
  }
  return Math.min(100, sum * 100);
}

const gpBucket = new TokenBucket(5, 0.5, 50);

export async function goplusSecurity(network: NetworkId, token: string): Promise<TokenSecurity | null> {
  const n = NETWORKS[network];
  const url =
    n.kind === 'solana'
      ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(token)}`
      : `https://api.gopluslabs.io/api/v1/token_security/${n.goplusId}?contract_addresses=${encodeURIComponent(token)}`;
  const r = await fetchJson<{ code: number; result: Record<string, Record<string, unknown>> | null }>(url, {
    bucket: gpBucket,
  });
  if (r.code !== 1 || !r.result) return null;
  const entry = r.result[token] ?? r.result[token.toLowerCase()] ?? Object.values(r.result)[0];
  if (!entry) return null;
  const flag = (k: string): boolean | null => (entry[k] === '1' ? true : entry[k] === '0' ? false : null);
  const pct = (k: string): number | null => {
    const v = num(entry[k]);
    return v === null ? null : v * 100;
  };
  const holders = Array.isArray(entry.holders) ? (entry.holders as Array<{ percent?: string }>) : [];
  const top10 = holders.length
    ? holders.slice(0, 10).reduce((s, h) => s + (num(h.percent) ?? 0), 0) * 100
    : null;

  const flags: string[] = [];
  const sec: TokenSecurity = {
    source: 'goplus',
    fetchedAt: Date.now(),
    network,
    token,
    honeypot: flag('is_honeypot'),
    cannotSell: flag('cannot_sell_all'),
    buyTaxPct: pct('buy_tax'),
    sellTaxPct: pct('sell_tax'),
    isMintable:
      n.kind === 'solana'
        ? (entry.mintable as { status?: string } | undefined)?.status === '1'
        : flag('is_mintable'),
    ownerCanChangeBalance: flag('owner_change_balance'),
    hiddenOwner: flag('hidden_owner'),
    isOpenSource: flag('is_open_source'),
    holderCount: num(entry.holder_count),
    top10HolderPct: top10,
    creator: creatorOf(entry),
    creatorPct: pct('creator_percent'),
    isFreezable: n.kind === 'solana' ? statusFlag(entry.freezable) : null,
    ownerPowers:
      n.kind === 'solana'
        ? statusFlag(entry.balance_mutable_authority)
        : [
            flag('can_take_back_ownership'),
            flag('slippage_modifiable'),
            flag('personal_slippage_modifiable'),
          ].some((x) => x === true) || null,
    lpLockedPct: lpLocked(entry.lp_holders),
    flags,
  };
  if (sec.honeypot) flags.push('Honeypot');
  if (sec.cannotSell) flags.push('Cannot sell all');
  if (sec.isMintable) flags.push('Mintable');
  if (sec.ownerCanChangeBalance) flags.push('Owner can change balances');
  if (sec.hiddenOwner) flags.push('Hidden owner');
  if (sec.isOpenSource === false) flags.push('Not open source');
  if (flag('is_proxy')) flags.push('Upgradeable proxy');
  if (flag('transfer_pausable')) flags.push('Transfers pausable');
  if (flag('is_blacklisted')) flags.push('Has blacklist');
  if (sec.isFreezable) flags.push('Freezable');
  if (sec.ownerPowers) flags.push('Owner can change taxes / ownership');
  if ((sec.sellTaxPct ?? 0) > 10) flags.push(`Sell tax ${sec.sellTaxPct?.toFixed(1)}%`);
  return sec;
}
