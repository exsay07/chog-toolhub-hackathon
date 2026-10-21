import type { NetworkId } from './networks.js';

/** Provenance of a value. Third-party aggregates are never presented as on-chain truth. */
export type DataSource = 'dexscreener' | 'geckoterminal' | 'goplus' | 'onchain' | 'kyberswap' | 'jupiter';

export interface Sourced {
  source: DataSource;
  /** When our server fetched it from the provider (ms). */
  fetchedAt: number;
}

export interface TokenRef {
  address: string;
  symbol: string;
  name: string;
}

export interface PairSummary extends Sourced {
  network: NetworkId;
  pairAddress: string;
  dex: string;
  base: TokenRef;
  quote: TokenRef;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  /** Fully diluted valuation (supply × price) — provider estimate. */
  fdvUsd: number | null;
  /** Circulating market cap — provider estimate, often unavailable. */
  marketCapUsd: number | null;
  volume: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns: {
    h24: { buys: number; sells: number } | null;
    h1: { buys: number; sells: number } | null;
    m5?: { buys: number; sells: number } | null;
    h6?: { buys: number; sells: number } | null;
  };
  /** Project links from the token profile (https only), when the provider has them. */
  socials?: { website: string | null; twitter: string | null; telegram: string | null };
  createdAt: number | null;
  url: string | null;
  imageUrl: string | null;
}

export interface Candle {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PoolTrade {
  hash: string;
  at: number;
  side: 'buy' | 'sell';
  priceUsd: number | null;
  volumeUsd: number | null;
  tokenAmount: number | null;
  maker: string | null;
}

export interface NewPool extends Sourced {
  network: NetworkId;
  poolAddress: string;
  name: string;
  dex: string;
  baseToken: string;
  quoteToken: string;
  baseSymbol: string;
  quoteSymbol: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  volume5mUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  createdAt: number | null;
}

export interface TokenSecurity extends Sourced {
  network: NetworkId;
  token: string;
  honeypot: boolean | null;
  cannotSell: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  isMintable: boolean | null;
  ownerCanChangeBalance: boolean | null;
  hiddenOwner: boolean | null;
  isOpenSource: boolean | null;
  holderCount: number | null;
  /** Share of supply held by top-10 holders (0–100). */
  top10HolderPct: number | null;
  /** Deployer / creator, when the scanner knows it. */
  creator?: string | null;
  creatorPct?: number | null;
  /** Solana: freeze authority still set. */
  isFreezable?: boolean | null;
  /** Owner can reclaim ownership or change taxes/slippage. */
  ownerPowers?: boolean | null;
  /** Share of LP tokens locked or burned (0–100), EVM only. */
  lpLockedPct?: number | null;
  flags: string[];
}

export type TrackerEventKind = 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'other';

export interface TrackerEvent {
  id: string;
  walletId: string;
  walletLabel: string;
  walletColor: string;
  network: NetworkId;
  wallet: string;
  hash: string;
  at: number;
  kind: TrackerEventKind;
  token: string | null;
  tokenSymbol: string | null;
  tokenAmount: number | null;
  /** Counter-asset leg (what was paid/received), when detected. */
  counterSymbol: string | null;
  counterAmount: number | null;
  /** Estimate from current market price; not the exact fill. */
  estUsd: number | null;
  explorerUrl: string;
}

/** Server → client WebSocket messages. */
export type WsServerMsg =
  | { t: 'hello'; serverTime: number }
  | { t: 'tracker'; event: TrackerEvent }
  | { t: 'newPool'; pool: NewPool }
  | { t: 'pair'; pair: PairSummary }
  | { t: 'tx'; hash: string; network: NetworkId; state: string }
  | { t: 'providerHealth'; health: Record<string, ProviderHealth> }
  | { t: 'error'; message: string };

/** Client → server WebSocket messages. */
export type WsClientMsg =
  | { t: 'subPair'; network: NetworkId; pair: string }
  | { t: 'unsubPair'; network: NetworkId; pair: string }
  | { t: 'subNewPools'; network: NetworkId }
  | { t: 'unsubNewPools'; network: NetworkId }
  | { t: 'ping' };

export interface ProviderHealth {
  ok: boolean;
  lastOkAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/**
 * Sorts candles ascending and merges duplicate timestamps (providers occasionally return the same
 * bucket twice; charting libraries require strictly increasing time).
 */
export function normalizeCandles(input: Candle[]): Candle[] {
  const valid = input.filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite));
  valid.sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  for (const c of valid) {
    const prev = out[out.length - 1];
    if (prev && prev.time === c.time) {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume = Math.max(prev.volume, c.volume);
    } else out.push({ ...c });
  }
  return out;
}

/** One search result per token (Dexscreener-style), aggregated across all of its pools. */
export interface TokenHit {
  network: NetworkId;
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  /** USD price from the most liquid pool. */
  priceUsd: number | null;
  change24h: number | null;
  /** Summed across pools (provider estimates). */
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  pairCount: number;
  bestPair: string;
  bestDex: string;
  bestQuoteSymbol: string;
  createdAt: number | null;
}

export interface SearchResult {
  hits: TokenHit[];
  /** Set when the query was a contract address that resolved unambiguously: open it directly. */
  exact: { network: NetworkId; token: string; pair: string | null } | null;
}

/**
 * Groups pool-level results into tokens. For address queries the queried token is the one
 * reported, even when it sits on the quote side of a pool (its USD price is then derived as
 * base.priceUsd / priceNative, i.e. the quote token's own price).
 */
export function groupPairsToTokens(pairs: PairSummary[], queryAddress?: string): TokenHit[] {
  const q = queryAddress?.toLowerCase();
  const groups = new Map<string, PairSummary[]>();
  for (const p of pairs) {
    // The token of interest: the queried address (whichever side it is on), else the base token.
    const tok =
      q && p.quote.address.toLowerCase() === q && p.base.address.toLowerCase() !== q ? p.quote : p.base;
    const key = `${p.network}:${tok.address.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const hits: TokenHit[] = [];
  for (const [key, list] of groups) {
    const addr = key.slice(key.indexOf(':') + 1);
    const ps = [...list].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    const best = ps[0]!;
    // Prefer a pool where the token is the base side for price/metadata (Dexscreener prices the base).
    const asBase = ps.find((p) => p.base.address.toLowerCase() === addr);
    const ref = asBase ?? best;
    const tok = ref.base.address.toLowerCase() === addr ? ref.base : ref.quote;
    const derived = ref.priceUsd !== null && ref.priceNative ? ref.priceUsd / ref.priceNative : null;
    hits.push({
      network: best.network,
      address: tok.address,
      symbol: tok.symbol,
      name: tok.name,
      imageUrl: asBase ? asBase.imageUrl : null,
      priceUsd: asBase ? asBase.priceUsd : derived,
      change24h: asBase ? asBase.change.h24 : null,
      liquidityUsd: ps.reduce((s, p) => s + (p.liquidityUsd ?? 0), 0),
      volume24hUsd: ps.reduce((s, p) => s + (p.volume.h24 ?? 0), 0),
      fdvUsd: asBase ? asBase.fdvUsd : null,
      marketCapUsd: asBase ? asBase.marketCapUsd : null,
      pairCount: ps.length,
      bestPair: (asBase ?? best).pairAddress,
      bestDex: (asBase ?? best).dex,
      bestQuoteSymbol: asBase ? asBase.quote.symbol : best.base.symbol,
      createdAt: ps.reduce<number | null>(
        (m, p) => (p.createdAt === null ? m : m === null ? p.createdAt : Math.min(m, p.createdAt)),
        null,
      ),
    });
  }
  return hits.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}
