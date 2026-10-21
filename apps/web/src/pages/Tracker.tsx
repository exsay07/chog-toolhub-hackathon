import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  NETWORKS,
  NETWORK_IDS,
  fmtAge,
  fmtNum,
  fmtUsd,
  isValidAddress,
  shortAddress,
  type CopyConfig,
  type NetworkId,
  type TrackerEvent,
} from '@chog/shared';
import { del, get, patch, post, put, ApiError } from '../lib/api';
import { useNotify, useTick } from '../lib/notify';
import {
  Badge,
  Button,
  Copy,
  cx,
  Empty,
  ErrorState,
  ExtLink,
  Field,
  Input,
  Modal,
  NetworkBadge,
  Notice,
  Panel,
  Select,
  SkeletonRows,
  Tabs,
  Toggle,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { ask } from '../components/Confirm';

interface Tracked {
  id: string;
  network: NetworkId;
  address: string;
  label: string;
  color: string;
  enabled: boolean;
  notify: { buy: boolean; sell: boolean; transfer: boolean };
  copy: CopyConfig | null;
}

const COLORS = ['#ff3e9a', '#7b5cff', '#22c7e8', '#9be22d', '#ffb547', '#ff5a5f', '#ffffff'];
type Filter = 'all' | 'buy' | 'sell' | 'transfer';

export default function Tracker() {
  useTick(15_000);
  const qc = useQueryClient();
  const wallets = useQuery({
    queryKey: ['tracked-wallets'],
    queryFn: () => get<Tracked[]>('/api/tracker/wallets'),
  });
  const [sel, setSel] = useState<string | 'all'>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(false);
  const [copyFor, setCopyFor] = useState<Tracked | null>(null);
  const kinds = filter === 'all' ? '' : filter === 'transfer' ? 'transfer_in,transfer_out' : filter;
  const events = useQuery({
    queryKey: ['tracker-events', sel, kinds],
    queryFn: () =>
      get<TrackerEvent[]>(
        `/api/tracker/events?limit=300${sel !== 'all' ? `&walletId=${sel}` : ''}${kinds ? `&kind=${kinds}` : ''}`,
      ),
    refetchInterval: 15_000,
  });
  const { trackerFeed } = useNotify();
  // Merge live WS events with stored history (dedupe by event id + wallet).
  const merged = useMemo(() => {
    const live = trackerFeed.filter(
      (e) =>
        (sel === 'all' || e.walletId === sel) &&
        (filter === 'all' || (filter === 'transfer' ? e.kind.startsWith('transfer') : e.kind === filter)),
    );
    const m = new Map<string, TrackerEvent>();
    for (const e of [...live, ...(events.data ?? [])]) m.set(`${e.id}:${e.walletId}`, e);
    return [...m.values()].sort((a, b) => b.at - a.at);
  }, [trackerFeed, events.data, sel, filter]);

  const upd = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Tracked> }) =>
      patch(`/api/tracker/wallets/${id}`, body),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tracked-wallets'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/tracker/wallets/${id}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tracked-wallets'] }),
  });

  return (
    <div className="h-full grid grid-cols-[340px_1fr] gap-3 p-4 min-h-0">
      <Panel
        title="Tracked wallets"
        dense
        actions={
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> Add
          </Button>
        }
      >
        {wallets.isLoading ? (
          <SkeletonRows />
        ) : wallets.isError ? (
          <ErrorState error={wallets.error} />
        ) : (wallets.data?.length ?? 0) === 0 ? (
          <Empty title="No wallets tracked">
            Add a public address to watch its buys and sells in real time.
          </Empty>
        ) : (
          <ul className="overflow-auto">
            <li>
              <button
                onClick={() => setSel('all')}
                className={cx(
                  'w-full text-left px-3 h-9 font-semibold hover:bg-surface-2',
                  sel === 'all' && 'bg-surface-2',
                )}
              >
                All wallets
              </button>
            </li>
            {wallets.data!.map((w) => (
              <li
                key={w.id}
                className={cx(
                  'border-t border-line/50 px-3 py-2 hover:bg-surface-2/50',
                  sel === w.id && 'bg-surface-2',
                )}
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSel(w.id)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  >
                    <span className="size-2.5 rounded-full shrink-0" style={{ background: w.color }} />
                    <span className="font-semibold truncate">{w.label}</span>
                    <NetworkBadge id={w.network} />
                  </button>
                  <Toggle
                    checked={w.enabled}
                    onChange={(v) => upd.mutate({ id: w.id, body: { enabled: v } })}
                    label=""
                  />
                </div>
                <div className="flex items-center gap-2 mt-1 text-[11px] text-muted">
                  <span className="num">{shortAddress(w.address, 5)}</span>
                  <Copy text={w.address} />
                  <ExtLink href={NETWORKS[w.network].explorer.address(w.address)}>↗</ExtLink>
                  {w.copy?.enabled && <Badge tone="accent">copy on</Badge>}
                  <span className="ml-auto flex gap-2">
                    <button className="hover:text-text" onClick={() => setCopyFor(w)}>
                      Copy-trade
                    </button>
                    <button
                      className="hover:text-down"
                      onClick={async () =>
                        (await ask(`Stop tracking ${w.label}?`, { confirmLabel: 'Stop tracking' })) &&
                        remove.mutate(w.id)
                      }
                      aria-label="Remove"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </span>
                </div>
                <div className="flex gap-3 mt-1.5 text-[11px]">
                  {(['buy', 'sell', 'transfer'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1 text-muted">
                      <input
                        type="checkbox"
                        checked={w.notify[k]}
                        onChange={(e) =>
                          upd.mutate({ id: w.id, body: { notify: { ...w.notify, [k]: e.target.checked } } })
                        }
                      />{' '}
                      {k}
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Activity"
        dense
        actions={
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { id: 'all', label: 'All' },
              { id: 'buy', label: 'Buys' },
              { id: 'sell', label: 'Sells' },
              { id: 'transfer', label: 'Transfers' },
            ]}
          />
        }
      >
        <div className="px-3 py-1.5 text-[11px] text-muted border-b border-line">
          Buy/sell detection is heuristic from on-chain transfers. Values are estimates from current prices —
          not exact fills. Events can arrive late or be missed during RPC outages.
        </div>
        {events.isLoading ? (
          <SkeletonRows rows={10} />
        ) : events.isError ? (
          <ErrorState error={events.error} />
        ) : merged.length === 0 ? (
          <Empty title="No activity yet" mood="search">
            New events appear within seconds of confirmation.
          </Empty>
        ) : (
          <EventList rows={merged} />
        )}
      </Panel>

      <AddWallet open={adding} onClose={() => setAdding(false)} />
      {copyFor && <CopySettings w={copyFor} onClose={() => setCopyFor(null)} />}
    </div>
  );
}

function EventList({ rows }: { rows: TrackerEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 34,
    overscan: 14,
    useFlushSync: false,
  });
  return (
    <div ref={ref} className="overflow-auto h-[calc(100%-28px)]">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((it) => {
          const e = rows[it.index]!;
          return (
            <div
              key={`${e.id}:${e.walletId}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: it.size,
                transform: `translateY(${it.start}px)`,
              }}
              className="flex items-center gap-3 px-3 text-[12px] border-b border-line/40"
            >
              <span className="size-2 rounded-full shrink-0" style={{ background: e.walletColor }} />
              <span className="w-28 truncate font-semibold">{e.walletLabel}</span>
              <span className="w-24">
                <Badge tone={e.kind === 'buy' ? 'up' : e.kind === 'sell' ? 'down' : 'neutral'}>
                  {e.kind.replace('_', ' ')}
                </Badge>
              </span>
              <span className="num w-28 text-right">{fmtNum(e.tokenAmount, 2)}</span>
              <span className="w-24 truncate font-semibold">
                {e.tokenSymbol ?? shortAddress(e.token ?? '?')}
              </span>
              <span className="w-32 text-muted truncate">
                {e.counterAmount !== null ? `for ${fmtNum(e.counterAmount, 4)} ${e.counterSymbol}` : ''}
              </span>
              <NetworkBadge id={e.network} />
              <span className="num ml-auto" title="Estimate from current price — not the exact fill">
                {e.estUsd !== null ? `~${fmtUsd(e.estUsd)}` : '—'}
              </span>
              <span className="w-12 text-right text-muted">{fmtAge(e.at)}</span>
              <ExtLink href={e.explorerUrl}>↗</ExtLink>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddWallet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ network: 'monad' as NetworkId, address: '', label: '', color: COLORS[0]! });
  const [err, setErr] = useState<string | null>(null);
  const valid = isValidAddress(f.network, f.address.trim());
  const m = useMutation({
    mutationFn: () =>
      post('/api/tracker/wallets', {
        ...f,
        address: f.address.trim(),
        enabled: true,
        notify: { buy: true, sell: true, transfer: false },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tracked-wallets'] });
      setF({ ...f, address: '', label: '' });
      onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Modal open={open} onClose={onClose} title="Track a wallet">
      <div className="space-y-3">
        <Field label="Network">
          <Select value={f.network} onChange={(e) => setF({ ...f, network: e.target.value as NetworkId })}>
            {NETWORK_IDS.map((n) => (
              <option key={n} value={n}>
                {NETWORKS[n].name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Public address"
          error={f.address && !valid ? `Not a valid ${NETWORKS[f.network].name} address` : null}
        >
          <Input
            value={f.address}
            onChange={(e) => setF({ ...f, address: e.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label="Label">
          <Input value={f.label} maxLength={40} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </Field>
        <div className="flex gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setF({ ...f, color: c })}
              className={cx(
                'size-6 rounded-full border-2',
                f.color === c ? 'border-text' : 'border-transparent',
              )}
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
        {err && <Notice tone="down">{err}</Notice>}
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!valid || !f.label.trim()}
            loading={m.isPending}
            onClick={() => m.mutate()}
          >
            Track
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const DEFAULT_COPY: CopyConfig = {
  enabled: false,
  sizing: { mode: 'fixed', amountNative: 0.1 },
  copySells: true,
  maxTradeUsd: 25,
  maxDailyUsd: 100,
  slippageBps: 300,
  minLiquidityUsd: 20_000,
  cooldownSec: 120,
  tokenBlocklist: [],
  tokenAllowlist: [],
};

function CopySettings({ w, onClose }: { w: Tracked; onClose: () => void }) {
  const qc = useQueryClient();
  const [c, setC] = useState<CopyConfig>(w.copy ?? DEFAULT_COPY);
  const [ack, setAck] = useState(!!w.copy?.enabled);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => put(`/api/tracker/wallets/${w.id}/copy`, c),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tracked-wallets'] });
      onClose();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <Modal open onClose={onClose} title={`Copy trading · ${w.label}`} width={560}>
      <div className="space-y-3">
        <Notice tone="warn">
          Copies are attempted from <b>your</b> trading wallet, in this browser tab, only while it is open and
          unlocked. A copy can fail or fill at a worse price even when the original succeeded: events arrive
          late, indexers disagree, liquidity moves, tokens can become unsellable. Never copy with more than
          you can lose.
        </Notice>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sizing">
            <Select
              value={c.sizing.mode}
              onChange={(e) =>
                setC({
                  ...c,
                  sizing:
                    e.target.value === 'fixed'
                      ? { mode: 'fixed', amountNative: 0.1 }
                      : { mode: 'percent', percent: 10 },
                })
              }
            >
              <option value="fixed">Fixed amount</option>
              <option value="percent">% of leader’s size</option>
            </Select>
          </Field>
          {c.sizing.mode === 'fixed' ? (
            <Field label={`Amount (${NETWORKS[w.network].nativeSymbol})`}>
              <Input
                type="number"
                value={c.sizing.amountNative}
                onChange={(e) => setC({ ...c, sizing: { mode: 'fixed', amountNative: num(e.target.value) } })}
              />
            </Field>
          ) : (
            <Field label="Percent of leader">
              <Input
                type="number"
                value={c.sizing.percent}
                onChange={(e) => setC({ ...c, sizing: { mode: 'percent', percent: num(e.target.value) } })}
              />
            </Field>
          )}
          <Field label="Max per trade (USD)">
            <Input
              type="number"
              value={c.maxTradeUsd}
              onChange={(e) => setC({ ...c, maxTradeUsd: num(e.target.value) })}
            />
          </Field>
          <Field label="Max per day (USD)">
            <Input
              type="number"
              value={c.maxDailyUsd}
              onChange={(e) => setC({ ...c, maxDailyUsd: num(e.target.value) })}
            />
          </Field>
          <Field label="Slippage (bps)">
            <Input
              type="number"
              value={c.slippageBps}
              onChange={(e) => setC({ ...c, slippageBps: num(e.target.value) })}
            />
          </Field>
          <Field label="Min liquidity (USD)">
            <Input
              type="number"
              value={c.minLiquidityUsd}
              onChange={(e) => setC({ ...c, minLiquidityUsd: num(e.target.value) })}
            />
          </Field>
          <Field label="Cooldown per token (s)">
            <Input
              type="number"
              value={c.cooldownSec}
              onChange={(e) => setC({ ...c, cooldownSec: num(e.target.value) })}
            />
          </Field>
          <div className="pt-5">
            <Toggle
              checked={c.copySells}
              onChange={(v) => setC({ ...c, copySells: v })}
              label="Also copy sells"
            />
          </div>
        </div>
        <Field label="Token blocklist (addresses, comma separated)">
          <Input
            value={c.tokenBlocklist.join(',')}
            onChange={(e) =>
              setC({
                ...c,
                tokenBlocklist: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label="Token allowlist (optional — only these will be copied)">
          <Input
            value={c.tokenAllowlist.join(',')}
            onChange={(e) =>
              setC({
                ...c,
                tokenAllowlist: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <p className="text-[11px] text-muted">
          Your global limits in Settings → Risk still apply; per-wallet limits can only make them stricter.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand
          automated copy trading can lose money.
        </label>
        {err && <Notice tone="down">{err}</Notice>}
        <div className="flex justify-between">
          <Toggle
            checked={c.enabled}
            onChange={(v) => setC({ ...c, enabled: v })}
            label="Enable copy trading"
          />
          <Button
            variant="primary"
            disabled={c.enabled && !ack}
            loading={m.isPending}
            onClick={() => m.mutate()}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
