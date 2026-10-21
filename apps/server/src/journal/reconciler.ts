import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { formatUnits, type PublicClient } from 'viem';
import { NETWORKS, transition, type NetworkId, type TxState } from '@chog/shared';
import type { Db } from '../db/client.js';
import { journal } from '../db/schema.js';
import { TRANSFER_TOPIC, ERC20_META_ABI, type EvmClients } from '../chain/evm.js';
import { solanaDeltas, type SolanaRpc, type SolParsedTx } from '../chain/solana.js';
import type { MarketService } from '../market/service.js';
import type { Hub } from '../ws/hub.js';
import { sanitizeError, type Logger } from '../lib/log.js';

type Row = typeof journal.$inferSelect;

export interface ReconcileOutcome {
  state: TxState;
  tokenQty?: number | null;
  nativeDelta?: number | null;
  usdValue?: number | null;
  feeNative?: number | null;
  feeUsd?: number | null;
  blockTime?: Date | null;
  error?: string | null;
  tokenSymbol?: string | null;
}

/**
 * Determines the real outcome of every submitted transaction from authoritative chain data. The
 * client's claim that a tx "went through" is never trusted.
 */
export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  stats = { runs: 0, reconciled: 0, errors: 0, backlog: 0 };

  constructor(
    private readonly db: Db,
    private readonly evm: EvmClients,
    private readonly sol: SolanaRpc,
    private readonly market: MarketService,
    private readonly hub: Hub,
    private readonly log: Logger,
  ) {}

  start(intervalMs = 3000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    this.stats.runs++;
    try {
      const rows = await this.db
        .select()
        .from(journal)
        .where(and(inArray(journal.state, ['submitted', 'pending', 'unknown']), lt(journal.attempts, 400)))
        .orderBy(journal.updatedAt)
        .limit(25);
      this.stats.backlog = rows.length;
      await Promise.all(rows.map((r) => this.one(r)));
    } finally {
      this.busy = false;
    }
  }

  async one(r: Row) {
    let out: ReconcileOutcome;
    try {
      out =
        NETWORKS[r.network as NetworkId].kind === 'evm' ? await this.evmOutcome(r) : await this.solOutcome(r);
    } catch (e) {
      this.stats.errors++;
      out = { state: r.state === 'submitted' ? 'unknown' : (r.state as TxState), error: sanitizeError(e) };
    }
    if (out.state !== r.state) {
      try {
        transition(r.state as TxState, out.state);
      } catch {
        this.log.error({ id: r.id, from: r.state, to: out.state }, 'invalid journal transition suppressed');
        return;
      }
    }
    await this.db
      .update(journal)
      .set({ ...out, attempts: sql`${journal.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(journal.id, r.id), eq(journal.state, r.state)));
    if (out.state !== r.state) {
      this.stats.reconciled++;
      this.hub.sendToUser(r.userId, {
        t: 'tx',
        hash: r.hash,
        network: r.network as NetworkId,
        state: out.state,
      });
    }
  }

  private async evmOutcome(r: Row): Promise<ReconcileOutcome> {
    const net = r.network as NetworkId;
    const c = this.evm[net] as PublicClient;
    const hash = r.hash as `0x${string}`;
    const ageMs = Date.now() - r.createdAt.getTime();
    const receipt = await c.getTransactionReceipt({ hash }).catch(() => null);
    if (!receipt) {
      const tx = await c.getTransaction({ hash }).catch(() => null);
      if (tx) {
        const n = await c.getTransactionCount({ address: tx.from, blockTag: 'latest' });
        if (n > tx.nonce)
          return { state: 'replaced', error: 'Another transaction with the same nonce was mined' };
        return { state: 'pending' };
      }
      // Our swaps carry a 20 min deadline; after that the tx can no longer succeed.
      if (ageMs > 25 * 60_000) return { state: 'expired', error: 'Not found on chain before deadline' };
      return {
        state: ageMs > 60_000 ? 'unknown' : r.state === 'submitted' ? 'submitted' : (r.state as TxState),
      };
    }
    const block = await c.getBlock({ blockNumber: receipt.blockNumber });
    const blockTime = new Date(Number(block.timestamp) * 1000);
    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
    const feeNative = Number(formatUnits(feeWei, 18));
    const px = await this.market.nativePriceUsd(net).catch(() => null);
    const feeUsd = px === null ? null : feeNative * px;
    if (receipt.status !== 'success')
      return { state: 'failed', feeNative, feeUsd, blockTime, error: 'Transaction reverted' };

    const wallet = r.wallet.toLowerCase();
    let tokenQty: number | null = null;
    let tokenSymbol: string | null = r.tokenSymbol;
    if (r.token) {
      let raw = 0n;
      for (const l of receipt.logs) {
        if (
          l.address.toLowerCase() !== r.token.toLowerCase() ||
          l.topics[0] !== TRANSFER_TOPIC ||
          l.topics.length !== 3
        )
          continue;
        const v = BigInt(l.data.slice(0, 66));
        if (`0x${l.topics[1]!.slice(26)}`.toLowerCase() === wallet) raw -= v;
        if (`0x${l.topics[2]!.slice(26)}`.toLowerCase() === wallet) raw += v;
      }
      const [dec, sym] = await Promise.all([
        c
          .readContract({ address: r.token as `0x${string}`, abi: ERC20_META_ABI, functionName: 'decimals' })
          .catch(() => 18),
        c
          .readContract({ address: r.token as `0x${string}`, abi: ERC20_META_ABI, functionName: 'symbol' })
          .catch(() => null),
      ]);
      tokenQty = Math.abs(Number(formatUnits(raw, Number(dec))));
      if (sym) tokenSymbol = String(sym).slice(0, 16);
    }
    // Native trade leg = balance change across the block, plus the fee we paid.
    let nativeDelta: number | null;
    try {
      const [b1, b0] = await Promise.all([
        c.getBalance({ address: r.wallet as `0x${string}`, blockNumber: receipt.blockNumber }),
        c.getBalance({ address: r.wallet as `0x${string}`, blockNumber: receipt.blockNumber - 1n }),
      ]);
      nativeDelta = Number(formatUnits(b1 - b0 + feeWei, 18));
    } catch {
      nativeDelta = null; // historical state unavailable on this RPC
    }
    const usdValue = nativeDelta !== null && px !== null ? Math.abs(nativeDelta) * px : null;
    return {
      state: 'confirmed',
      tokenQty,
      nativeDelta,
      usdValue,
      feeNative,
      feeUsd,
      blockTime,
      tokenSymbol,
      error: null,
    };
  }

  private async solOutcome(r: Row): Promise<ReconcileOutcome> {
    const ageMs = Date.now() - r.createdAt.getTime();
    const st = await this.sol.call<{
      value: Array<{ confirmationStatus: string | null; err: unknown } | null>;
    }>('getSignatureStatuses', [[r.hash], { searchTransactionHistory: true }]);
    const s = st.value[0];
    if (!s) {
      // Blockhash validity is ~150 slots (~60–90 s); after that the tx can never land.
      if (ageMs > 3 * 60_000) return { state: 'expired', error: 'Not found; blockhash expired' };
      return { state: ageMs > 30_000 ? 'unknown' : 'submitted' };
    }
    if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized')
      return { state: 'pending' };
    const tx = await this.sol.call<SolParsedTx | null>('getTransaction', [
      r.hash,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    if (!tx) return { state: 'pending' };
    const d = solanaDeltas(tx, r.wallet);
    const px = await this.market.nativePriceUsd('solana').catch(() => null);
    const feeNative = d?.feeSol ?? null;
    const feeUsd = feeNative !== null && px !== null ? feeNative * px : null;
    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
    if (s.err || !d || d.failed)
      return { state: 'failed', feeNative, feeUsd, blockTime, error: 'Transaction failed on chain' };
    const tokenQty = r.token ? Math.abs(d.tokens.get(r.token)?.delta ?? 0) : null;
    const usdValue = px !== null ? Math.abs(d.solDelta) * px : null;
    return {
      state: 'confirmed',
      tokenQty,
      nativeDelta: d.solDelta,
      usdValue,
      feeNative,
      feeUsd,
      blockTime,
      error: null,
    };
  }
}
