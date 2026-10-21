/**
 * LIVE integration tests against real public endpoints (no mocks). They need internet and can be
 * skipped with OFFLINE=1. They read data only — no transactions are sent, no funds involved.
 */
import { describe, expect, it } from 'vitest';
import { CHOG_GENESIS, NETWORKS } from '@chog/shared';
import { createEvmClients } from '../src/chain/evm.js';
import { OnchainOwnershipVerifier } from '../src/auth/nftGate.js';
import { dsSearch, dsTokenPairs, GeckoTerminal, goplusSecurity } from '../src/market/providers.js';
import { SolanaRpc } from '../src/chain/solana.js';
import { UpstreamError } from '../src/lib/http.js';

/** GeckoTerminal's free tier is 30 req/min; a 429 is the provider throttling us, not a test failure. */
async function geckoOrSkip<T>(ctx: { skip: (note?: string) => void }, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 429) ctx.skip('GeckoTerminal rate limit (HTTP 429)');
    throw e;
  }
}

const live = process.env.OFFLINE ? describe.skip : describe;
const CHOG_TOKEN = '0x350035555e10d9afaf1566aaebfced5ba6c27777';

live('live: Monad NFT gate (Chog Genesis)', () => {
  const evm = createEvmClients({
    monad: NETWORKS.monad.defaultRpcUrls,
    bsc: [],
    base: [],
    robinhood: [],
    solana: [],
  } as never);
  const client = evm.monad!;
  const gate = new OnchainOwnershipVerifier(client, CHOG_GENESIS.address as `0x${string}`);

  it('contract identity matches the canonical collection', async () => {
    const abi = [
      { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      {
        type: 'function',
        name: 'totalSupply',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }],
      },
    ] as const;
    expect(await client.getChainId()).toBe(143);
    expect(await client.readContract({ address: CHOG_GENESIS.address, abi, functionName: 'name' })).toBe(
      'Chog Genesis',
    );
    expect(
      await client.readContract({ address: CHOG_GENESIS.address, abi, functionName: 'totalSupply' }),
    ).toBe(1969n);
  });

  it('recognises a real holder (owner of token #1) and rejects an empty address', async () => {
    const owner = await client.readContract({
      address: CHOG_GENESIS.address,
      abi: [
        {
          type: 'function',
          name: 'ownerOf',
          stateMutability: 'view',
          inputs: [{ type: 'uint256' }],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'ownerOf',
      args: [1n],
    });
    const r = await gate.check(owner);
    expect(r.status).toBe('holder');
    expect((await gate.check('0x000000000000000000000000000000000000dEaD')).status).toBe('not_holder');
  });

  it('fails closed when the RPC is unreachable', async () => {
    const dead = createEvmClients({
      monad: ['http://127.0.0.1:9'],
      bsc: [],
      base: [],
      robinhood: [],
      solana: [],
    } as never).monad!;
    const g = new OnchainOwnershipVerifier(dead, CHOG_GENESIS.address as `0x${string}`);
    expect((await g.check('0x000000000000000000000000000000000000dEaD')).status).toBe('unverifiable');
  });
});

live('live: market data providers', () => {
  it('Dexscreener search + token pairs (Monad CHOG)', async () => {
    const s = await dsSearch('CHOG');
    expect(s.some((p) => p.network === 'monad')).toBe(true);
    const tp = await dsTokenPairs('monad', CHOG_TOKEN);
    expect(tp.length).toBeGreaterThan(0);
    expect(tp[0]!.source).toBe('dexscreener');
  });

  it('GeckoTerminal OHLCV + new pools', async (ctx) => {
    const gt = new GeckoTerminal('');
    const tp = await dsTokenPairs('monad', CHOG_TOKEN);
    const pool = tp.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0]!.pairAddress;
    const c = await geckoOrSkip(ctx, () => gt.ohlcv('monad', pool, 'hour', 1, 50));
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.time).toBeLessThan(c.at(-1)!.time + 1);
    const np = await geckoOrSkip(ctx, () => gt.newPools('base'));
    expect(np.length).toBeGreaterThan(0);
  });

  it('GoPlus token security (Monad)', async () => {
    const s = await goplusSecurity('monad', CHOG_TOKEN);
    expect(s).not.toBeNull();
    expect(s!.source).toBe('goplus');
  });

  it('Solana JSON-RPC reachable', async () => {
    const rpc = new SolanaRpc(NETWORKS.solana.defaultRpcUrls);
    const slot = await rpc.call<number>('getSlot', []);
    expect(slot).toBeGreaterThan(0);
  });
});

live('live: aggregators (quotes only, nothing is signed)', () => {
  it('KyberSwap quote on Monad uses the allow-listed router with no extra fee', async () => {
    const r = await fetch(
      `https://aggregator-api.kyberswap.com/monad/api/v1/routes?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&tokenOut=${CHOG_TOKEN}&amountIn=1000000000000000000`,
      { headers: { 'x-client-id': 'chog-toolhub' } },
    );
    const j = (await r.json()) as {
      code: number;
      data: { routerAddress: string; routeSummary: { extraFee?: { feeAmount: string } } };
    };
    expect(j.code).toBe(0);
    expect(j.data.routerAddress.toLowerCase()).toBe('0x6131b5fae19ea4f9d964eac0408e4408b66337b5');
    expect(['', '0', undefined]).toContain(j.data.routeSummary.extraFee?.feeAmount);
  });

  it('Jupiter quote (SOL → USDC) has no platform fee', async () => {
    const r = await fetch(
      'https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&slippageBps=50',
    );
    const j = (await r.json()) as { outAmount: string; platformFee: unknown };
    expect(Number(j.outAmount)).toBeGreaterThan(0);
    expect(j.platformFee).toBeNull();
  });
});

live('live: reconciliation against a real Monad swap', () => {
  it('derives confirmed state, token qty, native leg and fee from chain data only', async (ctx) => {
    const { Reconciler } = await import('../src/journal/reconciler.js');
    const { MarketService } = await import('../src/market/service.js');
    const gt = new GeckoTerminal('');
    const tp = await dsTokenPairs('monad', CHOG_TOKEN);
    const pool = tp.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0]!.pairAddress;
    const trades = await geckoOrSkip(ctx, () => gt.trades('monad', pool));
    const t = trades.find((x) => x.side === 'buy' && x.maker && x.hash);
    expect(t, 'a recent buy on the CHOG pool').toBeDefined();
    const evm = createEvmClients({
      monad: NETWORKS.monad.defaultRpcUrls,
      bsc: [],
      base: [],
      robinhood: [],
      solana: [],
    } as never);
    const rec = new Reconciler(
      {} as never,
      evm,
      new SolanaRpc(['http://127.0.0.1:9']),
      new MarketService(),
      {} as never,
      {} as never,
    );
    const row = {
      network: 'monad',
      hash: t!.hash,
      wallet: t!.maker!.toLowerCase(),
      token: CHOG_TOKEN,
      tokenSymbol: null,
      state: 'submitted',
      createdAt: new Date(),
    };
    const out = await (
      rec as unknown as { evmOutcome: (r: typeof row) => Promise<Record<string, unknown>> }
    ).evmOutcome(row);
    // Router-mediated buys may deliver tokens to the maker; aggregator flows can route elsewhere.
    expect(out.state).toBe('confirmed');
    expect(out.feeNative as number).toBeGreaterThan(0);
    expect(out.blockTime).toBeInstanceOf(Date);
    expect(typeof out.tokenQty).toBe('number');
  });
});
