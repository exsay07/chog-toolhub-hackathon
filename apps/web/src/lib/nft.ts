/** Shared bits for the NFT → Top Collections and Mint Tracker pages. */

export type NftChain = 'monad' | 'base' | 'robinhood' | 'ethereum';

export const NFT_CHAIN_TABS: Array<{ id: NftChain; label: string }> = [
  { id: 'monad', label: 'MONAD' },
  { id: 'base', label: 'BASE' },
  { id: 'robinhood', label: 'ROBINHOOD' },
  { id: 'ethereum', label: 'ETH' },
];

/** 1234 → 1.23K, 0.004567 → 0.00457: compact, always readable at table width. */
export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}K`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(2)}K`;
  if (a >= 100) return `${sign}${a.toFixed(0)}`;
  if (a >= 1) return `${sign}${a.toFixed(2)}`;
  if (a === 0) return '0';
  return `${sign}${a.toPrecision(3)}`;
}
