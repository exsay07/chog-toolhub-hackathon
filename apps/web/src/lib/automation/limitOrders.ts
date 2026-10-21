import { useEffect, useRef } from 'react';
import { NETWORKS, canTrade, type NetworkId } from '@chog/shared';
import { get } from '../api';
import { useSettings } from '../settings';
import { useNotify } from '../notify';
import { isUnlocked } from '../vault/vault';
import { killSwitch, prepareSwap } from '../trade/engine';
import { isTriggered, orderKind, readOrders, updateOrders, type LimitOrder } from '../trade/orders';
import { autoLog, tokenBalance } from './common';

const TICK_MS = 6_000;
/** Orders this tab is executing right now. */
const inFlight = new Set<string>();

/**
 * Watches open limit / TP / SL orders and sends the swap when the price crosses the trigger. Only
 * one tab runs it (Web Locks), so two open tabs never fill the same order twice.
 */
export function LimitOrderRunner() {
  const { settings } = useSettings();
  const { notify } = useNotify();
  const ref = useRef({ risk: settings.risk, notify });
  ref.current = { risk: settings.risk, notify };

  useEffect(() => {
    let stop = false;
    let timer = 0;
    let release: (() => void) | null = null;
    const loop = async () => {
      if (stop) return;
      try {
        await tick();
      } finally {
        if (!stop) timer = window.setTimeout(() => void loop(), TICK_MS);
      }
    };
    if (navigator.locks)
      void navigator.locks.request(
        'chog.limitOrders',
        () =>
          new Promise<void>((r) => {
            release = r;
            if (!stop) void loop();
            else r();
          }),
      );
    else void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
      release?.();
    };
    // tick / fill read the latest settings through `ref`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function tick() {
    const now = Date.now();
    // A tab closed mid-swap: the tx may or may not have been sent, so never re-open it (no double fill).
    if (readOrders().some((o) => o.status === 'executing' && !inFlight.has(o.id)))
      updateOrders((l) =>
        l.map((o) =>
          o.status === 'executing' && !inFlight.has(o.id)
            ? {
                ...o,
                status: 'failed',
                error: 'interrupted — check Portfolio before re-placing',
                doneAt: now,
              }
            : o,
        ),
      );
    // Expire stale orders.
    if (readOrders().some((o) => o.status === 'open' && o.expiresAt !== null && o.expiresAt < now))
      updateOrders((l) =>
        l.map((o) =>
          o.status === 'open' && o.expiresAt !== null && o.expiresAt < now
            ? { ...o, status: 'cancelled', error: 'expired', doneAt: now }
            : o,
        ),
      );
    const open = readOrders().filter((o) => o.status === 'open');
    if (!open.length || killSwitch.active || !isUnlocked()) return;
    const byNet = new Map<NetworkId, LimitOrder[]>();
    for (const o of open) byNet.set(o.network, [...(byNet.get(o.network) ?? []), o]);
    for (const [n, list] of byNet) {
      let prices: Record<string, number | null>;
      try {
        const tokens = [...new Set(list.map((o) => o.token))].join(',');
        prices = (
          await get<{ data: Record<string, number | null> }>(
            `/api/market/prices?network=${n}&tokens=${tokens}`,
          )
        ).data;
      } catch {
        continue;
      }
      for (const o of list) {
        const px = prices[o.token.toLowerCase()];
        if (isTriggered(o, px)) await fill(o, px!);
      }
    }
  }

  async function fill(o: LimitOrder, px: number) {
    // Re-read: a sibling (TP/SL group) may have filled a moment ago.
    const cur = readOrders().find((x) => x.id === o.id);
    if (!cur || cur.status !== 'open') return;
    inFlight.add(o.id);
    updateOrders((l) => l.map((x) => (x.id === o.id ? { ...x, status: 'executing' } : x)));
    const kind = orderKind(o);
    const label = `${kind} ${o.symbol} on ${NETWORKS[o.network].name}`;
    const finish = (patch: Partial<LimitOrder>) =>
      updateOrders((l) =>
        l.map((x) => {
          if (x.id === o.id) return { ...x, ...patch, doneAt: Date.now() };
          // A filled order cancels the rest of its group.
          if (patch.status === 'done' && o.group && x.group === o.group && x.status === 'open')
            return { ...x, status: 'cancelled', error: `${kind} filled`, doneAt: Date.now() };
          return x;
        }),
      );
    try {
      if (!canTrade(o.network)) throw new Error('trading is disabled on this network');
      let amount = o.amount;
      if (o.side === 'sell') {
        const bal = await tokenBalance(o.network, o.token, o.wallet ?? undefined);
        amount = o.amount >= 100 ? bal : (bal * o.amount) / 100;
        if (!(amount > 0)) throw new Error('no tokens to sell');
      }
      const prep = await prepareSwap(
        {
          network: o.network,
          side: o.side,
          token: o.token,
          amount,
          slippageBps: Math.round(o.slippagePct * 100),
          priority: o.priority,
          deadlineSec: 300,
          source: 'limit',
          automated: true,
          liquidityUsd: null,
          tokenSymbol: o.symbol,
          wallet: o.wallet ?? null,
        },
        ref.current.risk,
      );
      if (!prep.risk.ok) throw new Error(`blocked by risk limits: ${prep.risk.reasons.join('; ')}`);
      const hash = await prep.execute();
      finish({ status: 'done', hash });
      autoLog('trade', 'info', `${label} filled at ~$${px}: ${hash}`);
      ref.current.notify({
        category: 'execution',
        tone: o.side === 'buy' || o.when === 'above' ? 'up' : 'down',
        title: `${label} triggered`,
        body: 'Swap submitted · waiting for on-chain confirmation.',
        link: { href: NETWORKS[o.network].explorer.tx(hash), label: NETWORKS[o.network].explorer.name },
      });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      finish({ status: 'failed', error: msg });
      autoLog('trade', 'error', `${label} failed: ${msg}`);
      ref.current.notify({ category: 'failed', tone: 'down', title: `${label} failed`, body: msg });
    } finally {
      inFlight.delete(o.id);
    }
  }

  return null;
}
