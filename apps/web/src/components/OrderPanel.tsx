import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  NETWORKS,
  canTrade,
  fmtNum,
  fmtPct,
  fmtUsd,
  shortAddress,
  type NetworkId,
  type TxState,
} from '@chog/shared';
import { Keyboard, Settings2, X, Zap } from 'lucide-react';
import { useSettings } from '../lib/settings';
import { useVault } from '../lib/vault/useVault';
import { prepareSwap, type PreparedSwap, type Priority } from '../lib/trade/engine';
import { usePresets, type PresetState, type SidePreset } from '../lib/trade/presets';
import { cancelOrder, orderKind, placeOrders, useOrders, type LimitOrder } from '../lib/trade/orders';
import { tokenBalance } from '../lib/automation/common';
import { walletsOf } from '../lib/vault/vault';
import { useNotify } from '../lib/notify';
import { post } from '../lib/api';
import { Badge, Button, cx, ExtLink, Field, Input, Modal, Notice, Select, Tabs } from './ui';

/**
 * Axiom-style trade panel: three presets (P1/P2/P3, each with its own slippage + priority), four
 * one-click buy amounts and sell percentages, hotkeys (1–4 buy, Shift+1–4 sell), and price-triggered
 * limit / take-profit / stop-loss orders. Every swap still goes quote → risk check → simulate.
 */
