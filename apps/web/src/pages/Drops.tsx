import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { NETWORKS, isNetworkId } from '@chog/shared';
import { get } from '../lib/api';
import { useTick } from '../lib/notify';
import { Panel, SkeletonRows, Tabs, cx } from '../components/ui';
import { ChainIcon } from '../components/ChainIcon';

/**
 * Drops calendar (OpenSea): what is minting right now and what starts within the next 72 hours, with
 * price, wallet limit and a live countdown. Shared server cache; refreshed every few minutes.
 */

interface Stage {
  label: string;
  type: string;
  price: string | null;
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
  live: boolean;
  stage: Stage | null;
  next: Stage | null;
  at: number | null;
}

const NATIVE: Record<string, [string, number]> = {
  solana: ['SOL', 9],
  monad: ['MON', 18],
  ape_chain: ['APE', 18],
  polygon: ['POL', 18],
  hyperevm: ['HYPE', 18],
  avalanche: ['AVAX', 18],
  ronin: ['RON', 18],
  bera_chain: ['BERA', 18],
  flow: ['FLOW', 18],
  sei: ['SEI', 18],
};
const ZERO = /^0x0{40}$/i;

/** "0.03 ETH", "Free", or "Token" when it is priced in an ERC-20 we don't know the decimals of. */
export function fmtPrice(stage: Stage | null, chain: string): string {
  if (!stage?.price) return '—';
  if (/^0+$/.test(stage.price)) return 'Free';
  if (stage.currency && !ZERO.test(stage.currency)) return 'Token';
  const [sym, dec] = NATIVE[chain] ?? ['ETH', 18];
  const v = Number(stage.price) / 10 ** dec;
  return `${v >= 1 ? v.toFixed(2).replace(/\.?0+$/, '') : Number(v.toPrecision(3))} ${sym}`;
}

/** 2d 3h · 5h 12m · 14m · <1m */
export function fmtIn(ms: number): string {
  if (ms <= 60_000) return '<1m';
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function Thumb({ src, seed, label }: { src: string | null; seed: string; label: string }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken)
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-8 rounded-[5px] object-cover border border-line shrink-0"
      />
    );
  const hue = parseInt(seed.replace(/^0x/, '').slice(0, 6) || '0', 16) % 360;
  return (
    <span
      aria-hidden
      className="size-8 rounded-[5px] shrink-0 grid place-items-center text-[11px] font-semibold text-black/80 border border-line"
      style={{ background: `hsl(${hue} 55% 62%)` }}
    >
      {label
        .replace(/[^\p{L}\p{N}]/gu, '')
        .slice(0, 2)
        .toUpperCase() || '?'}
    </span>
  );
}

function ChainTag({ chain }: { chain: string }) {
  if (isNetworkId(chain))
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted">
        <ChainIcon id={chain} size={13} />
        {NETWORKS[chain].shortName}
      </span>
    );
  return <span className="text-[11px] text-muted uppercase">{chain.replace(/_/g, ' ')}</span>;
}

export function DropsPanel({ chain }: { chain: string }) {
  useTick(30_000);
  const [tab, setTab] = useState<'live' | 'soon'>('live');
  const q = useQuery({
    queryKey: ['nft-drops'],
    queryFn: () => get<{ rows: Drop[]; updatedAt: number }>('/api/nft/drops'),
    refetchInterval: 60_000,
  });
  const now = Date.now();
  // Client-side too: a drop that ended (or started) since the last refresh moves right away.
  const all = (q.data?.rows ?? []).filter((d) => chain === 'all' || d.chain === chain);
  const live = all.filter(
    (d) => (d.live && (d.at === null || d.at > now)) || (!d.live && d.at !== null && d.at <= now),
  );
  const soon = all.filter((d) => !d.live && d.at !== null && d.at > now);
  const rows = tab === 'live' ? live : soon;

  return (
    <Panel
      title="Drops"
      dense
      actions={
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: 'live', label: `MINTING NOW ${live.length}` },
            { id: 'soon', label: `UPCOMING · 72H ${soon.length}` },
          ]}
        />
      }
    >
      <div className="px-4 py-2 border-b border-line text-[12px] text-muted">
        From OpenSea’s drops calendar: minting now, or starting within the next 3 days. Times are live
        countdowns.
      </div>
      {q.isLoading ? (
        <div className="p-4">
          <SkeletonRows rows={4} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-5 text-[13px] text-muted">
          {tab === 'live'
            ? 'No drop is minting right now.'
            : 'Nothing scheduled to start in the next 72 hours.'}
        </div>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-surface text-[11px] text-muted">
              <tr className="border-b border-line [&>th]:h-8 [&>th]:px-3 [&>th]:font-medium">
                <th className="text-left">Collection</th>
                <th className="text-left">Stage</th>
                <th className="text-right">Price</th>
                <th className="text-right">Per wallet</th>
                <th className="text-right">{tab === 'live' ? 'Ends in' : 'Starts in'}</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((d) => {
                const st = tab === 'live' ? (d.stage ?? d.next) : (d.next ?? d.stage);
                const supported = isNetworkId(d.chain) && NETWORKS[d.chain].kind === 'evm';
                const task = `/nft?${new URLSearchParams({ network: d.chain, address: d.contract, name: d.name })}`;
                return (
                  <tr key={`${d.chain}:${d.contract}`} className="hover:bg-surface-2 [&>td]:h-12 [&>td]:px-3">
                    <td>
                      <span className="flex items-center gap-2.5 min-w-0">
                        <Thumb src={d.image} seed={d.contract} label={d.name} />
                        <span className="min-w-0">
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate max-w-[280px] text-text font-medium hover:underline underline-offset-2"
                          >
                            {d.name}
                          </a>
                          <ChainTag chain={d.chain} />
                        </span>
                      </span>
                    </td>
                    <td className="text-text-2 truncate max-w-[180px]">{st?.label ?? '—'}</td>
                    <td className="text-right num">{fmtPrice(st, d.chain)}</td>
                    <td className="text-right num text-text-2">{st?.maxPerWallet ?? '—'}</td>
                    <td
                      className={cx('text-right num', tab === 'live' ? 'text-warn' : 'text-up')}
                      title={d.at ? new Date(d.at).toLocaleString() : undefined}
                    >
                      {d.at ? fmtIn(d.at - now) : tab === 'live' ? 'open' : '—'}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <a
                        href={d.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] text-text border border-accent/50 bg-accent/12 hover:bg-accent/25 rounded-[var(--radius-sm)] px-2 h-6 inline-flex items-center"
                      >
                        Mint ↗
                      </a>
                      {supported && (
                        <Link
                          to={task}
                          className="ml-1.5 text-[12px] text-text-2 hover:text-text border border-line rounded-[var(--radius-sm)] px-2 h-6 inline-flex items-center hover:bg-surface-3"
                          title="Create an NFT Sniper task for this contract"
                        >
                          Mint task
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
