import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { H, login, makeApp, newAccount } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let alice: string;
let bob: string;

const P = '0x1111111111111111111111111111111111111111';
const X1 = '0x2222222222222222222222222222222222222222';
const X2 = '0x3333333333333333333333333333333333333333';
const SOL = 'So11111111111111111111111111111111111111112';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

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

const req = (cookie: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  t.app.inject({ method, url, headers: { ...H, cookie }, payload: payload as object });

const journalEntry = (n: number, wallet?: string) => ({
  idempotencyKey: `test-key-${n}`,
  network: 'base',
  hash: hash(n),
  kind: 'swap',
  source: 'manual',
  side: 'buy',
  token: null,
  quotedUsd: 1,
  ...(wallet ? { wallet } : {}),
});

describe('multi-wallet trading wallets', () => {
  it('new endpoints need a session', async () => {
    for (const [method, url] of [
      ['PUT', '/api/trading-wallets/extra'],
      ['GET', '/api/nft/collection?slug=chog'],
    ] as const)
      expect((await t.app.inject({ method, url, headers: H, payload: { evm: [] } })).statusCode).toBe(401);
  });

  it('needs a primary before extras', async () => {
    const r = await req(alice, 'PUT', '/api/trading-wallets/extra', { evm: [{ address: X1, label: 'W2' }] });
    expect(r.statusCode).toBe(400);
  });

  it('stores extras next to the primary, replaces the list, rejects junk', async () => {
    await req(alice, 'PUT', '/api/trading-wallets', { evm: P, solana: SOL });
    let r = await req(alice, 'PUT', '/api/trading-wallets/extra', {
      evm: [
        { address: X1.toUpperCase().replace('0X', '0x'), label: 'W2' },
        { address: X2, label: 'W3' },
      ],
    });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ kind: string; address: string; role: string; label: string | null }>;
    expect(rows.filter((w) => w.role === 'extra').map((w) => [w.address, w.label])).toEqual([
      [X1, 'W2'],
      [X2, 'W3'],
    ]);
    expect(rows.find((w) => w.role === 'primary' && w.kind === 'evm')?.address).toBe(P);
    r = await req(alice, 'PUT', '/api/trading-wallets/extra', { evm: [{ address: X2, label: 'only' }] });
    expect((r.json() as Array<{ role: string }>).filter((w) => w.role === 'extra')).toHaveLength(1);
    for (const bad of [
      { evm: [{ address: 'nope', label: '' }] },
      { evm: [{ address: P, label: 'self' }] },
      {
        evm: [
          { address: X1, label: '' },
          { address: X1, label: '' },
        ],
      },
      {
        evm: Array.from({ length: 21 }, (_, i) => ({
          address: `0x${String(i).padStart(40, '4')}`,
          label: '',
        })),
      },
    ])
      expect((await req(alice, 'PUT', '/api/trading-wallets/extra', bad)).statusCode).toBe(400);
  });

  it('journal records the sending wallet only if it is one of mine', async () => {
    let r = await req(alice, 'POST', '/api/journal', journalEntry(1));
    expect(r.json().wallet).toBe(P);
    r = await req(alice, 'POST', '/api/journal', journalEntry(2, X2.toUpperCase().replace('0X', '0x')));
    expect(r.json().wallet).toBe(X2);
    r = await req(alice, 'POST', '/api/journal', journalEntry(3, X1)); // removed from the list above
    expect(r.statusCode).toBe(400);
    await req(bob, 'PUT', '/api/trading-wallets', { evm: X1, solana: null });
    r = await req(bob, 'POST', '/api/journal', journalEntry(4, X2)); // alice's wallet
    expect(r.statusCode).toBe(400);
  });

  it('re-registering the primary keeps extras; deleting the vault forgets them', async () => {
    await req(alice, 'PUT', '/api/trading-wallets', { evm: P, solana: SOL });
    let rows = (await req(alice, 'GET', '/api/trading-wallets')).json() as Array<{ role: string }>;
    expect(rows.filter((w) => w.role === 'extra')).toHaveLength(1);
    await req(alice, 'PUT', '/api/trading-wallets', { evm: null, solana: null });
    rows = (await req(alice, 'GET', '/api/trading-wallets')).json() as Array<{ role: string }>;
    expect(rows).toHaveLength(0);
  });
});
