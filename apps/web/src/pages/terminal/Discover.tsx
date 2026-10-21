import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { NETWORKS, type PairSummary } from '@chog/shared';
import { ArrowDown, ArrowUp, SlidersHorizontal } from 'lucide-react';
import { discoverQuery, type DiscoverTf as Tf, type DiscoverView as View } from '../../lib/discover';
import { Copy, cx, ErrorState, Freshness, Input, SkeletonRows, Tabs } from '../../components/ui';
import {
  ageShort,
  ChangeText,
  QuickBuy,
  Socials,
  TokenAvatar,
  TxnsCell,
  usd,
  useFreshKeys,
  usePersisted,
  useTerminal,
} from './common';

/**
 * Discover: the ranked memecoin table (Axiom "Discover"). Ranking per chain from GeckoTerminal,
 * numbers refreshed from Dexscreener every few seconds; one-click buy on every row.
 */

type SortKey = 'rank' | 'age' | 'mcap' | 'liq' | 'vol' | 'txns' | 'm5' | 'h1' | 'h6' | 'h24';
interface Filters {
  minLiq: number;
  minMcap: number;
  maxAgeH: number;
}
const isFilters = (v: unknown): v is Filters =>
  !!v &&
  typeof v === 'object' &&
  ['minLiq', 'minMcap', 'maxAgeH'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number');

const ROW_H = 58;

const TF_KEY: Record<Tf, 'm5' | 'h1' | 'h6' | 'h24'> = { '5m': 'm5', '1h': 'h1', '6h': 'h6', '24h': 'h24' };

export function Discover() {
  const { chains, openToken } = useTerminal();
  const [view, setView] = usePersisted<View>(
    'term.view',
    'trending',
    (v): v is View => v === 'trending' || v === 'top',
  );
  const [tf, setTf] = usePersisted<Tf>('term.tf', '1h', (v): v is Tf =>
    ['5m', '1h', '6h', '24h'].includes(v as string),
  );
  const [filters, setFilters] = usePersisted<Filters>(
    'term.filters',
    { minLiq: 0, minMcap: 0, maxAgeH: 0 },
    isFilters,
  );
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'rank', dir: 1 });

  const q = useQuery({
    ...discoverQuery(chains, view, tf),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });

  const k = TF_KEY[tf];
  const rows = useMemo(() => {
    const now = Date.now();
    const list = (q.data?.data ?? [])
      .map((p, i) => ({ p, rank: i }))
      .filter(
        ({ p }) =>
          (p.liquidityUsd ?? 0) >= filters.minLiq &&
          (p.marketCapUsd ?? p.fdvUsd ?? 0) >= filters.minMcap &&
          (!filters.maxAgeH || (p.createdAt !== null && now - p.createdAt <= filters.maxAgeH * 3600_000)),
      );
    const val = ({ p, rank }: { p: PairSummary; rank: number }): number => {
      switch (sort.key) {
        case 'rank':
          return rank;
        case 'age':
          return p.createdAt ?? 0;
        case 'mcap':
          return p.marketCapUsd ?? p.fdvUsd ?? 0;
        case 'liq':
          return p.liquidityUsd ?? 0;
        case 'vol':
          return p.volume[k] ?? 0;
        case 'txns': {
          const t = p.txns[k];
          return t ? t.buys + t.sells : 0;
        }
        default:
          return p.change[sort.key] ?? -Infinity;
      }
    };
    return list.sort((a, b) => (val(a) - val(b)) * sort.dir);
  }, [q.data, filters, sort, k]);
  const fresh = useFreshKeys(rows.map((r) => `${r.p.network}:${r.p.pairAddress}`));
  // Only the rows on screen are in the DOM: the table paints instantly however long the list is.
  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    // A deep buffer of ready rows, rendered in React's normal batch (not synchronously inside the
    // scroll event) — scrolling never waits for a render.
    overscan: 14,
    useFlushSync: false,
  });
  const items = virt.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virt.getTotalSize() - (items[items.length - 1]?.end ?? 0);
  const filtered = filters.minLiq > 0 || filters.minMcap > 0 || filters.maxAgeH > 0;

  const head = (key: SortKey, label: string, align: 'left' | 'right' = 'right') => (
    <th className={cx('font-medium px-3', align === 'right' ? 'text-right' : 'text-left')}>
      <button
        onClick={() =>
          setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : key === 'rank' ? 1 : -1 }))
        }
        className={cx(
          'inline-flex items-center gap-0.5 hover:text-text',
          sort.key === key ? 'text-text' : 'text-muted',
        )}
      >
        {label}
        {sort.key === key &&
          (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-line shrink-0">
        <Tabs
          value={view}
          onChange={setView}
          items={[
            { id: 'trending', label: 'TRENDING' },
            { id: 'top', label: 'TOP VOLUME' },
          ]}
        />
        {view === 'trending' && (
          <Tabs
            value={tf}
            onChange={setTf}
            items={(['5m', '1h', '6h', '24h'] as const).map((id) => ({ id, label: id.toUpperCase() }))}
          />
        )}
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={cx(
            'h-7 px-2.5 rounded-[var(--radius-sm)] border text-[12px] inline-flex items-center gap-1.5',
            filtered
              ? 'border-accent/50 text-text bg-accent/10'
              : 'border-line text-text-2 hover:text-text hover:bg-surface-2',
          )}
        >
          <SlidersHorizontal className="size-3.5" />
          Filters{filtered ? ' ·' : ''}
        </button>
        <span className="ml-auto flex items-center gap-3 text-[12px] text-muted">
          {q.data && q.data.errors.length > 0 && (
            <span title="Still loading under the free-tier rate limit, or the provider failed">
              loading {q.data.errors.map((n) => NETWORKS[n].shortName).join(', ')}…
            </span>
          )}
          {q.data && (
            <Freshness
              fetchedAt={q.data.fetchedAt}
              stale={q.data.stale}
              source="GeckoTerminal · Dexscreener"
              maxAgeMs={150_000}
            />
          )}
        </span>
      </div>

      {showFilters && (
        <div className="flex items-end gap-4 px-4 py-3 border-b border-line bg-surface-2/40 shrink-0 text-[12px]">
          {(
            [
              ['minLiq', 'Min liquidity $'],
              ['minMcap', 'Min market cap $'],
              ['maxAgeH', 'Max age (hours)'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-muted">{label}</span>
              <Input
                type="number"
                min="0"
                className="w-32"
                value={filters[key] || ''}
                placeholder="any"
                onChange={(e) =>
                  setFilters((f) => ({ ...f, [key]: Math.max(0, Number(e.target.value) || 0) }))
                }
              />
            </label>
          ))}
          <button
            className="h-8 px-3 text-text-2 hover:text-text"
            onClick={() => setFilters({ minLiq: 0, minMcap: 0, maxAgeH: 0 })}
          >
            Reset
          </button>
        </div>
      )}

      <div ref={scroller} className="flex-1 min-h-0 overflow-auto">
        {q.isLoading ? (
          <div className="p-4">
            <SkeletonRows rows={12} />
          </div>
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-muted">
            {filtered ? 'Nothing matches the filters.' : 'No tokens yet — chains are still loading.'}
          </div>
        ) : (
          <table className="w-full table-fixed text-[13px] whitespace-nowrap">
            {/* Fixed widths: virtualized rows can't resize the columns while scrolling. */}
            <colgroup>
              <col className="w-10" />
              <col />
              <col className="w-[60px]" />
              <col className="w-[92px]" />
              <col className="w-[88px]" />
              <col className="w-[96px]" />
              <col className="w-[100px]" />
              <col className="w-[64px]" />
              <col className="w-[64px]" />
              <col className="w-[64px]" />
              <col className="w-[68px]" />
              <col className="w-[124px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-bg text-[11px]">
              <tr className="border-b border-line h-9">
                {head('rank', '#', 'left')}
                <th className="text-left font-medium px-3 text-muted">Token</th>
                {head('age', 'Age')}
                {head('mcap', 'Market cap')}
                {head('liq', 'Liquidity')}
                {head('vol', `Volume ${tf}`)}
                {head('txns', `TXNS ${tf}`)}
                {head('m5', '5m')}
                {head('h1', '1h')}
                {head('h6', '6h')}
                {head('h24', '24h')}
                <th className="px-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
              {items.map((it) => {
                const { p, rank } = rows[it.index]!;
                const key = `${p.network}:${p.pairAddress}`;
                return (
                  <tr
                    key={key}
                    onClick={() => openToken(p.network, p.base.address, p.base.symbol, p.pairAddress)}
                    className={cx(
                      'h-[58px] cursor-pointer hover:bg-surface-2 transition-colors',
                      fresh.has(key) && 'flash-up',
                    )}
                  >
                    <td className="px-3 num text-muted w-10">{rank + 1}</td>
                    <td className="px-3">
                      <span className="flex items-center gap-3 min-w-0">
                        <TokenAvatar p={p} size={36} />
                        <span className="min-w-0 overflow-hidden">
                          <span className="flex items-center gap-1.5">
                            <span className="font-semibold text-text truncate max-w-[140px]">
                              {p.base.symbol}
                            </span>
                            <span className="text-muted truncate max-w-[160px] text-[12px]">
                              {p.base.name}
                            </span>
                          </span>
                          <span className="flex items-center gap-2 text-[11px] text-muted mt-0.5">
                            <span className="num">
                              {p.base.address.slice(0, 4)}…{p.base.address.slice(-4)}
                            </span>
                            <span onClick={(e) => e.stopPropagation()}>
                              <Copy text={p.base.address} />
                            </span>
                            <Socials p={p} />
                            <span className="text-muted/70">{p.dex}</span>
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="px-3 text-right num text-text-2">{ageShort(p.createdAt)}</td>
                    <td className="px-3 text-right">
                      <span className="num text-text">{usd(p.marketCapUsd ?? p.fdvUsd)}</span>
                    </td>
                    <td className="px-3 text-right num text-text-2">{usd(p.liquidityUsd)}</td>
                    <td className="px-3 text-right num text-text">{usd(p.volume[k])}</td>
                    <td className="px-3 text-right">
                      <TxnsCell t={p.txns[k]} />
                    </td>
                    <td className="px-3 text-right">
                      <ChangeText v={p.change.m5} />
                    </td>
                    <td className="px-3 text-right">
                      <ChangeText v={p.change.h1} />
                    </td>
                    <td className="px-3 text-right">
                      <ChangeText v={p.change.h6} />
                    </td>
                    <td className="px-3 text-right">
                      <ChangeText v={p.change.h24} />
                    </td>
                    <td className="px-3 text-right">
                      <QuickBuy p={p} />
                    </td>
                  </tr>
                );
              })}
              {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