export function OrderPanel({
  network,
  token,
  symbol,
  liquidityUsd,
  priceUsd,
}: {
  network: NetworkId;
  token: string;
  symbol: string;
  liquidityUsd: number | null;
  /** Current USD price of the token (limit triggers, auto TP/SL). */
  priceUsd: number | null;
}) {
  const { settings } = useSettings();
  const { unlocked, vault } = useVault();
  const { notify } = useNotify();
  const qc = useQueryClient();
  const [ps, setPs] = usePresets();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [mode, setMode] = useState<'market' | 'limit'>('market');
  const [custom, setCustom] = useState('');
  const [prepared, setPrepared] = useState<PreparedSwap | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [state, setState] = useState<{ s: TxState; hash?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const n = NETWORKS[network];
  // Multi-wallet: EVM trades can go through any vault wallet (null = Main).
  const evmWallets = n.kind === 'evm' ? walletsOf(vault) : [];
  const [walletSel, setWalletSel] = useState<string | null>(null);
  const wallet = evmWallets.some((w) => w.address === walletSel) ? walletSel : null;
  const tradable = canTrade(network);
  const ready = !!vault && unlocked && tradable;
  const preset = ps.presets[ps.active];
  const sp: SidePreset = preset[side];
  const amounts = preset.buyAmounts[network];

  const bal = useQuery({
    queryKey: ['tokenBalance', network, token, wallet],
    queryFn: () => tokenBalance(network, token, wallet ?? undefined),
    enabled: !!vault && unlocked,
    refetchInterval: 15_000,
  });
  const balance = bal.data ?? null;

  /** Quote and either execute at once or open the review (confirm setting, warnings, blocks). */
  const trade = async (s: 'buy' | 'sell', amount: number, tag: string) => {
    if (!ready || busy) return;
    setErr(null);
    setState(null);
    setBusy(tag);
    const p = ps.presets[ps.active][s];
    try {
      const sw = await prepareSwap(
        {
          network,
          side: s,
          token,
          amount,
          slippageBps: Math.round(p.slippagePct * 100),
          priority: p.priority,
          deadlineSec: 1200,
          source: 'manual',
          automated: false,
          liquidityUsd,
          tokenSymbol: symbol,
          wallet,
        },
        settings.risk,
      );
      if (settings.trading.confirmEveryTrade || sw.risk.warnings.length > 0 || !sw.risk.ok) {
        setPrepared(sw);
        setBusy(null);
      } else await execute(sw);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  const execute = async (sw: PreparedSwap) => {
    setBusy('exec');
    setErr(null);
    const s = sw.req.side;
    try {
      const hash = await sw.execute((st, h) => setState({ s: st, hash: h }));
      notify({
        category: 'execution',
        tone: 'info',
        title: `${s === 'buy' ? 'Buy' : 'Sell'} ${symbol} submitted`,
        body: 'Waiting for on-chain confirmation — not final yet.',
        link: { href: n.explorer.tx(hash), label: n.explorer.name },
      });
      void post('/api/automation-logs', {
        automationId: null,
        kind: 'trade',
        level: 'info',
        message: `Manual ${s} ${symbol} on ${n.name}: ${hash}`,
      });
      if (s === 'buy' && ps.autoExit.on && priceUsd) {
        const ex = ps.autoExit;
        const base = {
          network,
          token,
          symbol,
          side: 'sell' as const,
          amount: 100,
          expiresAt: null,
          wallet: sw.req.wallet ?? null,
        };
        placeOrders([
          { ...base, when: 'above', priceUsd: priceUsd * (1 + ex.tpPct / 100), ...preset.sell },
          { ...base, when: 'below', priceUsd: priceUsd * (1 - ex.slPct / 100), ...preset.sell },
        ]);
      }
      void qc.invalidateQueries({ queryKey: ['journal'] });
      setTimeout(() => void bal.refetch(), 6_000);
      setPrepared(null);
    } catch (e) {
      setErr((e as Error).message);
      notify({
        category: 'failed',
        tone: 'down',
        title: `${s === 'buy' ? 'Buy' : 'Sell'} failed`,
        body: (e as Error).message.slice(0, 160),
      });
    } finally {
      setBusy(null);
    }
  };

  const buyAt = (i: number) => void trade('buy', amounts[i]!, `b${i}`);
  const sellPct = (pct: number, tag: string) => {
    if (balance === null || !(balance > 0)) return setErr(`No ${symbol} in the trading wallet`);
    void trade('sell', pct >= 100 ? balance : (balance * pct) / 100, tag);
  };

  // Hotkeys: 1–4 buy with the active preset, Shift+1–4 sell that percentage.
  const keys = useRef({ buyAt, sellPct, on: ps.hotkeys && mode === 'market' });
  keys.current = { buyAt, sellPct, on: ps.hotkeys && mode === 'market' };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!keys.current.on || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.closest('input, textarea, select, [contenteditable="true"]') ||
          document.querySelector('dialog[open]'))
      )
        return;
      const m = /^Digit([1-4])$/.exec(e.code);
      if (!m) return;
      e.preventDefault();
      const i = Number(m[1]) - 1;
      if (e.shiftKey) {
        setSide('sell');
        keys.current.sellPct(ps.presets[ps.active].sellPcts[i]!, `s${i}`);
      } else {
        setSide('buy');
        keys.current.buyAt(i);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ps]);

  const gate = !tradable ? (
    <Notice tone="warn">
      Trading on {n.name} is disabled ({n.tradingStatus}). Market data only.
    </Notice>
  ) : vault === null ? (
    <Notice tone="info">Set up a trading wallet (button at the top of the terminal) to trade.</Notice>
  ) : !unlocked ? (
    <Notice tone="info">Unlock your trading wallet (button at the top of the terminal) to trade.</Notice>
  ) : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-0.5 p-[2px] bg-surface-2 rounded-[var(--radius-sm)] border border-line">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            onClick={() => (setSide(s), setErr(null))}
            className={cx(
              'h-7 rounded-[4px] text-[13px] font-medium transition-colors',
              side === s
                ? s === 'buy'
                  ? 'bg-up/15 text-up'
                  : 'bg-down/15 text-down'
                : 'text-muted hover:text-text',
            )}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      {evmWallets.length > 1 && (
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-muted">Wallet</span>
          <Select
            aria-label="Trading wallet"
            value={wallet ?? ''}
            onChange={(e) => setWalletSel(e.target.value || null)}
          >
            {evmWallets.map((w) => (
              <option key={w.address} value={w.primary ? '' : w.address}>
                {w.label} · {shortAddress(w.address, 4)}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Tabs
          value={mode}
          onChange={setMode}
          items={[
            { id: 'market', label: 'Market' },
            { id: 'limit', label: 'Limit · TP/SL' },
          ]}
        />
        <div className="flex items-center gap-1">
          {([0, 1, 2] as const).map((i) => (
            <button
              key={i}
              onClick={() => setPs((s) => ({ ...s, active: i }))}
              title={`Preset ${i + 1}: ${ps.presets[i].buy.slippagePct}% slippage · ${ps.presets[i].buy.priority} priority`}
              className={cx(
                'h-[22px] px-1.5 rounded-[4px] text-[11px] font-medium border',
                ps.active === i
                  ? 'border-accent/60 bg-accent/15 text-text'
                  : 'border-line text-muted hover:text-text',
              )}
            >
              P{i + 1}
            </button>
          ))}
          <button
            onClick={() => setEditing(true)}
            className="size-[22px] grid place-items-center rounded-[4px] text-muted hover:text-text hover:bg-surface-2"
            aria-label="Edit presets"
            title="Edit presets"
          >
            <Settings2 className="size-3.5" />
          </button>
        </div>
      </div>

      {tradable && n.tradingStatus === 'implemented-unverified' && (
        <div className="text-[11px] text-muted">
          Execution path implemented against {n.tradingAdapter === 'jupiter' ? 'Jupiter' : 'KyberSwap'}; not
          yet verified by us with real funds on {n.name}.
        </div>
      )}

      {mode === 'market' ? (
        <>
          {gate}
          {side === 'buy' ? (
            <div className="grid grid-cols-4 gap-1">
              {amounts.map((a, i) => (
                <Button
                  key={i}
                  size="sm"
                  disabled={!ready || !!busy}
                  loading={busy === `b${i}`}
                  onClick={() => buyAt(i)}
                  className="px-1 hover:border-up/60"
                  title={ps.hotkeys ? `Hotkey ${i + 1}` : undefined}
                >
                  <span className="num">{fmtNum(a, 4)}</span>
                </Button>
              ))}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-muted">Balance</span>
                <span className="num">
                  {balance === null ? '—' : `${fmtNum(balance, 4)} ${symbol}`}
                  {balance !== null && priceUsd !== null && (
                    <span className="text-muted"> · {fmtUsd(balance * priceUsd)}</span>
                  )}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {preset.sellPcts.map((pct, i) => (
                  <Button
                    key={i}
                    size="sm"
                    disabled={!ready || !!busy || !(balance && balance > 0)}
                    loading={busy === `s${i}`}
                    onClick={() => sellPct(pct, `s${i}`)}
                    className="px-1 hover:border-down/60"
                    title={ps.hotkeys ? `Hotkey Shift+${i + 1}` : undefined}
                  >
                    <span className="num">{pct}%</span>
                  </Button>
                ))}
              </div>
            </>
          )}
          <div className="flex gap-1.5">
            <Input
              type="number"
              min="0"
              step="any"
              placeholder={side === 'buy' ? `Amount (${n.nativeSymbol})` : `Amount (${symbol})`}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && Number(custom) > 0) void trade(side, Number(custom), 'custom');
              }}
            />
            <Button
              variant={side === 'buy' ? 'up' : 'down'}
              disabled={!ready || !(Number(custom) > 0) || !!busy}
              loading={busy === 'custom'}
              onClick={() => void trade(side, Number(custom), 'custom')}
              className="shrink-0"
            >
              <Zap className="size-3.5" />
              {side === 'buy' ? 'Buy' : 'Sell'}
            </Button>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>
              P{ps.active + 1} · slippage <span className="num text-text-2">{sp.slippagePct}%</span> ·
              priority <span className="text-text-2">{n.supportsPriorityFee ? sp.priority : 'n/a'}</span>
            </span>
            {ps.hotkeys && (
              <span className="inline-flex items-center gap-1" title="1–4 buy · Shift+1–4 sell">
                <Keyboard className="size-3" /> 1–4
              </span>
            )}
          </div>
          {side === 'buy' && (
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={ps.autoExit.on}
                onChange={(e) => setPs((s) => ({ ...s, autoExit: { ...s.autoExit, on: e.target.checked } }))}
              />
              <span>
                Auto TP <span className="num text-up">+{ps.autoExit.tpPct}%</span> / SL{' '}
                <span className="num text-down">−{ps.autoExit.slPct}%</span> after buy
              </span>
            </label>
          )}
          {!settings.trading.confirmEveryTrade && (
            <div className="text-[11px] text-muted">
              Instant trade: clicks send right away (review opens only on risk warnings).
            </div>
          )}
        </>
      ) : (
        <LimitForm
          side={side}
          network={network}
          token={token}
          symbol={symbol}
          priceUsd={priceUsd}
          sp={sp}
          gate={gate}
          wallet={wallet}
        />
      )}

      {err && <Notice tone="down">{err}</Notice>}
      {state && (
        <div className="text-xs flex items-center gap-2">
          <Badge tone={state.s === 'submitted' ? 'info' : state.s.includes('fail') ? 'down' : 'neutral'}>
            {state.s}
          </Badge>
          {state.hash && <ExtLink href={n.explorer.tx(state.hash)}>{n.explorer.name} ↗</ExtLink>}
          <span className="text-muted">Final status comes from chain reconciliation (Portfolio).</span>
        </div>
      )}
      <OpenOrders network={network} token={token} />
      <ConfirmSwap
        p={prepared}
        busy={busy === 'exec'}
        onCancel={() => setPrepared(null)}
        onConfirm={() => prepared && void execute(prepared)}
      />
      <PresetEditor
        open={editing}
        onClose={() => setEditing(false)}
        network={network}
        ps={ps}
        setPs={setPs}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- limit orders ---- */

const EXPIRY = [
  { id: 'never', label: 'Never', ms: null },
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '24h', label: '24 hours', ms: 86_400_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
] as const;

function LimitForm({
  side,
  network,
  token,
  symbol,
  priceUsd,
  sp,
  gate,
  wallet,
}: {
  side: 'buy' | 'sell';
  network: NetworkId;
  token: string;
  symbol: string;
  priceUsd: number | null;
  sp: SidePreset;
  gate: React.ReactNode;
  wallet: string | null;
}) {
  const n = NETWORKS[network];
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState(side === 'buy' ? '' : '100');
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]['id']>('never');
  const [msg, setMsg] = useState<{ tone: 'info' | 'down'; text: string } | null>(null);
  useEffect(() => setAmount(side === 'buy' ? '' : '100'), [side]);

  const target = Number(price);
  const when: 'below' | 'above' | null =
    priceUsd && target > 0 ? (target < priceUsd ? 'below' : 'above') : null;
  const offs = side === 'buy' ? [-10, -25, -50] : [25, 50, 100, -15, -30];
  const setOff = (pct: number) =>
    priceUsd && setPrice(String(Number((priceUsd * (1 + pct / 100)).toPrecision(6))));

  const place = () => {
    setMsg(null);
    if (!when) return setMsg({ tone: 'down', text: 'Enter a trigger price (current price unknown?)' });
    const a = Number(amount);
    if (!(a > 0) || (side === 'sell' && a > 100)) return setMsg({ tone: 'down', text: 'Check the amount' });
    try {
      const ex = EXPIRY.find((x) => x.id === expiry)!.ms;
      const [o] = placeOrders([
        {
          network,
          token,
          symbol,
          side,
          when,
          priceUsd: target,
          amount: a,
          slippagePct: sp.slippagePct,
          priority: sp.priority,
          expiresAt: ex === null ? null : Date.now() + ex,
          wallet,
        },
      ]);
      setMsg({ tone: 'info', text: `${orderKind(o!)} placed` });
      setPrice('');
    } catch (e) {
      setMsg({ tone: 'down', text: (e as Error).message });
    }
  };

  return (
    <div className="space-y-3">
      {gate}
      <Field
        label="Trigger price (USD)"
        hint={
          priceUsd ? (
            <>
              Now <span className="num">${fmtNum(priceUsd, 6)}</span>
              {when && (
                <>
                  {' '}
                  · fires when price {when === 'below' ? '≤' : '≥'} target (
                  <span className={when === 'below' ? 'text-down' : 'text-up'}>
                    {fmtPct(((target - priceUsd) / priceUsd) * 100)}
                  </span>
                  )
                </>
              )}
            </>
          ) : (
            'Current price unknown'
          )
        }
      >
        <Input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-1">
        {offs.map((o) => (
          <Button key={o} size="sm" onClick={() => setOff(o)} disabled={!priceUsd} className="px-2">
            <span className={cx('num', o < 0 ? 'text-down' : 'text-up')}>
              {o > 0 ? '+' : ''}
              {o}%
            </span>
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={side === 'buy' ? `Amount (${n.nativeSymbol})` : 'Sell % of balance'}>
          <Input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Expires">
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)}>
            {EXPIRY.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button
        variant={side === 'buy' ? 'up' : 'down'}
        size="lg"
        className="w-full"
        disabled={!when || !(Number(amount) > 0)}
        onClick={place}
      >
        Place {when ? orderKind({ side, when }).toLowerCase() : `${side} order`}
      </Button>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="text-[11px] text-muted">
        DEX swaps have no order book: the order is a price trigger watched by this app and sent as a normal
        swap (P-preset slippage, your risk limits). It runs only while a Chog Toolhub tab is open and the
        trading wallet is unlocked.
      </p>
    </div>
  );
}

function OpenOrders({ network, token }: { network: NetworkId; token: string }) {
  const orders = useOrders().filter(
    (o) => o.network === network && o.token.toLowerCase() === token.toLowerCase(),
  );
  const open = orders.filter((o) => o.status === 'open' || o.status === 'executing');
  const recent = orders.filter((o) => o.status === 'done' || o.status === 'failed').slice(0, 3);
  if (!open.length && !recent.length) return null;
  const n = NETWORKS[network];
  const row = (o: LimitOrder) => (
    <div key={o.id} className="flex items-center gap-2 py-1 border-b border-line/50 last:border-0">
      <span
        className={cx('w-[82px] shrink-0', o.side === 'buy' || o.when === 'above' ? 'text-up' : 'text-down')}
      >
        {orderKind(o)}
      </span>
      <span className="num flex-1 min-w-0 truncate">
        {o.when === 'below' ? '≤' : '≥'} ${fmtNum(o.priceUsd, 6)} ·{' '}
        {o.side === 'buy' ? `${fmtNum(o.amount, 4)} ${n.nativeSymbol}` : `${o.amount}%`}
      </span>
      {o.status === 'open' ? (
        <button
          onClick={() => cancelOrder(o.id)}
          className="text-muted hover:text-down"
          aria-label="Cancel order"
          title="Cancel"
        >
          <X className="size-3.5" />
        </button>
      ) : o.status === 'executing' ? (
        <Badge tone="info">sending</Badge>
      ) : o.status === 'done' ? (
        o.hash ? (
          <ExtLink href={n.explorer.tx(o.hash)}>filled ↗</ExtLink>
        ) : (
          <Badge tone="up">filled</Badge>
        )
      ) : (
        <span title={o.error}>
          <Badge tone="down">failed</Badge>
        </span>
      )}
    </div>
  );
  return (
    <div className="text-[12px] pt-1">
      <div className="text-[11px] text-muted mb-1">Orders ({open.length} open)</div>
      {open.map(row)}
      {recent.map(row)}
    </div>
  );
}

/* ----------------------------------------------------------------------- preset editor ---- */

function PresetEditor({
  open,
  onClose,
  network,
  ps,
  setPs,
}: {
  open: boolean;
  onClose: () => void;
  network: NetworkId;
  ps: PresetState;
  setPs: (fn: (s: PresetState) => PresetState) => void;
}) {
  const n = NETWORKS[network];
  const i = ps.active;
  const p = ps.presets[i];
  const edit = (fn: (draft: PresetState['presets'][number]) => void) =>
    setPs((s) => {
      const presets = structuredClone(s.presets);
      fn(presets[i]);
      return { ...s, presets };
    });
  const numIn = (v: number, on: (x: number) => void, max = 1e6) => (
    <Input
      type="number"
      min="0"
      step="any"
      defaultValue={v}
      onBlur={(e) => {
        const x = Number(e.target.value);
        if (x > 0 && x <= max) on(x);
        else e.target.value = String(v);
      }}
    />
  );
  const sideRow = (k: 'buy' | 'sell') => (
    <div className="grid grid-cols-2 gap-2">
      <Field label={`${k === 'buy' ? 'Buy' : 'Sell'} slippage %`}>
        {numIn(p[k].slippagePct, (x) => edit((d) => void (d[k].slippagePct = x)), 50)}
      </Field>
      <Field label={`${k === 'buy' ? 'Buy' : 'Sell'} priority`}>
        <Select
          value={p[k].priority}
          disabled={!n.supportsPriorityFee}
          onChange={(e) => edit((d) => void (d[k].priority = e.target.value as Priority))}
        >
          <option value="none">Default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </Select>
      </Field>
    </div>
  );
  return (
    <Modal open={open} onClose={onClose} title={`Preset P${i + 1}`} width={440}>
      {/* key: re-mount the uncontrolled inputs when switching preset */}
      <div className="space-y-4" key={`${i}-${network}`}>
        <div className="flex gap-1">
          {([0, 1, 2] as const).map((j) => (
            <Button
              key={j}
              size="sm"
              variant={j === i ? 'primary' : 'secondary'}
              onClick={() => setPs((s) => ({ ...s, active: j }))}
            >
              P{j + 1}
            </Button>
          ))}
        </div>
        {sideRow('buy')}
        {sideRow('sell')}
        <Field label={`Buy buttons (${n.nativeSymbol}, ${n.name})`}>
          <div className="grid grid-cols-4 gap-1">
            {p.buyAmounts[network].map((a, k) => (
              <span key={k}>{numIn(a, (x) => edit((d) => void (d.buyAmounts[network][k] = x)))}</span>
            ))}
          </div>
        </Field>
        <Field label="Sell buttons (% of balance)">
          <div className="grid grid-cols-4 gap-1">
            {p.sellPcts.map((a, k) => (
              <span key={k}>{numIn(a, (x) => edit((d) => void (d.sellPcts[k] = x)), 100)}</span>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Auto take-profit %">
            {numIn(
              ps.autoExit.tpPct,
              (x) => setPs((s) => ({ ...s, autoExit: { ...s.autoExit, tpPct: x } })),
              10_000,
            )}
          </Field>
          <Field label="Auto stop-loss %">
            {numIn(
              ps.autoExit.slPct,
              (x) => setPs((s) => ({ ...s, autoExit: { ...s.autoExit, slPct: x } })),
              99,
            )}
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={ps.hotkeys}
            onChange={(e) => setPs((s) => ({ ...s, hotkeys: e.target.checked }))}
          />
          Hotkeys on the token page: 1–4 buy, Shift+1–4 sell
        </label>
        <p className="text-[11px] text-muted">
          Presets sync to your account. One-click trades skip the review only when “Confirm every trade” is
          off in Settings and the risk check raised nothing. MEV protection is not available on these routes
          yet.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

export function ConfirmSwap({
  p,
  busy,
  onCancel,
  onConfirm,
}: {
  p: PreparedSwap | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [ack, setAck] = useState(false);
  if (!p) return null;
  const n = NETWORKS[p.req.network];
  const row = (k: string, v: React.ReactNode, cls?: string) => (
    <div className="flex justify-between gap-4 py-1 border-b border-line/60 text-[13px]">
      <span className="text-muted">{k}</span>
      <span className={cx('num text-right', cls)}>{v}</span>
    </div>
  );
  const needsAck = p.risk.warnings.length > 0;
  return (
    <Modal open={!!p} onClose={onCancel} title={`Confirm ${p.req.side}`} width={460}>
      <div className="space-y-3">
        <div>
          {row('You pay', `${fmtNum(p.req.amount, 6)} ${p.inLabel}`)}
          {row('Expected', `${fmtNum(p.expectedOut, 6)} ${p.outLabel}`)}
          {row('Minimum (after slippage)', `${fmtNum(p.minOut, 6)} ${p.outLabel}`)}
          {row('Value (est.)', fmtUsd(p.amountUsd))}
          {row(
            'Price impact',
            fmtPct(p.priceImpactPct),
            (p.priceImpactPct ?? 0) > 3 ? 'text-warn' : undefined,
          )}
          {row('Network fee (est.)', p.gasUsd !== null ? fmtUsd(p.gasUsd) : 'shown by network')}
          {row('Chog Toolhub fee', '$0.00 (none)', 'text-up')}
          {row('Route', p.route)}
          {row('Network', n.name)}
          {p.needsApproval && row('Approval', 'Exact amount (not unlimited)', 'text-warn')}
        </div>
        {p.security ? (
          p.security.flags.length > 0 && (
            <Notice tone="warn">Scanner (GoPlus, third-party): {p.security.flags.join(' · ')}</Notice>
          )
        ) : (
          <Notice tone="warn">No security scan available for this token.</Notice>
        )}
        {!p.risk.ok && (
          <Notice tone="down">
            <b>Blocked by your risk limits:</b>
            <ul className="list-disc ml-4">
              {p.risk.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Notice>
        )}
        {p.risk.warnings.length > 0 && (
          <Notice tone="warn">
            <ul className="list-disc ml-4">
              {p.risk.warnings.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Notice>
        )}
        <p className="text-[11px] text-muted">
          Quotes move. The transaction is simulated before signing; if the price moves beyond your slippage it
          will revert (you still pay gas). Token taxes, honeypots and MEV are only partially detectable.
        </p>
        {needsAck && p.risk.ok && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand
            the warnings above
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant={p.req.side === 'buy' ? 'up' : 'down'}
            loading={busy}
            disabled={!p.risk.ok || (needsAck && !ack) || Date.now() - p.quotedAt > 60_000}
            onClick={onConfirm}
          >
            {Date.now() - p.quotedAt > 60_000 ? 'Quote expired — re-quote' : `Sign & send ${p.req.side}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
