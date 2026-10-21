import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  NETWORKS,
  fmtAge,
  fmtNum,
  fmtUsd,
  shortAddress,
  type Candle,
  type NetworkId,
  type PairSummary,
  type PoolTrade,
  type TokenSecurity,
} from '@chog/shared';
import { get, type Envelope } from '../../lib/api';
import { PriceChart } from '../../components/PriceChart';
import {
  Badge,
  cx,
  Empty,
  ErrorState,
  ExtLink,
  Freshness,
  Notice,
  Panel,
  Price,
  Skeleton,
  SkeletonRows,
  Tabs,
} from '../../components/ui';

/** Token page building blocks: chart (Dexscreener embed or native), trades, pools, risk scan. */

/** Every pool of the token, Dexscreener-style. Clicking a row switches chart + stats to that pool. */
export function PoolsPanel({
  pairs,
  selected,
  token,
  onSelect,
  bare,
}: {
  pairs: PairSummary[];
  selected: string;
  token: string;
  onSelect: (pair: string) => void;
  /** Without its own panel frame (embedded in another panel's tabs). */
  bare?: boolean;
}) {
  const table = (
    <div className="overflow-auto max-h-[340px]">
      <table className="w-full text-[12px] whitespace-nowrap [&_td]:px-2 [&_th]:px-2">
        <thead className="sticky top-0 bg-surface text-muted text-[11px]">
          <tr>
            <th className="text-left font-medium pl-4! py-1.5">DEX</th>
            <th className="text-left font-medium">Pair</th>
            <th className="text-right font-medium">Price</th>
            <th className="text-right font-medium">Liquidity</th>
            <th className="text-right font-medium">Vol 24h</th>
            <th className="text-right font-medium">Txns 24h</th>
            <th className="text-right font-medium pr-4!">Age</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((x) => {
            const base = x.base.address.toLowerCase() === token.toLowerCase();
            return (
              <tr
                key={x.pairAddress}
                onClick={() => onSelect(x.pairAddress)}
                className={cx(
                  'cursor-pointer hover:bg-surface-2',
                  x.pairAddress === selected && 'bg-accent/8',
                )}
              >
                <td className="pl-4! py-1.5 font-medium">{x.dex}</td>
                <td className="text-text-2">
                  {x.base.symbol}/{x.quote.symbol}
                  {!base && <span className="text-warn"> · quote</span>}
                </td>
                <td className="text-right">
                  <Price
                    v={
                      base
                        ? x.priceUsd
                        : x.priceUsd !== null && x.priceNative
                          ? x.priceUsd / x.priceNative
                          : null
                    }
                  />
                </td>
                <td className="num text-right">{fmtUsd(x.liquidityUsd, { compact: true })}</td>
                <td className="num text-right">{fmtUsd(x.volume.h24, { compact: true })}</td>
                <td className="num text-right text-muted">
                  {x.txns.h24 ? `${x.txns.h24.buys + x.txns.h24.sells}` : '—'}
                </td>
                <td className="num text-right text-muted pr-4!">{x.createdAt ? fmtAge(x.createdAt) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  if (bare) return table;
  return (
    <Panel
      title={`Pools (${pairs.length})`}
      dense
      actions={<span className="text-[11px] text-muted">by liquidity</span>}
    >
      {table}
    </Panel>
  );
}

type ChartSource = 'dexscreener' | 'native';
const CHART_KEY = 'chog.chartSource';
const readChartSource = (): ChartSource => {
  try {
    return localStorage.getItem(CHART_KEY) === 'native' ? 'native' : 'dexscreener';
  } catch {
    return 'dexscreener';
  }
};

/**
 * Default: Dexscreener's official embeddable chart (+ its live trades) — identical to dexscreener.com,
 * covers every pool Dexscreener indexes and doesn't consume our GeckoTerminal quota.
 * Alternative: native chart fed by GeckoTerminal OHLCV.
 */
export function ChartArea({
  network,
  pool,
  livePrice,
}: {
  network: NetworkId;
  pool: string;
  livePrice: number | null;
}) {
  const [src, setSrc] = useState<ChartSource>(readChartSource);
  const choose = (v: ChartSource) => {
    setSrc(v);
    try {
      localStorage.setItem(CHART_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const toggle = (
    <Tabs
      value={src}
      onChange={choose}
      items={[
        { id: 'dexscreener', label: 'Dexscreener' },
        { id: 'native', label: 'Native' },
      ]}
    />
  );
  if (src === 'native')
    return (
      <>
        <ChartPanel network={network} pool={pool} livePrice={livePrice} sourceToggle={toggle} />
        <TradesPanel network={network} pool={pool} />
      </>
    );
  return <DexscreenerChart network={network} pool={pool} sourceToggle={toggle} />;
}

function DexscreenerChart({
  network,
  pool,
  sourceToggle,
}: {
  network: NetworkId;
  pool: string;
  sourceToggle: ReactNode;
}) {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const qs = new URLSearchParams({
    embed: '1',
    loadChartSettings: '0',
    tabs: '0',
    info: '0',
    chartLeftToolbar: '0',
    chartTheme: theme,
    theme,
    chartStyle: '1',
    chartType: 'usd',
    interval: '15',
    trades: '1',
  });
  const url = `https://dexscreener.com/${NETWORKS[network].dexscreenerId}/${encodeURIComponent(pool)}?${qs}`;
  return (
    <Panel title="Chart & trades" className="shrink-0" dense actions={sourceToggle}>
      <iframe
        key={url}
        src={url}
        title="Dexscreener chart"
        className="w-full h-[640px] border-0 rounded-b-[var(--radius)]"
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </Panel>
  );
}

const TFS = [
  { id: 'm1', tf: 'minute', agg: 1, label: '1m' },
  { id: 'm5', tf: 'minute', agg: 5, label: '5m' },
  { id: 'm15', tf: 'minute', agg: 15, label: '15m' },
  { id: 'h1', tf: 'hour', agg: 1, label: '1h' },
  { id: 'h4', tf: 'hour', agg: 4, label: '4h' },
  { id: 'd1', tf: 'day', agg: 1, label: '1D' },
] as const;

function ChartPanel({
  network,
  pool,
  livePrice,
  sourceToggle,
}: {
  network: NetworkId;
  pool: string;
  livePrice: number | null;
  sourceToggle?: ReactNode;
}) {
  const [tf, setTf] = useState<(typeof TFS)[number]['id']>('m5');
  const t = TFS.find((x) => x.id === tf)!;
  const q = useQuery({
    queryKey: ['ohlcv', network, pool, tf],
    queryFn: ({ signal }) =>
      get<Envelope<Candle[]>>(`/api/market/ohlcv/${network}/${pool}?tf=${t.tf}&agg=${t.agg}`, signal),
    refetchInterval: t.tf === 'minute' ? 30_000 : 120_000,
    placeholderData: (prev) => prev,
  });
  return (
    <Panel
      title="Chart"
      className="shrink-0"
      actions={
        <>
          {q.data && (
            <Freshness
              fetchedAt={q.data.fetchedAt}
              stale={q.data.stale}
              source="GeckoTerminal"
              maxAgeMs={90_000}
            />
          )}
          <Tabs value={tf} onChange={setTf} items={TFS.map((x) => ({ id: x.id, label: x.label }))} />
          {sourceToggle}
        </>
      }
      dense
    >
      {q.isLoading ? (
        <Skeleton className="h-[360px] m-2" />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : (q.data?.data.length ?? 0) === 0 ? (
        <Empty title="No candle data" compact>
          GeckoTerminal has no OHLCV for this pool yet.
        </Empty>
      ) : (
        <PriceChart candles={q.data!.data} livePrice={livePrice} />
      )}
    </Panel>
  );
}

export function TradesPanel({ network, pool }: { network: NetworkId; pool: string }) {
  const q = useQuery({
    queryKey: ['trades', network, pool],
    queryFn: ({ signal }) => get<Envelope<PoolTrade[]>>(`/api/market/trades/${network}/${pool}`, signal),
    refetchInterval: 20_000,
  });
  return (
    <Panel
      title="Recent trades"
      actions={
        q.data && <Freshness fetchedAt={q.data.fetchedAt} stale={q.data.stale} source="GeckoTerminal" />
      }
      dense
    >
      {q.isLoading ? (
        <SkeletonRows />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : (q.data?.data.length ?? 0) === 0 ? (
        <Empty title="No recent trades" compact />
      ) : (
        <div className="overflow-auto max-h-[300px]">
          <table className="w-full text-[12px] whitespace-nowrap [&_td]:px-2 [&_th]:px-2">
            <thead className="sticky top-0 bg-surface text-muted text-[11px]">
              <tr>
                <th className="text-left font-semibold px-3 py-1">Age</th>
                <th className="text-left font-semibold">Side</th>
                <th className="text-right font-semibold">Price</th>
                <th className="text-right font-semibold">Value</th>
                <th className="text-right font-semibold">Amount</th>
                <th className="text-right font-semibold px-3">Maker</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.data.map((t) => (
                <tr key={t.hash + t.at} className="border-t border-line/50 hover:bg-surface-2">
                  <td className="px-3 py-1 text-muted">{fmtAge(t.at)}</td>
                  <td className={t.side === 'buy' ? 'text-up font-semibold' : 'text-down font-semibold'}>
                    {t.side}
                  </td>
                  <td className="text-right px-2">
                    <Price v={t.priceUsd} />
                  </td>
                  <td className="num text-right">{fmtUsd(t.volumeUsd)}</td>
                  <td className="num text-right">{fmtNum(t.tokenAmount, 2)}</td>
                  <td className="num text-right px-3">
                    {t.maker ? (
                      <ExtLink href={NETWORKS[network].explorer.tx(t.hash)}>{shortAddress(t.maker)}</ExtLink>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function SecurityPanel({
  network,
  token,
  bare,
}: {
  network: NetworkId;
  token: string;
  bare?: boolean;
}) {
  const q = useQuery({
    queryKey: ['security', network, token],
    queryFn: ({ signal }) =>
      get<Envelope<TokenSecurity | null>>(`/api/market/security/${network}/${token}`, signal),
    staleTime: 300_000,
  });
  const s = q.data?.data;
  const yn = (v: boolean | null, bad: boolean) =>
    v === null ? (
      <span className="text-muted">unknown</span>
    ) : (
      <span className={v === bad ? 'text-down font-semibold' : 'text-up'}>{v ? 'yes' : 'no'}</span>
    );
  const body = (
    <>
      {q.isLoading ? (
        <SkeletonRows rows={5} />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : !s ? (
        <Notice tone="warn">No scan available. Treat as unknown risk.</Notice>
      ) : (
        <div className="space-y-1 text-[12px]">
          <div className="flex justify-between">
            <span className="text-muted">Honeypot</span>
            {yn(s.honeypot, true)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Cannot sell all</span>
            {yn(s.cannotSell, true)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Buy / sell tax</span>
            <span className="num">
              {s.buyTaxPct?.toFixed(1) ?? '?'}% / {s.sellTaxPct?.toFixed(1) ?? '?'}%
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Mintable</span>
            {yn(s.isMintable, true)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Open source</span>
            {yn(s.isOpenSource, false)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Holders</span>
            <span className="num">{s.holderCount ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Top-10 holders</span>
            <span className="num">{s.top10HolderPct !== null ? `${s.top10HolderPct.toFixed(1)}%` : '—'}</span>
          </div>
          {s.isFreezable != null && (
            <div className="flex justify-between">
              <span className="text-muted">Freeze authority</span>
              {yn(s.isFreezable, true)}
            </div>
          )}
          {s.creatorPct != null && (
            <div className="flex justify-between">
              <span className="text-muted">Creator holds</span>
              <span className={cx('num', s.creatorPct > 10 && 'text-warn')}>{s.creatorPct.toFixed(1)}%</span>
            </div>
          )}
          {s.lpLockedPct != null && (
            <div className="flex justify-between">
              <span className="text-muted">LP locked / burned</span>
              <span className={cx('num', s.lpLockedPct < 50 && 'text-warn')}>
                {s.lpLockedPct.toFixed(0)}%
              </span>
            </div>
          )}
          {s.flags.length > 0 && (
            <div className="pt-1 flex flex-wrap gap-1">
              {s.flags.map((f) => (
                <Badge key={f} tone="down">
                  {f}
                </Badge>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted pt-1">
            Third-party heuristics. A clean scan does not mean a token is safe.
          </p>
        </div>
      )}
    </>
  );
  if (bare)
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[13px] font-semibold">Risk scan</h3>
          {q.data && <Freshness fetchedAt={q.data.fetchedAt} source="GoPlus" maxAgeMs={600_000} />}
        </div>
        {body}
      </div>
    );
  return (
    <Panel
      title="Risk scan"
      actions={q.data && <Freshness fetchedAt={q.data.fetchedAt} source="GoPlus" maxAgeMs={600_000} />}
    >
      {body}
    </Panel>
  );
}
