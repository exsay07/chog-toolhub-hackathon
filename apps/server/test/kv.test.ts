import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { H, login, makeApp, newAccount } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let alice: string;
let bob: string;

beforeAll(async () => {
  t = await makeApp();
  const a = newAccount();
  const b = newAccount();
  t.ownership.set(a.address, { status: 'holder', balance: 1 });
  t.ownership.set(b.address, { status: 'holder', balance: 1 });
  alice = (await login(t.app, a)).cookie;
  bob = (await login(t.app, b)).cookie;
});
afterAll(async () => t.close());

const req = (cookie: string, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { ...H, cookie }, payload: payload as object });

describe('per-user synced state (/api/kv)', () => {
  it('stores, overwrites and returns only the caller’s values', async () => {
    expect((await req(alice, 'PUT', '/api/kv/term.quick', { value: { monad: 7 } })).statusCode).toBe(200);
    expect((await req(alice, 'PUT', '/api/kv/term.quick', { value: { monad: 9 } })).statusCode).toBe(200);
    const entries = [
      { sniperId: 's1', network: 'base', token: '0xabc', symbol: 'X', entryPriceUsd: 1, at: 1 },
    ];
    await req(alice, 'PUT', '/api/kv/sniper.entries', { value: entries });
    expect((await req(alice, 'GET', '/api/kv')).json()).toEqual({
      'term.quick': { monad: 9 },
      'sniper.entries': entries,
    });
    expect((await req(bob, 'GET', '/api/kv')).json()).toEqual({});
    await req(bob, 'DELETE', '/api/kv/term.quick');
    expect((await req(alice, 'GET', '/api/kv')).json()['term.quick']).toEqual({ monad: 9 });
  });

  it('rejects unknown keys, missing values and oversized values; requires a session', async () => {
    expect((await req(alice, 'PUT', '/api/kv/vault.secret', { value: 1 })).statusCode).toBe(400);
    expect((await req(alice, 'PUT', '/api/kv/term.view', {})).statusCode).toBe(400);
    const big = 'x'.repeat(40_000);
    expect((await req(alice, 'PUT', '/api/kv/term.recent', { value: big })).statusCode).toBe(413);
    expect((await t.app.inject({ method: 'GET', url: '/api/kv' })).statusCode).toBe(401);
  });
});
