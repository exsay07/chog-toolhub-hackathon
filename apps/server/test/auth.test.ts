import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { H, login, makeApp, newAccount, siweMessage } from './helpers.js';
import { sessions } from '../src/db/schema.js';
import { loadConfig } from '../src/config.js';

let t: Awaited<ReturnType<typeof makeApp>>;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe('SIWE + NFT gate', () => {
  it('logs in a holder with a real secp256k1 signature and sets a hardened cookie', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'holder', balance: 2 });
    const { res, cookie } = await login(t.app, acc);
    expect(res.statusCode).toBe(200);
    expect(res.json().accessBasis).toBe('holder');
    const c = res.cookies.find((x) => x.name === 'chog_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().address).toBe(acc.address.toLowerCase());
  });

  it('rejects a non-holder (403 NOT_HOLDER) and issues no session', async () => {
    const acc = newAccount();
    const { res, cookie } = await login(t.app, acc);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('NOT_HOLDER');
    expect(cookie).toBe('');
  });

  it('fails closed when ownership is unverifiable (RPC outage)', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'unverifiable', reason: 'rpc down' });
    const { res } = await login(t.app, acc);
    expect(res.statusCode).toBe(503);
  });

  it('rejects replay of a used nonce', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'holder', balance: 1 });
    const message = await siweMessage(t.app, acc);
    const signature = await acc.signMessage({ message });
    const a = await t.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: H,
      payload: { message, signature },
    });
    const b = await t.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: H,
      payload: { message, signature },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(401);
    expect(b.json().code).toBe('NONCE');
  });

  it('rejects a signature from a different key (address spoofing)', async () => {
    const victim = newAccount();
    const attacker = newAccount();
    t.ownership.set(victim.address, { status: 'holder', balance: 1 });
    const message = await siweMessage(t.app, victim);
    const signature = await attacker.signMessage({ message });
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: H,
      payload: { message, signature },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('BAD_SIGNATURE');
  });

  it('rejects wrong domain, wrong URI, unknown nonce and expired messages', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'holder', balance: 1 });
    const cases = [
      { domain: 'evil.example' },
      { uri: 'https://evil.example' },
      { nonce: 'deadbeefdeadbeef' },
      { issuedAt: new Date(Date.now() - 20 * 60_000), expirationTime: new Date(Date.now() - 60_000) },
      { statement: 'Approve all my tokens' },
    ];
    for (const over of cases) {
      const message = await siweMessage(t.app, acc, over);
      const signature = await acc.signMessage({ message });
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: H,
        payload: { message, signature },
      });
      expect(r.statusCode, JSON.stringify(over)).toBe(401);
    }
  });

  it('blocks state-changing requests from foreign origins or without CSRF header', async () => {
    const a = await t.app.inject({
      method: 'POST',
      url: '/api/auth/nonce',
      headers: { origin: 'https://evil.example', 'x-chog-csrf': '1' },
    });
    const b = await t.app.inject({
      method: 'POST',
      url: '/api/auth/nonce',
      headers: { origin: 'http://localhost:5173' },
    });
    const c = await t.app.inject({ method: 'POST', url: '/api/auth/nonce' });
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([403, 403, 403]);
  });

  it('revokes the session when the NFT is sold (re-verification policy)', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'holder', balance: 1 });
    const { cookie } = await login(t.app, acc);
    // Age the verification past NFT_RECHECK_SEC.
    await t.ctx.db.update(sessions).set({ nftVerifiedAt: new Date(Date.now() - 3600_000) });
    t.ownership.set(acc.address, { status: 'not_holder' });
    const r = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('NOT_HOLDER');
    const again = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(again.statusCode).toBe(401);
  });

  it('keeps access during a short RPC outage (grace) and fails closed after it', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'holder', balance: 1 });
    const { cookie } = await login(t.app, acc);
    t.ownership.set(acc.address, { status: 'unverifiable', reason: 'rpc down' });
    await t.ctx.db.update(sessions).set({ nftVerifiedAt: new Date(Date.now() - 400_000) }); // > recheck(300s), < recheck+grace(1200s)
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(
      200,
    );
    await t.ctx.db.update(sessions).set({ nftVerifiedAt: new Date(Date.now() - 1300_000) });
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(
      503,
    );
  });

  it('logout revokes the session server-side', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'holder', balance: 1 });
    const { cookie } = await login(t.app, acc);
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...H, cookie } });
    const [s] = await t.ctx.db.select().from(sessions);
    expect(s!.revokedAt).not.toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(
      401,
    );
  });

  it('stores only a hash of the session token', async () => {
    const acc = newAccount();
    t.ownership.set(acc.address, { status: 'holder', balance: 1 });
    const { cookie } = await login(t.app, acc);
    const raw = cookie.split('=')[1]!;
    const rows = await t.ctx.db.select().from(sessions).where(eq(sessions.tokenHash, raw));
    expect(rows).toHaveLength(0);
  });
});

describe('config hardening', () => {
  it('refuses dev allowlist, http origin and missing DATABASE_URL in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://x.example', DATABASE_URL: '' }),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        APP_ORIGIN: 'http://x.example',
        DATABASE_URL: 'postgres://u@h/db',
      }),
    ).toThrow(/https/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://x.example',
        DATABASE_URL: 'postgres://u@h/db',
        NFT_GATE_DEV_ALLOWLIST: '0x0000000000000000000000000000000000000001',
      }),
    ).toThrow(/ALLOWLIST/);
  });
});

describe('session cache', () => {
  it('logout and revoke evict cached sessions immediately (in-process)', async () => {
    const { sessionCache } = await import('../src/auth/sessions.js');
    sessionCache.ttlMs = 60_000;
    const t2 = await makeApp();
    try {
      const acc = newAccount();
      t2.ownership.set(acc.address, { status: 'holder', balance: 1 });
      const { cookie } = await login(t2.app, acc);
      expect(
        (await t2.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
      ).toBe(200); // now cached
      await t2.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...H, cookie } });
      expect(
        (await t2.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
      ).toBe(401);
    } finally {
      sessionCache.ttlMs = 0;
      await t2.close();
    }
  });
});
