import { useEffect, useRef } from 'react';
import { readKv, writeKv } from '../userKv';
import { useQuery } from '@tanstack/react-query';
import {
  NETWORKS,
  canTrade,
  shortAddress,
  type NetworkId,
  type NewPool,
  type SniperConfig,
  type TokenSecurity,
} from '@chog/shared';
import { get } from '../api';
import { fetchSnipers, type SniperRow } from '../snipers';
import { useSettings } from '../settings';
import { useNotify } from '../notify';
import { socket } from '../ws';
import { isUnlocked } from '../vault/vault';
import { killSwitch, prepareSwap } from '../trade/engine';
import { autoLog, tokenBalance } from './common';

export type { SniperRow };

/** Pure filter: does a newly discovered pool match the user's criteria? Returns reasons when not. */
export function poolMatches(p: NewPool, c: SniperConfig, now = Date.now()): string[] {
  const f = c.filters;
  const r: string[] = [];
  if (p.network !== c.network) r.push('network');
  if (p.liquidityUsd === null) r.push('liquidity unknown');
  else {
    if (p.liquidityUsd < f.minLiquidityUsd) r.push('liquidity below min');
    if (f.maxLiquidityUsd !== null && p.liquidityUsd > f.maxLiquidityUsd) r.push('liquidity above max');
  }
  if ((p.volume5mUsd ?? 0) < f.minVolume5mUsd) r.push('5m volume below min');
  if (p.createdAt === null || now - p.createdAt > f.maxPoolAgeMin * 60_000)
    r.push('pool too old / age unknown');
  if (
    f.quoteSymbols.length &&
    !f.quoteSymbols.map((s) => s.toUpperCase()).includes(p.quoteSymbol.toUpperCase())
  )
    r.push('quote asset');
  if (f.nameIncludes && !`${p.baseSymbol} ${p.name}`.toLowerCase().includes(f.nameIncludes.toLowerCase()))
    r.push('name filter');
  if (f.minFdvUsd > 0 && (p.fdvUsd === null || p.fdvUsd < f.minFdvUsd)) r.push('FDV below min');
  if (f.maxFdvUsd !== null && p.fdvUsd !== null && p.fdvUsd > f.maxFdvUsd) r.push('FDV above max');
  if (f.minBuys5m > 0 && (p.buys5m ?? 0) < f.minBuys5m) r.push('too few buyers (5m)');
  if (f.dexIncludes && !p.dex.toLowerCase().includes(f.dexIncludes.toLowerCase())) r.push('DEX filter');
  if (c.antiRug.blacklist.some((a) => a.toLowerCase() === p.baseToken.toLowerCase()))
    r.push('blacklisted token');
  return r;
}

/**
 * Anti-rug verdict from the scanner (BasedBot-style). Unknown values never block on their own —
 * "require a security scan" covers tokens the scanner cannot read at all.
 */
export function antiRugReasons(sec: TokenSecurity | null, c: SniperConfig): string[] {
  const a = c.antiRug;
  const f = c.filters;
  const r: string[] = [];
  if (!sec) return f.requireSecurityScan ? ['security scan required but unavailable'] : [];
  if (sec.honeypot) r.push('honeypot');
  if (sec.cannotSell) r.push('cannot sell all');
  if ((sec.buyTaxPct ?? 0) > f.maxBuyTaxPct) r.push('buy tax above limit');
  if ((sec.sellTaxPct ?? 0) > f.maxSellTaxPct) r.push('sell tax above limit');
  if (a.blockMintable && sec.isMintable) r.push('mint authority / mintable');
  if (a.blockFreezable && sec.isFreezable) r.push('freeze authority');
  if (a.blockOwnerPowers && (sec.hiddenOwner || sec.ownerCanChangeBalance || sec.ownerPowers))
    r.push('owner powers (hidden owner / balances / taxes)');
  if (a.requireOpenSource && sec.isOpenSource === false) r.push('not open source');
  if (a.maxTop10Pct !== null && sec.top10HolderPct !== null && sec.top10HolderPct > a.maxTop10Pct)
    r.push(`top-10 holders ${sec.top10HolderPct.toFixed(0)}%`);
  if (a.maxCreatorPct !== null && (sec.creatorPct ?? null) !== null && sec.creatorPct! > a.maxCreatorPct)
    r.push(`creator holds ${sec.creatorPct!.toFixed(1)}%`);
  if (a.minLpLockedPct !== null && (sec.lpLockedPct ?? null) !== null && sec.lpLockedPct! < a.minLpLockedPct)
    r.push(`LP locked/burned ${sec.lpLockedPct!.toFixed(0)}%`);
  if (sec.creator && a.blacklist.some((x) => x.toLowerCase() === sec.creator!.toLowerCase()))
    r.push('blacklisted creator');
  return r;
}

