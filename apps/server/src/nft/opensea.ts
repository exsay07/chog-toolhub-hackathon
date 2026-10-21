import { fetchJson, TokenBucket, UpstreamError } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';
import type { Logger } from '../lib/log.js';

/**
 * OpenSea API v2 (https://docs.opensea.io/reference). The free key allows ~60 read requests a
 * minute, so every call goes through one shared token bucket and results are cached; the Top
 * Collections table is filled in the background and served progressively.
 *
 * Chain slugs used by OpenSea for our networks.
 */
export const OPENSEA_CHAINS = {
  monad: 'monad',
  base: 'base',
  robinhood: 'robinhood',
  ethereum: 'ethereum',
} as const;
export type NftChain = keyof typeof OPENSEA_CHAINS;
export const NFT_CHAINS = Object.keys(OPENSEA_CHAINS) as NftChain[];

export const TOP_SORTS = ['one_day_volume', 'one_day_sales', 'seven_days_volume', 'floor_price'] as const;

/** A chain OpenSea lists collections for (Top Collections can show any of them). */
export interface OsChain {
  id: string;
  name: string;
  symbol: string;
}
/** Used when OpenSea's /chains is unreachable (snapshot of 2026-10-21). */
export const FALLBACK_CHAINS: OsChain[] = [
  ['ethereum', 'Ethereum', 'ETH'],
  ['solana', 'Solana', 'SOL'],
  ['base', 'Base', 'ETH'],
  ['monad', 'Monad', 'MON'],
  ['robinhood', 'Robinhood Chain', 'ETH'],
  ['abstract', 'Abstract', 'ETH'],
  ['ape_chain', 'ApeChain', 'APE'],
  ['hyperevm', 'HyperEVM', 'HYPE'],
  ['polygon', 'Polygon', 'POL'],
  ['arbitrum', 'Arbitrum', 'ETH'],
  ['optimism', 'Optimism', 'ETH'],
  ['ink', 'Ink', 'ETH'],
  ['arc', 'Arc Chain', 'USDC'],
  ['unichain', 'Unichain', 'ETH'],
  ['shape', 'Shape', 'ETH'],
  ['flow', 'Flow', 'FLOW'],
  ['stablechain', 'Stable Chain', 'USDT0'],
  ['sei', 'Sei', 'SEI'],
  ['hyperliquid', 'Hyperliquid', 'USDC'],
  ['soneium', 'Soneium', 'ETH'],
  ['ronin', 'Ronin', 'RON'],
  ['megaeth', 'MegaETH', 'ETH'],
  ['somnia', 'Somnia', 'SOMI'],
  ['avalanche', 'Avalanche', 'AVAX'],
  ['gunzilla', 'GUNZ', 'GUN'],
  ['animechain', 'AnimeChain', 'ANIME'],
  ['bera_chain', 'Berachain', 'BERA'],
  ['blast', 'Blast', 'ETH'],
  ['zora', 'Zora', 'ETH'],
].map(([id, name, symbol]) => ({ id: id!, name: name!, symbol: symbol! }));
/** Shown first in the picker and kept warm. */
export const FEATURED_CHAINS = [
  'monad',
  'base',
  'robinhood',
  'ethereum',
  'solana',
  'abstract',
  'ape_chain',
  'hyperevm',
  'polygon',
  'arbitrum',
  'ink',
];
/** Every sort kept warm for these; the 24 h volume list for the rest of FEATURED_CHAINS. */
const WARM_ALL_SORTS = ['monad', 'base', 'robinhood'];
const CHAINS_TTL = 24 * 60 * 60_000;
/** Drops shown: minting now, or starting within this window. */
export const DROPS_HORIZON_MS = 72 * 60 * 60_000;
const DROPS_TTL = 5 * 60_000;

