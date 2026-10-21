import { describe, expect, it } from 'vitest';
import { moodOf, type CardData } from '../src/components/pnlRender';

const position = (roe: number, liquidated = false): CardData => ({
  kind: 'position',
  pair: 'MON-PERP',
  side: 'long',
  leverage: 20,
  roe,
  pnlUsd: roe * 10,
  entry: 1,
  exit: 1,
  heldSec: 60,
  liquidated,
  address: '',
});

const period = (pct: number | null, netUsd: number): CardData => ({
  kind: 'period',
  from: '2026-10-01',
  to: '2026-10-20',
  netUsd,
  pct,
  trades: 3,
  winDays: 1,
  lossDays: 1,
  address: '',
  incomplete: false,
});

describe('PnL card mood', () => {
  it('follows position ROE across the thresholds', () => {
    const at = (roe: number) => moodOf(position(roe));
    expect([1284.6, 100, 99.9, 25, 24.9, 0, -0.1, -24.9, -25, -79.9, -80, -100].map(at)).toEqual([
      'moon',
      'moon',
      'pump',
      'pump',
      'comfy',
      'comfy',
      'cope',
      'cope',
      'pain',
      'pain',
      'rekt',
      'rekt',
    ]);
  });

  it('is rekt when liquidated, whatever the ROE', () => {
    expect(moodOf(position(-12, true))).toBe('rekt');
  });

  it('uses the period % and falls back to the sign of net PnL', () => {
    expect(moodOf(period(38.6, 4820))).toBe('pump');
    expect(moodOf(period(null, 120))).toBe('comfy');
    expect(moodOf(period(null, -120))).toBe('cope');
  });
});
