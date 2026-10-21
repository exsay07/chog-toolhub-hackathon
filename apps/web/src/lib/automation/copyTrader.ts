import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  NETWORKS,
  canTrade,
  tokenKey,
  type CopyConfig,
  type NetworkId,
  type RiskLimits,
  type TrackerEvent,
} from '@chog/shared';
import { get } from '../api';
import { useSettings } from '../settings';
import { useNotify } from '../notify';
import { socket } from '../ws';
import { isUnlocked } from '../vault/vault';
import { killSwitch, prepareSwap } from '../trade/engine';
import { autoLog, nativeBalance, tokenBalance } from './common';

interface TrackedWallet {
  id: string;
  network: NetworkId;
  address: string;
  label: string;
  enabled: boolean;
  copy: CopyConfig | null;
}

/** Events older than this are not copied: the price has likely moved. */
const MAX_EVENT_AGE_MS = 90_000;

/**
 * Copy-trading executor. Runs in this tab only, only while the trading vault is unlocked and the
 * kill switch is off. Each copy goes through the same risk engine + simulation as manual trades.
 */
export function CopyTradeRunner() {
  const { settings } = useSettings();
  const { notify } = useNotify();
  const wallets = useQuery({
    queryKey: ['tracked-wallets'],
    queryFn: () => get<TrackedWallet[]>('/api/tracker/wallets'),
    refetchInterval: 30_000,
  });
  const seen = useRef(new Set<string>());
  const last = useRef(new Map<string, number>());
  const ref = useRef({ wallets: wallets.data, risk: settings.risk, notify });
  ref.current = { wallets: wallets.data, risk: settings.risk, notify };

  useEffect(
    () =>
      socket.on((m) => {
        if (m.t !== 'tracker') return;
        void handle(m.event);
      }),
    [],
  );

  async function handle(e: TrackerEvent) {
    const { wallets: ws, risk, notify: nfy } = ref.current;
    const w = ws?.find((x) => x.id === e.walletId);
    const c = w?.copy;
    if (!w || !c?.enabled || !w.enabled) return;
    if (e.kind !== 'buy' && !(e.kind === 'sell' && c.copySells)) return;
    if (!e.token) return;
    // Duplicate-event protection (re-delivery after reconnect, multiple tabs observe the same event).
    const dedupe = `${e.network}:${e.hash}:${e.token}:${e.kind}`;
    if (seen.current.has(dedupe)) return;
    seen.current.add(dedupe);
    if (seen.current.size > 2000) seen.current = new Set([...seen.current].slice(-1000));

    const label = `${w.label} ${e.kind} ${e.tokenSymbol ?? e.token.slice(0, 8)} on ${NETWORKS[e.network].name}`;
    const skip = (why: string) => autoLog('copy', 'info', `Skipped copy of ${label}: ${why}`, null);
    if (killSwitch.active) return skip('emergency stop active');
    if (!isUnlocked()) return skip('trading wallet locked');
    if (!canTrade(e.network)) return skip('trading disabled on network');
    if (Date.now() - e.at > MAX_EVENT_AGE_MS)
      return skip(`event too old (${Math.round((Date.now() - e.at) / 1000)}s)`);
    const key = tokenKey(e.network, e.token);
    const tokLower = e.token.toLowerCase();
    if (c.tokenBlocklist.map((x) => x.toLowerCase()).includes(tokLower)) return skip('token blocklisted');
    if (c.tokenAllowlist.length && !c.tokenAllowlist.map((x) => x.toLowerCase()).includes(tokLower))
      return skip('token not in allowlist');
    const lastAt = last.current.get(`${w.id}:${key}`);
    if (lastAt && Date.now() - lastAt < c.cooldownSec * 1000) return skip('cooldown');

    try {
      let amount: number;
      if (e.kind === 'buy') {
        if (c.sizing.mode === 'fixed') amount = c.sizing.amountNative;
        else {
          // Percentage of the leader's native spend, when the counter leg was native.
          if (e.counterAmount === null || !e.counterSymbol || ['USDC', 'USDT'].includes(e.counterSymbol))
            return skip('leader size unknown in native terms');
          amount = (e.counterAmount * c.sizing.percent) / 100;
        }
        const bal = await nativeBalance(e.network);
        if (amount > bal * 0.98) return skip(`insufficient ${NETWORKS[e.network].nativeSymbol} balance`);
      } else {
        amount = await tokenBalance(e.network, e.token);
        if (!(amount > 0)) return skip('no position to sell');
      }
      // Per-wallet limits tighten (never loosen) the global ones.
      const limits: RiskLimits = {
        ...risk,
        maxTradeUsd: Math.min(risk.maxTradeUsd, c.maxTradeUsd),
        maxDailyExposureUsd: Math.min(risk.maxDailyExposureUsd, c.maxDailyUsd),
        maxSlippageBps: Math.min(risk.maxSlippageBps, c.slippageBps),
        minLiquidityUsd: Math.max(risk.minLiquidityUsd, c.minLiquidityUsd),
      };
      const pairs = await get<{ data: Array<{ liquidityUsd: number | null }> }>(
        `/api/market/token/${e.network}/${e.token}`,
      ).catch(() => null);
      const liq = pairs?.data[0]?.liquidityUsd ?? null;
      const p = await prepareSwap(
        {
          network: e.network,
          side: e.kind === 'buy' ? 'buy' : 'sell',
          token: e.token,
          amount,
          slippageBps: c.slippageBps,
          priority: 'medium',
          deadlineSec: 120,
          source: 'copy',
          automated: true,
          liquidityUsd: liq,
          tokenSymbol: e.tokenSymbol ?? undefined,
        },
        limits,
      );
      if (!p.risk.ok) return skip(p.risk.reasons.join('; '));
      last.current.set(`${w.id}:${key}`, Date.now());
      const hash = await p.execute();
      autoLog(
        'copy',
        'info',
        `Copied ${label}: submitted ${hash} (quote ${p.amountUsd?.toFixed(2) ?? '?'} USD)`,
      );
      nfy({
        category: 'execution',
        tone: 'info',
        title: `Copy ${e.kind} submitted`,
        body: `${label} — awaiting confirmation`,
        link: { href: NETWORKS[e.network].explorer.tx(hash), label: 'Explorer' },
      });
    } catch (err) {
      autoLog('copy', 'error', `Copy of ${label} failed: ${(err as Error).message}`);
      nfy({
        category: 'failed',
        tone: 'down',
        title: 'Copy trade failed',
        body: `${label}: ${(err as Error).message.slice(0, 120)}`,
      });
    }
  }

  return null;
}
