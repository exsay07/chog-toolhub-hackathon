import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import {
  Badge,
  cx,
  ErrorState,
  ExtLink,
  Notice,
  Panel,
  Pct,
  Select,
  Skeleton,
  SkeletonRows,
  Tabs,
} from '../components/ui';
import { fmtCompact } from '../lib/nft';

/** NFT → Top Collections: OpenSea rankings on every chain OpenSea supports. */

interface OsChain {
  id: string;
  name: string;
  symbol: string;
  featured: boolean;
}
/** Quick buttons; every other chain is in the picker next to them. */
const QUICK = ['monad', 'base', 'robinhood', 'ethereum', 'solana'];
const QUICK_LABEL: Record<string, string> = {
  monad: 'MONAD',
  base: 'BASE',
  robinhood: 'ROBINHOOD',
  ethereum: 'ETH',
  solana: 'SOL',
};
const CHAIN_KEY = 'chog.nft.topChain';
const readChain = () => {
  try {
    const v = localStorage.getItem(CHAIN_KEY);
    return v && /^[a-z0-9_]{2,32}$/.test(v) ? v : 'monad';
  } catch {
    return 'monad';
  }
};

type Sort = 'one_day_volume' | 'one_day_sales' | 'seven_days_volume' | 'floor_price';

interface TopRow {
  rank: number;
  slug: string;
  name: string;
  image: string | null;
  verified: boolean;
  contract: string | null;
  url: string;
  floor: number | null;
  floorSymbol: string;
  floor24hAgo: number | null;
  volume24h: number | null;
  volume7d: number | null;
  volumeSymbol: string;
  sales24h: number | null;
  owners: number | null;
  supply: number | null;
}
interface TopResult {
  configured: boolean;
  rows: TopRow[];
  pending: number;
  updatedAt: number | null;
  error: string | null;
}

const SORTS: Array<{ id: Sort; label: string; title: string }> = [
  { id: 'one_day_volume', label: '24H VOL', title: 'Top by 24h volume' },
  { id: 'one_day_sales', label: '24H SALES', title: 'Most traded · 24h' },
  { id: 'seven_days_volume', label: '7D VOL', title: 'Top by 7-day volume' },
  { id: 'floor_price', label: 'FLOOR', title: 'Highest floor' },
];

