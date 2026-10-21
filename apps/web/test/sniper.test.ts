import { describe, expect, it } from 'vitest';
import { sniperConfigOf, type NewPool, type SniperConfig, type TokenSecurity } from '@chog/shared';
import { antiRugReasons, exitDecision, poolMatches, type Entry } from '../src/lib/automation/sniper';

// A config saved before anti-rug / ladder existed: it must still load, with safe defaults.
const legacy = {
  name: 'old',
  network: 'monad',
  enabled: true,
  mode: 'auto',
  entryAmountNative: 1,
  slippageBps: 500,
  priorityFee: 'medium',
  deadlineSec: 60,
  maxTradeUsd: 25,
  filters: {
    minLiquidityUsd: 5000,
    maxLiquidityUsd: null,
    minVolume5mUsd: 0,
    maxPoolAgeMin: 30,
    quoteSymbols: [],
    nameIncludes: '',
    requireSecurityScan: true,
    maxBuyTaxPct: 5,
    maxSellTaxPct: 5,
  },
  exit: { takeProfitPct: 100, stopLossPct: 40 },
};
const cfg = sniperConfigOf(legacy)!;

const sec = (p: Partial<TokenSecurity> = {}): TokenSecurity => ({
  source: 'goplus',
  fetchedAt: 0,
  network: 'monad',
  token: '0xaa',
  honeypot: false,
  cannotSell: false,
  buyTaxPct: 0,
  sellTaxPct: 0,
  isMintable: false,
  ownerCanChangeBalance: false,
  hiddenOwner: false,
  isOpenSource: true,
  holderCount: 100,
  top10HolderPct: 30,
  flags: [],
  ...p,
});

const pool = (p: Partial<NewPool> = {}): NewPool => ({
  source: 'geckoterminal',
  fetchedAt: 0,
  network: 'monad',
  poolAddress: '0xpool',
  name: 'CHOG / WMON',
  dex: 'uniswap-v3-monad',
  baseToken: '0x00000000000000000000000000000000000000aa',
  quoteToken: '0xwmon',
  baseSymbol: 'CHOG',
  quoteSymbol: 'WMON',
  priceUsd: 1,
  liquidityUsd: 10_000,
  fdvUsd: 50_000,
  volume5mUsd: 100,
  buys5m: 3,
  sells5m: 1,
  createdAt: Date.now() - 60_000,
  ...p,
});

describe('sniper config', () => {
  it('upgrades legacy configs with safe anti-rug defaults', () => {
    expect(cfg.antiRug.blockMintable).toBe(true);
    expect(cfg.antiRug.devSellExitPct).toBe(25);
    expect(cfg.limits).toEqual({ maxBuysPerHour: 5, maxOpenPositions: 5 });
    expect(cfg.exit.ladder).toEqual([]);
    expect(cfg.exit.trailingStopPct).toBeNull();
    expect(cfg.filters.dexIncludes).toBe('');
  });
});

describe('pool filters', () => {
  it('applies FDV, buyers, DEX and blacklist filters', () => {
    expect(poolMatches(pool(), cfg)).toEqual([]);
    const c: SniperConfig = {
      ...cfg,
      filters: { ...cfg.filters, maxFdvUsd: 40_000, minBuys5m: 5, dexIncludes: 'pancake' },
      antiRug: { ...cfg.antiRug, blacklist: ['0x00000000000000000000000000000000000000AA'] },
    };
    expect(poolMatches(pool(), c)).toEqual([
      'FDV above max',
      'too few buyers (5m)',
      'DEX filter',
      'blacklisted token',
    ]);
  });
});

describe('anti-rug', () => {
  it('passes a clean scan and blocks the usual rug tools', () => {
    expect(antiRugReasons(sec(), cfg)).toEqual([]);
    expect(antiRugReasons(null, cfg)).toEqual(['security scan required but unavailable']);
    expect(antiRugReasons(sec({ isMintable: true }), cfg)).toContain('mint authority / mintable');
    expect(antiRugReasons(sec({ isFreezable: true }), cfg)).toContain('freeze authority');
    expect(antiRugReasons(sec({ hiddenOwner: true }), cfg)[0]).toMatch(/owner powers/);
    expect(antiRugReasons(sec({ honeypot: true, sellTaxPct: 30 }), cfg)).toEqual([
      'honeypot',
      'sell tax above limit',
    ]);
  });

  it('holder, creator and LP thresholds only act on known values', () => {
    const c = {
      ...cfg,
      antiRug: {
        ...cfg.antiRug,
        maxTop10Pct: 50,
        maxCreatorPct: 5,
        minLpLockedPct: 80,
        blacklist: ['0xDEV'],
      },
    };
    expect(antiRugReasons(sec({ top10HolderPct: null }), c)).toEqual([]);
    expect(
      antiRugReasons(sec({ top10HolderPct: 70, creatorPct: 12, lpLockedPct: 10, creator: '0xdev' }), c),
    ).toEqual(['top-10 holders 70%', 'creator holds 12.0%', 'LP locked/burned 10%', 'blacklisted creator']);
  });
});

describe('exit decisions', () => {
  const e: Entry = {
    sniperId: 's',
    network: 'monad',
    token: '0xaa',
    symbol: 'CHOG',
    entryPriceUsd: 1,
    at: 0,
    peakPriceUsd: 1,
    steps: [],
    creator: '0xdev',
    creatorBal0: 1000,
  };
  const exit: SniperConfig['exit'] = {
    takeProfitPct: 500,
    stopLossPct: 40,
    ladder: [
      { atPct: 100, sellPct: 50 },
      { atPct: 300, sellPct: 25 },
    ],
    trailingStopPct: 30,
  };

  it('holds inside the band', () => {
    expect(exitDecision(e, exit, 25, 1.2, 1000)).toBeNull();
  });
  it('dev dump beats everything', () => {
    expect(exitDecision(e, exit, 25, 3, 700)).toEqual({ kind: 'all', reason: 'dev sold' });
    expect(exitDecision(e, exit, 25, 1, 800)).toBeNull(); // sold 20% < 25%
    expect(exitDecision(e, exit, null, 1, 0)).toBeNull(); // protection off
  });
  it('stop loss', () => {
    expect(exitDecision(e, exit, 25, 0.59, null)).toMatchObject({ kind: 'all', reason: /^SL/ });
  });
  it('ladder steps fire once each, in order', () => {
    expect(exitDecision(e, exit, 25, 2.1, null)).toEqual({ kind: 'step', step: 0, sellPct: 50 });
    const after = { ...e, steps: [0], peakPriceUsd: 2.1 };
    expect(exitDecision(after, exit, 25, 2.1, null)).toBeNull();
    expect(exitDecision({ ...after, peakPriceUsd: 4.2 }, exit, 25, 4.2, null)).toEqual({
      kind: 'step',
      step: 1,
      sellPct: 25,
    });
  });
  it('trailing stop only after a profit peak', () => {
    expect(exitDecision({ ...e, peakPriceUsd: 3 }, exit, 25, 2, null)).toMatchObject({
      kind: 'all',
      reason: /^trailing/,
    });
    expect(exitDecision({ ...e, peakPriceUsd: 1 }, { ...exit, stopLossPct: null }, 25, 0.5, null)).toBeNull();
  });
  it('full take profit', () => {
    expect(exitDecision({ ...e, steps: [0, 1], peakPriceUsd: 6 }, exit, 25, 6, null)).toMatchObject({
      kind: 'all',
      reason: /^TP/,
    });
  });
});
