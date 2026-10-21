import { afterEach, describe, expect, it, vi } from 'vitest';
import { MintAggregator, suspicion, type MintEvent } from '../src/nft/mintAggregator.js';
import { isDefiPosition } from '../src/nft/mintTracker.js';
import { OpenSea } from '../src/nft/opensea.js';

const NOW = 1_800_000_000_000;
const A = '0x00000000000000000000000000000000000000aa';
const w = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const ev = (contract: string, to: string, tx: string, minsAgo: number): MintEvent => ({
  contract,
  to,
  tx,
  at: NOW - minsAgo * 60_000,
});

describe('mint aggregator', () => {
  it('counts the last 10 minutes and the last hour, hottest first', () => {
    const agg = new MintAggregator();
    const B = '0x00000000000000000000000000000000000000bb';
    agg.add([
      ...Array.from({ length: 5 }, (_, i) => ev(A, w(i), `0xa${i}`, 2)),
      ...Array.from({ length: 5 }, (_, i) => ev(A, w(10 + i), `0xb${i}`, 30)),
      ...Array.from({ length: 8 }, (_, i) => ev(B, w(20 + i), `0xc${i}`, 1)),
      ev(A, w(99), '0xold', 90), // outside the hour
    ]);
    const rows = agg.rows(NOW);
    expect(rows.map((r) => [r.contract, r.m10, r.m60, r.wallets])).toEqual([
      [B, 8, 8, 8],
      [A, 5, 10, 10],
    ]);
  });

  it('flags airdrops (one tx → many wallets) and does not call them suspicious', () => {
    const agg = new MintAggregator();
    agg.add(Array.from({ length: 30 }, (_, i) => ev(A, w(i), `0xdrop${i % 3}`, 5)));
    const [r] = agg.rows(NOW);
    expect(r!.air).toBe(true);
    expect(r!.sus).toBeNull();
  });

  it('flags a thin wallet spread as SUS with a reason', () => {
    const agg = new MintAggregator();
    agg.add(Array.from({ length: 40 }, (_, i) => ev(A, w(i % 2), `0xt${i}`, 3)));
    expect(agg.rows(NOW)[0]!.sus).toBe('40 mints from only 2 wallets');
    expect(suspicion(10, 4, 7)).toBe('one wallet minted 70% of the last hour');
    expect(suspicion(50, 40, 3)).toBeNull();
    expect(suspicion(5, 1, 5)).toBeNull(); // too few mints to judge
  });

  it('ignores tiny activity and prunes expired contracts', () => {
    const agg = new MintAggregator();
    agg.add([ev(A, w(1), '0x1', 1), ev(A, w(2), '0x2', 1)]);
    expect(agg.rows(NOW)).toEqual([]);
    agg.prune(NOW + 2 * 60 * 60_000);
    expect(agg.size).toBe(0);
  });
});

describe('DeFi position filter', () => {
  it('hides LP position receipts, keeps collections', () => {
    expect(isDefiPosition({ name: 'Uniswap V3 Positions NFT-V1', symbol: 'UNI-V3-POS' })).toBe(true);
    expect(isDefiPosition({ name: null, symbol: 'UNI-V4-POSM' })).toBe(true);
    expect(isDefiPosition({ name: 'Slipstream Position NFT v1', symbol: 'AERO-CL-POS' })).toBe(true);
    // Name alone / symbol alone must each be enough.
    expect(isDefiPosition({ name: 'Pancake V3 Positions NFT-V1', symbol: 'X' })).toBe(true);
    expect(isDefiPosition({ name: 'Some Liquidity Position', symbol: null })).toBe(true);
    expect(isDefiPosition({ name: null, symbol: 'UNI-V3-POS' })).toBe(true);
    expect(isDefiPosition({ name: 'Ramses V3 Non Fungible Position', symbol: 'RAM-V3-NFP' })).toBe(true);
    expect(isDefiPosition({ name: 'Chog Genesis', symbol: 'CHOG' })).toBe(false);
    expect(isDefiPosition({ name: 'Composition NFT Art', symbol: 'COMP' })).toBe(false);
    expect(isDefiPosition({ name: 'Positive Vibes', symbol: 'POSV' })).toBe(false);
  });
});

