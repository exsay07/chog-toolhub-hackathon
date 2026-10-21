import { describe, expect, it } from 'vitest';
import { classify } from '../src/tracker/classify.js';
import { solanaDeltas, type SolParsedTx } from '../src/chain/solana.js';

const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';

describe('tracker classification', () => {
  it('native → token is a buy with native counter leg', () => {
    const r = classify('base', [{ token: TOKEN, amount: 1000 }], -0.5, true, ROUTER);
    expect(r).toEqual([
      expect.objectContaining({
        kind: 'buy',
        token: TOKEN,
        tokenAmount: 1000,
        counterSymbol: 'ETH',
        counterAmount: 0.5,
        counterIsNative: true,
      }),
    ]);
  });
  it('USDC → token is a buy with exact stable counter (≈USD)', () => {
    const r = classify(
      'base',
      [
        { token: TOKEN, amount: 5 },
        { token: USDC_BASE, amount: -250 },
      ],
      0,
      true,
      ROUTER,
    );
    expect(r[0]).toMatchObject({
      kind: 'buy',
      counterSymbol: 'USDC',
      counterAmount: 250,
      counterIsStable: true,
    });
  });
  it('token → WETH is a sell', () => {
    const r = classify(
      'base',
      [
        { token: TOKEN, amount: -5 },
        { token: WETH_BASE, amount: 0.2 },
      ],
      0,
      true,
      ROUTER,
    );
    expect(r[0]).toMatchObject({ kind: 'sell', token: TOKEN, tokenAmount: 5, counterSymbol: 'WETH' });
  });
  it('a plain incoming transfer is not a buy', () => {
    expect(classify('base', [{ token: TOKEN, amount: 5 }], 0, false, TOKEN)[0]!.kind).toBe('transfer_in');
  });
  it('direct token.transfer() by the wallet is a transfer, not a sell', () => {
    expect(classify('base', [{ token: TOKEN, amount: -5 }], 0, true, TOKEN)[0]!.kind).toBe('transfer_out');
  });
  it('token sent via router with invisible native proceeds is a (probable) sell with unknown counter', () => {
    const r = classify('base', [{ token: TOKEN, amount: -5 }], 0, true, ROUTER);
    expect(r[0]).toMatchObject({ kind: 'sell', counterAmount: null });
  });
  it('token → token swap yields both a buy and a sell', () => {
    const OTHER = '0x2222222222222222222222222222222222222222';
    const kinds = classify(
      'bsc',
      [
        { token: TOKEN, amount: 10 },
        { token: OTHER, amount: -3 },
      ],
      0,
      true,
      ROUTER,
    ).map((x) => x.kind);
    expect(kinds.sort()).toEqual(['buy', 'sell']);
  });
  it('solana: SOL → token buy using pre/post balances', () => {
    const W = 'Wa11et1111111111111111111111111111111111111';
    const tx: SolParsedTx = {
      slot: 1,
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_499_995_000, 0],
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: 'Mint111111111111111111111111111111111111111',
            owner: W,
            uiTokenAmount: { uiAmount: 42, decimals: 6, amount: '42000000' },
          },
        ],
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: W, signer: true },
            { pubkey: 'ATA', signer: false },
          ],
        },
      },
    };
    const d = solanaDeltas(tx, W)!;
    expect(d.solDelta).toBeCloseTo(-0.5);
    expect(d.feeSol).toBeCloseTo(0.000005);
    const r = classify(
      'solana',
      [...d.tokens].map(([token, v]) => ({ token, amount: v.delta })),
      d.solDelta,
      true,
      null,
    );
    expect(r[0]).toMatchObject({ kind: 'buy', tokenAmount: 42, counterSymbol: 'SOL' });
  });
});
