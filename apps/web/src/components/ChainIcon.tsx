import type { NetworkId } from '@chog/shared';
import { NETWORKS } from '@chog/shared';

/**
 * Official chain logos (64 px webp in /public/chains, from DefiLlama's chain icon set), rounded so they
 * sit cleanly from 9 px (token-logo corner) up to 20 px. Served from our own origin: no third-party
 * requests when a table full of tokens renders.
 */

const COLORS: Record<NetworkId, string> = {
  monad: '#836ef9',
  bsc: '#e8b30b',
  base: '#3b6ef6',
  robinhood: '#22b36b',
  ethereum: '#8c93b8',
  arc: '#f2a65a',
  ink: '#8b5cf6',
  hyperevm: '#5fd3c4',
  solana: '#19b38a',
};
/** Accent colour per chain (badges, charts). */
export const chainColor = (id: NetworkId) => COLORS[id];

export function ChainIcon({
  id,
  size = 16,
  className,
  round,
}: {
  id: NetworkId;
  size?: number;
  /** Circle instead of a rounded square (avatar stacks). */
  round?: boolean;
  /** Kept for callers of the old drawn icons; logos always render the same way. */
  bare?: boolean;
  className?: string;
}) {
  return (
    <img
      src={`/chains/${id}.webp`}
      width={size}
      height={size}
      alt={NETWORKS[id].name}
      title={NETWORKS[id].name}
      role="img"
      aria-label={NETWORKS[id].name}
      draggable={false}
      decoding="async"
      className={['shrink-0 object-cover', className].filter(Boolean).join(' ')}
      style={{
        width: size,
        height: size,
        borderRadius: round ? '50%' : Math.max(3, Math.round(size * 0.28)),
      }}
    />
  );
}
