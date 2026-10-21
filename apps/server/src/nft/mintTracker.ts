import { createPublicClient, defineChain, fallback, http, type PublicClient } from 'viem';
import { NETWORKS } from '@chog/shared';
import { TRANSFER_TOPIC } from '../chain/evm.js';
import type { Logger } from '../lib/log.js';
import { MintAggregator, WINDOW_MS, type MintRow } from './mintAggregator.js';
import { NFT_CHAINS, NOT_INDEXED_TTL, type ContractLinks, type NftChain, type OpenSea } from './opensea.js';

/**
 * Mint Tracker worker: follows the chain head on Monad, Base, Robinhood Chain and Ethereum and records every
 * ERC-721 mint (Transfer from 0x0 with an indexed tokenId = 4 topics). On start it backfills the
 * last hour. Contract names / supply are read on-chain; OpenSea links are looked up for the
 * collections that make it into the table.
 *
 * Log scans need RPCs that allow address-less eth_getLogs, so each chain has its own list
 * (MINT_RPC_*) and a block range that fits that provider's limit.
 */

const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

interface ChainCfg {
  /** Max blocks per eth_getLogs the provider accepts. */
  range: number;
  pollMs: number;
  /** Max getLogs calls per tick, so a backfill can't starve the RPC. */
  chunksPerTick: number;
}
const CHAIN_CFG: Record<NftChain, ChainCfg> = {
  monad: { range: 100, pollMs: 4000, chunksPerTick: 12 },
  base: { range: 100, pollMs: 6000, chunksPerTick: 6 },
  robinhood: { range: 1000, pollMs: 5000, chunksPerTick: 8 },
  // 12 s blocks; dRPC / Flashbots accept address-less log scans over small ranges.
  ethereum: { range: 25, pollMs: 12000, chunksPerTick: 6 },
};

export const DEFAULT_MINT_RPC: Record<NftChain, string[]> = {
  monad: ['https://rpc.monad.xyz', 'https://rpc3.monad.xyz'],
  base: ['https://base.drpc.org', 'https://1rpc.io/base'],
  robinhood: ['https://rpc.mainnet.chain.robinhood.com'],
  ethereum: ['https://eth.drpc.org', 'https://rpc.flashbots.net'],
};

const ERC721_META = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

interface Meta {
  name: string | null;
  symbol: string | null;
  supply: number | null;
  at: number;
}

/** Background refresh of the table's names / supply / OpenSea links. */
const WARM_MS = 20_000;

export interface MintTableRow extends MintRow {
  chain: NftChain;
  name: string | null;
  symbol: string | null;
  /** totalSupply() when the contract exposes it. */
  minted: number | null;
  links: { explorer: string; opensea: string | null; twitter: string | null; site: string | null };
  verified: boolean;
  /** Collection avatar from OpenSea once it has indexed the contract. */
  image: string | null;
}

export interface ChainStatus {
  ok: boolean;
  head: number | null;
  /** Blocks behind the head (backfilling or lagging). */
  behind: number;
  error: string | null;
}

class ChainFollower {
  readonly agg = new MintAggregator();
  status: ChainStatus = { ok: false, head: null, behind: 0, error: null };
  private next: bigint | null = null;
  private blockMs = 1000;
  private headTs = 0;
  private head = 0n;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Public RPCs throttle now and then; only report an outage after several failures in a row. */
  private failStreak = 0;

