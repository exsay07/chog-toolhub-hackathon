import { useQuery } from '@tanstack/react-query';
import { FarmSummary } from './perps/FarmSummary';
import { Link } from 'react-router';
import {
  NETWORKS,
  fmtAge,
  fmtNum,
  fmtUsd,
  shortAddress,
  type NetworkId,
  type PnlSummary,
} from '@chog/shared';
import { get } from '../lib/api';
import { fetchSnipers } from '../lib/snipers';
import { fetchMints } from '../lib/mints';
import { useAuth } from '../lib/auth';
import { useNotify } from '../lib/notify';
import { useVault } from '../lib/vault/useVault';
import {
  Badge,
  Empty,
  ErrorState,
  ExtLink,
  NetworkBadge,
  Notice,
  Panel,
  SkeletonRows,
  Stat,
} from '../components/ui';

export interface JournalRow {
  id: string;
  network: NetworkId;
  hash: string;
  kind: string;
  source: string;
  side: string | null;
  token: string | null;
  tokenSymbol: string | null;
  state: string;
  quotedUsd: number | null;
  usdValue: number | null;
  feeUsd: number | null;
  tokenQty: number | null;
  error: string | null;
  createdAt: string;
}

export const stateTone = (s: string) =>
  s === 'confirmed'
    ? 'up'
    : ['failed', 'expired', 'replaced'].includes(s)
      ? 'down'
      : s === 'unknown'
        ? 'warn'
        : 'info';

