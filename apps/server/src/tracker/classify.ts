import { NETWORKS, type NetworkId, type TrackerEventKind } from '@chog/shared';

/**
 * Quote assets per network (by address, never by symbol). Verified on-chain/Dexscreener 2026-10-19.
 * Used to decide whether a swap is a buy (quote → token) or a sell (token → quote).
 */
export const QUOTE_ASSETS: Record<NetworkId, Record<string, string>> = {
  monad: {
    [NETWORKS.monad.wrappedNative.toLowerCase()]: 'WMON',
    '0x754704bc059f8c67012fed69bc8a327a5aafb603': 'USDC',
  },
  base: {
    [NETWORKS.base.wrappedNative.toLowerCase()]: 'WETH',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  },
  bsc: {
    [NETWORKS.bsc.wrappedNative.toLowerCase()]: 'WBNB',
    '0x55d398326f99059ff775485246999027b3197955': 'USDT',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
  },
  robinhood: { [NETWORKS.robinhood.wrappedNative.toLowerCase()]: 'WETH' },
  ethereum: {
    [NETWORKS.ethereum.wrappedNative.toLowerCase()]: 'WETH',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  },
  arc: { [NETWORKS.arc.wrappedNative.toLowerCase()]: 'USDC' },
  ink: {
    [NETWORKS.ink.wrappedNative.toLowerCase()]: 'WETH',
    '0xf1815bd50389c46847f0bda824ec8da914045d14': 'USDC.e',
    '0x0200c29006150606b650577bbe7b6248f58470c1': 'USDT0',
  },
  hyperevm: {
    [NETWORKS.hyperevm.wrappedNative.toLowerCase()]: 'WHYPE',
    '0xb88339cb7199b77e23db6e890353e22632ba630f': 'USDC',
    '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb': 'USDT0',
  },
  solana: {
    [NETWORKS.solana.wrappedNative.toLowerCase()]: 'SOL',
    epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v: 'USDC',
    es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb: 'USDT',
  },
};

export interface Delta {
  token: string;
  amount: number; // signed, decimals applied
}

export interface Classified {
  kind: TrackerEventKind;
  token: string | null;
  tokenAmount: number | null;
  counterSymbol: string | null;
  counterAmount: number | null;
  /** True if the counter leg is a USD stablecoin, so counterAmount ≈ USD. */
  counterIsStable: boolean;
  /** True if the counter leg is the native asset (or wrapped native). */
  counterIsNative: boolean;
}

const STABLE = new Set(['USDC', 'USDT']);

/**
 * Classifies a wallet's net balance changes within a single transaction.
 *
 * @param nativeDelta signed native-asset change attributable to the trade (fee excluded) when known;
 *   for EVM we only know value *sent* by the wallet (internal ETH receipts are invisible in logs).
 * @param initiatedByWallet whether the tracked wallet signed the transaction.
 * @param txTo the transaction's `to` address (EVM), used to tell plain token transfers apart.
 */
export function classify(
  network: NetworkId,
  deltas: Delta[],
  nativeDelta: number,
  initiatedByWallet: boolean,
  txTo: string | null,
): Classified[] {
  const quotes = QUOTE_ASSETS[network];
  const isQuote = (t: string) => t.toLowerCase() in quotes;
  const nonQuoteIn = deltas.filter((d) => d.amount > 0 && !isQuote(d.token));
  const nonQuoteOut = deltas.filter((d) => d.amount < 0 && !isQuote(d.token));
  const quoteIn = deltas.filter((d) => d.amount > 0 && isQuote(d.token));
  const quoteOut = deltas.filter((d) => d.amount < 0 && isQuote(d.token));
  const native = NETWORKS[network].nativeSymbol;
  const out: Classified[] = [];

  const counter = (legs: Delta[], nativeAmt: number) => {
    const leg = legs[0];
    if (leg) {
      const sym = quotes[leg.token.toLowerCase()]!;
      return {
        counterSymbol: sym,
        counterAmount: Math.abs(leg.amount),
        counterIsStable: STABLE.has(sym),
        counterIsNative: !STABLE.has(sym),
      };
    }
    if (nativeAmt > 0)
      return {
        counterSymbol: native,
        counterAmount: nativeAmt,
        counterIsStable: false,
        counterIsNative: true,
      };
    return { counterSymbol: null, counterAmount: null, counterIsStable: false, counterIsNative: false };
  };

  const paidNative = nativeDelta < 0 ? -nativeDelta : 0;
  const gotNative = nativeDelta > 0 ? nativeDelta : 0;

  // Buys: received a non-quote token while paying quote/native (or another token: token→token swap).
  if (nonQuoteIn.length && (quoteOut.length || paidNative > 0 || nonQuoteOut.length)) {
    for (const d of nonQuoteIn)
      out.push({ kind: 'buy', token: d.token, tokenAmount: d.amount, ...counter(quoteOut, paidNative) });
  }
  // Sells: gave a non-quote token while receiving quote/native.
  if (nonQuoteOut.length && (quoteIn.length || gotNative > 0 || nonQuoteIn.length)) {
    for (const d of nonQuoteOut)
      out.push({ kind: 'sell', token: d.token, tokenAmount: -d.amount, ...counter(quoteIn, gotNative) });
  }
  if (out.length) return out;

  // Token sent by the wallet through a contract that is not the token itself: on EVM the native
  // proceeds of a router sell are an internal transfer and invisible in logs → probable sell.
  if (nonQuoteOut.length && initiatedByWallet && NETWORKS[network].kind === 'evm') {
    for (const d of nonQuoteOut) {
      if (txTo && txTo.toLowerCase() !== d.token.toLowerCase())
        out.push({
          kind: 'sell',
          token: d.token,
          tokenAmount: -d.amount,
          counterSymbol: null,
          counterAmount: null,
          counterIsStable: false,
          counterIsNative: false,
        });
      else out.push(transfer('transfer_out', d));
    }
    return out;
  }

  for (const d of nonQuoteIn) out.push(transfer('transfer_in', d));
  for (const d of nonQuoteOut) out.push(transfer('transfer_out', d));
  return out;
}

const transfer = (kind: 'transfer_in' | 'transfer_out', d: Delta): Classified => ({
  kind,
  token: d.token,
  tokenAmount: Math.abs(d.amount),
  counterSymbol: null,
  counterAmount: null,
  counterIsStable: false,
  counterIsNative: false,
});
