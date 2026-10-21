import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  NETWORKS,
  fmtNum,
  fmtUsd,
  shortAddress,
  type DailyPnl,
  type NetworkId,
  type PnlSummary,
} from '@chog/shared';
import { get } from '../lib/api';
import { useSettings } from '../lib/settings';
import { useVault } from '../lib/vault/useVault';
import {
  Button,
  Copy,
  cx,
  Empty,
  ErrorState,
  ExtLink,
  Modal,
  NetworkBadge,
  Notice,
  Panel,
  SkeletonRows,
  Stat,
  Tabs,
} from '../components/ui';
import { TxTable, type JournalRow } from './Dashboard';
import { PnlCardBuilder } from '../components/PnlCard';

interface Position {
  key: string;
  network: NetworkId;
  token: string;
  symbol?: string;
  qty: number;
  costUsd: number;
  priced: boolean;
  realizedUsd: number | null;
  untrackedQty: number;
  priceUsd: number | null;
  valueUsd: number | null;
  unrealizedUsd: number | null;
}
interface PnlResp {
  timeZone: string;
  days: DailyPnl[];
  summary: PnlSummary;
  positions: Position[];
  methodology: string;
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export default function Portfolio() {
  const { settings } = useSettings();
  const { vault } = useVault();
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [range, setRange] = useState<'month' | '30d' | 'all'>('month');
  const [card, setCard] = useState(false);
  const [from, to] = useMemo(() => {
    if (range === 'all') return [0, Date.now()];
    if (range === '30d') return [Date.now() - 30 * 86_400_000, Date.now()];
    // Month bounds padded by a day; exact day membership uses the user's zone server-side.
    return [Date.UTC(ym.y, ym.m, 1) - 86_400_000, Date.UTC(ym.y, ym.m + 1, 1) + 86_400_000];
  }, [range, ym]);
  const pnl = useQuery({
    queryKey: ['pnl', from, to],
    queryFn: () => get<PnlResp>(`/api/portfolio/pnl?from=${from}&to=${to}`),
    refetchInterval: 60_000,
  });
  const journal = useQuery({
    queryKey: ['journal', 'all'],
    queryFn: () => get<JournalRow[]>('/api/journal?limit=200'),
    refetchInterval: 15_000,
  });
  const balances = useQuery({
    queryKey: ['balances'],
    queryFn: () =>
      get<{
        data: Array<{
          network: NetworkId;
          address: string;
          native: number | null;
          nativeUsd: number | null;
          tokens: Array<{ token: string; symbol: string; amount: number; usd: number | null }>;
          error?: string;
        }>;
      }>('/api/portfolio/balances'),
    enabled: !!vault,
  });

  const days = useMemo(() => {
    const all = pnl.data?.days ?? [];
    if (range !== 'month') return all;
    const prefix = `${ym.y}-${String(ym.m + 1).padStart(2, '0')}`;
    return all.filter((d) => d.day.startsWith(prefix));
  }, [pnl.data, range, ym]);
  const sum = useMemo(() => {
    let net = 0,
      fees = 0,
      trades = 0,
      win = 0,
      loss = 0,
      inc = false;
    for (const d of days) {
      net += d.netRealizedUsd;
      fees += d.feesUsd;
      trades += d.trades;
      if (d.netRealizedUsd > 0) win++;
      if (d.netRealizedUsd < 0) loss++;
      inc ||= d.incomplete;
    }
    return { net, fees, trades, win, loss, inc };
  }, [days]);
  const deployed = useMemo(() => {
    const rows = (journal.data ?? []).filter(
      (r) =>
        r.kind === 'swap' &&
        r.side === 'buy' &&
        r.state === 'confirmed' &&
        Date.parse(r.createdAt) >= from &&
        Date.parse(r.createdAt) <= to,
    );
    const v = rows.reduce((s, r) => s + (r.usdValue ?? 0), 0);
    return v > 0 ? v : null;
  }, [journal.data, from, to]);

  const label =
    range === 'month'
      ? new Date(ym.y, ym.m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
      : range === '30d'
        ? 'Last 30 days'
        : 'All time';
  const open = (pnl.data?.positions ?? []).filter((p) => p.qty > 0);
  const unrealized = open.every((p) => p.unrealizedUsd === null)
    ? null
    : open.reduce((s, p) => s + (p.unrealizedUsd ?? 0), 0);

  return (
    <div className="page-stagger p-4 grid grid-cols-12 gap-3 auto-rows-min">
      <Panel className="col-span-12" dense>
        <div className="flex items-center gap-4 p-4">
          <div className="min-w-0">
            <div className="text-[12px] text-muted">Trading wallet</div>
            {vault ? (
              <div className="text-[13px] text-text num flex gap-4 mt-0.5">
                <span>
                  EVM {shortAddress(vault.evmAddress, 6)} <Copy text={vault.evmAddress} />
                </span>
                <span>
                  SOL {shortAddress(vault.solanaAddress, 6)} <Copy text={vault.solanaAddress} />
                </span>
              </div>
            ) : (
              <div className="text-xs text-muted">No trading wallet on this device.</div>
            )}
          </div>
          <div className="ml-auto grid grid-cols-4 gap-6">
            <Stat
              label={`Net realized · ${label}`}
              value={fmtUsd(sum.net, { sign: true })}
              tone={sum.net > 0 ? 'up' : sum.net < 0 ? 'down' : undefined}
              sub={sum.inc ? 'incomplete — some fills unpriced' : 'after fees'}
            />
            <Stat
              label="Unrealized (open)"
              value={unrealized === null ? '—' : fmtUsd(unrealized, { sign: true })}
              tone={unrealized === null || unrealized === 0 ? undefined : unrealized > 0 ? 'up' : 'down'}
              sub="at current est. prices"
            />
            <Stat label="Fees paid" value={fmtUsd(sum.fees)} sub="network gas" />
            <Stat label="Fills" value={sum.trades} sub={`${sum.win} green / ${sum.loss} red days`} />
          </div>
        </div>
      </Panel>

      <Panel
        title="PnL calendar"
        className="col-span-7"
        actions={
          <>
            <Tabs
              value={range}
              onChange={setRange}
              items={[
                { id: 'month', label: 'Month' },
                { id: '30d', label: '30d' },
                { id: 'all', label: 'All' },
              ]}
            />
            <Button size="sm" variant="primary" onClick={() => setCard(true)} disabled={!pnl.data}>
              Share card
            </Button>
          </>
        }
      >
        {pnl.isLoading ? (
          <SkeletonRows rows={8} />
        ) : pnl.isError ? (
          <ErrorState error={pnl.error} retry={() => void pnl.refetch()} />
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setYm(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}
                aria-label="Previous month"
              >
                ‹
              </Button>
              <span className="font-display font-semibold w-40 text-center">
                {new Date(ym.y, ym.m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setYm(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }))}
                aria-label="Next month"
              >
                ›
              </Button>
              <span className="ml-auto text-[11px] text-muted">Day boundaries: {settings.timeZone}</span>
            </div>
            <Calendar y={ym.y} m={ym.m} days={pnl.data!.days} />
            <details className="mt-2 text-[11px] text-muted">
              <summary className="cursor-pointer">How PnL is calculated</summary>
              <p className="mt-1">{pnl.data!.methodology}</p>
            </details>
          </>
        )}
      </Panel>

      <Panel title="Balances" className="col-span-5" dense>
        {!vault ? (
          <Empty title="No trading wallet" action={{ label: 'Set up in Token Terminal', to: '/terminal' }} />
        ) : balances.isLoading ? (
          <SkeletonRows />
        ) : balances.isError ? (
          <ErrorState error={balances.error} />
        ) : (
          <table className="w-full text-[12px]">
            <tbody>
              {balances.data!.data.flatMap((b) => [
                <tr key={b.network} className="border-t border-line/50 bg-surface-2/40">
                  <td className="px-3 py-1.5">
                    <NetworkBadge id={b.network} />
                  </td>
                  <td className="num text-right">
                    {b.error ? (
                      <span className="text-warn">{b.error}</span>
                    ) : (
                      `${fmtNum(b.native, 5)} ${NETWORKS[b.network].nativeSymbol}`
                    )}
                  </td>
                  <td className="num text-right px-3">{fmtUsd(b.nativeUsd)}</td>
                </tr>,
                ...b.tokens.map((t) => (
                  <tr key={`${b.network}:${t.token}`} className="border-t border-line/30">
                    <td className="px-3 pl-8 text-muted">{t.symbol || shortAddress(t.token)}</td>
                    <td className="num text-right">{fmtNum(t.amount, 4)}</td>
                    <td className="num text-right px-3">
                      {t.usd === null ? <span className="text-muted">unpriced</span> : fmtUsd(t.usd)}
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Open positions" className="col-span-12" dense>
        {open.length === 0 ? (
          <Empty title="No open positions" mood="sleep" action={{ label: 'Find a token', to: '/terminal' }}>
            Positions come from reconciled swaps made with your trading wallet.
          </Empty>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="text-muted text-[11px]">
              <tr>
                <th className="text-left px-3 py-1 font-semibold">Token</th>
                <th className="text-left font-semibold">Net</th>
                <th className="text-right font-semibold">Qty</th>
                <th className="text-right font-semibold">Avg cost</th>
                <th className="text-right font-semibold">Price</th>
                <th className="text-right font-semibold">Value</th>
                <th className="text-right font-semibold">Unrealized</th>
                <th className="text-right font-semibold px-3">Realized</th>
              </tr>
            </thead>
            <tbody>
              {open.map((p) => (
                <tr key={p.key} className="border-t border-line/50">
                  <td className="px-3 py-1 font-semibold">
                    <ExtLink href={NETWORKS[p.network].explorer.address(p.token)}>
                      {p.symbol ?? shortAddress(p.token)}
                    </ExtLink>
                  </td>
                  <td>
                    <NetworkBadge id={p.network} />
                  </td>
                  <td className="num text-right">{fmtNum(p.qty, 4)}</td>
                  <td className="num text-right">{p.priced && p.qty ? fmtUsd(p.costUsd / p.qty) : '—'}</td>
                  <td className="num text-right">{fmtUsd(p.priceUsd)}</td>
                  <td className="num text-right">{fmtUsd(p.valueUsd)}</td>
                  <td className={cx('num text-right', (p.unrealizedUsd ?? 0) >= 0 ? 'text-up' : 'text-down')}>
                    {p.unrealizedUsd === null ? '—' : fmtUsd(p.unrealizedUsd, { sign: true })}
                  </td>
                  <td className="num text-right px-3">
                    {p.realizedUsd === null ? 'incomplete' : fmtUsd(p.realizedUsd, { sign: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Transaction history" className="col-span-12" dense>
        <div className="px-3 py-1.5 text-[11px] text-muted border-b border-line">
          Status is determined by the server from chain data (receipt / signature status), never from the
          browser. “Submitted” is not success.
        </div>
        {journal.isLoading ? (
          <SkeletonRows />
        ) : journal.isError ? (
          <ErrorState error={journal.error} />
        ) : (journal.data?.length ?? 0) === 0 ? (
          <Empty title="No transactions" mood="sleep" />
        ) : (
          <TxTable rows={journal.data!} />
        )}
      </Panel>

      <Modal open={card} onClose={() => setCard(false)} title="PnL card" width={980}>
        {sum.inc && (
          <Notice tone="warn">Some fills in this range have unknown USD value; the card states this.</Notice>
        )}
        <PnlCardBuilder
          data={{
            kind: 'period',
            from:
              range === 'all'
                ? 'all time'
                : new Date(Math.max(from, 0) + (range === 'month' ? 86_400_000 : 0))
                    .toISOString()
                    .slice(0, 10),
            to: new Date(range === 'month' ? to - 2 * 86_400_000 : to).toISOString().slice(0, 10),
            netUsd: sum.net,
            pct: deployed ? (sum.net / deployed) * 100 : null,
            trades: sum.trades,
            winDays: sum.win,
            lossDays: sum.loss,
            address: vault?.evmAddress ?? '',
            incomplete: sum.inc,
          }}
        />
      </Modal>
    </div>
  );
}

function Calendar({ y, m, days }: { y: number; m: number; days: DailyPnl[] }) {
  const map = new Map(days.map((d) => [d.day, d]));
  const first = new Date(y, m, 1).getDay(); // 0 = Sunday
  const offset = (first + 6) % 7; // Monday-first grid
  const count = new Date(y, m + 1, 0).getDate();
  const max = Math.max(
    1,
    ...days
      .filter((d) => d.day.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`))
      .map((d) => Math.abs(d.netRealizedUsd)),
  );
  const cells = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: count }, (_, i) => i + 1),
  ];
  return (
    <div className="grid grid-cols-7 gap-1">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
        <div key={d} className="text-[10px] text-muted text-center font-semibold">
          {d}
        </div>
      ))}
      {cells.map((d, i) => {
        if (d === null) return <div key={`e${i}`} />;
        const k = iso(y, m, d);
        const p = map.get(k);
        const v = p?.netRealizedUsd ?? 0;
        const alpha = p ? 0.12 + 0.55 * Math.min(1, Math.abs(v) / max) : 0;
        return (
          <div
            key={k}
            className="h-16 rounded-[var(--radius-sm)] border border-line p-1.5 flex flex-col"
            style={
              p
                ? {
                    background: `color-mix(in oklab, ${v >= 0 ? 'var(--up)' : 'var(--down)'} ${Math.round(alpha * 100)}%, transparent)`,
                  }
                : undefined
            }
            title={
              p
                ? `${k}: realized ${fmtUsd(p.realizedUsd)} · fees ${fmtUsd(p.feesUsd)} · ${p.trades} fills${p.incomplete ? ' · incomplete' : ''}`
                : k
            }
          >
            <span className="text-[10px] text-muted">{d}</span>
            {p && (
              <span className={cx('num text-[12px] font-semibold mt-auto', v >= 0 ? 'text-up' : 'text-down')}>
                {fmtUsd(v, { sign: true, compact: true })}
                {p.incomplete && <span className="text-warn">*</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
