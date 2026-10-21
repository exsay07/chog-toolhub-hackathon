import { afterEach, describe, expect, it } from 'vitest';
import type { PrivateKeyAccount } from 'viem';
import { H, makeApp, newAccount, siweMessage } from './helpers.js';

const CODE = 'judge-pass-2026-abcdef';
let t: Awaited<ReturnType<typeof makeApp>> | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function signIn(account: PrivateKeyAccount, judgeCode?: string) {
  const message = await siweMessage(t!.app, account);
  const signature = await account.signMessage({ message });
  const res = await t!.app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: H,
    payload: { message, signature, ...(judgeCode !== undefined ? { judgeCode } : {}) },
  });
  const c = res.cookies.find((x) => x.name === 'chog_session');
  return { res, cookie: c ? `chog_session=${c.value}` : '' };
}
const me = (cookie: string) =>
  t!.app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...H, cookie } });

describe('judge access (reviewer pass)', () => {
  it('lets a wallet without the NFT in with the right code, labelled as judge', async () => {
    t = await makeApp({ JUDGE_ACCESS_CODE: CODE });
    const gate = (await t.app.inject({ method: 'GET', url: '/api/gate' })).json();
    expect(gate.judgeAccess).toBe(true);
    const { res, cookie } = await signIn(newAccount(), CODE);
    expect(res.statusCode).toBe(200);
    expect(res.json().accessBasis).toBe('judge');
    const m = await me(cookie);
    expect(m.statusCode).toBe(200);
    expect(m.json().accessBasis).toBe('judge');
    // Works past the periodic NFT re-check (no NFT is ever looked up for a judge).
    expect(t.ownership.calls).toBe(0);
  });

  it('a wrong code is refused (and is not a silent normal sign-in)', async () => {
    t = await makeApp({ JUDGE_ACCESS_CODE: CODE });
    const a = newAccount();
    t.ownership.set(a.address, { status: 'holder', balance: 1 });
    const { res, cookie } = await signIn(a, 'judge-pass-2026-WRONG!');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('BAD_JUDGE_CODE');
    expect(cookie).toBe('');
  });

  it('is off when no code is configured; holders are unaffected', async () => {
    t = await makeApp();
    expect((await t.app.inject({ method: 'GET', url: '/api/gate' })).json().judgeAccess).toBe(false);
    expect((await signIn(newAccount(), CODE)).res.statusCode).toBe(403);
    const holder = newAccount();
    t.ownership.set(holder.address, { status: 'holder', balance: 2 });
    const ok = await signIn(holder);
    expect(ok.res.json().accessBasis).toBe('holder');
    expect((await signIn(newAccount())).res.json().code).toBe('NOT_HOLDER');
  });

  it('an expired pass refuses new judges and ends existing judge sessions', async () => {
    t = await makeApp({
      JUDGE_ACCESS_CODE: CODE,
      JUDGE_ACCESS_UNTIL: new Date(Date.now() + 60_000).toISOString(),
    });
    const { cookie } = await signIn(newAccount(), CODE);
    expect((await me(cookie)).statusCode).toBe(200);
    t.ctx.cfg.judgeUntil = Date.now() - 1;
    const after = await me(cookie);
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('JUDGE_ACCESS_ENDED');
    expect((await signIn(newAccount(), CODE)).res.statusCode).toBe(403);
  });

  it('rejects malformed codes in the configuration', async () => {
    await expect(makeApp({ JUDGE_ACCESS_CODE: 'short' })).rejects.toThrow(/JUDGE_ACCESS_CODE/);
  });
});