export interface Entry {
  sniperId: string;
  network: NetworkId;
  token: string;
  symbol: string;
  entryPriceUsd: number;
  at: number;
  /** Highest price seen since entry (trailing stop). */
  peakPriceUsd?: number;
  /** Token amount right after the buy (ladder steps sell a share of it). */
  qty0?: number;
  /** Ladder steps already sold (indices). */
  steps?: number[];
  creator?: string | null;
  creatorBal0?: number | null;
  /** Vault wallet that holds the position (EVM); null/undefined = main. */
  wallet?: string | null;
}

export type ExitAction =
  { kind: 'all'; reason: string } | { kind: 'step'; step: number; sellPct: number } | null;

/** Pure exit decision for one position (exported for tests). Priority: dev sell, SL, trailing, TP, ladder. */
export function exitDecision(
  e: Entry,
  c: SniperConfig['exit'],
  devSellExitPct: number | null,
  px: number,
  creatorBal: number | null,
): ExitAction {
  const ch = ((px - e.entryPriceUsd) / e.entryPriceUsd) * 100;
  if (
    devSellExitPct !== null &&
    creatorBal !== null &&
    e.creatorBal0 &&
    e.creatorBal0 > 0 &&
    ((e.creatorBal0 - creatorBal) / e.creatorBal0) * 100 >= devSellExitPct
  )
    return { kind: 'all', reason: 'dev sold' };
  if (c.stopLossPct !== null && ch <= -c.stopLossPct) return { kind: 'all', reason: `SL ${ch.toFixed(1)}%` };
  const peak = Math.max(e.peakPriceUsd ?? e.entryPriceUsd, px);
  if (
    c.trailingStopPct !== null &&
    peak > e.entryPriceUsd &&
    px > 0 &&
    ((peak - px) / peak) * 100 >= c.trailingStopPct
  )
    return { kind: 'all', reason: `trailing stop (${(((px - peak) / peak) * 100).toFixed(1)}% from peak)` };
  if (c.takeProfitPct !== null && ch >= c.takeProfitPct)
    return { kind: 'all', reason: `TP +${ch.toFixed(1)}%` };
  const done = new Set(e.steps ?? []);
  for (const [i, s] of c.ladder.entries())
    if (!done.has(i) && ch >= s.atPct) return { kind: 'step', step: i, sellPct: s.sellPct };
  return null;
}

// Entry prices drive the exits, so they are synced to the account (lib/userKv.ts).
const isEntries = (v: unknown): v is Entry[] => Array.isArray(v);
export const loadEntries = (): Entry[] => readKv<Entry[]>('sniper.entries', [], isEntries);
export const saveEntries = (e: Entry[]) => writeKv('sniper.entries', e.slice(-100));

/**
 * Executes armed sniper configs in this tab while the vault is unlocked. Discovery is shared
 * server-side (one GeckoTerminal poll per network for all users); decisions are per user here.
 */