export default function Dashboard() {
  const { me } = useAuth();
  const { vault, unlocked } = useVault();
  const { trackerFeed } = useNotify();
  const balances = useQuery({
    queryKey: ['balances'],
    queryFn: () =>
      get<{
        data: Array<{
          network: NetworkId;
          native: number | null;
          nativeUsd: number | null;
          tokens: Array<{ usd: number | null }>;
          error?: string;
        }>;
      }>('/api/portfolio/balances'),
    enabled: !!vault,
    refetchInterval: 60_000,
  });
  const pnl = useQuery({
    queryKey: ['pnl', 'all'],
    queryFn: () => get<{ summary: PnlSummary }>('/api/portfolio/pnl'),
  });
  const journal = useQuery({
    queryKey: ['journal'],
    queryFn: () => get<JournalRow[]>('/api/journal?limit=12'),
    refetchInterval: 15_000,
  });
  const tracked = useQuery({
    queryKey: ['tracked-wallets'],
    queryFn: () =>
      get<Array<{ id: string; enabled: boolean; copy: { enabled: boolean } | null }>>('/api/tracker/wallets'),
  });
  const snipers = useQuery({
    queryKey: ['automations', 'sniper'],
    queryFn: fetchSnipers,
  });
  const mints = useQuery({
    queryKey: ['automations', 'mint'],
    queryFn: fetchMints,
  });

  const rows = balances.data?.data ?? [];
  const known = rows.flatMap((r) => [r.nativeUsd, ...r.tokens.map((t) => t.usd)]);
  const total = known.every((v) => v === null) ? null : known.reduce<number>((s, v) => s + (v ?? 0), 0);
  const partial = known.some((v) => v === null);

  return (
    <div className="page-stagger p-4 grid grid-cols-12 gap-3 auto-rows-min">
      <div className="col-span-12 flex items-baseline justify-between">
        <div className="text-[12px] text-muted num">
          {shortAddress(me?.address ?? '', 6)} ·{' '}
          {me?.accessBasis === 'holder'
            ? `${me.session.nftBalance} Chog Genesis`
            : me?.accessBasis === 'judge'
              ? 'judge access'
              : 'dev access'}{' '}
          · ownership verified {fmtAge(Date.parse(me?.session.nftVerifiedAt ?? ''))} ago
        </div>
      </div>
      <div className="lux col-span-12 grid grid-cols-4 border border-line rounded-[var(--radius)] bg-surface divide-x divide-line">
        <div className="p-4">
          <Stat
            label="Portfolio value"
            value={total === null ? '—' : fmtUsd(total)}
            sub={partial ? 'Some assets unpriced' : 'Trading wallet, estimated'}
          />
        </div>
        <div className="p-4">
          <Stat
            label="Net realized PnL"
            value={pnl.data ? fmtUsd(pnl.data.summary.netRealizedUsd, { sign: true }) : '—'}
            tone={
              !pnl.data || pnl.data.summary.netRealizedUsd === 0
                ? undefined
                : pnl.data.summary.netRealizedUsd > 0
                  ? 'up'
                  : 'down'
            }
            sub={
              pnl.data?.summary.incomplete
                ? 'Incomplete — unpriced fills'
                : `${pnl.data?.summary.trades ?? 0} fills`
            }
          />
        </div>
        <div className="p-4">
          <Stat
            label="Tracked wallets"
            value={tracked.data?.filter((t) => t.enabled).length ?? '—'}
            sub={`${tracked.data?.filter((t) => t.copy?.enabled).length ?? 0} copy-trading`}
          />
        </div>
        <div className="p-4">
          <Stat
            label="Armed automations"
            value={
              (snipers.data?.filter((s) => s.status === 'armed').length ?? 0) +
              (mints.data?.filter((s) => s.status === 'armed').length ?? 0)
            }
            sub="Snipers and mints"
          />
        </div>
      </div>

      {vault === null && (
        <div className="col-span-12">
          <Notice tone="info">
            You have no trading wallet yet. Open Token Terminal → “Set up trading wallet” to create one
            locally. Nothing is funded automatically.
          </Notice>
        </div>
      )}
      {vault && !unlocked && (
        <div className="col-span-12">
          <Notice tone="warn">
            Trading wallet is locked — copy trading and snipers in “auto” mode will skip trades until you
            unlock.
          </Notice>
        </div>
      )}

      <Panel title="Balances" className="col-span-4">
        {!vault ? (
          <Empty title="No trading wallet" action={{ label: 'Set up in Token Terminal', to: '/terminal' }} />
        ) : balances.isLoading ? (
          <SkeletonRows rows={5} />
        ) : balances.isError ? (
          <ErrorState error={balances.error} retry={() => void balances.refetch()} />
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {rows.map((r) => (
                <tr key={r.network} className="border-b border-line/50 last:border-0">
                  <td className="py-1.5">
                    <NetworkBadge id={r.network} />
                  </td>
                  <td className="num text-right">
                    {r.error ? (
                      <span className="text-warn text-xs">{r.error}</span>
                    ) : (
                      `${fmtNum(r.native, 4)} ${NETWORKS[r.network].nativeSymbol}`
                    )}
                  </td>
                  <td className="num text-right text-muted">{fmtUsd(r.nativeUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Recent transactions"
        className="col-span-8"
        actions={
          <Link to="/portfolio" className="text-[11px] text-info">
            All →
          </Link>
        }
        dense
      >
        {journal.isLoading ? (
          <SkeletonRows />
        ) : journal.isError ? (
          <ErrorState error={journal.error} />
        ) : (journal.data?.length ?? 0) === 0 ? (
          <Empty
            title="No transactions yet"
            mood="sleep"
            action={{ label: 'Open Token Terminal', to: '/terminal' }}
          >
            Trades you place from the terminal appear here and are reconciled against the chain.
          </Empty>
        ) : (
          <TxTable rows={journal.data!} />
        )}
      </Panel>

      <FarmSummary className="col-span-12" linkToPerps />

      <Panel
        title="Tracker activity"
        className="col-span-12"
        dense
        actions={
          <Link to="/tracker" className="text-[11px] text-info">
            Tracker →
          </Link>
        }
      >
        {trackerFeed.length === 0 ? (
          <Empty
            title="No live events this session"
            mood="search"
            action={{ label: 'Track a wallet', to: '/tracker' }}
          >
            Events from wallets you track will stream here in real time.
          </Empty>
        ) : (
          <ul className="stagger divide-y divide-line/50 max-h-64 overflow-auto">
            {trackerFeed.slice(0, 30).map((e) => (
              <li key={`${e.id}:${e.walletId}`} className="flex items-center gap-3 px-3 h-8 text-[12px]">
                <span className="size-2 rounded-full" style={{ background: e.walletColor }} />
                <span className="font-semibold w-28 truncate">{e.walletLabel}</span>
                <Badge tone={e.kind === 'buy' ? 'up' : e.kind === 'sell' ? 'down' : 'neutral'}>
                  {e.kind.replace('_', ' ')}
                </Badge>
                <span className="truncate">{e.tokenSymbol ?? shortAddress(e.token ?? '')}</span>
                <NetworkBadge id={e.network} />
                <span className="num ml-auto">{e.estUsd !== null ? `~${fmtUsd(e.estUsd)}` : '—'}</span>
                <span className="text-muted w-10 text-right">{fmtAge(e.at)}</span>
                <ExtLink href={e.explorerUrl}>↗</ExtLink>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function TxTable({ rows }: { rows: JournalRow[] }) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-[12px]">
        <thead className="text-muted text-[11px] bg-surface sticky top-0">
          <tr>
            <th className="text-left px-3 py-1 font-semibold">Time</th>
            <th className="text-left font-semibold">Net</th>
            <th className="text-left font-semibold">Type</th>
            <th className="text-left font-semibold">Token</th>
            <th className="text-right font-semibold">Qty</th>
            <th className="text-right font-semibold">Value</th>
            <th className="text-right font-semibold">Fee</th>
            <th className="text-left font-semibold pl-3">Status</th>
            <th className="px-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line/50" title={r.error ?? undefined}>
              <td className="px-3 py-1 text-muted">{new Date(r.createdAt).toLocaleString()}</td>
              <td>
                <NetworkBadge id={r.network} />
              </td>
              <td>
                {r.kind === 'swap' ? (
                  <span className={r.side === 'buy' ? 'text-up font-semibold' : 'text-down font-semibold'}>
                    {r.side}
                  </span>
                ) : (
                  r.kind
                )}
                {r.source !== 'manual' && <span className="text-muted"> · {r.source}</span>}
              </td>
              <td>{r.tokenSymbol ?? shortAddress(r.token ?? '')}</td>
              <td className="num text-right">{fmtNum(r.tokenQty, 4)}</td>
              <td className="num text-right">
                {r.usdValue !== null ? (
                  fmtUsd(r.usdValue)
                ) : r.quotedUsd !== null ? (
                  <span className="text-muted">~{fmtUsd(r.quotedUsd)} quoted</span>
                ) : (
                  '—'
                )}
              </td>
              <td className="num text-right">{fmtUsd(r.feeUsd)}</td>
              <td className="pl-3">
                <Badge tone={stateTone(r.state) as 'up'}>{r.state}</Badge>
              </td>
              <td className="px-3">
                <ExtLink href={NETWORKS[r.network].explorer.tx(r.hash)}>↗</ExtLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
