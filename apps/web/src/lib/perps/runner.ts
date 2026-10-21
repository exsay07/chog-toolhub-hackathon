import { useSyncExternalStore } from 'react';
import type { PerpsTaskConfig, PerplNet } from '@chog/shared';
import { patch } from '../api';
import { autoLog } from '../automation/common';
import { killSwitch } from '../trade/engine';
import { loadKey, marketSymbol, perplContext } from './perpl';
import { PerplFarmer } from './perplFarmer';
import { BulkFarmer } from './bulkFarmer';
import { bulkMarkets, loadAgent, type BulkNet } from './bulk';

/**
 * Perps bots running in this tab. They live outside React so switching pages never stops them;
 * closing the tab does (the browser asks first). The emergency stop closes every one of them.
 */

export type Farm = PerplFarmer | BulkFarmer;
const farms = new Map<string, Farm>();
const subs = new Set<() => void>();
let version = 0;
let emitTimer: number | null = null;
/**
 * Bots update many times a second (every price tick); the panels only need a few frames a second.
 * Updates are coalesced into at most one render every 250 ms.
 */
const emit = () => {
  if (emitTimer !== null) return;
  emitTimer = window.setTimeout(() => {
    emitTimer = null;
    version++;
    subs.forEach((f) => f());
  }, 250);
};

export function useFarms() {
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => version,
  );
  return farms;
}

export const runningFarms = () =>
  [...farms.values()].filter((f) => !['stopped', 'error'].includes(f.state.state));

/** Mainnet / testnet choice, remembered per venue on this device. */
export function farmNet(platform: 'perpl' | 'bulk'): 'mainnet' | 'testnet' {
  try {
    return localStorage.getItem(`chog.${platform}.net`) === 'testnet' ? 'testnet' : 'mainnet';
  } catch {
    return 'mainnet';
  }
}
export function setFarmNet(platform: 'perpl' | 'bulk', n: 'mainnet' | 'testnet') {
  try {
    localStorage.setItem(`chog.${platform}.net`, n);
  } catch {
    /* storage unavailable */
  }
  emit();
}
export const perplNet = (): PerplNet => farmNet('perpl');

function assertCanStart(id: string) {
  if (killSwitch.active) throw new Error('Emergency stop is active — release it first');
  const existing = farms.get(id);
  if (existing && !['stopped', 'error'].includes(existing.state.state))
    throw new Error('This bot is already running');
}

function track(id: string, f: Farm) {
  let lastStatus = '';
  f.subscribe(() => {
    emit();
    const st = f.state.state;
    const status = st === 'error' ? 'error' : st === 'stopped' ? 'stopped' : 'running';
    if (status !== lastStatus) {
      lastStatus = status;
      void patch(`/api/automations/perps/${id}/status`, { status }).catch(() => {});
    }
  });
  farms.set(id, f);
  f.start();
  emit();
  return f;
}

/** Warnings, errors and cycle summaries go to the account's automation log (never secrets). */
const logTo = (id: string) => (level: 'info' | 'warn' | 'error', msg: string) => {
  const notable = level === 'error' || /^Cycle \d+ done|reached|^Stopped|Emergency stop/.test(msg);
  if (level !== 'info' || notable || /^Starting/.test(msg)) autoLog('perps', level, msg, id);
  if (notable) farmEvents.forEach((f) => f({ id, level, msg }));
};

/** Notable bot moments (cycle done, limits hit, errors) for the in-app notifications. */
export interface FarmEvent {
  id: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}
const farmEvents = new Set<(e: FarmEvent) => void>();
export function onFarmEvent(fn: (e: FarmEvent) => void) {
  farmEvents.add(fn);
  return () => void farmEvents.delete(fn);
}

export async function startBulkFarm(id: string, cfg: PerpsTaskConfig, owner: string, net: BulkNet) {
  assertCanStart(id);
  const agent = await loadAgent(net, owner);
  if (!agent) throw new Error('Authorise the bot with Phantom first');
  const market = (await bulkMarkets(net)).find((m) => m.symbol === cfg.pair && m.status === 'TRADING');
  if (!market) throw new Error(`${cfg.pair} is not tradable on Bulk ${net} right now`);
  if (cfg.sizeUsd < market.minNotional)
    throw new Error(`Bulk's minimum order on ${cfg.pair} is $${market.minNotional} — raise the order size`);
  return track(id, new BulkFarmer(id, agent, market, cfg, logTo(id)));
}

export async function startPerplFarm(id: string, cfg: PerpsTaskConfig, address: string, net: PerplNet) {
  assertCanStart(id);
  const key = await loadKey(net, address);
  if (!key) throw new Error('Create or paste a Perpl API key first');
  const ctx = await perplContext(net);
  const base = cfg.pair.split('-')[0];
  const market = ctx.markets.find((m) => marketSymbol(m) === base && m.config.is_open);
  if (!market) throw new Error(`${base} is not tradable on Perpl ${net} right now`);

  return track(id, new PerplFarmer(id, key, market, cfg, logTo(id)));
}

export function stopFarm(id: string, reason?: string) {
  farms.get(id)?.stop(reason);
}

export function forgetFarm(id: string) {
  const f = farms.get(id);
  if (f && ['stopped', 'error'].includes(f.state.state)) {
    farms.delete(id);
    emit();
  }
}

killSwitch.listeners.add(() => {
  if (killSwitch.active) for (const f of farms.values()) f.stop('Emergency stop');
});

window.addEventListener('beforeunload', (e) => {
  if (runningFarms().length) e.preventDefault();
});

/** Session totals across every bot in this tab, sampled for the volume sparkline. */
export interface FarmTotals {
  running: number;
  volumeUsd: number;
  feesUsd: number;
  pnlUsd: number;
  cycles: number;
}
export function farmTotals(): FarmTotals {
  const t: FarmTotals = { running: 0, volumeUsd: 0, feesUsd: 0, pnlUsd: 0, cycles: 0 };
  for (const f of farms.values()) {
    const s = f.state;
    if (!['stopped', 'error'].includes(s.state)) t.running++;
    t.volumeUsd += s.volumeUsd;
    t.feesUsd += s.feesUsd;
    t.pnlUsd += s.pnlUsd;
    t.cycles += s.cycles;
  }
  return t;
}
export const volumeHistory: Array<{ t: number; v: number }> = [];
window.setInterval(() => {
  if (!farms.size) return;
  volumeHistory.push({ t: Date.now(), v: farmTotals().volumeUsd });
  if (volumeHistory.length > 360) volumeHistory.shift();
  emit();
}, 5_000);
