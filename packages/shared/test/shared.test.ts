import { describe, expect, it } from 'vitest';
import {
  base58Decode,
  base58Encode,
  canTransition,
  computePositions,
  dailyRealized,
  dayKey,
  DEFAULT_RISK_LIMITS,
  evaluateTrade,
  fmtSmall,
  normalizeCandles,
  groupPairsToTokens,
  type PairSummary,
  isSolanaAddress,
  isValidAddress,
  normalizeAddress,
  perpsConfigViolations,
  spentInWindow,
  summarize,
  transition,
  unrealizedUsd,
  zMintTask,
  zSettings,
  DEFAULT_SETTINGS,
  type Fill,
  type TradeIntent,
  NETWORK_IDS,
  NETWORKS,
  canTrade,
} from '../src/index.js';

describe('address validation', () => {
  it('validates per network', () => {
    expect(isValidAddress('base', '0x4200000000000000000000000000000000000006')).toBe(true);
    expect(isValidAddress('base', '0x42000000000000000000000000000000000006')).toBe(false);
    // Bad EIP-55 checksum (mixed case) is rejected.
    expect(isValidAddress('base', '0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
    expect(isValidAddress('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
    expect(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isSolanaAddress('1111111111111111111111111111111')).toBe(false); // decodes to < 32 bytes
    expect(isSolanaAddress('0OIl0000000000000000000000000000')).toBe(false);
    expect(isValidAddress('solana', '0x4200000000000000000000000000000000000006')).toBe(false);
  });
  it('base58 round-trips, including leading zero bytes', () => {
    for (const hex of ['00', '0000ff', 'ff', '00010203040506070809', 'deadbeef'.repeat(8)]) {
      const b = Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16)));
      expect(base58Decode(base58Encode(b))).toEqual(b);
    }
    expect(base58Encode(base58Decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')!)).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(base58Decode('1111')).toEqual(new Uint8Array(4));
  });
  it('normalizes EVM to lowercase but keeps Solana case', () => {
    expect(normalizeAddress('monad', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    );
    expect(normalizeAddress('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(() => normalizeAddress('bsc', 'nope')).toThrow();
  });
});

describe('transaction state machine', () => {
  it('never jumps from submitted to success without chain confirmation semantics', () => {
    expect(canTransition('draft', 'confirmed')).toBe(false);
    expect(canTransition('awaiting_approval', 'confirmed')).toBe(false);
    expect(canTransition('submitted', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'failed')).toBe(false);
    expect(() => transition('failed', 'pending')).toThrow();
    expect(transition('unknown', 'pending')).toBe('pending');
  });
});

describe('risk engine', () => {
  const base: TradeIntent = {
    network: 'base',
    token: '0xabc',
    side: 'buy',
    amountUsd: 20,
    slippageBps: 100,
    priceImpactPct: 0.5,
    liquidityUsd: 100_000,
    automated: true,
    security: { honeypot: false, cannotSell: false, buyTaxPct: 0, sellTaxPct: 0 },
  };
  const ctx = { now: 1_000_000, spentLast24hUsd: 0, lastTradeAt: {}, emergencyStop: false };

  it('accepts a sane trade', () => {
    expect(evaluateTrade(base, DEFAULT_RISK_LIMITS, ctx).ok).toBe(true);
  });
  it('enforces per-trade, daily, slippage, impact, liquidity, honeypot, cooldown, kill switch', () => {
    const L = DEFAULT_RISK_LIMITS;
    expect(evaluateTrade({ ...base, amountUsd: 51 }, L, ctx).ok).toBe(false);
    expect(evaluateTrade(base, L, { ...ctx, spentLast24hUsd: 190 }).ok).toBe(false);
    expect(evaluateTrade({ ...base, slippageBps: 301 }, L, ctx).ok).toBe(false);
    expect(evaluateTrade({ ...base, priceImpactPct: 6 }, L, ctx).ok).toBe(false);
    expect(evaluateTrade({ ...base, liquidityUsd: 500 }, L, ctx).ok).toBe(false);
    expect(evaluateTrade({ ...base, security: { honeypot: true } }, L, ctx).ok).toBe(false);
    expect(evaluateTrade({ ...base, security: { sellTaxPct: 25 } }, L, ctx).ok).toBe(false);
    expect(evaluateTrade(base, L, { ...ctx, lastTradeAt: { 'base:0xabc': ctx.now - 10_000 } }).ok).toBe(
      false,
    );
    expect(evaluateTrade(base, L, { ...ctx, emergencyStop: true }).ok).toBe(false);
    expect(evaluateTrade({ ...base, network: 'robinhood' }, L, ctx).ok).toBe(false);
  });
  it('refuses buys whose USD value is unknown (limits unenforceable)', () => {
    expect(evaluateTrade({ ...base, amountUsd: null }, DEFAULT_RISK_LIMITS, ctx).ok).toBe(false);
  });
  it('manual trades get warnings, not blocks, for low liquidity / unknown scan', () => {
    const v = evaluateTrade(
      { ...base, automated: false, liquidityUsd: 500, security: undefined },
      DEFAULT_RISK_LIMITS,
      ctx,
    );
    expect(v.ok).toBe(true);
    expect(v.warnings.length).toBeGreaterThanOrEqual(2);
  });
  it('sums spend in the trailing window', () => {
    expect(
      spentInWindow(
        [
          { at: 0, usd: 10 },
          { at: 90_000_000, usd: 5 },
        ],
        100_000_000,
      ),
    ).toBe(5);
  });
});

describe('PnL', () => {
  const T = Date.UTC(2026, 9, 18, 22, 30); // 22:30 UTC
  const f = (
    id: string,
    at: number,
    side: 'buy' | 'sell',
    qty: number,
    usd: number | null,
    feeUsd: number | null = 0.1,
  ): Fill => ({
    id,
    at,
    network: 'base',
    token: '0xT',
    side,
    qty,
    usd,
    feeUsd,
  });

  it('weighted-average cost, realized and unrealized', () => {
    const { positions, events } = computePositions([
      f('1', T, 'buy', 100, 100),
      f('2', T + 1, 'buy', 100, 300),
      f('3', T + 2, 'sell', 50, 150),
    ]);
    const p = positions.get('base:0xt')!;
    expect(p.qty).toBe(150);
    expect(p.costUsd).toBeCloseTo(300); // avg 2.0 → 400 − 100
    expect(p.realizedUsd).toBeCloseTo(50); // 150 − 50×2
    expect(unrealizedUsd(p, 3)).toBeCloseTo(150);
    expect(events).toHaveLength(3);
  });

  it('does not invent PnL when USD value is unknown', () => {
    const { positions, events } = computePositions([
      f('1', T, 'buy', 10, null),
      f('2', T + 1, 'sell', 10, 50),
    ]);
    expect(positions.get('base:0xt')!.realizedUsd).toBeNull();
    expect(events[1]!.realizedUsd).toBeNull();
    const d = [...dailyRealized(events, 'UTC').values()];
    expect(d[0]!.incomplete).toBe(true);
  });

  it('ignores untracked quantity (tokens received by transfer)', () => {
    const { positions } = computePositions([f('1', T, 'buy', 10, 10), f('2', T + 1, 'sell', 20, 40)]);
    const p = positions.get('base:0xt')!;
    expect(p.untrackedQty).toBe(10);
    expect(p.realizedUsd).toBeCloseTo(10); // 20 proceeds for 10 tracked − 10 cost
  });

  it('buckets by the user’s time zone', () => {
    expect(dayKey(T, 'UTC')).toBe('2026-10-18');
    expect(dayKey(T, 'Europe/Kyiv')).toBe('2026-10-19');
    const { events } = computePositions([f('1', T, 'buy', 1, 1), f('2', T + 60_000, 'sell', 1, 3)]);
    const days = [...dailyRealized(events, 'Europe/Kyiv').values()];
    expect(days[0]!.day).toBe('2026-10-19');
    expect(days[0]!.netRealizedUsd).toBeCloseTo(2 - 0.2);
    const s = summarize(days);
    expect(s.winDays).toBe(1);
    expect(s.trades).toBe(2);
  });
});

describe('schemas', () => {
  it('default settings are valid', () => {
    expect(zSettings.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });
  it('mint task only accepts simple signatures and EVM networks', () => {
    const ok = {
      name: 'x',
      network: 'monad',
      address: '0x4200000000000000000000000000000000000006',
      functionSignature: 'mint(uint256)',
      args: ['{quantity}'],
      quantity: 1,
      unitPriceNative: 1,
      maxTotalSpendNative: 1,
      startAt: null,
      maxAttempts: 2,
      priorityFee: 'low',
    };
    expect(zMintTask.safeParse(ok).success).toBe(true);
    expect(zMintTask.safeParse({ ...ok, functionSignature: 'mint(uint256);selfdestruct()' }).success).toBe(
      false,
    );
    expect(zMintTask.safeParse({ ...ok, functionSignature: 'mint(string)' }).success).toBe(false);
    expect(
      zMintTask.safeParse({
        ...ok,
        network: 'solana',
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      }).success,
    ).toBe(false);
  });
  it('perps config cross-field risk checks', () => {
    const c = {
      platform: 'bulk' as const,
      pair: 'BTC-USD',
      direction: 'long' as const,
      sizeUsd: 1000,
      leverage: 10,
      entry: 'limit' as const,
      exit: 'market' as const,
      limitOffsetBps: 0,
      holdSec: 60,
      intervalSec: 60,
      risk: {
        maxNotionalUsd: 500,
        maxLeverage: 5,
        maxOpenPositions: 1,
        maxConcurrentOrders: 1,
        maxDailyLossUsd: 10,
        maxRuntimeMin: 10,
      },
    };
    expect(perpsConfigViolations(c)).toHaveLength(3);
  });
});

describe('candles', () => {
  it('sorts and merges duplicate timestamps (regression: chart crash on GeckoTerminal duplicates)', () => {
    const c = (time: number, o: number, h: number, l: number, cl: number) => ({
      time,
      open: o,
      high: h,
      low: l,
      close: cl,
      volume: 1,
    });
    const out = normalizeCandles([
      c(3, 1, 2, 1, 2),
      c(1, 1, 1, 1, 1),
      c(3, 2, 5, 0.5, 4),
      c(2, NaN, 1, 1, 1),
    ]);
    expect(out.map((x) => x.time)).toEqual([1, 3]);
    expect(out[1]).toMatchObject({ open: 1, high: 5, low: 0.5, close: 4 });
  });
});

describe('search grouping', () => {
  const pair = (
    o: Partial<PairSummary> & { pairAddress: string; base: string; quote: string; liq: number },
  ): PairSummary => ({
    source: 'dexscreener',
    fetchedAt: 0,
    network: o.network ?? 'monad',
    pairAddress: o.pairAddress,
    dex: 'x',
    base: { address: o.base, symbol: o.base.slice(0, 4), name: o.base },
    quote: { address: o.quote, symbol: o.quote.slice(0, 4), name: o.quote },
    priceUsd: o.priceUsd ?? 2,
    priceNative: o.priceNative ?? 4,
    liquidityUsd: o.liq,
    fdvUsd: null,
    marketCapUsd: null,
    volume: { m5: null, h1: null, h6: null, h24: 10 },
    change: { m5: null, h1: null, h6: null, h24: 1 },
    txns: { h24: null, h1: null },
    createdAt: null,
    url: null,
    imageUrl: null,
  });
  it('collapses many pools of one token into one hit (the "mon" search problem)', () => {
    const hits = groupPairsToTokens([
      pair({ pairAddress: 'p1', base: 'WMON', quote: 'USDC', liq: 100 }),
      pair({ pairAddress: 'p2', base: 'WMON', quote: 'CHOG', liq: 900 }),
      pair({ pairAddress: 'p3', base: 'WMON', quote: 'AUSD', liq: 50 }),
      pair({ pairAddress: 'p4', base: 'MONX', quote: 'WMON', liq: 10 }),
      pair({ pairAddress: 'p5', base: 'WMON', quote: 'USDC', liq: 5, network: 'bsc' }),
    ]);
    expect(hits.map((h) => `${h.network}:${h.address}`)).toEqual(['monad:WMON', 'monad:MONX', 'bsc:WMON']);
    expect(hits[0]).toMatchObject({ pairCount: 3, liquidityUsd: 1050, bestPair: 'p2', volume24hUsd: 30 });
  });
  it('reports the queried token even when it is the quote side, deriving its price', () => {
    const hits = groupPairsToTokens(
      [pair({ pairAddress: 'p1', base: 'MEME', quote: 'WMON', liq: 10, priceUsd: 0.5, priceNative: 0.25 })],
      'wmon',
    );
    expect(hits[0]).toMatchObject({ address: 'WMON', priceUsd: 2, change24h: null });
  });
  it('mixed sides for the queried token stay one hit and use the base-side pool for price (USDC regression)', () => {
    const hits = groupPairsToTokens(
      [
        pair({ pairAddress: 'p1', base: 'PUMP', quote: 'USDC', liq: 1000, priceUsd: 0.004 }),
        pair({ pairAddress: 'p2', base: 'USDC', quote: 'SOL', liq: 10, priceUsd: 1 }),
      ],
      'usdc',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ address: 'USDC', priceUsd: 1, bestPair: 'p2', pairCount: 2 });
  });
});

describe('format', () => {
  it('formats tiny prices with subscript zeros', () => {
    expect(fmtSmall(0.0000012341)).toBe('0.0₅1234');
    expect(fmtSmall(0.00123)).toBe('0.00123');
  });
});

describe('network table', () => {
  it('has the Axiom memecoin chains plus Monad, each fully described', () => {
    expect(NETWORK_IDS).toEqual(
      expect.arrayContaining([
        'monad',
        'solana',
        'bsc',
        'base',
        'ethereum',
        'robinhood',
        'arc',
        'ink',
        'hyperevm',
      ]),
    );
    const chainIds = new Set<number>();
    for (const id of NETWORK_IDS) {
      const n = NETWORKS[id];
      expect(n.defaultRpcUrls.length, id).toBeGreaterThan(0);
      expect(
        n.defaultRpcUrls.every((u) => u.startsWith('https://')),
        id,
      ).toBe(true);
      expect(n.dexscreenerId && n.geckoterminalId, id).toBeTruthy();
      if (n.kind === 'evm') {
        expect(n.chainId, id).toBeGreaterThan(0);
        expect(chainIds.has(n.chainId!), `${id} duplicate chain id`).toBe(false);
        chainIds.add(n.chainId!);
        expect(isValidAddress(id, n.wrappedNative), id).toBe(true);
        // Anything tradable needs an aggregator route.
        if (canTrade(id)) expect(n.kyberPath, id).toBeTruthy();
      }
    }
    expect(NETWORKS.ethereum.geckoterminalId).toBe('eth');
    expect(NETWORKS.arc).toMatchObject({ chainId: 5042, nativeSymbol: 'USDC', nativeDecimals: 18 });
    expect(canTrade('ink')).toBe(false); // no KyberSwap route on Ink
  });
});

describe('settings migration', () => {
  it('settings saved before onboarding existed still parse (guide shows once)', () => {
    const { onboarding: _drop, ...old } = DEFAULT_SETTINGS;
    const p = zSettings.safeParse(old);
    expect(p.success).toBe(true);
    expect(p.success && p.data.onboarding).toEqual({ guideDoneAt: null });
    expect(
      zSettings.parse({ ...DEFAULT_SETTINGS, onboarding: { guideDoneAt: 123 } }).onboarding.guideDoneAt,
    ).toBe(123);
  });
});
