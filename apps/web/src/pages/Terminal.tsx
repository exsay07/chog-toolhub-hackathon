import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  NETWORKS,
  NETWORK_IDS,
  fmtUsd,
  isNetworkId,
  isValidAddress,
  shortAddress,
  type NetworkId,
  type SearchResult,
} from '@chog/shared';
import { Check, ChevronDown, Search, Zap } from 'lucide-react';
import { get, type Envelope } from '../lib/api';
import { WalletButton } from '../components/WalletButton';
import { ChainIcon } from '../components/ChainIcon';
import { sfxTab } from '../lib/sfx';
import { cx, Input, Pct, Price } from '../components/ui';
import {
  DEFAULT_QUICK,
  isNetList,
  isQuick,
  pushRecent,
  TermCtx,
  TokenAvatar,
  usePersisted,
  withQuickDefaults,
} from './terminal/common';
import { Discover } from './terminal/Discover';
import { Pulse } from './terminal/Pulse';
import { Watchlist } from './terminal/Watchlist';
import { TokenPage } from './terminal/TokenPage';

/**
 * Token Terminal (Axiom / basedbot-style): Discover table, Pulse columns, Watchlist and the token
 * page, under one toolbar — search, chain filter, per-chain quick-buy amounts and the trading wallet
 * (which exists for this terminal only).
 */
