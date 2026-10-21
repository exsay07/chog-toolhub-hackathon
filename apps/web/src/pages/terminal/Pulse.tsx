import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { NETWORKS, type NetworkId, type PairSummary } from '@chog/shared';
import { pulseQuery } from '../../lib/discover';
import { Copy, cx, ErrorState, SkeletonRows } from '../../components/ui';
import {
  ageShort,
  ChangeText,
  QuickBuy,
  Socials,
  TokenAvatar,
  usd,
  useFreshKeys,
  useTerminal,
} from './common';

/**
 * Pulse (Axiom-style): three live columns — brand-new pools, young tokens picking up real activity,
 * and what the whole market is trading right now. Refreshed every 4 seconds.
 */

const HOUR = 3600_000;
/** "Heating up": a young token (< 24h) with real flow in the last hour. */
const heating = (p: PairSummary, now: number) => {
  const age = p.createdAt ? now - p.createdAt : Infinity;
  const tx = (p.txns.h1?.buys ?? 0) + (p.txns.h1?.sells ?? 0);
  return age < 24 * HOUR && (tx >= 40 || (p.volume.h1 ?? 0) >= 10_000);
};

export function Pulse() {
  const { chains } = useTerminal();
  const q = useQuery({
    ...pulseQuery(chains),
    refetchInterval: 4000,
    placeholderData: (prev) => prev,
  });

  const cols = useMemo(() => {
    const now = Date.now();
    const key = (p: PairSummary) => `${p.network}:${p.pairAddress.toLowerCase()}`;
    const all = new Map<string, PairSummary>();
    for (const p of [...(q.data?.data.fresh ?? []), ...(q.data?.data.trending ?? [])]) all.set(key(p), p);
    const hot = [...all.values()].filter((p) => heating(p, now));
    const hotKeys = new Set(hot.map(key));
    // Test / empty pools (no real liquidity) are noise, not launches.
    const fresh = (q.data?.data.fresh ?? [])
      .filter((p) => !hotKeys.has(key(p)) && (p.liquidityUsd ?? 0) >= 100)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const trending = (q.data?.data.trending ?? [])
      .filter((p) => !hotKeys.has(key(p)))
      .sort(
        (a, b) =>
          (b.txns.m5?.buys ?? 0) +
          (b.txns.m5?.sells ?? 0) -
          ((a.txns.m5?.buys ?? 0) + (a.txns.m5?.sells ?? 0)),
      );
    hot.sort((a, b) => (b.volume.h1 ?? 0) - (a.volume.h1 ?? 0));
    return { fresh, hot, trending };
  }, [q.data]);

  if (q.isLoading)
    return (
      <div className="p-4">
        <SkeletonRows rows={12} />
      </div>
    );
  if (q.isError && !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  return (
    <div className="h-full min-h-0 grid grid-cols-3 divide-x divide-line">
      <Column
        title="New pairs"
        hint="Pools created most recently"
        rows={cols.fresh}
        loading={q.data?.errors ?? []}
      />
      <Column
        title="Heating up"
        hint="Younger than 24h with real flow in the last hour (≥ 40 trades or ≥ $10K volume)"
        rows={cols.hot}
        loading={q.data?.errors ?? []}
      />
      <Column
        title="Trending"
        hint="Most active right now (5-minute trending)"
        rows={cols.trending}
        loading={q.data?.errors ?? []}
      />
    </div>
  );
}

function Column({
  title,
  hint,
  rows,
  loading,
}: {
  title: string;
  hint: string;
  rows: PairSummary[];
  loading: NetworkId[];
}) {
  const fresh = useFreshKeys(rows.map((p) => `${p.network}:${p.pairAddress}`));
  // Only on-screen cards are rendered; each one is measured (heights differ slightly).
  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 80,
    overscan: 8,
    useFlushSync: false,
    getItemKey: (i) => `${rows[i]!.network}:${rows[i]!.pairAddress}`,
  });
  return (
    <section className="flex flex-col min-h-0">
      <header className="flex items-center gap-2 px-4 h-10 border-b border-line shrink-0" title={hint}>
        <h3 className="text-[13px] font-semibold text-text">{title}</h3>
        <span className="text-[12px] text-muted num">{rows.length}</span>
        {loading.length > 0 && (
          <span className="ml-auto text-[11px] text-muted">
            loading {loading.map((n) => NETWORKS[n].shortName).join(', ')}…
          </span>
        )}
      </header>
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-[12px] text-muted">
            {loading.length ? 'Loading…' : 'Nothing here right now.'}
          </div>
        ) : (
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((it) => {
              const p = rows[it.index]!;
              return (
                <div
                  key={it.key}
                  data-index={it.index}
                  ref={virt.measureElement}
                  className="absolute left-0 right-0"
                  style={{ transform: `translateY(${it.start}px)` }}
                >
                  <Card p={p} fresh={fresh.has(`${p.network}:${p.pairAddress}`)} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function Card({ p, fresh }: { p: PairSummary; fresh: boolean }) {
  const { openToken } = useTerminal();
  const t5 = p.txns.m5;
  const tx = t5 ? t5.buys + t5.sells : null;
  const buyPct = t5 && tx ? (t5.buys / tx) * 100 : 50;
  return (
    <div
      onClick={() => openToken(p.network, p.base.address, p.base.symbol, p.pairAddress)}
      className={cx(
        'group flex gap-3 px-4 py-3 border-b border-line cursor-pointer hover:bg-surface-2 transition-colors',
        fresh && 'flash-up',
      )}
    >
      <TokenAvatar p={p} size={52} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold text-text truncate max-w-[110px]">{p.base.symbol}</span>
          <span className="text-[12px] text-muted truncate">{p.base.name}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted mt-0.5">
          <span className="num text-up/90">{ageShort(p.createdAt)}</span>
          <span onClick={(e) => e.stopPropagation()}>
            <Copy text={p.base.address} />
          </span>
          <Socials p={p} />
          <span className="truncate">{p.dex}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] mt-1.5 num">
          <span>
            <span className="text-muted">V </span>
            <span className="text-text">{usd(p.volume.h1 ?? p.volume.h24)}</span>
          </span>
          <span>
            <span className="text-muted">L </span>
            <span className="text-text-2">{usd(p.liquidityUsd)}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="text-muted">TX </span>
            <span className="text-text-2">{tx ?? '—'}</span>
            <span className="h-[3px] w-8 rounded-full bg-down/60 overflow-hidden">
              <span className="block h-full bg-up" style={{ width: `${buyPct}%` }} />
            </span>
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end justify-between shrink-0">
        <span className="text-right">
          <span className="text-[11px] text-muted">MC </span>
          <span className="num text-[13px] text-text">{usd(p.marketCapUsd ?? p.fdvUsd)}</span>
          <span className="block text-[11px]">
            <ChangeText v={p.change.m5} />
            <span className="text-muted"> 5m</span>
          </span>
        </span>
        <QuickBuy p={p} compact />
      </div>
    </div>
  );
}
