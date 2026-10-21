import { and, eq } from 'drizzle-orm';
import { formatUnits, pad, type Log, type PublicClient } from 'viem';
import { NETWORKS, type NetworkId, type TrackerEvent } from '@chog/shared';
import type { Db } from '../db/client.js';
import { trackedWallets, trackerCursors, trackerEvents } from '../db/schema.js';
import { ERC20_META_ABI, TRANSFER_TOPIC, type EvmClients } from '../chain/evm.js';
import { solanaDeltas, type SolanaRpc, type SolParsedTx } from '../chain/solana.js';
import type { MarketService } from '../market/service.js';
import type { Hub } from '../ws/hub.js';
import type { Logger } from '../lib/log.js';
import { sanitizeError } from '../lib/log.js';
import { classify, type Classified, type Delta } from './classify.js';

interface Watcher {
  userId: string;
  walletId: string;
  label: string;
  color: string;
  notify: { buy: boolean; sell: boolean; transfer: boolean };
}

const MAX_CATCHUP_BLOCKS = 3000;

/**
 * Polls public chain data for every address tracked by at least one user. Addresses are polled once
 * no matter how many users track them; events are stored once and delivered per user.
 */
export class TrackerWorker {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();
  private tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  private solRound = 0;
  stats = { polls: 0, events: 0, errors: 0, capped: 0, lastLagBlocks: {} as Record<string, number> };

  constructor(
    private readonly db: Db,
    private readonly evm: EvmClients,
    private readonly sol: SolanaRpc,
    private readonly market: MarketService,
    private readonly hub: Hub,
    private readonly log: Logger,
    private readonly pollSec: number,
    private readonly maxAddresses = 500,
  ) {}

