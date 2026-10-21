import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import * as wasm from 'bulk-keychain-wasm';
import type { PerpsTaskConfig } from '@chog/shared';

/**
 * Live run of the Bulk farmer on Bulk TESTNET (free test funds, no real money). Opt-in:
 *   BULK_LIVE=1 npx vitest run apps/web/test/bulk.live.test.ts
 * Testnet books are nearly empty, so a second throwaway account ("maker") quotes both sides around
 * the mark price and lifts the farmer's resting bids, letting every leg actually fill.
 */

wasm.initSync({
  module: readFileSync(
    new URL('../../../node_modules/bulk-keychain-wasm/bulk_keychain_wasm_bg.wasm', import.meta.url),
  ),
});
vi.mock('../src/lib/perps/bulk', async (orig) => ({
  ...(await orig<typeof import('../src/lib/perps/bulk')>()),
  keychain: async () => wasm,
}));
vi.stubGlobal('window', globalThis);

const NET = 'testnet' as const;
const API = 'https://exchange-api.bulk.trade/api/v1';
const SYM = 'SOL-USD';

async function throwawayAccount() {
  const { submit, nonce, agentSign, claimFaucet } = await import('../src/lib/perps/bulk');
  const gen = async () => {
    const k = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return { k, pub: bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))) };
  };
  const owner = await gen();
  const agentKey = await gen();
  // Owner authorises the agent in the same wallet ("base58") mode Phantom uses.
  const w = wasm.prepareWalletMessage(
    wasm.prepareAgentWallet(agentKey.pub, false, {
      signatureDomain: NET,
      account: owner.pub,
      signer: owner.pub,
      nonce: nonce(),
    }),
    'base58',
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, owner.k.privateKey, w.messageBytes as BufferSource),
  );
  const st = await submit(NET, wasm.finalizeWalletMessage(w, bs58.encode(sig)), 'base58');
  expect(st[0]?.agentWallet).toBeTruthy();
  const agent = {
    net: NET,
    owner: owner.pub,
    pubkey: agentKey.pub,
    privateKey: agentKey.k.privateKey,
    createdAt: Date.now(),
  };
  expect(await claimFaucet(agent)).toBeGreaterThan(0);
  const order = async (o: Record<string, unknown>) =>
    submit(
      NET,
      await agentSign(
        agent,
        wasm.prepareOrder(
          { symbol: SYM, reduceOnly: false, iso: false, ...o },
          {
            signatureDomain: NET,
            account: owner.pub,
            signer: agentKey.pub,
            nonce: nonce(),
          },
        ) as never,
      ),
    );
  return { agent, order };
}

const cfg = (o: Partial<PerpsTaskConfig>): PerpsTaskConfig => ({
  platform: 'bulk',
  pair: SYM,
  direction: 'alternate',
  sizeUsd: 60,
  leverage: 5,
  entry: 'market',
  exit: 'market',
  limitOffsetBps: 20,
  holdSec: 5,
  intervalSec: 8,
  risk: {
    maxNotionalUsd: 500,
    maxLeverage: 10,
    maxOpenPositions: 1,
    maxConcurrentOrders: 2,
    maxDailyLossUsd: 25,
    maxRuntimeMin: 10,
  },
  ...o,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.BULK_LIVE)('Bulk farmer on testnet (live)', () => {
  it('completes real long and short cycles, then stops flat', async () => {
    const { bulkMarkets } = await import('../src/lib/perps/bulk');
    const { BulkFarmer } = await import('../src/lib/perps/bulkFarmer');
    const market = (await bulkMarkets(NET)).find((m) => m.symbol === SYM)!;
    const mark = Number((await (await fetch(`${API}/ticker/${SYM}`)).json()).markPrice);
    const maker = await throwawayAccount();
    const px = (v: number) => Math.round(v * 1000) / 1000;
    // Two-sided liquidity 0.1% around mark (testnet has none of its own).
    for (const [isBuy, p] of [
      [true, px(mark * 0.999)],
      [false, px(mark * 1.001)],
    ] as const)
      await maker.order({
        type: 'order',
        isBuy,
        price: p,
        size: 20,
        orderType: { type: 'limit', tif: 'ALO' },
      });

    const farmer = (await throwawayAccount()).agent;
    const f = new BulkFarmer('live', farmer, market, cfg({}), (l, m) => console.log(`[${l}] ${m}`));
    f.start();
    const t0 = Date.now();
    while (f.state.cycles < 2 && Date.now() - t0 < 120_000 && !['error', 'stopped'].includes(f.state.state))
      await sleep(1000);
    expect(f.state.error).toBeNull();
    expect(f.state.cycles).toBeGreaterThanOrEqual(2);
    expect(f.state.volumeUsd).toBeGreaterThan(200);
    f.stop();
    while (f.state.state !== 'stopped' && Date.now() - t0 < 180_000) await sleep(500);
    expect(f.state.state).toBe('stopped');
    expect(f.state.position).toBeNull();
    await maker.order({ type: 'cancelAll', symbols: [SYM] });
  }, 240_000);
  it('maker mode: rests post-only orders at the touch and they fill', async () => {
    const { bulkMarkets, bulkAccount } = await import('../src/lib/perps/bulk');
    const { BulkFarmer } = await import('../src/lib/perps/bulkFarmer');
    const market = (await bulkMarkets(NET)).find((m) => m.symbol === SYM)!;
    const mark = Number((await (await fetch(`${API}/ticker/${SYM}`)).json()).markPrice);
    const maker = await throwawayAccount();
    const px = (v: number) => Math.round(v * 1000) / 1000;
    // A wide two-sided quote so the farmer's post-only orders become the best bid / ask.
    await maker.order({
      type: 'order',
      isBuy: true,
      price: px(mark * 0.997),
      size: 20,
      orderType: { type: 'limit', tif: 'ALO' },
    });
    await maker.order({
      type: 'order',
      isBuy: false,
      price: px(mark * 1.003),
      size: 20,
      orderType: { type: 'limit', tif: 'ALO' },
    });

    const farmer = (await throwawayAccount()).agent;
    const f = new BulkFarmer(
      'live-maker',
      farmer,
      market,
      cfg({ entry: 'limit', exit: 'limit', holdSec: 5 }),
      (l, m) => console.log(`[${l}] ${m}`),
    );
    f.start();
    const t0 = Date.now();
    // The "market": every few seconds, hit whatever the farmer has resting.
    const taker = setInterval(async () => {
      const a = await bulkAccount(NET, farmer.owner).catch(() => null);
      const mine = a?.openOrders.find((o) => o.symbol === SYM);
      if (!mine) return;
      const restingBuy = mine.price < mark;
      await maker.order({
        type: 'order',
        isBuy: !restingBuy,
        price: 0,
        size: Math.abs(mine.size),
        orderType: { type: 'market', isMarket: true, triggerPx: 0 },
      });
    }, 4000);
    try {
      while (f.state.cycles < 1 && Date.now() - t0 < 150_000 && !['error', 'stopped'].includes(f.state.state))
        await sleep(1000);
    } finally {
      clearInterval(taker);
    }
    expect(f.state.error).toBeNull();
    expect(f.state.cycles).toBeGreaterThanOrEqual(1);
    expect(f.state.makerVolumeUsd).toBeGreaterThan(100);
    f.stop();
    while (f.state.state !== 'stopped' && Date.now() - t0 < 220_000) await sleep(500);
    expect(f.state.state).toBe('stopped');
    await maker.order({ type: 'cancelAll', symbols: [SYM] });
  }, 260_000);
});
