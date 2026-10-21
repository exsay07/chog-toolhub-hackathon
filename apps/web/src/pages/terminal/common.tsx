import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { UserKvKey } from '@chog/shared';
import { readKv, useKv, writeKv } from '../../lib/userKv';
import { useQueryClient } from '@tanstack/react-query';
import {
  NETWORKS,
  NETWORK_IDS,
  canTrade,
  fmtInt,
  fmtUsd,
  isNetworkId,
  type NetworkId,
  type PairSummary,
} from '@chog/shared';
import { Globe, Send, Zap } from 'lucide-react';
import { useSettings } from '../../lib/settings';
import { useVault } from '../../lib/vault/useVault';
import { prepareSwap, type PreparedSwap } from '../../lib/trade/engine';
import { useNotify } from '../../lib/notify';
import { post } from '../../lib/api';
import { ConfirmSwap } from '../../components/OrderPanel';
import { ChainIcon } from '../../components/ChainIcon';
import { cx } from '../../components/ui';

/* --------------------------------------------------------------------------- persistence ---- */

export function usePersisted<T>(key: UserKvKey, fallback: T, ok: (v: unknown) => v is T) {
  return useKv(key, fallback, ok);
}

export const isNetList = (v: unknown): v is NetworkId[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => isNetworkId(x as string));

/** Native amount spent by one quick-buy click, per network (MON / BNB / ETH / SOL differ wildly). */
export const DEFAULT_QUICK: Record<NetworkId, number> = {
  monad: 5,
  bsc: 0.02,
  base: 0.005,
  solana: 0.05,
  robinhood: 0.005,
  ethereum: 0.005,
  arc: 10,
  ink: 0.005,
  hyperevm: 0.5,
};
/** Saved amounts are merged over the defaults, so a newly added chain gets its default. */
export const isQuick = (v: unknown): v is Record<NetworkId, number> =>
  !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'number');
export const withQuickDefaults = (q: Partial<Record<NetworkId, number>>): Record<NetworkId, number> => ({
  ...DEFAULT_QUICK,
  ...Object.fromEntries(Object.entries(q).filter(([k]) => NETWORK_IDS.includes(k as NetworkId))),
});

/* ----------------------------------------------------------------------- terminal context ---- */

interface TerminalCtx {
  chains: NetworkId[];
  quick: Record<NetworkId, number>;
  openWallet: () => void;
  openToken: (n: NetworkId, token: string, symbol: string, pair?: string) => void;
}
export const TermCtx = createContext<TerminalCtx | null>(null);
export const useTerminal = () => useContext(TermCtx)!;

/* ------------------------------------------------------------------------------ recent ---- */

export type Recent = { network: NetworkId; address: string; symbol: string };
export function readRecent(): Recent[] {
  return readKv<Recent[]>('term.recent', [], (v): v is Recent[] => Array.isArray(v))
    .filter((r) => isNetworkId(r.network))
    .slice(0, 30);
}
export function pushRecent(r: Recent) {
  writeKv(
    'term.recent',
    [
      r,
      ...readRecent().filter(
        (x) => !(x.network === r.network && x.address.toLowerCase() === r.address.toLowerCase()),
      ),
    ].slice(0, 30),
  );
}

/* ------------------------------------------------------------------------------ pieces ---- */

