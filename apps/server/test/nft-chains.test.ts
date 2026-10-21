import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { H, login, makeApp, newAccount } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
beforeAll(async () => {
  t = await makeApp();
  const a = newAccount();
  t.ownership.set(a.address, { status: 'holder', balance: 1 });
  cookie = (await login(t.app, a)).cookie;
});
afterAll(async () => t.close());

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { ...H, cookie } });

describe('Top Collections chains', () => {
  it('lists every OpenSea chain, featured ones first', async () => {
    const r = await get('/api/nft/chains');
    expect(r.statusCode).toBe(200);
    const chains = (r.json() as { chains: Array<{ id: string; featured: boolean }> }).chains;
    expect(chains.length).toBeGreaterThanOrEqual(25);
    expect(chains.slice(0, 5).map((c) => c.id)).toEqual(['monad', 'base', 'robinhood', 'ethereum', 'solana']);
    for (const id of ['abstract', 'ape_chain', 'polygon', 'arbitrum', 'zora', 'blast', 'bera_chain'])
      expect(chains.some((c) => c.id === id)).toBe(true);
    const firstOther = chains.findIndex((c) => !c.featured);
    expect(chains.slice(firstOther).every((c) => !c.featured)).toBe(true);
  });

  it('accepts any listed chain and rejects unknown ones', async () => {
    expect((await get('/api/nft/top?chain=ethereum&sort=one_day_volume')).statusCode).toBe(200);
    expect((await get('/api/nft/top?chain=ape_chain&sort=floor_price')).statusCode).toBe(200);
    expect((await get('/api/nft/top?chain=notachain')).statusCode).toBe(400);
    expect((await get('/api/nft/top?chain=../../x')).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/nft/chains', headers: H })).statusCode).toBe(401);
  });
});
