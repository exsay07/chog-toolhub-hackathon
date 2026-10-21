import { useQueries, useQuery } from '@tanstack/react-query';
import { NETWORK_IDS, type NetworkId, type PairSummary } from '@chog/shared';
import { get } from '../../lib/api';
import { Copy, cx, SkeletonRows } from '../../components/ui';
import {
  ageShort,
  ChangeText,
  QuickBuy,
  readRecent,
  Socials,
  TokenAvatar,
  TxnsCell,
  usd,
  useTerminal,
} from './common';

/** Starred tokens and recently opened ones, with live numbers (Dexscreener, best pool per token). */

interface WatchItem {
  id: string;
  network: NetworkId;
  address: string;
  symbol: string | null;
}

export function Watchlist() {
  const watch = useQuery({ queryKey: ['watchlist'], queryFn: () => get<WatchItem[]>('/api/watchlist') });
  const starred = watch.data ?? [];
  const recent = readRecent().filter(
    (r) =>
      !starred.some((w) => w.network === r.network && w.address.toLowerCase() === r.address.toLowerCase()),
  );
  return (
    <div className="h-full min-h-0 overflow-auto">
      <Section
        title="Watchlist"
        items={starred}
        loading={watch.isLoading}
        empty="Star a token (☆ on its page) to keep it here."
      />
      <Section title="Recently opened" items={recent} loading={false} empty="Tokens you open show up here." />
    </div>
  );
}

function Section({
  title,
  items,
  loading,
  empty,
}: {
  title: string;
  items: Array<{ network: NetworkId; address: string }>;
  loading: boolean;
  empty: string;
}) {
  const { openToken } = useTerminal();
  const byNet = NETWORK_IDS.map((n) => ({
    n,
    tokens: items.filter((i) => i.network === n).map((i) => i.address),
  })).filter((g) => g.tokens.length > 0);
  const qs = useQueries({
    queries: byNet.map((g) => ({
      queryKey: ['watch-rows', g.n, g.tokens.join(',')],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        get<{ data: PairSummary[] }>(
          `/api/discover/tokens?network=${g.n}&tokens=${g.tokens.join(',')}`,
          signal,
        ),
      refetchInterval: 8000,
    })),
  });
  const rows = qs.flatMap((q) => q.data?.data ?? []);
  return (
    <section>
      <header className="flex items-center gap-2 px-4 h-10 border-b border-line sticky top-0 bg-bg z-10">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="text-[12px] text-muted num">{items.length}</span>
      </header>
      {loading || qs.some((q) => q.isLoading) ? (
        <div className="p-4">
          <SkeletonRows rows={4} />
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-6 text-[12px] text-muted">{empty}</div>
      ) : (
        <table className="w-full text-[13px] whitespace-nowrap">
          <tbody className="divide-y divide-line">
            {rows.map((p) => (
              <tr
                key={`${p.network}:${p.base.address}`}
                onClick={() => openToken(p.network, p.base.address, p.base.symbol, p.pairAddress)}
                className={cx('h-[56px] cursor-pointer hover:bg-surface-2')}
              >
                <td className="px-4">
                  <span className="flex items-center gap-3">
                    <TokenAvatar p={p} size={34} />
                    <span>
                      <span className="block font-semibold">{p.base.symbol}</span>
                      <span className="flex items-center gap-2 text-[11px] text-muted">
                        <span className="num">
                          {p.base.address.slice(0, 4)}…{p.base.address.slice(-4)}
                        </span>
                        <span onClick={(e) => e.stopPropagation()}>
                          <Copy text={p.base.address} />
                        </span>
                        <Socials p={p} />
                      </span>
                    </span>
                  </span>
                </td>
                <td className="px-3 text-right num text-text-2">{ageShort(p.createdAt)}</td>
                <td className="px-3 text-right">
                  <span className="text-[11px] text-muted">MC </span>
                  <span className="num">{usd(p.marketCapUsd ?? p.fdvUsd)}</span>
                </td>
                <td className="px-3 text-right">
                  <span className="text-[11px] text-muted">L </span>
                  <span className="num text-text-2">{usd(p.liquidityUsd)}</span>
                </td>
                <td className="px-3 text-right">
                  <span className="text-[11px] text-muted">V 24h </span>
                  <span className="num">{usd(p.volume.h24)}</span>
                </td>
                <td className="px-3 text-right">
                  <TxnsCell t={p.txns.h24} />
                </td>
                <td className="px-3 text-right">
                  <ChangeText v={p.change.h1} /> <span className="text-[11px] text-muted">1h</span>
                </td>
                <td className="px-3 text-right">
                  <ChangeText v={p.change.h24} /> <span className="text-[11px] text-muted">24h</span>
                </td>
                <td className="px-4 text-right">
                  <QuickBuy p={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
