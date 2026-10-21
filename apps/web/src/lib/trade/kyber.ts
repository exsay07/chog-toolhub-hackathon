import { EVM_NATIVE_SENTINEL, NETWORKS, type NetworkId } from '@chog/shared';

/**
 * KyberSwap Aggregator (https://docs.kyberswap.com). Router address verified 2026-10-19 identical on
 * Monad, Base and BSC. Any other router in a response is rejected.
 */
export const KYBER_ROUTERS = new Set(['0x6131b5fae19ea4f9d964eac0408e4408b66337b5']);
const BASE = 'https://aggregator-api.kyberswap.com';
const CLIENT_ID = 'chog-toolhub';

export interface KyberRouteSummary {
  tokenIn: string;
  amountIn: string;
  amountInUsd: string;
  tokenOut: string;
  amountOut: string;
  amountOutUsd: string;
  gas: string;
  gasUsd: string;
  extraFee?: { feeAmount: string; chargeFeeBy: string; isInBps: boolean; feeReceiver: string };
  routerAddress?: string;
  [k: string]: unknown;
}

export interface KyberQuote {
  routeSummary: KyberRouteSummary;
  routerAddress: string;
}

async function kj<T>(url: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, {
    ...init,
    signal,
    headers: {
      'x-client-id': CLIENT_ID,
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const j = (await r.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
  if (!r.ok || !j || j.code !== 0 || !j.data)
    throw new Error(`KyberSwap: ${j?.message ?? `HTTP ${r.status}`}`);
  return j.data;
}

export async function kyberQuote(
  network: NetworkId,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  signal?: AbortSignal,
): Promise<KyberQuote> {
  const path = NETWORKS[network].kyberPath;
  if (!path) throw new Error('KyberSwap not available on this network');
  const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString(), gasInclude: 'true' });
  const d = await kj<KyberQuote>(`${BASE}/${path}/api/v1/routes?${q}`, undefined, signal);
  if (!KYBER_ROUTERS.has(d.routerAddress.toLowerCase()))
    throw new Error('Unexpected KyberSwap router address — refusing');
  // Chog Toolhub charges no platform fee: any integrator fee in the route is a red flag.
  const fee = d.routeSummary.extraFee;
  if (fee && fee.feeAmount && fee.feeAmount !== '0' && fee.feeAmount !== '')
    throw new Error('Route carries an extra fee — refusing');
  return d;
}

export interface KyberBuild {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  amountOut: bigint;
  gas: bigint;
}

export async function kyberBuild(
  network: NetworkId,
  quote: KyberQuote,
  wallet: `0x${string}`,
  slippageBps: number,
  deadlineSec: number,
): Promise<KyberBuild> {
  const path = NETWORKS[network].kyberPath!;
  const d = await kj<{
    data: `0x${string}`;
    routerAddress: string;
    amountOut: string;
    gas: string;
    transactionValue: string;
  }>(`${BASE}/${path}/api/v1/route/build`, {
    method: 'POST',
    body: JSON.stringify({
      routeSummary: quote.routeSummary,
      sender: wallet,
      recipient: wallet,
      slippageTolerance: slippageBps,
      deadline: Math.floor(Date.now() / 1000) + deadlineSec,
      source: CLIENT_ID,
      enableGasEstimation: false,
    }),
  });
  if (
    !KYBER_ROUTERS.has(d.routerAddress.toLowerCase()) ||
    d.routerAddress.toLowerCase() !== quote.routerAddress.toLowerCase()
  )
    throw new Error('Build returned a different router — refusing');
  // Recipient check: our address must appear in calldata (the router transfers output to `recipient`).
  if (!d.data.toLowerCase().includes(wallet.slice(2).toLowerCase()))
    throw new Error('Calldata does not pay our wallet — refusing');
  const nativeIn = quote.routeSummary.tokenIn.toLowerCase() === EVM_NATIVE_SENTINEL.toLowerCase();
  const value = BigInt(d.transactionValue || '0');
  if (nativeIn ? value !== BigInt(quote.routeSummary.amountIn) : value !== 0n)
    throw new Error('Unexpected transaction value — refusing');
  return {
    to: d.routerAddress as `0x${string}`,
    data: d.data,
    value,
    amountOut: BigInt(d.amountOut),
    gas: BigInt(d.gas || '0'),
  };
}

export function kyberPriceImpactPct(q: KyberQuote): number | null {
  const i = Number(q.routeSummary.amountInUsd);
  const o = Number(q.routeSummary.amountOutUsd);
  if (!(i > 0) || !Number.isFinite(o)) return null;
  return Math.max(0, ((i - o) / i) * 100);
}