  constructor(
    readonly chain: NftChain,
    readonly client: PublicClient,
    private readonly cfg: ChainCfg,
    private readonly log: Logger,
  ) {}

  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
        this.failStreak = 0;
        this.status.ok = true;
        this.status.error = null;
      } catch (e) {
        if (++this.failStreak >= 3) {
          this.status.ok = false;
          this.status.error = rpcError(e);
        }
        this.log.debug({ chain: this.chain, err: String(e) }, 'mint tracker tick failed');
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => void loop(), this.cfg.pollMs);
        this.timer.unref?.();
      }
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Block number → approximate ms timestamp (fine for 10-minute / 1-hour windows). */
  private timeOf(bn: bigint) {
    return this.headTs - Number(this.head - bn) * this.blockMs;
  }

  private async tick() {
    const latest = await this.client.getBlock({ blockTag: 'latest' });
    this.head = latest.number;
    this.headTs = Number(latest.timestamp) * 1000;
    if (this.next === null) {
      // Measure the block time, then start one hour back.
      const sample = 1000n < this.head ? 1000n : this.head;
      const old = await this.client.getBlock({ blockNumber: this.head - sample });
      this.blockMs = Math.max(50, ((this.headTs - Number(old.timestamp) * 1000) / Number(sample)) | 0);
      const back = BigInt(Math.ceil(WINDOW_MS / this.blockMs));
      this.next = this.head > back ? this.head - back : 0n;
    }
    // Never more than an hour behind: skip ahead instead of replaying stale blocks.
    const floor = this.head - BigInt(Math.ceil(WINDOW_MS / this.blockMs));
    let next: bigint = this.next < floor ? floor : this.next;
    const span = BigInt(this.cfg.range - 1);

    for (let i = 0; i < this.cfg.chunksPerTick && next <= this.head; i++) {
      const from: bigint = next;
      const to: bigint = from + span < this.head ? from + span : this.head;
      const logs = await this.client.request({
        method: 'eth_getLogs',
        params: [
          {
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            topics: [TRANSFER_TOPIC, ZERO_TOPIC],
          },
        ],
      });
      this.agg.add(
        logs
          .filter((l) => l.topics.length === 4 && l.blockNumber && l.transactionHash)
          .map((l) => ({
            contract: l.address,
            to: `0x${l.topics[2]!.slice(26)}`,
            tx: l.transactionHash!,
            at: this.timeOf(BigInt(l.blockNumber!)),
          })),
      );
      next = to + 1n;
      this.next = next;
    }
    this.next = next;
    this.agg.prune(Date.now());
    this.status.head = Number(this.head);
    this.status.behind = Math.max(0, Number(this.head - next + 1n));
  }
}

export class MintTracker {
  private followers: ChainFollower[] = [];
  private meta = new Map<string, Meta>();
  private links = new Map<string, ContractLinks | null>();
  /** When each link lookup last ran (null answers are retried after NOT_INDEXED_TTL). */
  private linkAt = new Map<string, number>();
  private metaInflight = new Set<string>();

