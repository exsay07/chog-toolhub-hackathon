import { formatUnits, parseUnits } from 'viem';
import { PublicKey } from '@solana/web3.js';
import {
  EVM_NATIVE_SENTINEL,
  NETWORKS,
  canTrade,
  evaluateTrade,
  tokenKey,
  type NetworkId,
  type RiskLimits,
  type RiskVerdict,
  type TokenSecurity,
  type TxState,
} from '@chog/shared';
import { get, post, uid, type Envelope } from '../api';
import { evmSignerFor, solanaSigner } from '../vault/vault';
import { ERC20_ABI, feeOverrides, publicClient, walletClient, withNonceLock } from './evm';
import { kyberBuild, kyberPriceImpactPct, kyberQuote, type KyberQuote } from './kyber';
import { jupBuild, jupQuote, solConnection, WSOL, type JupQuote } from './jupiter';

export type Priority = 'none' | 'low' | 'medium' | 'high';

export interface SwapRequest {
  network: NetworkId;
  side: 'buy' | 'sell';
  token: string;
  /** buy: native amount (MON/ETH/BNB/SOL). sell: token amount. */
  amount: number;
  slippageBps: number;
  priority: Priority;
  deadlineSec: number;
  source: 'manual' | 'sniper' | 'copy' | 'limit';
  automated: boolean;
  liquidityUsd: number | null;
  tokenSymbol?: string;
  /** EVM only: which vault wallet trades (default: main). */
  wallet?: string | null;
}

export interface PreparedSwap {
  id: string;
  req: SwapRequest;
  inLabel: string;
  outLabel: string;
  expectedOut: number;
  minOut: number;
  amountUsd: number | null;
  priceImpactPct: number | null;
  gasUsd: number | null;
  needsApproval: boolean;
  security: TokenSecurity | null;
  risk: RiskVerdict;
  route: string;
  quotedAt: number;
  execute: (onState?: (s: TxState, hash?: string) => void) => Promise<string>;
}

import { killSwitch } from '../killSwitch';
export { killSwitch };

/** Duplicate-submission guard: one in-flight swap per (network, token, side). */
const inflight = new Set<string>();

async function security(network: NetworkId, token: string): Promise<TokenSecurity | null> {
  try {
    return (await get<Envelope<TokenSecurity | null>>(`/api/market/security/${network}/${token}`)).data;
  } catch {
    return null;
  }
}

async function nativePrice(network: NetworkId): Promise<number | null> {
  try {
    return (
      (await get<Envelope<Record<string, number | null>>>('/api/market/native-prices')).data[network] ?? null
    );
  } catch {
    return null;
  }
}

/** Trailing-24h automated buy spend, from the server journal (survives reloads and devices). */
export async function automatedSpend24h(): Promise<{ usd: number; lastTradeAt: Record<string, number> }> {
  const rows = await get<
    Array<{
      source: string;
      side: string | null;
      state: string;
      quotedUsd: number | null;
      createdAt: string;
      network: string;
      token: string | null;
    }>
  >('/api/journal?limit=500');
  const now = Date.now();
  let usd = 0;
  const lastTradeAt: Record<string, number> = {};
  for (const r of rows) {
    const at = Date.parse(r.createdAt);
    if (r.source !== 'manual' && r.token) {
      const k = tokenKey(r.network as NetworkId, r.token);
      lastTradeAt[k] = Math.max(lastTradeAt[k] ?? 0, at);
    }
    if (
      r.source === 'manual' ||
      r.side !== 'buy' ||
      ['failed', 'expired', 'replaced', 'cancelled'].includes(r.state)
    )
      continue;
    if (now - at < 86_400_000) usd += r.quotedUsd ?? 0;
  }
  return { usd, lastTradeAt };
}

/**
 * The tx is already broadcast when this runs, so recording it must not be lost to a blip: retry
 * with backoff. The idempotency key makes retries safe.
 */
