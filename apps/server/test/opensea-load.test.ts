import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSea } from '../src/nft/opensea.js';

afterEach(() => vi.unstubAllGlobals());

/** Fake OpenSea: 25 collections per list, counts every request that reaches it. */
function fakeOpenSea() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      const json = u.includes('/collections/top')
        ? {
            collections: Array.from({ length: 25 }, (_, i) => ({
              collection: `col-${i}`,
              name: `Collection ${i}`,
              contracts: [],
            })),
          }
        : u.includes('/stats')
          ? {
              total: { floor_price: 1, floor_price_symbol: 'MON', num_owners: 10 },
              intervals: [{ interval: 'one_day', sales: 1, volume: 2, volume_symbol: 'MON' }],
            }
          : u.includes('/floor_prices')
            ? {
                floor_prices: [
                  { time: 1, token_unit: 1 },
                  { time: 2, token_unit: 2 },
                ],
              }
            : { collection: 'x', name: 'x', total_supply: 100 };
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('Top Collections under many visitors', () => {
  it('1000 visitors opening the page cost the same OpenSea requests as one', async () => {
    const calls = fakeOpenSea();
    const os = new OpenSea('key', undefined, false, undefined, { burst: 1000, perSec: 1000 });
    // 1000 simultaneous page loads.
    const first = Array.from({ length: 1000 }, () => os.top('monad', 'one_day_volume'));
    expect(first.every((r) => r.configured)).toBe(true);
    await vi.waitFor(() => expect(os.top('monad', 'one_day_volume').pending).toBe(0), { timeout: 5000 });
    await vi.waitFor(() => expect(calls.length).toBe(1 + 25 * 3), { timeout: 5000 });
    // Everyone keeps polling: answers come from the snapshot, OpenSea sees nothing new.
    for (let i = 0; i < 5000; i++) os.top('monad', 'one_day_volume');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(76);
    const r = os.top('monad', 'one_day_volume');
    expect(r.rows).toHaveLength(25);
    expect(r.rows[0]).toMatchObject({ floor: 1, volume24h: 2, supply: 100 });
  });

  it('a second sort reuses the per-collection stats already fetched', async () => {
    const calls = fakeOpenSea();
    const os = new OpenSea('key', undefined, false, undefined, { burst: 1000, perSec: 1000 });
    os.top('monad', 'one_day_volume');
    await vi.waitFor(() => expect(calls.length).toBe(76), { timeout: 5000 });
    os.top('monad', 'floor_price');
    await vi.waitFor(() => expect(os.top('monad', 'floor_price').pending).toBe(0), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    // Same 25 collections: only the new list itself is fetched.
    expect(calls.length).toBe(77);
  });
});
