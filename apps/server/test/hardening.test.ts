import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { H, login, makeApp, newAccount } from './helpers.js';
import { Hub } from '../src/ws/hub.js';
import { MarketService } from '../src/market/service.js';
import { createLogger } from '../src/lib/log.js';

describe('hardening regressions (security audit findings)', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  beforeAll(async () => {
    t = await makeApp({ JOURNAL_MAX_INFLIGHT_PER_USER: '3' });
    const a = newAccount();
    t.ownership.set(a.address, { status: 'holder', balance: 1 });
    cookie = (await login(t.app, a)).cookie;
  });
  afterAll(async () => t.close());

  it('F-01: /internal/metrics is hidden from proxied requests even on loopback', async () => {
    const direct = await t.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      remoteAddress: '127.0.0.1',
    });
    expect(direct.statusCode).toBe(200);
    const proxied = await t.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(proxied.statusCode).toBe(404);
    const remote = await t.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      remoteAddress: '203.0.113.9',
    });
    expect(remote.statusCode).toBe(404);
  });

  it('www.<domain> redirects to the canonical origin, keeping path and query', async () => {
    const r = await t.app.inject({
      method: 'GET',
      url: '/terminal?x=1',
      headers: { host: 'www.localhost:5173' },
    });
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe('http://localhost:5173/terminal?x=1');
    const api = await t.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'localhost:5173' } });
    expect(api.statusCode).toBe(200);
  });

  it('F-03: caps unreconciled journal entries per user', async () => {
    await t.app.inject({
      method: 'PUT',
      url: '/api/trading-wallets',
      headers: { ...H, cookie },
      payload: { evm: privateKeyToAccount(generatePrivateKey()).address, solana: null },
    });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/journal',
        headers: { ...H, cookie },
        payload: {
          idempotencyKey: `cap-${i}-xxxxxx`,
          network: 'base',
          hash: `0x${String(i).repeat(64)}`,
          kind: 'swap',
          source: 'manual',
          side: 'buy',
          token: null,
          quotedUsd: 1,
        },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('F-02: caps WebSocket connections per user', () => {
    const hub = new Hub(new MarketService(), createLogger('silent'), 30, 2);
    const closed: number[] = [];
    const fake = () => ({
      readyState: 1,
      bufferedAmount: 0,
      send() {},
      on() {},
      close(code: number) {
        closed.push(code);
      },
    });
    hub.add(fake() as never, 'u1');
    hub.add(fake() as never, 'u1');
    hub.add(fake() as never, 'u1');
    hub.add(fake() as never, 'u2');
    expect(hub.connectionCount).toBe(3);
    expect(closed).toEqual([4029]);
  });
});