export default function Terminal() {
  const params = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const network = isNetworkId(params.network) ? params.network : undefined;
  const token = network && params.token && isValidAddress(network, params.token) ? params.token : undefined;
  // v2: the chain list grew (ETH, ARC, INK, HYPE) — start everyone on "all chains" again.
  const [chains, setChains] = usePersisted<NetworkId[]>('term.chains', [...NETWORK_IDS], isNetList);
  const [savedQuick, setQuick] = usePersisted('term.quick', DEFAULT_QUICK, isQuick);
  const quick = useMemo(() => withQuickDefaults(savedQuick), [savedQuick]);
  const [walletOpen, setWalletOpen] = useState(false);

  const openToken = useCallback(
    (n: NetworkId, a: string, symbol: string, pair?: string) => {
      pushRecent({ network: n, address: a, symbol });
      nav(`/terminal/${n}/${a}${pair ? `?pair=${encodeURIComponent(pair)}` : ''}`, { viewTransition: true });
    },
    [nav],
  );
  const ctx = useMemo(
    () => ({ chains, quick, openWallet: () => setWalletOpen(true), openToken }),
    [chains, quick, openToken],
  );
  const sub = loc.pathname.split('/')[2];

  return (
    <TermCtx.Provider value={ctx}>
      <div className="h-full min-h-0 flex flex-col">
        <div className="flex items-center gap-3 px-4 h-12 border-b border-line shrink-0">
          <nav className="flex items-center gap-1" aria-label="Terminal">
            {(
              [
                ['/terminal', 'DISCOVER', !sub],
                ['/terminal/pulse', 'PULSE', sub === 'pulse'],
                ['/terminal/watchlist', 'WATCHLIST', sub === 'watchlist'],
              ] as const
            ).map(([to, label, active]) => (
              <NavLink
                key={to}
                to={to}
                end
                viewTransition
                onClick={() => !active && sfxTab()}
                className={cx(
                  'h-8 px-3 rounded-[var(--radius-sm)] text-[13px] font-medium inline-flex items-center transition-colors',
                  active ? 'bg-surface-3 text-text' : 'text-muted hover:text-text hover:bg-surface-2',
                )}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <SearchBox />
          <ChainPicker chains={chains} setChains={setChains} />
          <QuickAmounts quick={quick} setQuick={setQuick} />
          <span className="w-px h-5 bg-line" />
          <WalletButton open={walletOpen} onOpenChange={setWalletOpen} />
        </div>

        <div className="flex-1 min-h-0">
          {network && token ? (
            <TokenPage
              key={`${network}:${token}`}
              network={network}
              token={token}
              initialPair={sp.get('pair')}
            />
          ) : sub === 'pulse' ? (
            <Pulse />
          ) : sub === 'watchlist' ? (
            <Watchlist />
          ) : (
            <Discover />
          )}
        </div>
      </div>
    </TermCtx.Provider>
  );
}

/* ------------------------------------------------------------------------------- search ---- */

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Search by name/symbol or paste a token / pair address (opens straight away when unambiguous). "/" focuses. */
function SearchBox() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q.trim());
  const search = useQuery({
    queryKey: ['search', dq],
    queryFn: ({ signal }) =>
      get<Envelope<SearchResult>>(`/api/market/search?q=${encodeURIComponent(dq)}`, signal),
    enabled: dq.length >= 2,
    staleTime: 15_000,
  });
  const hits = search.data?.data.hits.slice(0, 12) ?? [];

  const go = useCallback(
    (n: NetworkId, a: string, symbol: string, pair?: string | null) => {
      pushRecent({ network: n, address: a, symbol });
      setOpen(false);
      setQ('');
      input.current?.blur();
      nav(`/terminal/${n}/${a}${pair ? `?pair=${encodeURIComponent(pair)}` : ''}`);
    },
    [nav],
  );

  // A pasted contract that resolves to exactly one token/pair opens immediately (Dexscreener-style).
  const opened = useRef<string | null>(null);
  const exact = search.data?.data.exact;
  useEffect(() => {
    if (!exact || opened.current === dq) return;
    opened.current = dq;
    const hit = search.data?.data.hits.find((h) => h.address.toLowerCase() === exact.token.toLowerCase());
    go(exact.network, exact.token, hit?.symbol ?? shortAddress(exact.token), exact.pair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, dq]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', down);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', down);
    };
  }, []);
  useEffect(() => setHi(0), [dq]);

  return (
    <div ref={box} className="relative flex-1 min-w-[220px] max-w-[560px]">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted pointer-events-none" />
      <Input
        ref={input}
        className="pl-8 pr-8 h-8"
        placeholder="Search by name or paste a contract"
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          const h = hits[hi];
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi((i) => Math.min(hits.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter' && h) {
            go(h.network, h.address, h.symbol, h.bestPair);
          } else if (e.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
        }}
        aria-label="Search tokens"
      />
      <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted border border-line rounded px-1">
        /
      </kbd>
      {open && dq.length >= 2 && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 bg-surface border border-line-strong rounded-[var(--radius)] shadow-[var(--shadow-lg)] overflow-hidden">
          {search.isLoading ? (
            <div className="px-3 py-3 text-[12px] text-muted">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted">
              No match. For a brand-new token, paste its contract.
            </div>
          ) : (
            <ul className="max-h-[420px] overflow-auto py-1" role="listbox">
              {hits.map((h, i) => (
                <li key={`${h.network}:${h.address}`}>
                  <button
                    onMouseEnter={() => setHi(i)}
                    onClick={() => go(h.network, h.address, h.symbol, h.bestPair)}
                    className={cx(
                      'w-full flex items-center gap-3 px-3 h-12 text-left',
                      i === hi && 'bg-surface-2',
                    )}
                  >
                    <TokenAvatar
                      p={{
                        imageUrl: h.imageUrl,
                        base: { address: h.address, symbol: h.symbol, name: h.name },
                        network: h.network,
                      }}
                      size={30}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="font-semibold">{h.symbol}</span>
                        <span className="text-[12px] text-muted truncate">{h.name}</span>
                      </span>
                      <span className="block text-[11px] text-muted num">
                        {NETWORKS[h.network].shortName} · {shortAddress(h.address)} · liq{' '}
                        {fmtUsd(h.liquidityUsd, { compact: true })}
                      </span>
                    </span>
                    <span className="text-right text-[12px]">
                      <Price v={h.priceUsd} className="block" />
                      <Pct v={h.change24h} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- chains / amounts ---- */

/** Chain filter: a compact button (dots of the selected chains) that opens a checklist, Axiom-style. */
function ChainPicker({ chains, setChains }: { chains: NetworkId[]; setChains: (c: NetworkId[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const all = chains.length === NETWORK_IDS.length;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  const toggle = (n: NetworkId) => {
    const next = chains.includes(n) ? chains.filter((c) => c !== n) : [...chains, n];
    // Keep the table's chain order stable whatever the click order.
    setChains(next.length ? NETWORK_IDS.filter((x) => next.includes(x)) : [...NETWORK_IDS]);
  };
  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Chains"
        aria-expanded={open}
        className="h-8 px-2.5 rounded-[var(--radius-sm)] border border-line text-[12px] text-text-2 hover:text-text hover:bg-surface-2 inline-flex items-center gap-2"
      >
        {/* Avatar stack: at most 4 round logos with a ring, then +N. */}
        <span className="flex items-center -space-x-1">
          {(all ? NETWORK_IDS : chains).slice(0, 4).map((n) => (
            <ChainIcon key={n} id={n} size={16} round className="ring-2 ring-surface" />
          ))}
          {(all ? NETWORK_IDS : chains).length > 4 && (
            <span className="h-4 min-w-4 px-1 rounded-full bg-surface-3 ring-2 ring-surface text-[9px] num grid place-items-center text-text-2">
              +{(all ? NETWORK_IDS : chains).length - 4}
            </span>
          )}
        </span>
        {all ? 'All chains' : chains.length === 1 ? NETWORKS[chains[0]!].name : `${chains.length} chains`}
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-56 bg-surface border border-line-strong rounded-[var(--radius)] shadow-[var(--shadow-lg)] py-1">
          <button
            onClick={() => setChains([...NETWORK_IDS])}
            className="w-full flex items-center gap-2.5 px-3 h-8 text-[12px] hover:bg-surface-2"
          >
            <span
              className={cx(
                'size-3.5 rounded-[3px] border grid place-items-center',
                all ? 'bg-accent border-accent' : 'border-line-strong',
              )}
            >
              {all && <Check className="size-3 text-white" />}
            </span>
            All chains
          </button>
          <div className="h-px bg-line my-1" />
          {NETWORK_IDS.map((n) => {
            const on = chains.includes(n);
            return (
              <button
                key={n}
                onClick={() => toggle(n)}
                aria-pressed={on}
                className="w-full flex items-center gap-2.5 px-3 h-8 text-[12px] hover:bg-surface-2"
              >
                <span
                  className={cx(
                    'size-3.5 rounded-[3px] border grid place-items-center',
                    on ? 'bg-accent border-accent' : 'border-line-strong',
                  )}
                >
                  {on && <Check className="size-3 text-white" />}
                </span>
                <ChainIcon id={n} size={16} />
                <span className="flex-1 text-left">{NETWORKS[n].name}</span>
                <span className="text-muted">{NETWORKS[n].shortName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuickAmounts({
  quick,
  setQuick,
}: {
  quick: Record<NetworkId, number>;
  setQuick: (q: Record<NetworkId, number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);
  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-8 px-2.5 rounded-[var(--radius-sm)] border border-line text-[12px] text-text-2 hover:text-text hover:bg-surface-2 inline-flex items-center gap-1.5 whitespace-nowrap"
        title="Amount spent by one quick-buy click, per chain"
      >
        <Zap className="size-3.5 text-accent" />
        Quick buy
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-64 bg-surface border border-line-strong rounded-[var(--radius)] shadow-[var(--shadow-lg)] p-3 space-y-2">
          <div className="text-[12px] text-muted">One click on ⚡ buys for this amount:</div>
          {NETWORK_IDS.map((n) => (
            <label key={n} className="flex items-center gap-2 text-[12px]">
              <ChainIcon id={n} size={16} />
              <span className="w-16">{NETWORKS[n].shortName}</span>
              <Input
                type="number"
                min="0"
                step="any"
                className="h-7 flex-1"
                value={quick[n]}
                onChange={(e) => setQuick({ ...quick, [n]: Math.max(0, Number(e.target.value) || 0) })}
              />
              <span className="w-10 text-muted">{NETWORKS[n].nativeSymbol}</span>
            </label>
          ))}
          <p className="text-[11px] text-muted leading-snug">
            Every quick buy is quoted, simulated and risk-checked. It asks for confirmation when the risk
            check warns or “Confirm every trade” is on (Settings).
          </p>
        </div>
      )}
    </div>
  );
}