/** Token logo with the chain mark in the corner (Axiom-style). */
export function TokenAvatar({
  p,
  size = 36,
}: {
  p: Pick<PairSummary, 'imageUrl' | 'base' | 'network'>;
  size?: number;
}) {
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      {p.imageUrl ? (
        <img
          src={p.imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full rounded-[6px] object-cover border border-line bg-surface-3"
        />
      ) : (
        <span className="size-full rounded-[6px] border border-line bg-surface-3 grid place-items-center text-[11px] font-semibold text-muted">
          {p.base.symbol.slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="absolute -right-1.5 -bottom-1.5 rounded-[5px] bg-bg p-px">
        <ChainIcon id={p.network} size={Math.max(12, Math.round(size * 0.36))} />
      </span>
    </span>
  );
}

export function Socials({ p }: { p: Pick<PairSummary, 'socials' | 'url'> }) {
  const s = p.socials;
  const link = (href: string | null | undefined, label: string, icon: ReactNode) =>
    href && /^https:\/\//.test(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-muted hover:text-text"
        title={label}
        aria-label={label}
      >
        {icon}
      </a>
    ) : null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {link(s?.twitter, 'X / Twitter', <span className="text-[11px] leading-none font-semibold">𝕏</span>)}
      {link(s?.telegram, 'Telegram', <Send className="size-3" />)}
      {link(s?.website, 'Website', <Globe className="size-3" />)}
    </span>
  );
}

/** "12s", "4m", "3h", "2d" — compact age like Axiom. */
export function ageShort(ms: number | null, now = Date.now()) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 60) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (86_400 * 30))}mo`;
}

export const usd = (v: number | null | undefined) => fmtUsd(v ?? null, { compact: true });

/** Buys vs sells as numbers + a thin proportion bar. */
export function TxnsCell({ t }: { t: { buys: number; sells: number } | null | undefined }) {
  if (!t) return <span className="text-muted">—</span>;
  const total = t.buys + t.sells;
  const buyPct = total ? (t.buys / total) * 100 : 50;
  return (
    <span className="inline-flex flex-col items-end gap-1 min-w-[64px]">
      <span className="num text-text">{fmtInt(total)}</span>
      <span className="num text-[11px]">
        <span className="text-up">{fmtInt(t.buys)}</span>
        <span className="text-muted"> / </span>
        <span className="text-down">{fmtInt(t.sells)}</span>
      </span>
      <span className="h-[2px] w-full bg-down/60 rounded-full overflow-hidden">
        <span className="block h-full bg-up" style={{ width: `${buyPct}%` }} />
      </span>
    </span>
  );
}

export function ChangeText({ v, className }: { v: number | null | undefined; className?: string }) {
  if (v === null || v === undefined || !Number.isFinite(v))
    return <span className={cx('text-muted num', className)}>—</span>;
  return (
    <span className={cx('num', v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-text-2', className)}>
      {v > 0 ? '+' : ''}
      {Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%
    </span>
  );
}

/** Rows that just appeared get a short highlight (new pairs, re-ranked rows). */
export function useFreshKeys(keys: string[]) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const joined = keys.join('|');
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(keys);
      return;
    }
    const added = keys.filter((k) => !seen.current!.has(k));
    for (const k of added) seen.current.add(k);
    if (added.length === 0) return;
    setFresh(new Set(added));
    const t = setTimeout(() => setFresh(new Set()), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return fresh;
}

/* ---------------------------------------------------------------------------- quick buy ---- */

/**
 * One-click buy with the per-network quick amount. Goes through the same prepareSwap path as the
 * order panel (quote → simulate → risk check). It executes straight away only when the risk check
 * raised nothing and "confirm every trade" is off in Settings; otherwise the review dialog opens.
 */
export function QuickBuy({ p, compact }: { p: PairSummary; compact?: boolean }) {
  const { quick, openWallet } = useTerminal();
  const { settings } = useSettings();
  const { vault, unlocked } = useVault();
  const { notify } = useNotify();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<PreparedSwap | null>(null);
  const amount = quick[p.network];
  const n = NETWORKS[p.network];
  const tradable = canTrade(p.network);

  const execute = async (sw: PreparedSwap) => {
    setBusy(true);
    try {
      const hash = await sw.execute();
      notify({
        category: 'execution',
        tone: 'info',
        title: `Buy ${p.base.symbol} submitted`,
        body: `${amount} ${n.nativeSymbol} · waiting for on-chain confirmation.`,
        link: { href: n.explorer.tx(hash), label: n.explorer.name },
      });
      void post('/api/automation-logs', {
        automationId: null,
        kind: 'trade',
        level: 'info',
        message: `Quick buy ${p.base.symbol} for ${amount} ${n.nativeSymbol} on ${n.name}: ${hash}`,
      });
      void qc.invalidateQueries({ queryKey: ['journal'] });
      setPrepared(null);
    } catch (e) {
      notify({
        category: 'failed',
        tone: 'down',
        title: 'Buy failed',
        body: (e as Error).message.slice(0, 160),
      });
    } finally {
      setBusy(false);
    }
  };

  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!vault || !unlocked) return openWallet();
    setBusy(true);
    try {
      const sw = await prepareSwap(
        {
          network: p.network,
          side: 'buy',
          token: p.base.address,
          amount,
          slippageBps: settings.trading.defaultSlippageBps,
          priority: settings.trading.priorityFee,
          deadlineSec: 1200,
          source: 'manual',
          automated: false,
          liquidityUsd: p.liquidityUsd,
          tokenSymbol: p.base.symbol,
        },
        settings.risk,
      );
      if (settings.trading.confirmEveryTrade || sw.risk.warnings.length > 0 || !sw.risk.ok) {
        setPrepared(sw);
        setBusy(false);
      } else await execute(sw);
    } catch (err) {
      setBusy(false);
      notify({
        category: 'failed',
        tone: 'down',
        title: 'Quote failed',
        body: (err as Error).message.slice(0, 160),
      });
    }
  };

  return (
    <>
      <button
        onClick={(e) => void click(e)}
        disabled={!tradable || busy}
        title={
          tradable
            ? `Buy ${p.base.symbol} for ${amount} ${n.nativeSymbol}`
            : `Trading is disabled on ${n.name} (data only)`
        }
        className={cx(
          'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap transition-colors',
          compact ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-[12px]',
          tradable
            ? 'border-accent/40 bg-accent/12 text-text hover:bg-accent/25 hover:border-accent/70'
            : 'border-line text-muted cursor-not-allowed',
          busy && 'opacity-60',
        )}
      >
        <Zap className={cx(compact ? 'size-3' : 'size-3.5', tradable && 'text-accent')} />
        <span className="num">{amount}</span>
        <span className="text-muted">{n.nativeSymbol}</span>
      </button>
      {prepared && (
        <ConfirmSwap
          p={prepared}
          busy={busy}
          onCancel={() => setPrepared(null)}
          onConfirm={() => void execute(prepared)}
        />
      )}
    </>
  );
}