  start() {
    for (const n of Object.values(NETWORKS)) {
      const fn = n.kind === 'evm' ? () => this.pollEvm(n.id) : () => this.pollSolana();
      const t = setInterval(
        () => void this.guard(n.id, fn),
        Math.max(this.pollSec, n.kind === 'solana' ? 15 : 0) * 1000,
      );
      t.unref();
      this.timers.push(t);
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Prevents overlapping polls of the same network (no duplicate jobs). */
  private async guard(key: string, fn: () => Promise<void>) {
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      this.stats.polls++;
      await fn();
    } catch (e) {
      this.stats.errors++;
      this.log.warn({ network: key, err: sanitizeError(e) }, 'tracker poll failed');
    } finally {
      this.running.delete(key);
    }
  }

  private async watchers(network: NetworkId): Promise<Map<string, Watcher[]>> {
    const rows = await this.db
      .select()
      .from(trackedWallets)
      .where(and(eq(trackedWallets.network, network), eq(trackedWallets.enabled, true)));
    const m = new Map<string, Watcher[]>();
    for (const r of rows) {
      const k = NETWORKS[network].kind === 'evm' ? r.address.toLowerCase() : r.address;
      if (!m.has(k) && m.size >= this.maxAddresses) {
        this.stats.capped = (this.stats.capped ?? 0) + 1;
        continue; // capacity cap protects the shared RPC budget; surfaced in /internal/metrics
      }
      const list = m.get(k) ?? [];
      list.push({
        userId: r.userId,
        walletId: r.id,
        label: r.label,
        color: r.color,
        notify: r.notify as Watcher['notify'],
      });
      m.set(k, list);
    }
    return m;
  }

  private async getCursor(key: string) {
    const [r] = await this.db.select().from(trackerCursors).where(eq(trackerCursors.key, key)).limit(1);
    return r?.value ?? null;
  }

  private async setCursor(key: string, value: string) {
    await this.db
      .insert(trackerCursors)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: trackerCursors.key, set: { value, updatedAt: new Date() } });
  }

  /* ------------------------------------ EVM ------------------------------------ */

  async pollEvm(network: NetworkId) {
    const client = this.evm[network];
    if (!client) return;
    const w = await this.watchers(network);
    if (w.size === 0) return;
    const key = `evm:${network}`;
    const head = await client.getBlockNumber();
    const cur = await this.getCursor(key);
    let from = cur ? BigInt(cur) + 1n : head;
    if (head - from > BigInt(MAX_CATCHUP_BLOCKS)) {
      this.log.warn(
        { network, skipped: (head - from).toString() },
        'tracker too far behind; skipping ahead (gap)',
      );
      from = head - BigInt(MAX_CATCHUP_BLOCKS);
    }
    if (from > head) return;
    const range = BigInt(NETWORKS[network].logsBlockRange ?? 100);
    const to = from + range - 1n < head ? from + range - 1n : head;
    this.stats.lastLagBlocks[network] = Number(head - to);

    const addrs = [...w.keys()] as `0x${string}`[];
    const logs: Log[] = [];
    for (let i = 0; i < addrs.length; i += 50) {
      const topics = addrs.slice(i, i + 50).map((a) => pad(a, { size: 32 }));
      const [a, b] = await Promise.all([
        client.request({
          method: 'eth_getLogs',
          params: [
            {
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${to.toString(16)}`,
              topics: [TRANSFER_TOPIC, topics],
            },
          ],
        }),
        client.request({
          method: 'eth_getLogs',
          params: [
            {
              fromBlock: `0x${from.toString(16)}`,
              toBlock: `0x${to.toString(16)}`,
              topics: [TRANSFER_TOPIC, null, topics],
            },
          ],
        }),
      ]);
      logs.push(...(a as Log[]), ...(b as Log[]));
    }
    await this.processEvmLogs(network, client, logs, w);
    await this.setCursor(key, to.toString());
  }

  private async processEvmLogs(
    network: NetworkId,
    client: PublicClient,
    logs: Log[],
    w: Map<string, Watcher[]>,
  ) {
    // Group by tx hash, then by tracked wallet.
    const byTx = new Map<string, Log[]>();
    const seen = new Set<string>();
    for (const l of logs) {
      // ERC-20 Transfer has 3 topics; ERC-721 has 4 (tokenId indexed) — skip NFTs here.
      if (!l.transactionHash || l.topics.length !== 3) continue;
      const id = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const arr = byTx.get(l.transactionHash) ?? [];
      arr.push(l);
      byTx.set(l.transactionHash, arr);
    }
    for (const [hash, txLogs] of byTx) {
      const tx = await client.getTransaction({ hash: hash as `0x${string}` }).catch(() => null);
      if (!tx) continue;
      const block = await client.getBlock({ blockNumber: tx.blockNumber! }).catch(() => null);
      const at = block ? Number(block.timestamp) * 1000 : Date.now();
      const wallets = new Set<string>();
      for (const l of txLogs) {
        const fromA = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
        const toA = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
        if (w.has(fromA)) wallets.add(fromA);
        if (w.has(toA)) wallets.add(toA);
      }
      for (const wallet of wallets) {
        const raw = new Map<string, bigint>();
        for (const l of txLogs) {
          const fromA = `0x${l.topics[1]!.slice(26)}`.toLowerCase();
          const toA = `0x${l.topics[2]!.slice(26)}`.toLowerCase();
          const v = l.data && l.data !== '0x' ? BigInt(l.data.slice(0, 66)) : 0n;
          const t = l.address.toLowerCase();
          if (fromA === wallet) raw.set(t, (raw.get(t) ?? 0n) - v);
          if (toA === wallet) raw.set(t, (raw.get(t) ?? 0n) + v);
        }
        const deltas: Delta[] = [];
        for (const [token, v] of raw) {
          if (v === 0n) continue;
          const meta = await this.meta(network, client, token);
          deltas.push({ token, amount: Number(formatUnits(v, meta.decimals)) });
        }
        const initiated = tx.from.toLowerCase() === wallet;
        const nativeDelta = initiated ? -Number(formatUnits(tx.value, 18)) : 0;
        const cls = classify(network, deltas, nativeDelta, initiated, tx.to ?? null);
        for (const c of cls) await this.emit(network, wallet, hash, at, c, w.get(wallet)!, client);
      }
    }
  }

  private async meta(network: NetworkId, client: PublicClient, token: string) {
    const k = `${network}:${token}`;
    const hit = this.tokenMeta.get(k);
    if (hit) return hit;
    const [symbol, decimals] = await Promise.all([
      client
        .readContract({ address: token as `0x${string}`, abi: ERC20_META_ABI, functionName: 'symbol' })
        .catch(() => '?'),
      client
        .readContract({ address: token as `0x${string}`, abi: ERC20_META_ABI, functionName: 'decimals' })
        .catch(() => 18),
    ]);
    const m = {
      symbol:
        String(symbol)
          .replace(/[^\w.$-]/g, '')
          .slice(0, 16) || '?',
      decimals: Number(decimals),
    };
    if (this.tokenMeta.size > 20_000) this.tokenMeta.clear();
    this.tokenMeta.set(k, m);
    return m;
  }

  /* ----------------------------------- Solana ---------------------------------- */

  async pollSolana() {
    const w = await this.watchers('solana');
    if (w.size === 0) return;
    // Round-robin a bounded number of addresses per tick to respect RPC limits.
    const addrs = [...w.keys()];
    const batch = Array.from(
      { length: Math.min(5, addrs.length) },
      (_, i) => addrs[(this.solRound + i) % addrs.length]!,
    );
    this.solRound = (this.solRound + batch.length) % Math.max(1, addrs.length);
    for (const addr of batch) {
      const key = `sol:${addr}`;
      const cursor = await this.getCursor(key);
      const sigs = await this.sol.call<Array<{ signature: string; err: unknown; blockTime: number | null }>>(
        'getSignaturesForAddress',
        [addr, { limit: cursor ? 20 : 1, ...(cursor ? { until: cursor } : {}), commitment: 'confirmed' }],
      );
      if (!sigs.length) continue;
      if (cursor) {
        for (const s of [...sigs].reverse()) {
          if (s.err) continue;
          const tx = await this.sol.call<SolParsedTx | null>('getTransaction', [
            s.signature,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
          ]);
          if (!tx) continue;
          const d = solanaDeltas(tx, addr);
          if (!d || d.failed) continue;
          const deltas: Delta[] = [...d.tokens].map(([token, v]) => ({ token, amount: v.delta }));
          const keys = tx.transaction.message.accountKeys;
          const signer0 = typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey;
          const cls = classify('solana', deltas, d.solDelta, signer0 === addr, null);
          const at = (tx.blockTime ?? s.blockTime ?? Date.now() / 1000) * 1000;
          for (const c of cls) await this.emit('solana', addr, s.signature, at, c, w.get(addr)!, null);
        }
      }
      await this.setCursor(key, sigs[0]!.signature);
    }
  }

  /* ----------------------------------- output ---------------------------------- */

  private async emit(
    network: NetworkId,
    wallet: string,
    hash: string,
    at: number,
    c: Classified,
    watchers: Watcher[],
    client: PublicClient | null,
  ) {
    let symbol: string | null = null;
    if (c.token && client) symbol = (await this.meta(network, client, c.token)).symbol;
    let estUsd: number | null = null;
    try {
      if (c.counterAmount !== null && c.counterIsStable) estUsd = c.counterAmount;
      else if (c.counterAmount !== null && c.counterIsNative) {
        const px = await this.market.nativePriceUsd(network);
        estUsd = px === null ? null : px * c.counterAmount;
      } else if (c.token && c.tokenAmount !== null) {
        const px = (await this.market.prices(network, [c.token])).get(c.token.toLowerCase()) ?? null;
        estUsd = px === null ? null : px * c.tokenAmount;
      }
    } catch {
      estUsd = null;
    }

    const [row] = await this.db
      .insert(trackerEvents)
      .values({
        network,
        wallet,
        hash,
        at: new Date(at),
        kind: c.kind,
        token: c.token,
        tokenSymbol: symbol,
        tokenAmount: c.tokenAmount,
        counterSymbol: c.counterSymbol,
        counterAmount: c.counterAmount,
        estUsd,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return; // duplicate (already processed) — idempotent
    this.stats.events++;

    for (const wch of watchers) {
      const cat = c.kind === 'buy' ? 'buy' : c.kind === 'sell' ? 'sell' : 'transfer';
      const ev: TrackerEvent = {
        id: row.id,
        walletId: wch.walletId,
        walletLabel: wch.label,
        walletColor: wch.color,
        network,
        wallet,
        hash,
        at,
        kind: c.kind,
        token: c.token,
        tokenSymbol: symbol,
        tokenAmount: c.tokenAmount,
        counterSymbol: c.counterSymbol,
        counterAmount: c.counterAmount,
        estUsd,
        explorerUrl: NETWORKS[network].explorer.tx(hash),
      };
      // Always deliver (UI filters by preference); copy-trading relies on buy/sell even if muted.
      if (wch.notify[cat] || cat !== 'transfer') this.hub.sendToUser(wch.userId, { t: 'tracker', event: ev });
    }
  }
}
