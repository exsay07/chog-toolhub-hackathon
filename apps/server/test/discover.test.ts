import { afterEach, describe, expect, it, vi } from 'vitest';
import { Discover, isMemeCandidate, normalizeGtPool, overlay } from '../src/market/discover.js';
import { MarketService } from '../src/market/service.js';

const pool = (addr: string, base: string, sym: string, created = '2026-10-20T10:00:00Z') => ({
  attributes: {
    address: addr,
    name: `${sym} / WMON`,
    pool_created_at: created,
    base_token_price_usd: '0.5',
    base_token_price_native_currency: '0.01',
    fdv_usd: '900000',
    market_cap_usd: null,
    reserve_in_usd: '40000',
    price_change_percentage: { m5: '1.5', h1: '-3', h6: '10', h24: '25' },
    volume_usd: { m5: '100', h1: '2000', h6: '9000', h24: '30000' },
    transactions: { m5: { buys: 3, sells: 1 }, h1: { buys: 30, sells: 12 }, h24: { buys: 300, sells: 200 } },
  },
  relationships: {
    base_token: { data: { id: `monad_${base}` } },
    quote_token: { data: { id: 'monad_0x3bd359c1119da7da1d913d1c4d2b7c461115433a' } },
    dex: { data: { id: 'uniswap-v3-monad' } },
  },
});
const token = (addr: string, sym: string, img = 'https://assets.geckoterminal.com/x.png') => ({
  id: `monad_${addr}`,
  attributes: { address: addr, name: `${sym} token`, symbol: sym, image_url: img },
});
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

describe('discover normalization', () => {
  it('maps a GeckoTerminal pool to a pair row (numbers, txns per window, logo)', () => {
    const tokens = new Map([[`monad_${A}`, token(A, 'CHOG')]]);
    const r = normalizeGtPool('monad', pool('0xpool', A, 'CHOG'), tokens, 1);
    expect(r).toMatchObject({
      network: 'monad',
      pairAddress: '0xpool',
      dex: 'uniswap-v3-monad',
      base: { address: A, symbol: 'CHOG', name: 'CHOG token' },
      priceUsd: 0.5,
      liquidityUsd: 40000,
      fdvUsd: 900000,
      volume: { m5: 100, h1: 2000, h6: 9000, h24: 30000 },
      change: { m5: 1.5, h1: -3, h6: 10, h24: 25 },
      txns: { m5: { buys: 3, sells: 1 }, h1: { buys: 30, sells: 12 }, h6: null },
      imageUrl: 'https://assets.geckoterminal.com/x.png',
      createdAt: Date.parse('2026-10-20T10:00:00Z'),
    });
    // GeckoTerminal's placeholder image is not a logo.
    const t2 = new Map([[`monad_${A}`, token(A, 'X', 'https://assets.geckoterminal.com/missing.png')]]);
    expect(normalizeGtPool('monad', pool('0xp', A, 'X'), t2, 1).imageUrl).toBeNull();
  });

  it('overlays live Dexscreener numbers but keeps identity and missing windows', () => {
    const base = normalizeGtPool('monad', pool('0xpool', A, 'CHOG'), new Map(), 1);
    const live = {
      ...base,
      source: 'dexscreener' as const,
      fetchedAt: 99,
      priceUsd: 0.7,
      marketCapUsd: 1_000_000,
      txns: { h24: { buys: 400, sells: 250 }, h1: null, m5: { buys: 9, sells: 2 }, h6: null },
      socials: { website: 'https://chog.xyz', twitter: null, telegram: null },
    };
    const r = overlay(base, live);
    expect(r).toMatchObject({
      source: 'dexscreener',
      priceUsd: 0.7,
      marketCapUsd: 1_000_000,
      txns: { h24: { buys: 400, sells: 250 }, m5: { buys: 9, sells: 2 }, h1: { buys: 30, sells: 12 } },
      socials: { website: 'https://chog.xyz' },
      pairAddress: '0xpool',
    });
    expect(overlay(base, undefined)).toBe(base);
  });

  it('drops stables, wrapped natives and majors from the memecoin feed', () => {
    const row = (sym: string, addr = A) => normalizeGtPool('monad', pool('0xp', addr, sym), new Map(), 1);
    for (const s of ['USDC', 'USDT0', 'WMON', 'WETH', 'EURW', 'eurc', 'aUSD', 'musd', 'WBTC'])
      expect(isMemeCandidate(row(s)), s).toBe(false);
    for (const s of ['CHOG', 'PEPE', 'MOLANDAK', 'USELESS']) expect(isMemeCandidate(row(s)), s).toBe(true);
    // Wrapped native by address, whatever it is called.
    expect(isMemeCandidate(row('X', '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A'))).toBe(false);
  });
});

describe('Discover service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ranks per chain from GeckoTerminal, refreshes rows from Dexscreener in one batch, round-robins chains', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('geckoterminal.com') && url.includes('/networks/monad/trending_pools'))
          return Response.json({
            data: [
              pool('0xa1', A, 'CHOG'),
              pool('0xa2', '0x3333333333333333333333333333333333333333', 'USDC'),
              pool('0xa3', B, 'PEPE'),
            ],
            included: [token(A, 'CHOG'), token(B, 'PEPE')],
          });
        if (url.includes('geckoterminal.com') && url.includes('/networks/base/trending_pools'))
          return Response.json({ data: [pool('0xb1', A, 'BASED')], included: [] });
        if (url.includes('api.dexscreener.com/latest/dex/pairs/monad/'))
          return Response.json({
            pairs: [
              {
                chainId: 'monad',
                dexId: 'uniswap',
                pairAddress: '0xa1',
                baseToken: { address: A, name: 'Chog', symbol: 'CHOG' },
                quoteToken: { address: B, name: 'W', symbol: 'WMON' },
                priceUsd: '0.9',
                info: {
                  imageUrl: 'https://dd.dexscreener.com/c.png',
                  socials: [{ type: 'twitter', url: 'https://x.com/chog' }],
                },
              },
            ],
          });
        return Response.json({ pairs: [] });
      }),
    );
    const d = new Discover(new MarketService());
    const r = await d.discover(['monad', 'base'], 'trending', '1h');
    // USDC filtered out; monad #1, base #1, monad #2.
    expect(r.rows.map((x) => x.base.symbol)).toEqual(['CHOG', 'BASED', 'PEPE']);
    expect(r.rows[0]).toMatchObject({ priceUsd: 0.9, socials: { twitter: 'https://x.com/chog' } });
    expect(calls.some((u) => u.includes('trending_pools?duration=1h'))).toBe(true);
    // One Dexscreener batch for the whole monad list.
    expect(calls.filter((u) => u.includes('/latest/dex/pairs/monad/')).length).toBe(1);
    expect(r.errors).toEqual([]);
  });
});

describe('GeckoTerminal rate-limit cooldown', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stops calling for a minute after a 429 instead of retrying into the limit', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 429 }));
    vi.stubGlobal('fetch', f);
    const m = new MarketService();
    await expect(m.gecko.raw('/networks/base/trending_pools')).rejects.toMatchObject({ status: 429 });
    expect(f).toHaveBeenCalledTimes(1); // no automatic retries on 429
    await expect(m.gecko.raw('/networks/monad/trending_pools')).rejects.toMatchObject({ status: 429 });
    expect(f).toHaveBeenCalledTimes(1); // cooling down: nothing sent
    expect(m.gecko.coolingDown).toBe(true);
  });
});
