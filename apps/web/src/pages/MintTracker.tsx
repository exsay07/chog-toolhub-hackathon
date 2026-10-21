import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { fmtAge, shortAddress } from '@chog/shared';
import { get } from '../lib/api';
import {
  Badge,
  cx,
  ErrorState,
  ExtLink,
  NetworkBadge,
  Notice,
  Panel,
  SkeletonRows,
  Tabs,
  Toggle,
} from '../components/ui';
import { fmtCompact, type NftChain } from '../lib/nft';
import { DropsPanel } from './Drops';

/**
 * NFT → Mint Tracker: the OpenSea drops calendar (minting now / next 72 h) and live ERC-721 mints read
 * from Monad, Base, Robinhood Chain and Ethereum, hottest first. Only collections minting in the last
 * 15 minutes are listed.
 * RATE = mints in the last 10 minutes / hour; SUS = thin wallet spread; AIR = airdrop.
 */

interface MintRow {
  chain: NftChain;
  contract: string;
  name: string | null;
  symbol: string | null;
  minted: number | null;
  m10: number;
  m60: number;
  wallets: number;
  topWalletShare: number;
  air: boolean;
  sus: string | null;
  firstSeen: number;
  lastMint: number;
  verified: boolean;
  image: string | null;
  links: { explorer: string; opensea: string | null; twitter: string | null; site: string | null };
}
interface ChainStatus {
  ok: boolean;
  head: number | null;
  behind: number;
  error: string | null;
}
interface MintsResult {
  enabled: boolean;
  rows: MintRow[];
  status: Partial<Record<NftChain, ChainStatus>>;
}

type ChainFilter = 'all' | NftChain;
/** "Hot" = at least this many mints in the last 10 minutes. */
const HOT_10M = 10;
/** A collection counts as minting now if its last mint is this recent. */
const ACTIVE_MS = 15 * 60_000;

