import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  NETWORKS,
  NETWORK_IDS,
  canTrade,
  fmtAge,
  fmtUsd,
  shortAddress,
  zSniperConfig,
  type NetworkId,
  type NewPool,
  type SniperConfig,
} from '@chog/shared';
import { del, get, patch, post, put, type Envelope } from '../lib/api';
import { useNewPoolsSubscription, useWsMessages } from '../lib/ws';
import { useTick } from '../lib/notify';
import { loadEntries, poolMatches, saveEntries, type Entry } from '../lib/automation/sniper';
import { fetchSnipers, type SniperRow } from '../lib/snipers';
import { WalletPicker } from '../components/WalletPicker';
import {
  Badge,
  Button,
  cx,
  Empty,
  ErrorState,
  Field,
  Freshness,
  Input,
  Modal,
  NetworkBadge,
  Notice,
  Panel,
  Select,
  SkeletonRows,
  Tabs,
  Toggle,
  Price,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { useVault } from '../lib/vault/useVault';
import { ask } from '../components/Confirm';

const DEFAULT: SniperConfig = {
  name: 'New sniper',
  network: 'monad',
  enabled: true,
  mode: 'alert',
  entryAmountNative: 1,
  slippageBps: 500,
  priorityFee: 'medium',
  deadlineSec: 60,
  maxTradeUsd: 25,
  filters: {
    minLiquidityUsd: 5000,
    maxLiquidityUsd: null,
    minVolume5mUsd: 0,
    maxPoolAgeMin: 30,
    quoteSymbols: [],
    nameIncludes: '',
    requireSecurityScan: true,
    maxBuyTaxPct: 5,
    maxSellTaxPct: 5,
    minFdvUsd: 0,
    maxFdvUsd: null,
    minBuys5m: 0,
    dexIncludes: '',
  },
  antiRug: {
    blockMintable: true,
    blockFreezable: true,
    blockOwnerPowers: true,
    requireOpenSource: false,
    maxTop10Pct: 60,
    maxCreatorPct: 10,
    minLpLockedPct: null,
    blacklist: [],
    devSellExitPct: 25,
  },
  limits: { maxBuysPerHour: 5, maxOpenPositions: 5 },
  wallets: [],
  exit: {
    takeProfitPct: null,
    stopLossPct: 40,
    ladder: [
      { atPct: 100, sellPct: 50 },
      { atPct: 300, sellPct: 25 },
    ],
    trailingStopPct: 30,
  },
};

export default function Sniper() {
  useTick(10_000);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { unlocked } = useVault();
  const list = useQuery({
    queryKey: ['automations', 'sniper'],
    queryFn: fetchSnipers,
  });
  const logs = useQuery({
    queryKey: ['logs', 'sniper'],
    queryFn: () =>
      get<Array<{ id: number; level: string; message: string; at: string }>>(
        '/api/automation-logs?kind=sniper',
      ),
    refetchInterval: 10_000,
  });
  const [edit, setEdit] = useState<SniperRow | 'new' | null>(null);
  const [feedNet, setFeedNet] = useState<NetworkId>('monad');
  const [bottom, setBottom] = useState<'positions' | 'log'>('positions');
  const status = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) =>
      patch(`/api/automations/sniper/${id}/status`, { status: s }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['automations', 'sniper'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/automations/sniper/${id}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['automations', 'sniper'] }),
  });

  return (
    <div className="h-full grid grid-cols-[420px_1fr] grid-rows-[1fr_220px] gap-3 p-4 min-h-0">
      <Panel
        title="Snipers"
        className="row-span-2"
        dense
        actions={
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            <Icon name="plus" size={13} /> New
          </Button>
        }
      >
        <div className="p-3 border-b border-line">
          <Notice tone="warn">
            Discovery: GeckoTerminal new-pool feed (polled server-side, ~30 s cadence on the free tier) — not
            mempool-level. “Auto” mode buys only from this open tab while your vault is unlocked, after risk
            checks and simulation. Sniping new tokens is extremely risky; most new tokens go to zero and
            scanners miss many scams.
          </Notice>
        </div>
        {list.isLoading ? (
          <SkeletonRows />
        ) : list.isError ? (
          <ErrorState error={list.error} />
        ) : (list.data?.length ?? 0) === 0 ? (
          <Empty title="No snipers">
            Create one to get alerts (or auto-buys) for new pools matching your filters.
          </Empty>
        ) : (
          <ul>
            {list.data!.map((s) => (
              <li key={s.id} className="px-3 py-2.5 border-b border-line/60">
                <div className="flex items-center gap-2">
                  <span className="font-semibold truncate">{s.data.name}</span>
                  <NetworkBadge id={s.data.network} />
                  <Badge tone={s.data.mode === 'auto' ? 'accent' : 'neutral'}>{s.data.mode}</Badge>
                  <Badge tone={s.status === 'armed' ? 'up' : s.status === 'stopped' ? 'down' : 'neutral'}>
                    {s.status}
                  </Badge>
                  <span className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant={s.status === 'armed' ? 'secondary' : 'primary'}
                      onClick={() => status.mutate({ id: s.id, s: s.status === 'armed' ? 'idle' : 'armed' })}
                      disabled={s.data.mode === 'auto' && !canTrade(s.data.network)}
                    >
                      {s.status === 'armed' ? 'Disarm' : 'Arm'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () =>
                        (await ask('Delete this sniper?', { confirmLabel: 'Delete' })) && remove.mutate(s.id)
                      }
                      aria-label="Delete"
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  </span>
                </div>
                <div className="text-[11px] text-muted mt-1">
                  {s.data.mode === 'auto'
                    ? `${s.data.entryAmountNative} ${NETWORKS[s.data.network].nativeSymbol} · max $${s.data.maxTradeUsd} · slip ${s.data.slippageBps / 100}%`
                    : 'alerts only'}{' '}
                  · liq ≥ ${s.data.filters.minLiquidityUsd} · age ≤ {s.data.filters.maxPoolAgeMin}m
                  {s.data.exit.ladder.length > 0 &&
                    ` · ladder ${s.data.exit.ladder.map((l) => `+${l.atPct}%:${l.sellPct}%`).join(' ')}`}
                  {s.data.exit.takeProfitPct && ` · TP +${s.data.exit.takeProfitPct}%`}
                  {s.data.exit.stopLossPct && ` · SL −${s.data.exit.stopLossPct}%`}
                  {s.data.exit.trailingStopPct && ` · trail ${s.data.exit.trailingStopPct}%`}
                  {s.data.mode === 'auto' &&
                    s.data.antiRug.devSellExitPct &&
                    ` · dev-sell ${s.data.antiRug.devSellExitPct}%`}
                </div>
                {s.data.mode === 'auto' && s.status === 'armed' && !unlocked && (
                  <div className="text-[11px] text-warn mt-1">Vault locked — auto-buys will be skipped.</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <NewPoolsFeed
        network={feedNet}
        setNetwork={setFeedNet}
        snipers={list.data ?? []}
        onOpen={(n, t) => nav(`/terminal/${n}/${t}`)}
      />

      <Panel
        title={bottom === 'positions' ? 'Positions' : 'Sniper log'}
        dense
        actions={
          <Tabs
            value={bottom}
            onChange={setBottom}
            items={[
              { id: 'positions', label: 'POSITIONS' },
              { id: 'log', label: 'LOG' },
            ]}
          />
        }
      >
        {bottom === 'positions' ? (
          <Positions snipers={list.data ?? []} onOpen={(n, t) => nav(`/terminal/${n}/${t}`)} />
        ) : (logs.data?.length ?? 0) === 0 ? (
          <Empty title="No sniper activity yet" mood="sleep" />
        ) : (
          <ul className="overflow-auto h-full text-[12px] num">
            {logs.data!.map((l) => (
              <li
                key={l.id}
                className={cx(
                  'px-3 py-0.5 border-b border-line/40',
                  l.level === 'error' && 'text-down',
                  l.level === 'warn' && 'text-warn',
                )}
              >
                <span className="text-muted">{new Date(l.at).toLocaleTimeString()} </span>
                {l.message}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {edit && <SniperForm row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function NewPoolsFeed({
  network,
  setNetwork,
  snipers,
  onOpen,
}: {
  network: NetworkId;
  setNetwork: (n: NetworkId) => void;
  snipers: SniperRow[];
  onOpen: (n: NetworkId, t: string) => void;
}) {
  const q = useQuery({
    queryKey: ['new-pools', network],
    queryFn: () => get<Envelope<NewPool[]>>(`/api/market/new-pools/${network}`),
    refetchInterval: 60_000,
  });
  const [live, setLive] = useState<NewPool[]>([]);
  useNewPoolsSubscription(network);
  useWsMessages(
    (m) => {
      if (m.t === 'newPool' && m.pool.network === network) setLive((p) => [m.pool, ...p].slice(0, 50));
    },
    [network],
  );
  const rows = [...live, ...(q.data?.data ?? [])]
    .filter((p, i, a) => a.findIndex((x) => x.poolAddress === p.poolAddress) === i)
    .slice(0, 100);
  const nets = NETWORK_IDS.map((n) => ({ id: n, label: NETWORKS[n].shortName }));
  return (
    <Panel
      title="New pools"
      dense
      actions={
        <>
          {q.data && (
            <Freshness
              fetchedAt={q.data.fetchedAt}
              stale={q.data.stale}
              source="GeckoTerminal"
              maxAgeMs={120_000}
            />
          )}
          <Tabs value={network} onChange={setNetwork} items={nets} />
        </>
      }
    >
      {q.isLoading ? (
        <SkeletonRows rows={10} />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <Empty title="No new pools reported" mood="search" />
      ) : (
        <div className="overflow-auto h-full">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-surface text-muted text-[11px]">
              <tr>
                <th className="text-left px-3 py-1 font-semibold">Pair</th>
                <th className="text-left font-semibold">DEX</th>
                <th className="text-right font-semibold">Price</th>
                <th className="text-right font-semibold">Liquidity</th>
                <th className="text-right font-semibold">FDV</th>
                <th className="text-right font-semibold">Vol 5m</th>
                <th className="text-right font-semibold">B/S 5m</th>
                <th className="text-right font-semibold">Age</th>
                <th className="text-left font-semibold pl-3">Matches</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const matching = snipers.filter(
                  (s) => s.data.network === network && poolMatches(p, s.data).length === 0,
                );
                return (
                  <tr
                    key={p.poolAddress}
                    className={cx(
                      'border-t border-line/50 hover:bg-surface-2 cursor-pointer',
                      live.includes(p) && 'flash-up',
                    )}
                    onClick={() => onOpen(p.network, p.baseToken)}
                  >
                    <td className="px-3 py-1 font-semibold">
                      {p.baseSymbol}
                      <span className="text-muted font-normal">/{p.quoteSymbol}</span>
                    </td>
                    <td className="text-muted truncate max-w-32">{p.dex}</td>
                    <td className="text-right">
                      <Price v={p.priceUsd} />
                    </td>
                    <td className="num text-right">{fmtUsd(p.liquidityUsd, { compact: true })}</td>
                    <td className="num text-right text-muted">{fmtUsd(p.fdvUsd, { compact: true })}</td>
                    <td className="num text-right">{fmtUsd(p.volume5mUsd, { compact: true })}</td>
                    <td className="num text-right">
                      {p.buys5m ?? '—'}/{p.sells5m ?? '—'}
                    </td>
                    <td className="num text-right">{p.createdAt ? fmtAge(p.createdAt) : '—'}</td>
                    <td className="pl-3">
                      {matching.map((s) => (
                        <Badge key={s.id} tone="accent">
                          {s.data.name}
                        </Badge>
                      ))}
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

/** Open sniper positions (entry prices synced to the account) with live PnL. */
function Positions({ snipers, onOpen }: { snipers: SniperRow[]; onOpen: (n: NetworkId, t: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>(loadEntries);
  useEffect(() => {
    const t = setInterval(() => setEntries(loadEntries()), 3_000);
    return () => clearInterval(t);
  }, []);
  const nets = [...new Set(entries.map((e) => e.network))];
  const px = useQuery({
    queryKey: ['sniper-px', entries.map((e) => `${e.network}:${e.token}`).join(',')],
    enabled: entries.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const out: Record<string, number | null> = {};
      for (const n of nets) {
        const toks = entries.filter((e) => e.network === n).map((e) => e.token);
        const r = await get<{ data: Record<string, number | null> }>(
          `/api/market/prices?network=${n}&tokens=${toks.join(',')}`,
        );
        for (const [k, v] of Object.entries(r.data)) out[`${n}:${k}`] = v;
      }
      return out;
    },
  });
  if (!entries.length)
    return (
      <Empty title="No open sniper positions" mood="sleep" compact>
        Auto-buys appear here with live PnL and their exit plan.
      </Empty>
    );
  const untrack = async (e: Entry) => {
    const ok = await ask(`Stop tracking ${e.symbol}? Its exits (TP/SL/ladder) will no longer run.`, {
      confirmLabel: 'Stop',
    });
    if (!ok) return;
    const next = loadEntries().filter(
      (x) => !(x.token === e.token && x.sniperId === e.sniperId && x.at === e.at && x.wallet === e.wallet),
    );
    saveEntries(next);
    setEntries(next);
  };
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-[12px] whitespace-nowrap [&_td]:px-2 [&_th]:px-2">
        <thead className="sticky top-0 bg-surface text-muted text-[11px]">
          <tr>
            <th className="text-left font-semibold pl-3! py-1">Token</th>
            <th className="text-left font-semibold">Sniper</th>
            <th className="text-right font-semibold">Entry</th>
            <th className="text-right font-semibold">Now</th>
            <th className="text-right font-semibold">PnL</th>
            <th className="text-right font-semibold">Peak</th>
            <th className="text-left font-semibold">Exit plan</th>
            <th className="text-right font-semibold">Age</th>
            <th className="pr-3!" />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const s = snipers.find((x) => x.id === e.sniperId);
            const now = px.data?.[`${e.network}:${e.token.toLowerCase()}`] ?? null;
            const ch = now !== null ? ((now - e.entryPriceUsd) / e.entryPriceUsd) * 100 : null;
            const peak = Math.max(e.peakPriceUsd ?? e.entryPriceUsd, now ?? 0);
            const x = s?.data.exit;
            const devPct = s?.data.antiRug.devSellExitPct ?? null;
            const plan = x
              ? [
                  ...x.ladder.map(
                    (l, i) => `${(e.steps ?? []).includes(i) ? '✓ ' : ''}+${l.atPct}%→${l.sellPct}%`,
                  ),
                  x.takeProfitPct ? `TP +${x.takeProfitPct}%` : null,
                  x.stopLossPct ? `SL −${x.stopLossPct}%` : null,
                  x.trailingStopPct ? `trail ${x.trailingStopPct}%` : null,
                  e.creator && devPct ? `dev-sell ${devPct}%` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'sniper deleted — manage manually';
            return (
              <tr
                key={`${e.sniperId}:${e.token}:${e.at}:${e.wallet ?? ''}`}
                className="border-t border-line/50 hover:bg-surface-2"
              >
                <td className="pl-3! py-1">
                  <button
                    className="font-semibold hover:underline"
                    onClick={() => onOpen(e.network, e.token)}
                  >
                    {e.symbol}
                  </button>{' '}
                  <NetworkBadge id={e.network} />
                </td>
                <td className="text-muted truncate max-w-28">
                  {s?.data.name ?? '—'}
                  {e.wallet && <span className="num"> · {shortAddress(e.wallet, 3)}</span>}
                </td>
                <td className="text-right">
                  <Price v={e.entryPriceUsd} />
                </td>
                <td className="text-right">
                  <Price v={now} />
                </td>
                <td
                  className={cx(
                    'num text-right',
                    ch === null ? 'text-muted' : ch >= 0 ? 'text-up' : 'text-down',
                  )}
                >
                  {ch === null ? '—' : `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%`}
                </td>
                <td className="text-right">
                  <Price v={peak} />
                </td>
                <td className={cx('text-[11px]', x ? 'text-text-2' : 'text-warn')}>{plan}</td>
                <td className="num text-right text-muted">{fmtAge(e.at)}</td>
                <td className="pr-3! text-right">
                  <Button size="sm" variant="ghost" onClick={() => onOpen(e.network, e.token)}>
                    Sell…
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void untrack(e)}
                    aria-label="Stop tracking"
                  >
                    <Icon name="trash" size={13} />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const numOrNull = (v: string) => (v === '' ? null : Number(v));

function SniperForm({ row, onClose }: { row: SniperRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [c, setC] = useState<SniperConfig>(row?.data ?? DEFAULT);
  const [err, setErr] = useState<string | null>(null);
  const n = (v: string) => (v === '' ? 0 : Number(v));
  const f = c.filters;
  const a = c.antiRug;
  const x = c.exit;
  const setF = (p: Partial<SniperConfig['filters']>) => setC({ ...c, filters: { ...f, ...p } });
  const setA = (p: Partial<SniperConfig['antiRug']>) => setC({ ...c, antiRug: { ...a, ...p } });
  const setX = (p: Partial<SniperConfig['exit']>) => setC({ ...c, exit: { ...x, ...p } });
  const save = useMutation({
    mutationFn: async () => {
      const p = zSniperConfig.safeParse(c);
      if (!p.success)
        throw new Error(p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return row ? put(`/api/automations/sniper/${row.id}`, p.data) : post('/api/automations/sniper', p.data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automations', 'sniper'] });
      onClose();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const native = NETWORKS[c.network].nativeSymbol;
  const sol = NETWORKS[c.network].kind === 'solana';
  const num = (
    label: string,
    v: number | null,
    on: (v: number | null) => void,
    hint?: string,
    nullable = false,
  ) => (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        value={v ?? ''}
        onChange={(e) => on(nullable ? numOrNull(e.target.value) : n(e.target.value))}
      />
    </Field>
  );
  const h3 = (t: string) => <h3 className="font-display font-semibold text-text-2 pt-1">{t}</h3>;
  const setStep = (i: number, p: Partial<SniperConfig['exit']['ladder'][number]>) =>
    setX({ ladder: x.ladder.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  return (
    <Modal open onClose={onClose} title={row ? 'Edit sniper' : 'New sniper'} width={700}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Name">
            <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          </Field>
          <Field label="Network">
            <Select value={c.network} onChange={(e) => setC({ ...c, network: e.target.value as NetworkId })}>
              {NETWORK_IDS.map((id) => (
                <option key={id} value={id}>
                  {NETWORKS[id].name}
                  {!canTrade(id) ? ' (alerts only)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mode">
            <Select value={c.mode} onChange={(e) => setC({ ...c, mode: e.target.value as 'alert' | 'auto' })}>
              <option value="alert">Alert only</option>
              <option value="auto" disabled={!canTrade(c.network)}>
                Auto-buy
              </option>
            </Select>
          </Field>
        </div>

        {h3('Discovery filters')}
        <div className="grid grid-cols-3 gap-3">
          {num('Min liquidity $', f.minLiquidityUsd, (v) => setF({ minLiquidityUsd: v ?? 0 }))}
          {num(
            'Max liquidity $',
            f.maxLiquidityUsd,
            (v) => setF({ maxLiquidityUsd: v }),
            'blank = none',
            true,
          )}
          {num('Max pool age (min)', f.maxPoolAgeMin, (v) => setF({ maxPoolAgeMin: v ?? 0 }))}
          {num('Min FDV $', f.minFdvUsd, (v) => setF({ minFdvUsd: v ?? 0 }))}
          {num('Max FDV $', f.maxFdvUsd, (v) => setF({ maxFdvUsd: v }), 'blank = none', true)}
          {num('Min 5m volume $', f.minVolume5mUsd, (v) => setF({ minVolume5mUsd: v ?? 0 }))}
          {num('Min buys (5m)', f.minBuys5m, (v) => setF({ minBuys5m: v ?? 0 }), 'wait for real buyers')}
          <Field label="Quote symbols (comma)" hint="e.g. WMON,USDC — empty = any">
            <Input
              value={f.quoteSymbols.join(',')}
              onChange={(e) =>
                setF({
                  quoteSymbols: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="DEX contains" hint="e.g. uniswap (migrations land on a DEX)">
            <Input value={f.dexIncludes} onChange={(e) => setF({ dexIncludes: e.target.value })} />
          </Field>
          <Field label="Name contains">
            <Input value={f.nameIncludes} onChange={(e) => setF({ nameIncludes: e.target.value })} />
          </Field>
        </div>

        {c.mode === 'auto' && (
          <>
            {h3('Execution')}
            <div className="grid grid-cols-3 gap-3">
              {num(`Entry (${native})`, c.entryAmountNative, (v) =>
                setC({ ...c, entryAmountNative: v ?? 0 }),
              )}
              {num('Max trade $', c.maxTradeUsd, (v) => setC({ ...c, maxTradeUsd: v ?? 0 }))}
              {num(
                'Slippage (bps)',
                c.slippageBps,
                (v) => setC({ ...c, slippageBps: v ?? 0 }),
                '100 bps = 1%',
              )}
              {NETWORKS[c.network].supportsPriorityFee && (
                <Field label="Priority fee">
                  <Select
                    value={c.priorityFee}
                    onChange={(e) =>
                      setC({ ...c, priorityFee: e.target.value as SniperConfig['priorityFee'] })
                    }
                  >
                    <option value="none">Default</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </Select>
                </Field>
              )}
              {NETWORKS[c.network].kind === 'evm' &&
                num('Deadline (s)', c.deadlineSec, (v) => setC({ ...c, deadlineSec: v ?? 0 }))}
              {num('Max buys / hour', c.limits.maxBuysPerHour, (v) =>
                setC({ ...c, limits: { ...c.limits, maxBuysPerHour: v ?? 0 } }),
              )}
              {num('Max open positions', c.limits.maxOpenPositions, (v) =>
                setC({ ...c, limits: { ...c.limits, maxOpenPositions: v ?? 0 } }),
              )}
            </div>

            {NETWORKS[c.network].kind === 'evm' && (
              <WalletPicker
                label="Buy from wallets (each buys the entry amount)"
                value={c.wallets}
                onChange={(wallets) => setC({ ...c, wallets })}
              />
            )}

            {h3('Anti-rug')}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <Toggle
                checked={f.requireSecurityScan}
                onChange={(v) => setF({ requireSecurityScan: v })}
                label="Require a security scan"
              />
              <Toggle
                checked={a.blockMintable}
                onChange={(v) => setA({ blockMintable: v })}
                label={sol ? 'Block if mint authority is set' : 'Block mintable tokens'}
              />
              {sol && (
                <Toggle
                  checked={a.blockFreezable}
                  onChange={(v) => setA({ blockFreezable: v })}
                  label="Block if freeze authority is set"
                />
              )}
              <Toggle
                checked={a.blockOwnerPowers}
                onChange={(v) => setA({ blockOwnerPowers: v })}
                label="Block owner powers (hidden owner, balances, taxes)"
              />
              {!sol && (
                <Toggle
                  checked={a.requireOpenSource}
                  onChange={(v) => setA({ requireOpenSource: v })}
                  label="Require verified source code"
                />
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Max buy / sell tax %">
                <div className="flex gap-1">
                  <Input
                    type="number"
                    value={f.maxBuyTaxPct}
                    onChange={(e) => setF({ maxBuyTaxPct: n(e.target.value) })}
                  />
                  <Input
                    type="number"
                    value={f.maxSellTaxPct}
                    onChange={(e) => setF({ maxSellTaxPct: n(e.target.value) })}
                  />
                </div>
              </Field>
              {num(
                'Max top-10 holders %',
                a.maxTop10Pct,
                (v) => setA({ maxTop10Pct: v }),
                'blank = off',
                true,
              )}
              {num(
                'Max creator holding %',
                a.maxCreatorPct,
                (v) => setA({ maxCreatorPct: v }),
                'blank = off',
                true,
              )}
              {!sol &&
                num(
                  'Min LP locked/burned %',
                  a.minLpLockedPct,
                  (v) => setA({ minLpLockedPct: v }),
                  'blank = off',
                  true,
                )}
              {num(
                'Dev-sell exit %',
                a.devSellExitPct,
                (v) => setA({ devSellExitPct: v }),
                'sell all if the creator dumps this share',
                true,
              )}
            </div>
            <Field label="Blacklist (token or creator addresses, one per line)">
              <textarea
                className="w-full h-16 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-surface border border-line-strong text-[12px] num outline-none focus:border-accent"
                value={a.blacklist.join('\n')}
                onChange={(e) =>
                  setA({
                    blacklist: e.target.value
                      .split(/[\s,]+/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>

            {h3('Exit')}
            <div className="grid grid-cols-3 gap-3">
              {num('Stop loss %', x.stopLossPct, (v) => setX({ stopLossPct: v }), 'blank = off', true)}
              {num(
                'Trailing stop %',
                x.trailingStopPct,
                (v) => setX({ trailingStopPct: v }),
                'from the peak, while in profit',
                true,
              )}
              {num(
                'Take profit % (all)',
                x.takeProfitPct,
                (v) => setX({ takeProfitPct: v }),
                'blank = off',
                true,
              )}
            </div>
            <Field label="Take-profit ladder" hint="At +X% sell Y% of the original position (up to 4 steps)">
              <div className="space-y-1">
                {x.ladder.map((l, i) => (
                  <div key={i} className="flex items-center gap-2 text-[12px]">
                    <span className="text-muted w-6">#{i + 1}</span>
                    <span className="text-muted">at +</span>
                    <Input
                      type="number"
                      className="w-24"
                      aria-label={`Step ${i + 1} trigger %`}
                      value={l.atPct}
                      onChange={(e) => setStep(i, { atPct: n(e.target.value) })}
                    />
                    <span className="text-muted">% sell</span>
                    <Input
                      type="number"
                      className="w-20"
                      aria-label={`Step ${i + 1} sell %`}
                      value={l.sellPct}
                      onChange={(e) => setStep(i, { sellPct: n(e.target.value) })}
                    />
                    <span className="text-muted">%</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove step ${i + 1}`}
                      onClick={() => setX({ ladder: x.ladder.filter((_, j) => j !== i) })}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                {x.ladder.length < 4 && (
                  <Button
                    size="sm"
                    onClick={() =>
                      setX({
                        ladder: [...x.ladder, { atPct: (x.ladder.at(-1)?.atPct ?? 50) * 2, sellPct: 25 }],
                      })
                    }
                  >
                    Add step
                  </Button>
                )}
              </div>
            </Field>
            <Notice tone="warn">
              Exits are checked every ~15 s from Dexscreener prices while a Chog Toolhub tab is open and the
              wallet is unlocked. They are not on-chain orders and can fill far from the trigger in fast
              markets. Dev-sell protection works only when the scanner knows the creator address.
            </Notice>
          </>
        )}
        {err && <Notice tone="down">{err}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
