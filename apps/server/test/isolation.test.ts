import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { DEFAULT_SETTINGS } from '@chog/shared';
import { H, login, makeApp, newAccount } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let alice: string;
let bob: string;
const aliceTrading = privateKeyToAccount(generatePrivateKey()).address;

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

const req = (
  cookie: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) => t.app.inject({ method, url, headers: { ...H, cookie }, payload: payload as object });

describe('authorization and cross-user isolation', () => {
  it('requires a session for every protected endpoint', async () => {
    for (const url of [
      '/api/settings',
      '/api/watchlist',
      '/api/tracker/wallets',
      '/api/journal',
      '/api/portfolio/pnl',
      '/api/automations/sniper',
      '/api/market/search?q=x',
    ]) {
      const r = await t.app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
  });

  it('tracked wallets: bob cannot read, edit or delete alice’s entries (IDOR)', async () => {
    const created = await req(alice, 'POST', '/api/tracker/wallets', {
      network: 'base',
      address: '0x4200000000000000000000000000000000000006',
      label: 'whale',
      color: '#ff4fa3',
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect((await req(bob, 'GET', '/api/tracker/wallets')).json()).toHaveLength(0);
    expect((await req(bob, 'PATCH', `/api/tracker/wallets/${id}`, { label: 'pwned' })).statusCode).toBe(404);
    await req(bob, 'DELETE', `/api/tracker/wallets/${id}`);
    const mine = (await req(alice, 'GET', '/api/tracker/wallets')).json();
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe('whale');
    const copy = {
      enabled: true,
      sizing: { mode: 'fixed', amountNative: 0.1 },
      copySells: true,
      maxTradeUsd: 50,
      maxDailyUsd: 100,
      slippageBps: 100,
      minLiquidityUsd: 1000,
      cooldownSec: 30,
      tokenBlocklist: [],
      tokenAllowlist: [],
    };
    expect((await req(bob, 'PUT', `/api/tracker/wallets/${id}/copy`, copy)).statusCode).toBe(404);
    expect((await req(alice, 'PUT', `/api/tracker/wallets/${id}/copy`, copy)).statusCode).toBe(200);
  });

  it('rejects invalid addresses for the selected network', async () => {
    const r = await req(alice, 'POST', '/api/tracker/wallets', {
      network: 'solana',
      address: '0x4200000000000000000000000000000000000006',
      label: 'x',
      color: '#ffffff',
    });
    expect(r.statusCode).toBe(400);
    const r2 = await req(alice, 'POST', '/api/tracker/wallets', {
      network: 'base',
      address: '0x4200000000000000000000000000000000000006',
      label: '<script>',
      color: '#ffffff',
    });
    expect(r2.statusCode).toBe(400);
  });

  it('settings are validated and per-user', async () => {
    const bad = await req(alice, 'PUT', '/api/settings', {
      ...DEFAULT_SETTINGS,
      trading: { ...DEFAULT_SETTINGS.trading, defaultSlippageBps: 99999 },
    });
    expect(bad.statusCode).toBe(400);
    const tz = await req(alice, 'PUT', '/api/settings', { ...DEFAULT_SETTINGS, timeZone: 'Mars/Olympus' });
    expect(tz.statusCode).toBe(400);
    const ok = await req(alice, 'PUT', '/api/settings', { ...DEFAULT_SETTINGS, timeZone: 'Europe/Kyiv' });
    expect(ok.statusCode).toBe(200);
    expect((await req(bob, 'GET', '/api/settings')).json().timeZone).toBe('UTC');
    expect((await req(alice, 'GET', '/api/settings')).json().timeZone).toBe('Europe/Kyiv');
  });

  it('journal: requires a registered trading wallet, is idempotent, and is per-user', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const entry = {
      idempotencyKey: 'k-12345678',
      network: 'base',
      hash,
      kind: 'swap',
      source: 'manual',
      side: 'buy',
      token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      quotedUsd: 10,
    };
    expect((await req(alice, 'POST', '/api/journal', entry)).statusCode).toBe(400);
    expect(
      (await req(alice, 'PUT', '/api/trading-wallets', { evm: aliceTrading, solana: null })).statusCode,
    ).toBe(200);
    const a = await req(alice, 'POST', '/api/journal', entry);
    const b = await req(alice, 'POST', '/api/journal', entry);
    expect(a.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    expect(a.json().state).toBe('submitted');
    expect(a.json().wallet).toBe(aliceTrading.toLowerCase());
    expect((await req(bob, 'GET', '/api/journal')).json()).toHaveLength(0);
  });

  it('automations: schema-validated, owner-scoped, emergency stop disarms all', async () => {
    const cfg = {
      platform: 'perpl',
      pair: 'BTC-USD',
      direction: 'long',
      sizeUsd: 100,
      leverage: 2,
      entry: 'market',
      exit: 'limit',
      limitOffsetBps: 10,
      holdSec: 60,
      intervalSec: 60,
      risk: {
        maxNotionalUsd: 500,
        maxLeverage: 5,
        maxOpenPositions: 1,
        maxConcurrentOrders: 2,
        maxDailyLossUsd: 50,
        maxRuntimeMin: 60,
      },
    };
    const r = await req(alice, 'POST', '/api/automations/perps', cfg);
    expect(r.statusCode).toBe(200);
    expect((await req(alice, 'POST', '/api/automations/perps', { ...cfg, leverage: 500 })).statusCode).toBe(
      400,
    );
    expect((await req(alice, 'POST', '/api/automations/shell', cfg)).statusCode).toBe(400);
    const id = r.json().id;
    expect(
      (await req(bob, 'PATCH', `/api/automations/perps/${id}/status`, { status: 'running' })).statusCode,
    ).toBe(404);
    await req(alice, 'PATCH', `/api/automations/perps/${id}/status`, { status: 'running' });
    await req(alice, 'POST', '/api/automations/emergency-stop', {});
    const list = (await req(alice, 'GET', '/api/automations/perps')).json();
    expect(list[0].status).toBe('stopped');
  });

  it('session management: bob cannot revoke alice’s session', async () => {
    const sessions = (await req(alice, 'GET', '/api/auth/sessions')).json();
    await req(bob, 'POST', `/api/auth/sessions/${sessions[0].id}/revoke`, {});
    expect((await req(alice, 'GET', '/api/auth/me')).statusCode).toBe(200);
  });
});