describe('OpenSea top collections', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is off without a key when the free-tier key is disabled (no requests)', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(new OpenSea('', undefined, false).top('monad', 'one_day_volume')).toMatchObject({
      configured: false,
      rows: [],
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('mints the free-tier key once, stores it, and reuses it after a restart', async () => {
    const minted: string[] = [];
    const keysUsed: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        if (url.endsWith('/auth/keys') && init?.method === 'POST') {
          minted.push(url);
          const body = { api_key: 'free-1', expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() };
          return new Response(JSON.stringify(body), { status: 200 });
        }
        keysUsed.push(init?.headers?.['x-api-key'] ?? '');
        return new Response(JSON.stringify({ collections: [] }), { status: 200 });
      }),
    );
    type AutoKey = import('../src/nft/opensea.js').AutoKey;
    const box: { saved: AutoKey | null } = { saved: null };
    const store = { load: async () => box.saved, save: async (k: AutoKey) => void (box.saved = k) };
    const a = new OpenSea('', undefined, true, store);
    expect(a.top('monad', 'one_day_volume').configured).toBe(true);
    await vi.waitFor(() => expect(keysUsed).toContain('free-1'));
    expect(minted).toHaveLength(1);
    expect(box.saved?.key).toBe('free-1');
    // "Restart": a new instance loads the stored key instead of minting another.
    const b = new OpenSea('', undefined, true, store);
    b.top('base', 'one_day_volume');
    await vi.waitFor(() => expect(keysUsed.filter((k) => k === 'free-1').length).toBeGreaterThan(1));
    expect(minted).toHaveLength(1);
  });

  it('lists, then fills floor / 24h change / volume / owners / supply per row', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url);
        expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
        const body = url.includes('/collections/top')
          ? {
              collections: [
                {
                  collection: 'chog-genesis',
                  name: 'Chog Genesis',
                  image_url: 'https://i.seadn.io/x.png',
                  safelist_status: 'verified',
                  opensea_url: 'https://opensea.io/collection/chog-genesis',
                  contracts: [{ address: '0xc96d', chain: 'monad' }],
                },
              ],
            }
          : url.endsWith('/stats')
            ? {
                total: { floor_price: 120, floor_price_symbol: 'MON', num_owners: 900 },
                intervals: [
                  { interval: 'one_day', sales: 7, volume: 800, volume_symbol: 'MON' },
                  { interval: 'seven_day', sales: 40, volume: 5000, volume_symbol: 'MON' },
                ],
              }
            : url.includes('/floor_prices')
              ? {
                  floor_prices: [
                    { time: 2, token_unit: 120 },
                    { time: 1, token_unit: 100 },
                  ],
                }
              : { collection: 'chog-genesis', total_supply: 1969 };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const os = new OpenSea('k');
    expect(os.top('monad', 'one_day_volume')).toMatchObject({ configured: true, rows: [], pending: 25 });
    await vi.waitFor(() => expect(os.top('monad', 'one_day_volume').rows[0]?.supply).toBe(1969), {
      timeout: 8000,
    });
    const r = os.top('monad', 'one_day_volume');
    expect(r.pending).toBe(0);
    expect(r.rows[0]).toMatchObject({
      rank: 1,
      name: 'Chog Genesis',
      verified: true,
      contract: '0xc96d',
      floor: 120,
      floorSymbol: 'MON',
      floor24hAgo: 100,
      volume24h: 800,
      volume7d: 5000,
      sales24h: 7,
      owners: 900,
    });
    expect(calls[0]).toContain('/collections/top?chains=monad&sort_by=one_day_volume');
  });

  it('reports a rejected key instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    const os = new OpenSea('bad');
    os.top('base', 'one_day_sales');
    await vi.waitFor(() =>
      expect(os.top('base', 'one_day_sales').error).toBe('OpenSea rejected the API key'),
    );
  });
});
