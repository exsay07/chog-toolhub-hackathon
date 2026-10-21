import { NETWORK_IDS, type NetworkId } from '@chog/shared';
import { useKv } from '../userKv';
import type { Priority } from './engine';

/**
 * Axiom-style trade presets: three slots (P1/P2/P3), each with its own slippage and priority for
 * buys and sells, four one-click buy amounts per network and four sell percentages. Synced to the
 * account (term.presets) so they follow the user to any device.
 */

export interface SidePreset {
  slippagePct: number;
  priority: Priority;
}
export interface TradePreset {
  buy: SidePreset;
  sell: SidePreset;
  /** Native amounts per network for the four buy buttons. */
  buyAmounts: Record<NetworkId, [number, number, number, number]>;
  sellPcts: [number, number, number, number];
}
export interface PresetState {
  active: 0 | 1 | 2;
  presets: [TradePreset, TradePreset, TradePreset];
  /** 1–4 buy, Shift+1–4 sell, on the token page. */
  hotkeys: boolean;
  /** After a manual buy, place a take-profit and a stop-loss for the whole position. */
  autoExit: { on: boolean; tpPct: number; slPct: number };
}

const AMOUNTS: Record<NetworkId, [number, number, number, number]> = {
  monad: [1, 5, 10, 25],
  bsc: [0.01, 0.02, 0.05, 0.1],
  base: [0.002, 0.005, 0.01, 0.02],
  solana: [0.05, 0.1, 0.25, 0.5],
  robinhood: [0.002, 0.005, 0.01, 0.02],
  ethereum: [0.002, 0.005, 0.01, 0.02],
  arc: [5, 10, 25, 50],
  ink: [0.002, 0.005, 0.01, 0.02],
  hyperevm: [0.25, 0.5, 1, 2],
};

const preset = (slip: number, prio: Priority): TradePreset => ({
  buy: { slippagePct: slip, priority: prio },
  sell: { slippagePct: slip, priority: prio },
  buyAmounts: structuredClone(AMOUNTS),
  sellPcts: [10, 25, 50, 100],
});

export const DEFAULT_PRESETS: PresetState = {
  active: 0,
  presets: [preset(1, 'low'), preset(5, 'medium'), preset(15, 'high')],
  hotkeys: true,
  autoExit: { on: false, tpPct: 100, slPct: 30 },
};

const PRIOS: Priority[] = ['none', 'low', 'medium', 'high'];
const num4 = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && x > 0 && x < 1e7);
const side = (v: unknown): v is SidePreset => {
  const s = v as SidePreset;
  return (
    !!s &&
    typeof s.slippagePct === 'number' &&
    s.slippagePct > 0 &&
    s.slippagePct <= 50 &&
    PRIOS.includes(s.priority)
  );
};

/** Validates a stored value; missing networks (added later) get their defaults. */
export function normalizePresets(v: unknown): PresetState | null {
  const s = v as PresetState;
  if (!s || typeof s !== 'object' || !Array.isArray(s.presets) || s.presets.length !== 3) return null;
  const presets = s.presets.map((p, i) => {
    const d = DEFAULT_PRESETS.presets[i]!;
    if (!p || !side(p.buy) || !side(p.sell)) return d;
    const buyAmounts = { ...structuredClone(AMOUNTS) };
    for (const n of NETWORK_IDS) if (num4(p.buyAmounts?.[n])) buyAmounts[n] = p.buyAmounts[n];
    return {
      buy: p.buy,
      sell: p.sell,
      buyAmounts,
      sellPcts: num4(p.sellPcts) && p.sellPcts.every((x) => x <= 100) ? p.sellPcts : d.sellPcts,
    };
  }) as PresetState['presets'];
  return {
    active: s.active === 1 || s.active === 2 ? s.active : 0,
    presets,
    hotkeys: s.hotkeys !== false,
    autoExit:
      s.autoExit &&
      typeof s.autoExit.tpPct === 'number' &&
      s.autoExit.tpPct > 0 &&
      typeof s.autoExit.slPct === 'number' &&
      s.autoExit.slPct > 0 &&
      s.autoExit.slPct < 100
        ? { on: !!s.autoExit.on, tpPct: s.autoExit.tpPct, slPct: s.autoExit.slPct }
        : DEFAULT_PRESETS.autoExit,
  };
}

const isState = (v: unknown): v is PresetState => normalizePresets(v) !== null;

export function usePresets() {
  const [raw, set] = useKv<PresetState>('term.presets', DEFAULT_PRESETS, isState);
  return [normalizePresets(raw) ?? DEFAULT_PRESETS, set] as const;
}