async function journal(
  req: SwapRequest,
  kind: 'swap' | 'approve',
  hash: string,
  quotedUsd: number | null,
  key: string,
) {
  const body = {
    idempotencyKey: key,
    network: req.network,
    hash,
    kind,
    source: req.source,
    side: kind === 'swap' ? req.side : null,
    token: req.token,
    quotedUsd,
    ...(req.wallet ? { wallet: req.wallet } : {}),
  };
  for (let i = 0; ; i++) {
    try {
      await post('/api/journal', body);
      return;
    } catch (e) {
      if (i >= 4) {
        console.warn('journal write failed; tx is on chain, will not appear in PnL until re-recorded', hash);
        throw new Error(`Transaction sent (${hash}) but could not be recorded: ${(e as Error).message}`, {
          cause: e,
        });
      }
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
}

export async function prepareSwap(req: SwapRequest, limits: RiskLimits): Promise<PreparedSwap> {
  if (!canTrade(req.network))
    throw new Error(
      `Trading is not enabled on ${NETWORKS[req.network].name} (${NETWORKS[req.network].tradingStatus})`,
    );
  if (!(req.amount > 0)) throw new Error('Amount must be positive');
  const n = NETWORKS[req.network];
  const [sec, npx, spend] = await Promise.all([
    security(req.network, req.token),
    nativePrice(req.network),
    req.automated ? automatedSpend24h() : Promise.resolve({ usd: 0, lastTradeAt: {} }),
  ]);
  const id = uid('swap');
  const riskCtx = {
    now: Date.now(),
    spentLast24hUsd: spend.usd,
    lastTradeAt: spend.lastTradeAt,
    emergencyStop: killSwitch.active,
  };
  const secFlags = sec
    ? {
        honeypot: sec.honeypot ?? undefined,
        cannotSell: sec.cannotSell ?? undefined,
        buyTaxPct: sec.buyTaxPct ?? undefined,
        sellTaxPct: sec.sellTaxPct ?? undefined,
      }
    : undefined;

  if (n.kind === 'evm') {
    const wallet = evmSignerFor(req.wallet).address;
    const pc = publicClient(req.network);
    const decimals =
      req.side === 'sell'
        ? Number(
            await pc.readContract({
              address: req.token as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'decimals',
            }),
          )
        : 18;
    const tokenIn = req.side === 'buy' ? EVM_NATIVE_SENTINEL : req.token;
    const tokenOut = req.side === 'buy' ? req.token : EVM_NATIVE_SENTINEL;
    const amountIn = parseUnits(
      req.amount.toFixed(Math.min(decimals, 18)),
      req.side === 'buy' ? n.nativeDecimals : decimals,
    );
    const outDecimals =
      req.side === 'buy'
        ? Number(
            await pc.readContract({
              address: req.token as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'decimals',
            }),
          )
        : n.nativeDecimals;
    const q: KyberQuote = await kyberQuote(req.network, tokenIn, tokenOut, amountIn);
    const amountUsd = Number(q.routeSummary.amountInUsd) || null;
    const impact = kyberPriceImpactPct(q);
    const expectedOut = Number(formatUnits(BigInt(q.routeSummary.amountOut), outDecimals));
    let needsApproval = false;
    if (req.side === 'sell') {
      const allowance = await pc.readContract({
        address: req.token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [wallet, q.routerAddress as `0x${string}`],
      });
      needsApproval = allowance < amountIn;
    }
    const risk = evaluateTrade(
      {
        network: req.network,
        token: req.token,
        side: req.side,
        amountUsd,
        slippageBps: req.slippageBps,
        priceImpactPct: impact,
        liquidityUsd: req.liquidityUsd,
        automated: req.automated,
        security: secFlags,
      },
      limits,
      riskCtx,
    );
    return {
      id,
      req,
      inLabel: req.side === 'buy' ? n.nativeSymbol : (req.tokenSymbol ?? 'TOKEN'),
      outLabel: req.side === 'buy' ? (req.tokenSymbol ?? 'TOKEN') : n.nativeSymbol,
      expectedOut,
      minOut: expectedOut * (1 - req.slippageBps / 10_000),
      amountUsd,
      priceImpactPct: impact,
      gasUsd: Number(q.routeSummary.gasUsd) || null,
      needsApproval,
      security: sec,
      risk,
      route: 'KyberSwap',
      quotedAt: Date.now(),
      execute: (onState) => executeEvm(req, q, amountIn, needsApproval, amountUsd, id, onState),
    };
  }

  // Solana via Jupiter
  const signer = solanaSigner();
  const conn = solConnection();
  let decimals = 9;
  if (req.side === 'sell') {
    const info = await conn.getParsedAccountInfo(new PublicKey(req.token));
    const d = (info.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info
      ?.decimals;
    if (d === undefined) throw new Error('Could not read token decimals');
    decimals = d;
  }
  const amountIn = parseUnits(req.amount.toFixed(Math.min(decimals, 9)), decimals);
  const q: JupQuote = await jupQuote(
    req.side === 'buy' ? WSOL : req.token,
    req.side === 'buy' ? req.token : WSOL,
    amountIn,
    req.slippageBps,
  );
  const outDecimals = req.side === 'buy' ? await mintDecimals(req.token) : 9;
  const expectedOut = Number(formatUnits(BigInt(q.outAmount), outDecimals));
  const nativeLeg = req.side === 'buy' ? req.amount : expectedOut;
  const amountUsd = npx === null ? null : nativeLeg * npx;
  const impact = Number(q.priceImpactPct) * 100;
  const risk = evaluateTrade(
    {
      network: 'solana',
      token: req.token,
      side: req.side,
      amountUsd,
      slippageBps: req.slippageBps,
      priceImpactPct: Number.isFinite(impact) ? impact : null,
      liquidityUsd: req.liquidityUsd,
      automated: req.automated,
      security: secFlags,
    },
    limits,
    riskCtx,
  );
  return {
    id,
    req,
    inLabel: req.side === 'buy' ? 'SOL' : (req.tokenSymbol ?? 'TOKEN'),
    outLabel: req.side === 'buy' ? (req.tokenSymbol ?? 'TOKEN') : 'SOL',
    expectedOut,
    minOut: Number(formatUnits(BigInt(q.otherAmountThreshold), outDecimals)),
    amountUsd,
    priceImpactPct: Number.isFinite(impact) ? impact : null,
    gasUsd: null,
    needsApproval: false,
    security: sec,
    risk,
    route: `Jupiter · ${q.routePlan
      .map((r) => r.swapInfo.label)
      .filter(Boolean)
      .slice(0, 3)
      .join(' → ')}`,
    quotedAt: Date.now(),
    execute: (onState) => executeSolana(req, q, amountUsd, id, signer, onState),
  };
}

async function mintDecimals(mint: string) {
  const info = await solConnection().getParsedAccountInfo(new PublicKey(mint));
  const d = (info.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info
    ?.decimals;
  if (d === undefined) throw new Error('Could not read token decimals');
  return d;
}

function guard(req: SwapRequest) {
  if (req.automated && killSwitch.active) throw new Error('Emergency stop is active');
  const k = `${req.network}:${req.token.toLowerCase()}:${req.side}:${(req.wallet ?? '').toLowerCase()}`;
  if (inflight.has(k)) throw new Error('A swap for this token is already in flight');
  inflight.add(k);
  return () => inflight.delete(k);
}

async function executeEvm(
  req: SwapRequest,
  q: KyberQuote,
  amountIn: bigint,
  needsApproval: boolean,
  amountUsd: number | null,
  id: string,
  onState?: (s: TxState, hash?: string) => void,
): Promise<string> {
  const release = guard(req);
  try {
    const pc = publicClient(req.network);
    const wc = walletClient(req.network, req.wallet);
    const wallet = evmSignerFor(req.wallet).address;
    const fees = await feeOverrides(req.network, req.priority);

    if (needsApproval) {
      // Exact-amount approval only — never unlimited.
      onState?.('signing');
      const hash = await withNonceLock(
        req.network,
        async (nonce) =>
          wc.writeContract({
            address: req.token as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [q.routerAddress as `0x${string}`, amountIn],
            nonce,
            ...fees,
          } as never),
        req.wallet,
      );
      await journal(req, 'approve', hash, null, `${id}-approve`);
      const rc = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== 'success') throw new Error('Approval transaction reverted');
    }

    onState?.('simulating');
    const b = await kyberBuild(req.network, q, wallet, req.slippageBps, req.deadlineSec);
    try {
      await pc.call({ account: wallet, to: b.to, data: b.data, value: b.value });
    } catch (e) {
      onState?.('simulation_failed');
      throw new Error(`Simulation failed: ${(e as Error).message.split('\n')[0]}`, { cause: e });
    }
    const gas = await pc.estimateGas({ account: wallet, to: b.to, data: b.data, value: b.value });
    onState?.('signing');
    const hash = await withNonceLock(
      req.network,
      (nonce) =>
        wc.sendTransaction({
          to: b.to,
          data: b.data,
          value: b.value,
          gas: (gas * 125n) / 100n,
          nonce,
          ...fees,
        } as never),
      req.wallet,
    );
    onState?.('submitted', hash);
    await journal(req, 'swap', hash, amountUsd, id);
    return hash;
  } finally {
    release();
  }
}

async function executeSolana(
  req: SwapRequest,
  q: JupQuote,
  amountUsd: number | null,
  id: string,
  signer: ReturnType<typeof solanaSigner>,
  onState?: (s: TxState, hash?: string) => void,
): Promise<string> {
  const release = guard(req);
  try {
    const conn = solConnection();
    onState?.('simulating');
    const tx = await jupBuild(q, signer, req.priority);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false });
    if (sim.value.err) {
      onState?.('simulation_failed');
      throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    }
    onState?.('signing');
    await tx.sign([signer]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3n });
    onState?.('submitted', sig);
    await journal(req, 'swap', sig, amountUsd, id);
    return sig;
  } finally {
    release();
  }
}