  constructor(
    rpc: Record<NftChain, string[]>,
    private readonly opensea: OpenSea,
    private readonly log: Logger,
  ) {
    for (const chain of NFT_CHAINS) {
      const n = NETWORKS[chain];
      const urls = rpc[chain].length ? rpc[chain] : DEFAULT_MINT_RPC[chain];
      const client = createPublicClient({
        chain: defineChain({
          id: n.chainId!,
          name: n.name,
          nativeCurrency: { name: n.nativeSymbol, symbol: n.nativeSymbol, decimals: n.nativeDecimals },
          rpcUrls: { default: { http: urls } },
        }),
        transport: fallback(
          urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })),
          { rank: false },
        ),
      }) as PublicClient;
      this.followers.push(new ChainFollower(chain, client, CHAIN_CFG[chain], log));
    }
  }

  private warmTimer: NodeJS.Timeout | null = null;

  start() {
    for (const f of this.followers) f.start();
    // Names, supply and OpenSea links (avatars) are looked up in the background for the current
    // table, so a visitor sees them at once instead of waiting for the lookups to start.
    this.warmTimer = setInterval(() => void this.rows(NFT_CHAINS), WARM_MS);
    this.warmTimer.unref?.();
  }

  stop() {
    for (const f of this.followers) f.stop();
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
  }

  get stats() {
    return Object.fromEntries(this.followers.map((f) => [f.chain, { ...f.status, contracts: f.agg.size }]));
  }

  status(): Record<NftChain, ChainStatus> {
    return Object.fromEntries(this.followers.map((f) => [f.chain, f.status])) as Record<
      NftChain,
      ChainStatus
    >;
  }

  /** The table: hottest first, enriched with whatever metadata has been resolved so far. */
  rows(chains: NftChain[], limit = 60): MintTableRow[] {
    const now = Date.now();
    const out: MintTableRow[] = [];
    for (const f of this.followers) {
      if (!chains.includes(f.chain)) continue;
      for (const r of f.agg.rows(now).slice(0, limit)) {
        const key = `${f.chain}:${r.contract}`;
        const m = this.meta.get(key);
        const l = this.links.get(key);
        const relink = l === null && now - (this.linkAt.get(key) ?? 0) > NOT_INDEXED_TTL;
        if (!m || now - m.at > 10 * 60_000 || relink) this.resolve(f, r.contract);
        if (m && isDefiPosition(m)) continue;
        const osName = l?.name && !/^0x[0-9a-f]{40}$/i.test(l.name) ? l.name : null;
        out.push({
          ...r,
          chain: f.chain,
          name: osName ?? m?.name ?? null,
          symbol: m?.symbol ?? null,
          minted: m?.supply ?? null,
          links: {
            explorer: NETWORKS[f.chain].explorer.address(r.contract),
            opensea: l?.url ?? null,
            twitter: l?.twitter ?? null,
            site: l?.site ?? null,
          },
          verified: l?.verified ?? false,
          image: l?.image ?? null,
        });
      }
    }
    return out.sort((a, b) => b.m10 - a.m10 || b.m60 - a.m60).slice(0, limit);
  }

  private resolve(f: ChainFollower, contract: string) {
    const key = `${f.chain}:${contract}`;
    if (this.metaInflight.has(key)) return;
    this.metaInflight.add(key);
    // Bounded caches: contracts that minted once and went quiet are dropped first.
    for (const m of [this.meta, this.links, this.linkAt] as Array<Map<string, unknown>>)
      while (m.size > 5000) m.delete(m.keys().next().value!);
    const address = contract as `0x${string}`;
    const read = (functionName: 'name' | 'symbol' | 'totalSupply') =>
      f.client.readContract({ address, abi: ERC721_META, functionName }).catch(() => null);
    void (async () => {
      const prev = this.meta.get(key);
      const [name, symbol, supply] = await Promise.all([
        prev?.name !== undefined && prev.name !== null ? prev.name : read('name'),
        prev?.symbol !== undefined && prev.symbol !== null ? prev.symbol : read('symbol'),
        read('totalSupply'),
      ]);
      this.meta.set(key, {
        name: typeof name === 'string' ? name.slice(0, 80) : null,
        symbol: typeof symbol === 'string' ? symbol.slice(0, 20) : null,
        supply: typeof supply === 'bigint' && supply < 10n ** 12n ? Number(supply) : null,
        at: Date.now(),
      });
      const known = this.links.get(key);
      const stale = known === null && Date.now() - (this.linkAt.get(key) ?? 0) > NOT_INDEXED_TTL;
      if (known === undefined || stale) {
        const l = await this.opensea.contractLinks(f.chain, contract).catch(() => undefined);
        if (l !== undefined) {
          this.links.set(key, l);
          this.linkAt.set(key, Date.now());
        }
      }
    })().finally(() => this.metaInflight.delete(key));
  }
}

/**
 * DeFi liquidity-position NFTs (Uniswap V3/V4, Aerodrome Slipstream, PancakeSwap…) are minted on
 * every LP deposit — they are receipts, not collections, so they never show up in the tracker.
 */
export function isDefiPosition(m: { name: string | null; symbol: string | null }) {
  const sym = m.symbol ?? '';
  const name = m.name ?? '';
  return (
    /(^|[-_ ])POS(M)?([-_ ]|$)|-POS-|^UNI-V\d|CL-POS|NFP$|^LP[-_]|-LP$/i.test(sym) ||
    /\bpositions?\b.*\bNFT\b|\bliquidity position|non[- ]?fungible position/i.test(name)
  );
}

function rpcError(e: unknown) {
  const s = e instanceof Error ? e.message : String(e);
  if (/specify an address|block range|range is too|limited to/i.test(s))
    return 'the RPC refuses chain-wide log scans — set MINT_RPC_* to a provider that allows them';
  if (/429|rate|too many|request limit/i.test(s)) return 'the RPC is rate-limiting us — retrying';
  return 'the RPC is unavailable — retrying';
}
