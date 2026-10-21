import { useEffect, useMemo, useState } from 'react';
import { Ticker } from '../../components/Ticker';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NETWORKS, fmtInt, shortAddress, type NetworkId, type PairSummary } from '@chog/shared';
import { Star } from 'lucide-react';
import { del, get, post, type Envelope } from '../../lib/api';
import { usePairSubscription, useWsMessages } from '../../lib/ws';
import { useTick } from '../../lib/notify';
import { OrderPanel } from '../../components/OrderPanel';
import {
  Badge,
  Copy,
  cx,
  Empty,
  ErrorState,
  ExtLink,
  Freshness,
  Panel,
  Price,
  Skeleton,
  Tabs,
} from '../../components/ui';
import { ChartArea, PoolsPanel, SecurityPanel } from './panels';
import { ageShort, ChangeText, QuickBuy, Socials, TokenAvatar, usd } from './common';

/**
 * Token page (Axiom-style): one stats strip across the top, chart taking the width, and the trade
 * panel + risk scan on the right. Price/stats stream over the WebSocket every few seconds.
 */

interface WatchItem {
  id: string;
  network: NetworkId;
  address: string;
  symbol: string | null;
}

export function TokenPage({
  network,
  token,
  initialPair,
}: {
  network: NetworkId;
  token: string;
  initialPair: string | null;
}) {
  useTick(15_000);
  const qc = useQueryClient();
  const pairs = useQuery({
    queryKey: ['tokenPairs', network, token],
    queryFn: ({ signal }) => get<Envelope<PairSummary[]>>(`/api/market/token/${network}/${token}`, signal),
    refetchInterval: 60_000,
  });
  const [pairAddr, setPairAddr] = useState<string | null>(initialPair);
  const pair = useMemo(() => {
    const list = pairs.data?.data ?? [];
    return (
      list.find((p) => p.pairAddress.toLowerCase() === pairAddr?.toLowerCase()) ??
      list.find((p) => p.base.address.toLowerCase() === token.toLowerCase()) ??
      list[0] ??
      null
    );
  }, [pairs.data, pairAddr, token]);
  const [live, setLive] = useState<PairSummary | null>(null);
  usePairSubscription(network, pair?.pairAddress);
  useWsMessages(
    (m) => {
      if (m.t === 'pair' && pair && m.pair.pairAddress === pair.pairAddress) setLive(m.pair);
    },
    [pair?.pairAddress],
  );
  useEffect(() => setLive(null), [pair?.pairAddress]);
  const p = live ?? pair;
  const [bottom, setBottom] = useState<'pools' | 'risk'>('pools');

  const watch = useQuery({ queryKey: ['watchlist'], queryFn: () => get<WatchItem[]>('/api/watchlist') });
  const starred = watch.data?.find(
    (w) => w.network === network && w.address.toLowerCase() === token.toLowerCase(),
  );
  const toggleStar = useMutation({
    mutationFn: () =>
      starred
        ? del(`/api/watchlist/${starred.id}`)
        : post('/api/watchlist', { network, address: token, symbol: p?.base.symbol }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  if (pairs.isLoading)
    return (
      <div className="p-3 space-y-3">
        <Skeleton className="h-14" />
        <Skeleton className="h-[560px]" />
      </div>
    );
  if (pairs.isError) return <ErrorState error={pairs.error} retry={() => void pairs.refetch()} />;
  if (!p)
    return (
      <div className="p-6">
        <Empty title="No liquidity pairs found" mood="search">
          Dexscreener has no pairs for {shortAddress(token)} on {NETWORKS[network].name}. It may be very new,
          unlisted, or not a token.
        </Empty>
      </div>
    );

  const all = pairs.data?.data ?? [];
  const isBase = p.base.address.toLowerCase() === token.toLowerCase();
  const meta = isBase ? p : (all.find((x) => x.base.address.toLowerCase() === token.toLowerCase()) ?? null);
  const tokRef = isBase ? p.base : p.quote;
  const priceUsd = meta
    ? meta.priceUsd
    : p.priceUsd !== null && p.priceNative
      ? p.priceUsd / p.priceNative
      : null;
  const totalLiq = all.reduce((acc, x) => acc + (x.liquidityUsd ?? 0), 0);
  const totalVol = all.reduce((acc, x) => acc + (x.volume.h24 ?? 0), 0);
  const row: PairSummary = meta ?? { ...p, base: tokRef };

  const stat = (label: string, value: React.ReactNode, title?: string) => (
    <div className="px-4 first:pl-0 min-w-0 shrink-0" title={title}>
      <div className="text-[11px] text-muted whitespace-nowrap">{label}</div>
      <div className="text-[13px] mt-0.5 num text-text whitespace-nowrap">
        {typeof value === 'string' ? <Ticker text={value} /> : value}
      </div>
    </div>
  );
  const t24 = p.txns.h24;

  return (
    <div className="h-full min-h-0 grid grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col min-w-0 min-h-0 overflow-y-auto border-r border-line">
        {/* Identity + price */}
        <div className="flex items-center gap-3 px-4 pt-3 pb-2 shrink-0">
          <TokenAvatar p={row} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-[20px] font-semibold leading-none">{tokRef.symbol}</h1>
              <span className="text-[13px] text-muted truncate">{tokRef.name}</span>
              <button
                onClick={() => toggleStar.mutate()}
                className={starred ? 'text-accent' : 'text-muted hover:text-text'}
                aria-label="Toggle watchlist"
                title={starred ? 'Remove from watchlist' : 'Add to watchlist'}
              >
                <Star className={cx('size-4', starred && 'fill-current')} />
              </button>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted mt-1.5 whitespace-nowrap">
              <span className="inline-flex items-center gap-1">
                <span className="num">{shortAddress(token, 5)}</span>
                <Copy text={token} />
              </span>
              <span className="num" title="Age of the selected pool">
                {ageShort(p.createdAt)}
              </span>
              <Socials p={row} />
              <ExtLink href={NETWORKS[network].explorer.address(token)}>
                {NETWORKS[network].explorer.name}
              </ExtLink>
              {p.url && <ExtLink href={p.url}>Dexscreener</ExtLink>}
            </div>
          </div>
          <div className="text-right shrink-0">
            <Price v={priceUsd} live className="text-[24px] font-semibold block leading-none" />
            <div className="mt-1.5 text-[12px] flex items-center justify-end gap-2">
              <ChangeText v={meta?.change.h24} />
              <span className="text-muted">24h</span>
              <Freshness fetchedAt={p.fetchedAt} source="Dexscreener" maxAgeMs={30_000} />
            </div>
          </div>
        </div>
        {/* Stats strip */}
        <div className="flex items-center divide-x divide-line px-4 pb-3 border-b border-line shrink-0 overflow-x-auto">
          {stat('Market cap', usd(meta?.marketCapUsd ?? meta?.fdvUsd), 'Provider estimate')}
          {stat('Liquidity', usd(totalLiq), 'Sum over all pools')}
          {stat('Volume 24h', usd(totalVol), 'Sum over all pools')}
          {stat('5m', <ChangeText v={meta?.change.m5} />)}
          {stat('1h', <ChangeText v={meta?.change.h1} />)}
          {stat('6h', <ChangeText v={meta?.change.h6} />)}
          {stat(
            'TXNS 24h',
            t24 ? (
              <span>
                {fmtInt(t24.buys + t24.sells)}{' '}
                <span className="text-[11px]">
                  (<span className="text-up">{fmtInt(t24.buys)}</span>/
                  <span className="text-down">{fmtInt(t24.sells)}</span>)
                </span>
              </span>
            ) : (
              '—'
            ),
          )}
          {stat('FDV', usd(meta?.fdvUsd), 'Fully diluted valuation')}
          {stat('Pools', all.length)}
        </div>

        <div className="p-2 flex flex-col gap-2">
          <ChartArea network={network} pool={p.pairAddress} livePrice={isBase ? p.priceUsd : null} />
          <Panel
            title={bottom === 'pools' ? `Pools (${all.length})` : 'Risk scan'}
            dense
            actions={
              <Tabs
                value={bottom}
                onChange={setBottom}
                items={[
                  { id: 'pools', label: 'POOLS' },
                  { id: 'risk', label: 'RISK' },
                ]}
              />
            }
          >
            {bottom === 'pools' ? (
              <PoolsPanel pairs={all} selected={p.pairAddress} token={token} onSelect={setPairAddr} bare />
            ) : (
              <SecurityPanel network={network} token={token} bare />
            )}
          </Panel>
        </div>
      </div>

      {/* Right rail: trade first, then quick actions + risk */}
      <aside className="min-h-0 overflow-y-auto bg-surface/40">
        <div className="p-4 border-b border-line">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold">Trade {tokRef.symbol}</h2>
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              Quick <QuickBuy p={row} compact />
            </span>
          </div>
          <OrderPanel
            network={network}
            token={token}
            symbol={tokRef.symbol}
            liquidityUsd={p.liquidityUsd}
            priceUsd={priceUsd}
          />
        </div>
        <div className="p-4 border-b border-line">
          <SecurityPanel network={network} token={token} bare />
        </div>
        <div className="p-4 text-[12px] space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted">Pool</span>
            <span className="truncate ml-3">
              {p.dex} · {p.base.symbol}/{p.quote.symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Pool liquidity</span>
            <span className="num">{usd(p.liquidityUsd)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">FDV</span>
            <span className="num">{usd(meta?.fdvUsd)}</span>
          </div>
          {!isBase && (
            <div className="pt-1">
              <Badge tone="warn">token is the quote side of this pool</Badge>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
