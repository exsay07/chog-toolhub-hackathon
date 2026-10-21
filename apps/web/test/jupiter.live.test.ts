import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { jupBuild, jupQuote, validateJupTx, WSOL } from '../src/lib/trade/jupiter';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Live: quote → build → validate → sign with @solana/web3.js v3 (nothing is sent).
describe.skipIf(!!process.env.OFFLINE)('Jupiter swap path (live, not sent)', () => {
  it('builds, validates and signs a SOL→USDC swap', async () => {
    const kp = await Keypair.generate();
    const q = await jupQuote(WSOL, USDC, 10_000_000n, 100);
    expect(BigInt(q.outAmount)).toBeGreaterThan(0n);
    const tx = await jupBuild(q, kp, 'low');
    expect(() => validateJupTx(tx, kp.publicKey.toBase58())).not.toThrow();
    await tx.sign([kp]);
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
    expect(tx.serialize().length).toBeGreaterThan(100);
  }, 30_000);
});