export interface DropStage {
  label: string;
  type: string;
  /** Price in the smallest unit (wei / lamports) as a decimal string. */
  price: string | null;
  /** Native coin when the currency is the zero address; otherwise the ERC-20 address. */
  currency: string | null;
  start: number | null;
  end: number | null;
  maxPerWallet: number | null;
}
export interface Drop {
  slug: string;
  name: string;
  chain: string;
  contract: string;
  image: string | null;
  url: string;
  /** Minting right now (an active stage that has not ended). */
  live: boolean;
  stage: DropStage | null;
  next: DropStage | null;
  /** When it starts (upcoming) or ends (live). */
  at: number | null;
}
interface OsStage {
  stage_type?: string;
  label?: string;
  price?: string | null;
  price_currency_address?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  max_per_wallet?: string | number | null;
}
interface OsDrop {
  collection_slug: string;
  collection_name?: string;
  chain: string;
  contract_address: string;
  is_minting?: boolean;
  image_url?: string | null;
  opensea_url?: string;
  active_stage?: OsStage | null;
  next_stage?: OsStage | null;
}

const ms = (t: string | null | undefined) => {
  const v = t ? Date.parse(t) : NaN;
  return Number.isFinite(v) ? v : null;
};
function stageOf(s: OsStage | null | undefined): DropStage | null {
  if (!s) return null;
  const max = Number(s.max_per_wallet);
  return {
    label: String(s.label ?? s.stage_type ?? 'Mint').slice(0, 40),
    type: String(s.stage_type ?? ''),
    price: s.price && /^\d{1,40}$/.test(s.price) ? s.price : null,
    currency: s.price_currency_address ?? null,
    start: ms(s.start_time),
    end: ms(s.end_time),
    maxPerWallet: Number.isFinite(max) && max > 0 ? max : null,
  };
}

/** Pure filter + shape (exported for tests): live now, or starting within the horizon. */
export function selectDrops(raw: OsDrop[], now = Date.now(), horizon = DROPS_HORIZON_MS): Drop[] {
  const seen = new Set<string>();
  const out: Drop[] = [];
  for (const d of raw) {
    if (!/^[a-z0-9_]{2,32}$/.test(d.chain) || !d.contract_address || !d.collection_slug) continue;
    const key = `${d.chain}:${d.contract_address.toLowerCase()}`;
    if (seen.has(key)) continue;
    const stage = stageOf(d.active_stage);
    const next = stageOf(d.next_stage);
    const live =
      !!d.is_minting &&
      !!stage &&
      (stage.start === null || stage.start <= now) &&
      (stage.end === null || stage.end > now);
    // Upcoming: the next stage (or a scheduled active stage) starts within the horizon.
    const startsAt = [next?.start, stage && stage.start !== null && stage.start > now ? stage.start : null]
      .filter((x): x is number => typeof x === 'number' && x > now)
      .sort((a, b) => a - b)[0];
    const upcoming = startsAt !== undefined && startsAt - now <= horizon;
    if (!live && !upcoming) continue;
    seen.add(key);
    out.push({
      slug: d.collection_slug,
      name: String(d.collection_name || d.collection_slug).slice(0, 80),
      chain: d.chain,
      contract: d.contract_address,
      image: thumb(safeUrl(d.image_url), 96),
      url:
        d.opensea_url && d.opensea_url.startsWith('https://opensea.io/')
          ? d.opensea_url
          : `https://opensea.io/collection/${d.collection_slug}`,
      live,
      stage,
      next,
      at: live ? (stage?.end ?? null) : (startsAt ?? null),
    });
  }
  return out.sort((a, b) => Number(b.live) - Number(a.live) || (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** How long "OpenSea doesn't know this contract yet" is remembered. */
export const NOT_INDEXED_TTL = 10 * 60_000;

/** OpenSea's image CDN resizes on the fly: ask for a small square instead of the original upload. */
export function thumb(url: string | null, size = 96): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)seadn\.io$/.test(u.hostname)) return url;
    u.searchParams.set('w', String(size));
    return u.toString();
  } catch {
    return url;
  }
}
export type TopSort = (typeof TOP_SORTS)[number];