export default function MintTracker() {
  const [chain, setChain] = useState<ChainFilter>('all');
  const [mode, setMode] = useState<'live' | 'hot'>('live');
  const [hideSus, setHideSus] = useState(false);
  const [hideAir, setHideAir] = useState(true);
  const q = useQuery({
    queryKey: ['nft-mints'],
    queryFn: () => get<MintsResult>('/api/nft/mints?chain=all'),
    refetchInterval: 5000,
  });
  const all = q.data?.rows ?? [];
  const count = (c: ChainFilter) =>
    all.filter((r) => Date.now() - r.lastMint <= ACTIVE_MS && (c === 'all' || r.chain === c)).length;
  const now = Date.now();
  const rows = all.filter(
    (r) =>
      now - r.lastMint <= ACTIVE_MS &&
      (chain === 'all' || r.chain === chain) &&
      (mode === 'live' || r.m10 >= HOT_10M) &&
      !(hideSus && r.sus) &&
      !(hideAir && r.air),
  );
  const maxRate = Math.max(1, ...rows.map((r) => r.m10));
  const status = q.data?.status ?? {};
  const catchingUp = (Object.entries(status) as Array<[NftChain, ChainStatus]>).filter(
    ([, s]) => s.ok && s.behind > 200,
  );
  const failing = (Object.entries(status) as Array<[NftChain, ChainStatus]>).filter(([, s]) => s.error);

  return (
    <div className="p-4 space-y-3">
      <DropsPanel chain={chain} />
      <Panel
        title="Live mints · last 15 min"
        actions={
          <>
            <Tabs
              value={chain}
              onChange={setChain}
              items={(['all', 'monad', 'base', 'robinhood', 'ethereum'] as const).map((id) => ({
                id,
                label: `${id === 'all' ? 'ALL' : id === 'robinhood' ? 'RH' : id === 'ethereum' ? 'ETH' : id.toUpperCase()} ${count(id)}`,
              }))}
            />
            <Tabs
              value={mode}
              onChange={setMode}
              items={[
                { id: 'live', label: 'LIVE' },
                { id: 'hot', label: 'HOT' },
              ]}
            />
          </>
        }
        dense
      >
        <div className="px-4 py-2.5 border-b border-line text-[12px] text-muted flex items-center gap-4">
          <span className="min-w-0">
            Hottest first. <b className="text-text-2 font-medium">RATE</b> = mints in the last 10 minutes /
            hour — the dot warms up with it. <b className="text-text-2 font-medium">SUS</b> = thin wallet
            spread (hover for the reason). <b className="text-text-2 font-medium">AIR</b> = airdrop.
          </span>
          <span className="ml-auto flex items-center gap-4 shrink-0">
            <Toggle checked={hideSus} onChange={setHideSus} label="Hide SUS" />
            <Toggle checked={hideAir} onChange={setHideAir} label="Hide airdrops" />
          </span>
        </div>

        {(catchingUp.length > 0 || failing.length > 0) && (
          <div className="px-4 pt-3 space-y-2">
            {catchingUp.length > 0 && (
              <Notice tone="info">
                Reading the last hour from the chain ({catchingUp.map(([c]) => c).join(', ')}) — numbers grow
                for about a minute after the server starts.
              </Notice>
            )}
            {failing.map(([c, s]) => (
              <Notice key={c} tone="down">
                {c}: {s.error}
              </Notice>
            ))}
          </div>
        )}

        {q.isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={10} />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : !q.data?.enabled ? (
          <div className="p-4">
            <Notice tone="info">The mint tracker is turned off on this server (MINTS_ENABLED=false).</Notice>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-[13px] text-muted">
            {mode === 'hot'
              ? `Nothing is minting ${HOT_10M}+ per 10 minutes right now.`
              : 'Nothing has minted in the last 15 minutes.'}
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] text-muted">
              <tr className="border-b border-line [&>th]:h-8 [&>th]:px-3 [&>th]:font-medium">
                <th className="text-left">Collection</th>
                <th className="text-right">Minted</th>
                <th className="text-left pl-6">Rate</th>
                <th className="text-right">Wallets · 1h</th>
                <th className="text-right">First seen</th>
                <th className="text-left">Links</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <Row key={`${r.chain}:${r.contract}`} r={r} heat={r.m10 / maxRate} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

/** OpenSea image when the collection is indexed; otherwise a stable colour tile with its initials. */
function Avatar({ r }: { r: MintRow }) {
  const [broken, setBroken] = useState(false);
  if (r.image && !broken)
    return (
      <img
        src={r.image}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-7 rounded-[4px] object-cover border border-line shrink-0"
      />
    );
  const hue = parseInt(r.contract.slice(2, 8), 16) % 360;
  const label = (r.name ?? r.symbol ?? r.contract.slice(2))
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-hidden
      className="size-7 rounded-[4px] shrink-0 grid place-items-center text-[11px] font-semibold text-black/80 border border-line"
      style={{ background: `hsl(${hue} 55% 62%)` }}
    >
      {label || '?'}
    </span>
  );
}

function Row({ r, heat }: { r: MintRow; heat: number }) {
  const sniper = `/nft?${new URLSearchParams({ network: r.chain, address: r.contract, name: r.name ?? '' })}`;
  return (
    <tr className="hover:bg-surface-2 [&>td]:h-11 [&>td]:px-3">
      <td>
        <span className="flex items-center gap-2.5 min-w-0">
          <Avatar r={r} />
          <Link
            to={sniper}
            className="truncate max-w-[260px] hover:underline underline-offset-2 decoration-accent"
            title={`Mint ${r.name ?? r.contract} — opens an NFT Sniper task with this contract`}
          >
            {r.name ?? shortAddress(r.contract)}
          </Link>
          <NetworkBadge id={r.chain} />
          {r.verified && (
            <Badge tone="info" title="Verified on OpenSea">
              ✓
            </Badge>
          )}
          {r.air && (
            <Badge
              tone="neutral"
              title="Most mints arrive in transactions that send tokens to many wallets at once"
            >
              AIR
            </Badge>
          )}
          {r.sus && (
            <Badge tone="warn" title={r.sus}>
              SUS
            </Badge>
          )}
        </span>
      </td>
      <td className="text-right num">{r.minted === null ? '—' : fmtCompact(r.minted)}</td>
      <td className="pl-6">
        <span className="inline-flex items-center gap-2 num">
          <HeatDot heat={heat} />
          <span className={cx(r.m10 > 0 ? 'text-text' : 'text-muted')}>+{r.m10}</span>
          <span className="text-muted">/10m</span>
          <span className="text-text-2">+{r.m60}/h</span>
        </span>
      </td>
      <td
        className="text-right num"
        title={`Busiest wallet: ${Math.round(r.topWalletShare * 100)}% of mints`}
      >
        {r.wallets}
      </td>
      <td className="text-right text-muted num">{fmtAge(r.firstSeen)}</td>
      <td>
        <span className="flex items-center gap-2.5 text-[12px]">
          {r.links.opensea && <ExtLink href={r.links.opensea}>OpenSea</ExtLink>}
          {r.links.twitter && <ExtLink href={r.links.twitter}>𝕏</ExtLink>}
          {r.links.site && <ExtLink href={r.links.site}>Site</ExtLink>}
          <ExtLink href={r.links.explorer}>Explorer</ExtLink>
        </span>
      </td>
      <td className="text-right">
        <Link
          to={sniper}
          className="text-[12px] text-text-2 hover:text-text border border-line rounded-[var(--radius-sm)] px-2 h-6 inline-flex items-center hover:bg-surface-3"
          title="Create an NFT Sniper task for this contract"
        >
          Mint task
        </Link>
      </td>
    </tr>
  );
}

/** Grey when quiet → amber → red-hot as the 10-minute rate climbs (relative to the hottest row). */
function HeatDot({ heat }: { heat: number }) {
  const h = Math.max(0, Math.min(1, heat));
  const color = h < 0.05 ? 'var(--color-muted)' : `hsl(${Math.round(45 - 45 * h)} 95% ${55 - 8 * h}%)`;
  return (
    <span
      className="size-[7px] rounded-full shrink-0"
      style={{ background: color, boxShadow: h > 0.3 ? `0 0 ${4 + 6 * h}px ${color}` : 'none' }}
    />
  );
}