export function SniperRunner() {
  const { settings } = useSettings();
  const { notify } = useNotify();
  const q = useQuery({
    queryKey: ['automations', 'sniper'],
    queryFn: fetchSnipers,
    refetchInterval: 30_000,
  });
  const armed = (q.data ?? []).filter((s) => s.data.enabled && s.status === 'armed');
  const all = q.data ?? [];
  const nets = [...new Set(armed.map((s) => s.data.network))].sort().join(',');
  const ref = useRef({ armed, all, risk: settings.risk, notify });
  ref.current = { armed, all, risk: settings.risk, notify };
  const handled = useRef(new Set<string>());
  /** Buys started this session per sniper (timestamps) — a guard against bursts before entries sync. */
  const buys = useRef(new Map<string, number[]>());

  // Subscribe to new pools for each armed network.
  useEffect(() => {
    if (!nets) return;
    const unsubs = nets
      .split(',')
      .map((n) =>
        socket.subscribe(
          `pools:${n}`,
          { t: 'subNewPools', network: n as NetworkId },
          { t: 'unsubNewPools', network: n as NetworkId },
        ),
      );
    return () => unsubs.forEach((u) => u());
  }, [nets]);

  useEffect(
    () =>
      socket.on((m) => {
        if (m.t !== 'newPool') return;
        for (const s of ref.current.armed) void onPool(s, m.pool);
      }),
    [],
  );

  async function onPool(s: SniperRow, p: NewPool) {
    const c = s.data;
    const key = `${s.id}:${p.network}:${p.baseToken}`;
    if (handled.current.has(key)) return; // duplicate signal
    const miss = poolMatches(p, c);
    if (miss.length) return;
    handled.current.add(key);
    const label = `${p.baseSymbol}/${p.quoteSymbol} on ${NETWORKS[p.network].name}`;
    ref.current.notify({
      category: 'sniper',
      tone: 'info',
      title: `Sniper “${c.name}” match: ${label}`,
      body: `liq $${Math.round(p.liquidityUsd ?? 0)} · ${c.mode === 'alert' ? 'alert only' : 'evaluating auto-buy'}`,
    });
    autoLog('sniper', 'info', `Match ${label} (pool ${p.poolAddress})`, s.id);
    if (c.mode !== 'auto') return;
    if (killSwitch.active) return autoLog('sniper', 'warn', 'Skipped: emergency stop', s.id);
    if (!isUnlocked()) return autoLog('sniper', 'warn', 'Skipped: trading wallet locked', s.id);
    if (!canTrade(p.network)) return autoLog('sniper', 'warn', 'Skipped: trading disabled on network', s.id);
    const now = Date.now();
    const mine = loadEntries().filter((e) => e.sniperId === s.id);
    const recent = [...(buys.current.get(s.id) ?? []), ...mine.map((e) => e.at)].filter(
      (t, i, a) => now - t < 3_600_000 && a.indexOf(t) === i,
    );
    if (recent.length >= c.limits.maxBuysPerHour)
      return autoLog(
        'sniper',
        'warn',
        `Skipped ${label}: ${c.limits.maxBuysPerHour} buys/hour reached`,
        s.id,
      );
    if (new Set(mine.map((e) => e.token.toLowerCase())).size >= c.limits.maxOpenPositions)
      return autoLog('sniper', 'warn', `Skipped ${label}: ${c.limits.maxOpenPositions} open positions`, s.id);
    if (mine.some((e) => e.token.toLowerCase() === p.baseToken.toLowerCase()))
      return autoLog('sniper', 'info', `Skipped ${label}: already holding`, s.id);
    // EVM snipers can buy from several vault wallets; Solana always uses the main one.
    const wallets: Array<string | null> =
      NETWORKS[p.network].kind === 'evm' && c.wallets.length ? c.wallets : [null];
    // Per-sniper cap can only tighten the global per-trade limit (it applies to each wallet's buy).
    const risk = {
      ...ref.current.risk,
      maxTradeUsd: Math.min(ref.current.risk.maxTradeUsd, c.maxTradeUsd),
    };
    const req = (wallet: string | null) => ({
      network: p.network,
      side: 'buy' as const,
      token: p.baseToken,
      amount: c.entryAmountNative,
      slippageBps: c.slippageBps,
      priority: c.priorityFee,
      deadlineSec: c.deadlineSec,
      source: 'sniper' as const,
      automated: true,
      liquidityUsd: p.liquidityUsd,
      tokenSymbol: p.baseSymbol,
      wallet,
    });
    let first;
    try {
      first = await prepareSwap(req(wallets[0]!), risk);
    } catch (e) {
      return autoLog('sniper', 'error', `Quote failed for ${label}: ${(e as Error).message}`, s.id);
    }
    const sec = first.security;
    const reasons = [...first.risk.reasons, ...antiRugReasons(sec, c)];
    if (reasons.length) return autoLog('sniper', 'warn', `Not buying ${label}: ${reasons.join('; ')}`, s.id);
    buys.current.set(s.id, [...(buys.current.get(s.id) ?? []), now]);
    const creator = sec?.creator ?? null;
    const creatorBal0 =
      creator && c.antiRug.devSellExitPct !== null
        ? await tokenBalance(p.network, p.baseToken, creator).catch(() => null)
        : null;
    let bought = 0;
    for (const [i, wallet] of wallets.entries()) {
      const who = wallet ? ` [${shortAddress(wallet)}]` : '';
      try {
        // Each wallet gets its own fresh quote (and risk check) except the first, already checked.
        const prep = i === 0 ? first : await prepareSwap(req(wallet), risk);
        if (!prep.risk.ok) throw new Error(prep.risk.reasons.join('; '));
        const hash = await prep.execute();
        bought++;
        if (p.priceUsd)
          saveEntries([
            ...loadEntries(),
            {
              sniperId: s.id,
              network: p.network,
              token: p.baseToken,
              symbol: p.baseSymbol,
              entryPriceUsd: p.priceUsd,
              at: Date.now(),
              peakPriceUsd: p.priceUsd,
              steps: [],
              creator,
              creatorBal0,
              wallet,
            },
          ]);
        autoLog('sniper', 'info', `Buy submitted for ${label}${who}: ${hash}`, s.id);
        ref.current.notify({
          category: 'execution',
          tone: 'up',
          title: `Sniper buy submitted: ${p.baseSymbol}${who}`,
          body: 'Awaiting confirmation',
          link: { href: NETWORKS[p.network].explorer.tx(hash), label: 'Explorer' },
        });
      } catch (e) {
        autoLog('sniper', 'error', `Buy failed for ${label}${who}: ${(e as Error).message}`, s.id);
        ref.current.notify({
          category: 'failed',
          tone: 'down',
          title: `Sniper buy failed${who}`,
          body: (e as Error).message.slice(0, 140),
        });
      }
    }
    if (wallets.length > 1)
      autoLog('sniper', 'info', `${label}: bought from ${bought}/${wallets.length} wallets`, s.id);
  }

  // Exit manager: dev-sell, stop-loss, trailing stop, take-profit and ladder steps (every 15 s).
  useEffect(() => {
    let busy = false;
    const t = setInterval(() => {
      if (busy) return;
      busy = true;
      void checkExits().finally(() => (busy = false));
    }, 15_000);
    return () => clearInterval(t);
    // checkExits reads the latest state through `ref`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sell(e: Entry, qty: number, why: string) {
    const prep = await prepareSwap(
      {
        network: e.network,
        side: 'sell',
        token: e.token,
        amount: qty,
        slippageBps: Math.min(ref.current.risk.maxSlippageBps, 1000),
        priority: 'medium',
        deadlineSec: 300,
        source: 'sniper',
        automated: true,
        liquidityUsd: null,
        tokenSymbol: e.symbol,
        wallet: e.wallet ?? null,
      },
      ref.current.risk,
    );
    if (!prep.risk.ok) throw new Error(`blocked by risk limits: ${prep.risk.reasons.join('; ')}`);
    const hash = await prep.execute();
    autoLog('sniper', 'info', `Exit (${why}) for ${e.symbol}: ${hash}`, e.sniperId);
    ref.current.notify({
      category: 'execution',
      tone: why.startsWith('TP') || why.startsWith('ladder') ? 'up' : 'down',
      title: `Sniper exit: ${e.symbol} · ${why}`,
      body: 'Sell submitted · awaiting confirmation',
      link: { href: NETWORKS[e.network].explorer.tx(hash), label: 'Explorer' },
    });
  }

  async function checkExits() {
    if (killSwitch.active || !isUnlocked()) return;
    const entries = loadEntries();
    if (!entries.length) return;
    const byNet = new Map<NetworkId, Entry[]>();
    for (const e of entries) byNet.set(e.network, [...(byNet.get(e.network) ?? []), e]);
    const out = new Map<Entry, Entry | null>(); // null = position closed
    for (const [n, list] of byNet) {
      let prices: Record<string, number | null>;
      try {
        prices = (
          await get<{ data: Record<string, number | null> }>(
            `/api/market/prices?network=${n}&tokens=${list.map((x) => x.token).join(',')}`,
          )
        ).data;
      } catch {
        continue;
      }
      for (const e of list) {
        // A deleted sniper's positions have no exit rules: they stay listed for manual handling.
        const cfg = ref.current.all.find((s) => s.id === e.sniperId)?.data;
        const px = prices[e.token.toLowerCase()];
        if (!cfg || px === null || px === undefined) continue;
        let cur: Entry = { ...e, peakPriceUsd: Math.max(e.peakPriceUsd ?? e.entryPriceUsd, px) };
        try {
          const qty = await tokenBalance(n, e.token, e.wallet ?? undefined);
          if (!(qty > 0)) {
            // Bought minutes ago and the balance is still 0 → the buy may not be mined yet.
            out.set(e, Date.now() - e.at > 10 * 60_000 ? null : cur);
            continue;
          }
          if (cur.qty0 === undefined) cur = { ...cur, qty0: qty };
          const dev =
            cur.creator && cfg.antiRug.devSellExitPct !== null && cur.creatorBal0
              ? await tokenBalance(n, e.token, cur.creator).catch(() => null)
              : null;
          const act = exitDecision(cur, cfg.exit, cfg.antiRug.devSellExitPct, px, dev);
          if (act?.kind === 'all') {
            await sell(cur, qty, act.reason);
            out.set(e, null);
          } else if (act?.kind === 'step') {
            const part = Math.min(qty, ((cur.qty0 ?? qty) * act.sellPct) / 100);
            await sell(cur, part, `ladder +${cfg.exit.ladder[act.step]!.atPct}% · ${act.sellPct}%`);
            const next = { ...cur, steps: [...(cur.steps ?? []), act.step] };
            out.set(e, part >= qty * 0.999 ? null : next);
          } else out.set(e, cur);
        } catch (err) {
          autoLog('sniper', 'error', `Exit for ${e.symbol} failed: ${(err as Error).message}`, e.sniperId);
          out.set(e, cur);
        }
      }
    }
    // Re-read: a buy may have added an entry while this pass ran.
    saveEntries(
      loadEntries().flatMap((e) => {
        const match = [...out.keys()].find(
          (k) => k.token === e.token && k.sniperId === e.sniperId && k.at === e.at && k.wallet === e.wallet,
        );
        if (!match) return [e];
        const v = out.get(match);
        return v ? [v] : [];
      }),
    );
  }

  return null;
}