const API = 'https://api.opensea.io/api/v2';
const TOP_LIMIT = 25;
const LIST_TTL = 5 * 60_000;
const STATS_TTL = 10 * 60_000;
const DETAIL_TTL = 12 * 60 * 60_000;
/** Stop refreshing a chain/sort nobody has looked at for this long. */
const IDLE_MS = 15 * 60_000;
/** Rows enriched in parallel (the token bucket still caps the request rate). */
const ENRICH_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `n` in flight, in order of the list. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

interface OsCollection {
  collection: string;
  name: string;
  image_url?: string | null;
  opensea_url?: string;
  safelist_status?: string;
  contracts?: Array<{ address: string; chain: string }>;
  project_url?: string | null;
  twitter_username?: string | null;
  total_supply?: number;
}
interface OsStats {
  total: { floor_price?: number; floor_price_symbol?: string; num_owners?: number };
  intervals: Array<{ interval: string; sales: number; volume: number; volume_symbol?: string }>;
}

export interface TopRow {
  rank: number;
  slug: string;
  name: string;
  image: string | null;
  verified: boolean;
  contract: string | null;
  url: string;
  /** Null until the stats for this row have been fetched. */
  floor: number | null;
  floorSymbol: string;
  floor24hAgo: number | null;
  volume24h: number | null;
  volume7d: number | null;
  volumeSymbol: string;
  sales24h: number | null;
  owners: number | null;
  supply: number | null;
}

export interface TopResult {
  configured: boolean;
  rows: TopRow[];
  /** Rows whose stats are still being fetched. */
  pending: number;
  updatedAt: number | null;
  error: string | null;
}

export interface ContractLinks {
  slug: string;
  name: string | null;
  url: string;
  twitter: string | null;
  site: string | null;
  verified: boolean;
  /** Collection avatar (OpenSea image), https only. */
  image: string | null;
}

/**
 * OpenSea's documented free-tier key (POST /auth/keys, no signup): valid 7 days, 600 reads/hour.
 * Used automatically when no permanent OPENSEA_API_KEY is configured; renewed a day before it expires.
 */
export interface AutoKey {
  key: string;
  expiresAt: number;
  mintedAt: number;
}
/** Persists the free-tier key across restarts (OpenSea rate-limits key creation). */
export interface KeyStore {
  load(): Promise<AutoKey | null>;
  save(k: AutoKey): Promise<void>;
}
const FREE_KEY_RENEW_MS = 24 * 60 * 60_000;
/** A freshly minted key is not accepted at once: 401s in this window mean "wait", not "re-mint". */
const FREE_KEY_WARMUP_MS = 20 * 60_000;
/** Never ask OpenSea for keys more often than this (their creation endpoint is rate-limited). */
const MINT_MIN_GAP_MS = 6 * 60 * 60_000;

export class OpenSea {
  /** Permanent key: 120/min → kept at ~1.8 req/s. Free-tier key: 600/hour → ~0.15 req/s (540/hour). */
  private bucket: TokenBucket;
  private autoKey: AutoKey | null = null;
  private loaded = false;
  private lastMintTry = 0;
  private minting: Promise<string> | null = null;
  private cache = new TtlCache(4000);
  private snapshots = new Map<string, { rows: TopRow[]; at: number; error: string | null }>();
  private lastAsked = new Map<string, number>();
  private refreshing = new Set<string>();

  constructor(
    private readonly apiKey: string,
    private readonly log?: Logger,
    /** Mint OpenSea's free-tier key when no permanent key is set. */
    private readonly autoFreeKey = true,
    private readonly store?: KeyStore,
    /** Request budget override (tests). */
    rate?: { burst: number; perSec: number },
  ) {
    this.bucket = rate
      ? new TokenBucket(rate.burst, rate.perSec, 400)
      : apiKey
        ? new TokenBucket(6, 1.8, 400)
        : new TokenBucket(2, 0.15, 400);
  }