export default function TopCollections() {
  const [chain, setChainState] = useState<string>(readChain);
  const setChain = (c: string) => {
    setChainState(c);
    try {
      localStorage.setItem(CHAIN_KEY, c);
    } catch {
      /* ignore */
    }
  };
  const chains = useQuery({
    queryKey: ['nft-chains'],
    queryFn: () => get<{ chains: OsChain[] }>('/api/nft/chains'),
    staleTime: 3_600_000,
  });
  const list = chains.data?.chains ?? [];
  const current = list.find((c) => c.id === chain);
  const [sort, setSort] = useState<Sort>('one_day_volume');
  const q = useQuery({
    queryKey: ['nft-top', chain, sort],
    queryFn: () => get<TopResult>(`/api/nft/top?chain=${chain}&sort=${sort}`),
    // Rows fill in as the server works through OpenSea's rate limit: poll fast until done.
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && d.configured && d.updatedAt && d.pending === 0 ? 60_000 : 3000;
    },
  });
  const d = q.data;

  return (
    <div className="p-4">
      <Panel
        title={`${SORTS.find((s) => s.id === sort)!.title}${current ? ` · ${current.name}` : ''}`}
        actions={
          <>
            <Tabs
              value={QUICK.includes(chain) ? chain : ''}
              onChange={setChain}
              items={QUICK.map((id) => ({ id, label: QUICK_LABEL[id]! }))}
            />
            <Select
              aria-label="Chain"
              value={chain}
              onChange={(e) => setChain(e.target.value)}
              className="w-40"
            >
              {(list.length ? list : [{ id: chain, name: chain, symbol: '', featured: true }]).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.symbol ? ` · ${c.symbol}` : ''}
                </option>
              ))}
            </Select>
            <Tabs value={sort} onChange={setSort} items={SORTS} />
          </>
        }
        dense
      >
        <div className="px-4 py-2.5 border-b border-line text-[12px] text-muted flex items-center gap-3">
          <span>
            Ranked by OpenSea · floor change is the last 24h of floor history · prices in each
            collection&apos;s own currency.
          </span>
          {d?.configured && d.pending > 0 && (
            <span className="ml-auto text-text-2">
              Loading stats… {d.rows.length - d.pending}/{d.rows.length || 25}
            </span>
          )}
        </div>

        {q.isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={10} />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : !d?.configured ? (
          <div className="p-4">
            <Notice tone="info">
              Top Collections uses the OpenSea API. Get a free key on opensea.io (Account → Settings →
              Developer), add <span className="num">OPENSEA_API_KEY=…</span> to the server&apos;s{' '}
              <span className="num">.env</span> and restart the server.
            </Notice>
          </div>
        ) : (
          <>
            {d.error && (
              <div className="p-4 pb-0">
                <Notice tone="down">{d.error}</Notice>
              </div>
            )}
            {d.rows.length === 0 && !d.error ? (
              d.updatedAt ? (
                <div className="p-6 text-[13px] text-muted">No ranked collections on this network yet.</div>
              ) : (
                <div className="p-4">
                  <SkeletonRows rows={10} />
                </div>
              )
            ) : (
              <table className="w-full text-[13px]">
                <thead className="text-[11px] text-muted">
                  <tr className="border-b border-line [&>th]:h-8 [&>th]:px-3 [&>th]:font-medium">
                    <th className="w-10 text-left">#</th>
                    <th className="text-left">Collection</th>
                    <th className="text-right">Floor</th>
                    <th className="text-right">24h change</th>
                    <th className="text-right">24h %</th>
                    <th className="text-right">24h volume</th>
                    <th className="text-right">24h sales</th>
                    <th className="text-right">7d volume</th>
                    <th className="text-right">Owners</th>
                    <th className="text-right">Supply</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.rows.map((r) => (
                    <Row key={r.slug} r={r} />
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

function Row({ r }: { r: TopRow }) {
  const loading = r.floor === null && r.volume24h === null;
  const change = r.floor !== null && r.floor24hAgo !== null ? r.floor - r.floor24hAgo : null;
  const pct = change !== null && r.floor24hAgo ? (change / r.floor24hAgo) * 100 : null;
  const cell = (v: React.ReactNode) => (loading ? <Skeleton className="w-14 ml-auto" /> : v);
  const amt = (v: number | null, sym: string) =>
    v === null ? (
      <span className="text-muted">—</span>
    ) : (
      <span className="num">
        {fmtCompact(v)} <span className="text-muted">{sym}</span>
      </span>
    );
  return (
    <tr className="hover:bg-surface-2 [&>td]:h-11 [&>td]:px-3">
      <td className="num text-muted">{r.rank}</td>
      <td>
        <span className="flex items-center gap-2.5 min-w-0">
          {r.image ? (
            <img
              src={r.image}
              alt=""
              referrerPolicy="no-referrer"
              loading="lazy"
              className="size-7 rounded-[4px] object-cover border border-line shrink-0"
            />
          ) : (
            <span className="size-7 rounded-[4px] bg-surface-3 shrink-0" />
          )}
          <ExtLink href={r.url}>
            <span className="truncate max-w-[260px] inline-block align-middle">{r.name}</span>
          </ExtLink>
          {r.verified && (
            <Badge tone="info" title="Verified on OpenSea">
              ✓
            </Badge>
          )}
        </span>
      </td>
      <td className="text-right">{cell(amt(r.floor || null, r.floorSymbol))}</td>
      <td className="text-right">
        {cell(
          change === null ? (
            <span className="text-muted">—</span>
          ) : (
            <span
              className={cx('num', change > 0 ? 'text-up' : change < 0 ? 'text-down' : 'text-text-2')}
              title={`${fmtCompact(r.floor24hAgo!)} → ${fmtCompact(r.floor!)} ${r.floorSymbol}`}
            >
              {change > 0 ? '+' : ''}
              {fmtCompact(change)} {change > 0 ? '↑' : change < 0 ? '↓' : ''}
            </span>
          ),
        )}
      </td>
      <td className="text-right">{cell(<Pct v={pct} />)}</td>
      <td className="text-right">{cell(amt(r.volume24h, r.volumeSymbol))}</td>
      <td className="text-right num">{cell(r.sales24h ?? '—')}</td>
      <td className="text-right">{cell(amt(r.volume7d, r.volumeSymbol))}</td>
      <td className="text-right num">{cell(r.owners === null ? '—' : fmtCompact(r.owners))}</td>
      <td className="text-right num">{cell(r.supply === null ? '—' : fmtCompact(r.supply))}</td>
    </tr>
  );
}
