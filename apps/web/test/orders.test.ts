import { beforeEach, describe, expect, it } from 'vitest';

// Node has no localStorage; the order store only needs get/set/remove.
const mem = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
});

const { USER_KV_MAX_BYTES } = await import('@chog/shared');
const {
  cancelOrder,
  isTriggered,
  orderKind,
  placeOrders,
  readOrders,
  updateOrders,
  MAX_OPEN_ORDERS,
  KEEP_PAST,
} = await import('../src/lib/trade/orders');
const { DEFAULT_PRESETS, normalizePresets } = await import('../src/lib/trade/presets');

const base = {
  network: 'monad' as const,
  token: '0x00000000000000000000000000000000000000aa',
  symbol: 'CHOG',
  amount: 100,
  slippagePct: 5,
  priority: 'medium' as const,
  expiresAt: null,
};

beforeEach(() => mem.clear());

describe('limit orders', () => {
  it('names and triggers each kind', () => {
    const tp = { ...base, side: 'sell' as const, when: 'above' as const, priceUsd: 2 };
    const [o] = placeOrders([tp]);
    expect(orderKind(o!)).toBe('Take profit');
    expect(orderKind({ side: 'sell', when: 'below' })).toBe('Stop loss');
    expect(orderKind({ side: 'buy', when: 'below' })).toBe('Limit buy');
    expect(orderKind({ side: 'buy', when: 'above' })).toBe('Breakout buy');
    expect(isTriggered(o!, 1.99)).toBe(false);
    expect(isTriggered(o!, 2)).toBe(true);
    expect(isTriggered(o!, null)).toBe(false);
    expect(isTriggered(o!, 0)).toBe(false);
    const sl = { ...o!, when: 'below' as const, priceUsd: 1 };
    expect(isTriggered(sl, 1.01)).toBe(false);
    expect(isTriggered(sl, 0.5)).toBe(true);
  });

  it('only open orders trigger; cancel works', () => {
    const [o] = placeOrders([{ ...base, side: 'buy', when: 'below', priceUsd: 1, amount: 2 }]);
    cancelOrder(o!.id);
    const c = readOrders().find((x) => x.id === o!.id)!;
    expect(c.status).toBe('cancelled');
    expect(isTriggered(c, 0.1)).toBe(false);
  });

  it('TP + SL placed together share a group; single orders do not', () => {
    const pair = placeOrders([
      { ...base, side: 'sell', when: 'above', priceUsd: 2 },
      { ...base, side: 'sell', when: 'below', priceUsd: 0.7 },
    ]);
    expect(pair[0]!.group).toBeTruthy();
    expect(pair[0]!.group).toBe(pair[1]!.group);
    const [one] = placeOrders([{ ...base, side: 'sell', when: 'above', priceUsd: 3 }]);
    expect(one!.group).toBeNull();
  });

  it('caps open orders and trims history', () => {
    placeOrders(
      Array.from({ length: MAX_OPEN_ORDERS }, (_, i) => ({
        ...base,
        side: 'buy' as const,
        when: 'below' as const,
        priceUsd: i + 1,
      })),
    );
    expect(() => placeOrders([{ ...base, side: 'buy', when: 'below', priceUsd: 1 }])).toThrow(/At most/);
    updateOrders((l) => l.map((o) => ({ ...o, status: 'done', doneAt: Date.now() })));
    expect(readOrders().length).toBe(KEEP_PAST);
  });

  it('worst case (all open + full history, long fields) fits the 32 KB account slot', () => {
    const long = {
      ...base,
      symbol: 'S'.repeat(20),
      wallet: `0x${'b'.repeat(40)}`,
      priceUsd: 0.000123456789012,
    };
    placeOrders(
      Array.from({ length: MAX_OPEN_ORDERS }, () => ({
        ...long,
        side: 'sell' as const,
        when: 'above' as const,
      })),
    );
    updateOrders((l) => [
      ...l,
      ...Array.from({ length: 30 }, (_, i) => ({
        ...l[0]!,
        id: `old_${i}`,
        status: 'failed' as const,
        error: 'x'.repeat(300),
        hash: `0x${'c'.repeat(64)}`,
        doneAt: i,
      })),
    ]);
    const bytes = new TextEncoder().encode(mem.get('chog.term.orders')!).length;
    expect(bytes).toBeLessThan(USER_KV_MAX_BYTES);
  });

  it('drops malformed orders from the store instead of running them', () => {
    const [ok] = placeOrders([{ ...base, side: 'buy', when: 'below', priceUsd: 1, amount: 2 }]);
    const bad = [
      { ...ok, id: 'b1', side: 'steal' },
      { ...ok, id: 'b2', priceUsd: -1 },
      { ...ok, id: 'b3', side: 'sell', amount: 500 },
      { ...ok, id: 'b4', wallet: 'not-an-address' },
      { ...ok, id: 'b5', slippagePct: 99 },
      null,
    ];
    mem.set('chog.term.orders', JSON.stringify([ok, ...bad]));
    expect(readOrders().map((o) => o.id)).toEqual([ok!.id]);
  });
});

describe('presets', () => {
  it('rejects junk and fills new networks with defaults', () => {
    expect(normalizePresets(null)).toBeNull();
    expect(normalizePresets({ presets: [] })).toBeNull();
    const saved = structuredClone(DEFAULT_PRESETS) as unknown as {
      active: number;
      presets: Array<{ buyAmounts: Record<string, unknown>; sellPcts: unknown }>;
    };
    delete saved.presets[0]!.buyAmounts.hyperevm;
    saved.presets[1]!.sellPcts = [10, 20, 30, 400];
    saved.active = 7;
    const n = normalizePresets(saved)!;
    expect(n.active).toBe(0);
    expect(n.presets[0].buyAmounts.hyperevm).toEqual(DEFAULT_PRESETS.presets[0].buyAmounts.hyperevm);
    expect(n.presets[1].sellPcts).toEqual([10, 25, 50, 100]);
    expect(n.autoExit).toEqual(DEFAULT_PRESETS.autoExit);
  });
});