  get configured() {
    return this.apiKey.length > 0 || this.autoFreeKey;
  }

  /** "permanent" | "free-tier" — shown so the UI can say why lists fill slowly. */
  get keyKind() {
    return this.apiKey ? 'permanent' : 'free-tier';
  }

  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    if (!this.loaded) {
      this.loaded = true;
      this.autoKey = (await this.store?.load().catch(() => null)) ?? null;
    }
    const k = this.autoKey;
    if (k && k.expiresAt - Date.now() > FREE_KEY_RENEW_MS) return k.key;
    // Renew a day early; keep using the old key until the new one exists.
    if (Date.now() - this.lastMintTry < MINT_MIN_GAP_MS) {
      if (k && k.expiresAt > Date.now()) return k.key;
      throw new UpstreamError('Waiting for an OpenSea API key', 503, true);
    }
    this.minting ??= (async () => {
      this.lastMintTry = Date.now();
      try {
        const r = await fetchJson<{ api_key: string; expires_at: string }>(`${API}/auth/keys`, {
          method: 'POST',
          timeoutMs: 10_000,
          retries: 0,
        });
        const fresh: AutoKey = {
          key: r.api_key,
          expiresAt: Date.parse(r.expires_at) || Date.now() + 6 * 86_400_000,
          mintedAt: Date.now(),
        };
        this.autoKey = fresh;
        await this.store?.save(fresh).catch(() => {});
        this.log?.info({ expiresAt: r.expires_at }, 'opensea free-tier key minted');
        return fresh.key;
      } catch (e) {
        this.log?.warn({ err: (e as Error).message }, 'opensea free-tier key mint failed; retrying later');
        if (k && k.expiresAt > Date.now()) return k.key;
        throw e;
      } finally {
        this.minting = null;
      }
    })();
    return this.minting;
  }

  private async get<T>(path: string, priority = false): Promise<T> {
    const key = await this.key();
    try {
      return await fetchJson<T>(`${API}${path}`, {
        bucket: this.bucket,
        priority,
        timeoutMs: 10_000,
        retries: 2,
        headers: { 'x-api-key': key },
      });
    } catch (e) {
      // A brand-new free key needs a few minutes before OpenSea accepts it: wait, don't re-mint.
      if (!this.apiKey && e instanceof UpstreamError && e.status === 401) {
        if (this.autoKey && Date.now() - this.autoKey.mintedAt < FREE_KEY_WARMUP_MS)
          throw new UpstreamError('OpenSea key is activating', 503, true);
        // Revoked or expired: drop it so the next call mints a fresh one (subject to MINT_MIN_GAP_MS).
        this.autoKey = null;
        this.lastMintTry = 0;
        return fetchJson<T>(`${API}${path}`, {
          bucket: this.bucket,
          timeoutMs: 10_000,
          retries: 1,
          headers: { 'x-api-key': await this.key() },
        });
      }
      throw e;
    }
  }

  private warmTimer: NodeJS.Timeout | null = null;
  private floors = new Map<string, { price: number; symbol: string; at: number }>();
  private floorBusy = new Set<string>();

  /**
   * Last known floor of a collection, answered instantly from memory (public pages call this, so it
   * must never wait on OpenSea); refreshed in the background at most every 10 minutes.
   */
  floorOf(slug: string): { price: number; symbol: string } | null {
    const f = this.floors.get(slug);
    if (this.configured && (!f || Date.now() - f.at > STATS_TTL) && !this.floorBusy.has(slug)) {
      this.floorBusy.add(slug);
      void this.cache
        .get(`stats:${slug}`, STATS_TTL, () =>
          this.get<OsStats>(`/collections/${encodeURIComponent(slug)}/stats`),
        )
        .then((r) => {
          const t = r.value.total;
          if (typeof t.floor_price === 'number')
            this.floors.set(slug, {
              price: t.floor_price,
              symbol: t.floor_price_symbol ?? '',
              at: Date.now(),
            });
        })
        .catch(() => {})
        .finally(() => this.floorBusy.delete(slug));
    }
    return f ? { price: f.price, symbol: f.symbol } : null;
  }

  /**
   * Keeps the lists people open most ready: the 24 h volume list of every featured chain and every sort
   * of our own networks (Monad, Base, Robinhood). Any other chain/sort is fetched on first view (~10 s)
   * and then stays warm while someone looks at it. Visitors only read these snapshots, so OpenSea traffic
   * does not grow with the number of people on the page. Only with a permanent key (~60-75 requests/min
   * of its 120/min; stats are cached per collection and shared between sorts).
   */
  startWarm() {
    if (!this.apiKey || this.warmTimer) return;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const known = new Set((await this.chains()).map((c) => c.id));
        const featured = FEATURED_CHAINS.filter((c) => known.has(c));
        const now = Date.now();
        for (const chain of featured) this.lastAsked.set(`${chain}:one_day_volume`, now);
        for (const chain of WARM_ALL_SORTS)
          for (const sort of TOP_SORTS) this.lastAsked.set(`${chain}:${sort}`, now);
        // Default views first (a few chains at a time), then the other sorts of our own networks.
        void this.drops().catch(() => {});
        this.floorOf('chog-genesis');
        await pool(featured, 3, (chain) => this.refresh(chain, 'one_day_volume'));
        for (const sort of TOP_SORTS.filter((x) => x !== 'one_day_volume'))
          for (const chain of WARM_ALL_SORTS) await this.refresh(chain, sort);
      } finally {
        running = false;
      }
    };
    void tick();
    this.warmTimer = setInterval(() => void tick(), LIST_TTL);
    this.warmTimer.unref?.();
  }

  stopWarm() {
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
  }

  /** Current snapshot (instantly) + a background refresh when it is missing or old. */
  /**
   * OpenSea drops calendar: featured, upcoming and recently minted (first pages), reduced to what is
   * minting now or starts within 72 h. Cached 5 minutes and shared by every visitor.
   */
  async drops(): Promise<{ rows: Drop[]; updatedAt: number }> {
    if (!this.configured) return { rows: [], updatedAt: Date.now() };
    const r = await this.cache.get('drops', DROPS_TTL, async () => {
      const page = (q: string) =>
        this.get<{ drops: OsDrop[]; next?: string | null }>(`/drops?${q}`).catch(
          () => ({ drops: [] }) as { drops: OsDrop[]; next?: string | null },
        );
      const [featured, upcoming, recent] = await Promise.all([
        page('type=featured&limit=100'),
        page('type=upcoming&limit=100'),
        page('type=recently_minted&limit=100'),
      ]);
      let more = recent.drops;
      if (recent.next) {
        const p2 = await page(`type=recently_minted&limit=100&next=${encodeURIComponent(recent.next)}`);
        more = [...more, ...p2.drops];
      }
      return { rows: selectDrops([...upcoming.drops, ...featured.drops, ...more]), updatedAt: Date.now() };
    });
    return r.value;
  }

  /** Chains with OpenSea collection data (cached a day; built-in list if OpenSea is unreachable). */
  async chains(): Promise<OsChain[]> {
    if (!this.configured) return FALLBACK_CHAINS;
    try {
      const r = await this.cache.get('chains', CHAINS_TTL, () =>
        this.get<{ chains: Array<{ chain: string; name: string; symbol: string }> }>('/chains'),
      );
      const list = r.value.chains
        .filter((c) => /^[a-z0-9_]{2,32}$/.test(c.chain) && !c.chain.startsWith('tenderly'))
        .map((c) => ({
          id: c.chain,
          name: String(c.name).slice(0, 40),
          symbol: String(c.symbol).slice(0, 12),
        }));
      return list.length ? list : FALLBACK_CHAINS;
    } catch {
      return FALLBACK_CHAINS;
    }
  }

  top(chain: string, sort: TopSort): TopResult {
    if (!this.configured) return { configured: false, rows: [], pending: 0, updatedAt: null, error: null };
    const key = `${chain}:${sort}`;
    this.lastAsked.set(key, Date.now());
    const snap = this.snapshots.get(key);
    if (!snap || Date.now() - snap.at > LIST_TTL) void this.refresh(chain, sort);
    const rows = snap?.rows ?? [];
    return {
      configured: true,
      rows,
      pending: snap ? rows.filter((r) => r.floor === null && r.volume24h === null).length : TOP_LIMIT,
      updatedAt: snap?.at ?? null,
      error: snap?.error ?? null,
    };
  }

  private async refresh(chain: string, sort: TopSort) {
    const key = `${chain}:${sort}`;
    if (this.refreshing.has(key)) return;
    this.refreshing.add(key);
    try {
      const list = await this.cache.get(`top:${key}`, LIST_TTL, () =>
        this.get<{ collections: OsCollection[] }>(
          `/collections/top?chains=${encodeURIComponent(chain)}&sort_by=${sort}&limit=${TOP_LIMIT}`,
        ),
      );
      const prev = new Map((this.snapshots.get(key)?.rows ?? []).map((r) => [r.slug, r]));
      const rows: TopRow[] = list.value.collections.map((c, i) => ({
        ...emptyRow(c, chain),
        ...pickStats(prev.get(c.collection)),
        rank: i + 1,
      }));
      this.snapshots.set(key, { rows, at: Date.now(), error: null });
      // Two passes, a few rows at a time, in rank order: first what the table is about (floor, volume,
      // sales, owners), then the extras (24 h floor change, supply).
      const active = () => Date.now() - (this.lastAsked.get(key) ?? 0) <= IDLE_MS;
      const pass = (fn: (r: TopRow) => Promise<void>) =>
        pool(rows, ENRICH_CONCURRENCY, async (row) => {
          if (!active()) return;
          await fn(row).catch((e) => this.log?.debug({ err: String(e), slug: row.slug }, 'opensea row'));
        });
      await pass((r) => this.enrichStats(r));
      await pass((r) => this.enrichExtras(r));
    } catch (e) {
      const msg =
        e instanceof UpstreamError && (e.status === 401 || e.status === 403)
          ? 'OpenSea rejected the API key'
          : 'OpenSea is unavailable right now';
      const snap = this.snapshots.get(key);
      this.snapshots.set(key, { rows: snap?.rows ?? [], at: snap?.at ?? 0, error: msg });
      this.log?.warn({ err: String(e), chain, sort }, 'opensea top collections');
    } finally {
      this.refreshing.delete(key);
    }
  }

  private async enrichStats(row: TopRow) {
    const stats = await this.cache.get(`stats:${row.slug}`, STATS_TTL, () =>
      this.get<OsStats>(`/collections/${encodeURIComponent(row.slug)}/stats`),
    );
    const t = stats.value.total;
    const one = stats.value.intervals.find((x) => x.interval.startsWith('one_day'));
    const seven = stats.value.intervals.find((x) => x.interval.startsWith('seven_day'));
    row.floor = t.floor_price ?? 0;
    row.floorSymbol = t.floor_price_symbol ?? '';
    row.owners = t.num_owners ?? null;
    row.volume24h = one?.volume ?? 0;
    row.sales24h = one?.sales ?? 0;
    row.volume7d = seven?.volume ?? null;
    row.volumeSymbol = one?.volume_symbol || seven?.volume_symbol || '';
  }

  private async enrichExtras(row: TopRow) {
    const hist = await this.cache.get(`floor:${row.slug}`, STATS_TTL, () =>
      this.get<{ floor_prices: Array<{ time: number; token_unit?: number | null }> }>(
        `/collections/${encodeURIComponent(row.slug)}/floor_prices?timeframe=one_day`,
      ),
    );
    const pts = hist.value.floor_prices
      .filter((p) => typeof p.token_unit === 'number' && p.token_unit > 0)
      .sort((a, b) => a.time - b.time);
    row.floor24hAgo = pts.length >= 2 ? pts[0]!.token_unit! : null;

    const detail = await this.collection(row.slug);
    row.supply = detail.total_supply ?? null;
  }

  private async collection(slug: string, priority = false) {
    const d = await this.cache.get(`col:${slug}`, DETAIL_TTL, () =>
      this.get<OsCollection>(`/collections/${encodeURIComponent(slug)}`, priority),
    );
    return d.value;
  }

  /** Contracts of an OpenSea collection slug (NFT Sniper: paste an opensea.io/collection/… link). */
  async slugContracts(
    slug: string,
  ): Promise<{ name: string; contracts: Array<{ chain: string; address: string }> }> {
    const c = await this.collection(slug);
    return {
      name: c.name,
      contracts: (c.contracts ?? []).filter((x) => /^0x[0-9a-fA-F]{40}$/.test(x.address)).slice(0, 10),
    };
  }

  /**
   * OpenSea page (+ socials with a key) for a contract seen minting. The contract lookup works
   * without a key; 404 means OpenSea doesn't know the contract yet → null.
   */
  async contractLinks(chain: NftChain, address: string): Promise<ContractLinks | null> {
    const r = await this.cache.get(
      `contract:${chain}:${address}`,
      DETAIL_TTL,
      async () => {
        try {
          const c = await this.get<{ collection?: string | null; name?: string | null }>(
            `/chain/${OPENSEA_CHAINS[chain]}/contract/${address}`,
            true,
          );
          if (!c.collection) return null;
          const links: ContractLinks = {
            slug: c.collection,
            name: c.name ?? null,
            url: `https://opensea.io/collection/${c.collection}`,
            twitter: null,
            site: null,
            verified: false,
            image: null,
          };
          if (this.configured) {
            const d = await this.collection(c.collection, true).catch(() => null);
            if (d) {
              links.twitter = d.twitter_username ? `https://x.com/${d.twitter_username}` : null;
              links.site = safeUrl(d.project_url);
              links.verified = d.safelist_status === 'verified';
              links.image = thumb(safeUrl(d.image_url));
            }
          }
          return links;
        } catch (e) {
          if (e instanceof UpstreamError && e.status === 404) return null;
          throw e;
        }
      },
      DETAIL_TTL,
    );
    // A brand-new contract OpenSea has not indexed yet: ask again soon, not in 12 hours.
    if (r.value === null) this.cache.set(`contract:${chain}:${address}`, null, NOT_INDEXED_TTL);
    return r.value;
  }

  /** Queue depth, for health/metrics. */
  get queued() {
    return this.bucket.pending;
  }
}

function emptyRow(c: OsCollection, chain: string): TopRow {
  const contract = c.contracts?.find((x) => x.chain === chain)?.address ?? null;
  return {
    rank: 0,
    slug: c.collection,
    name: c.name || c.collection,
    image: thumb(safeUrl(c.image_url), 64),
    verified: c.safelist_status === 'verified',
    contract,
    url:
      c.opensea_url && c.opensea_url.startsWith('https://opensea.io/')
        ? c.opensea_url
        : `https://opensea.io/collection/${c.collection}`,
    floor: null,
    floorSymbol: '',
    floor24hAgo: null,
    volume24h: null,
    volume7d: null,
    volumeSymbol: '',
    sales24h: null,
    owners: null,
    supply: null,
  };
}

/** Keeps already-fetched numbers visible while a list refresh re-enriches the rows. */
function pickStats(r: TopRow | undefined): Partial<TopRow> {
  if (!r) return {};
  const { floor, floorSymbol, floor24hAgo, volume24h, volume7d, volumeSymbol, sales24h, owners, supply } = r;
  return { floor, floorSymbol, floor24hAgo, volume24h, volume7d, volumeSymbol, sales24h, owners, supply };
}

/** Only plain https links reach the browser. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x.toString() : null;
  } catch {
    return null;
  }
}
