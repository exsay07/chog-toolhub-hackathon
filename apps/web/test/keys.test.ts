import { describe, expect, it } from 'vitest';
import { base58Encode } from '@chog/shared';
import { generateSecrets, parseImport } from '../src/lib/vault/vault';

// @solana/web3.js v3: key generation / import are async (WebCrypto Ed25519).
describe('trading wallet keys', () => {
  it('generates a pair and re-imports it to the same addresses', async () => {
    const g = await generateSecrets();
    expect(g.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(g.solanaAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const sk = Uint8Array.from(atob(g.solanaSecretKey), (c) => c.charCodeAt(0));
    expect(sk.length).toBe(64);
    const again = await parseImport(g.evmPrivateKey, base58Encode(sk));
    expect(again.evmAddress).toBe(g.evmAddress);
    expect(again.solanaAddress).toBe(g.solanaAddress);
    const asJson = await parseImport(g.evmPrivateKey.slice(2), JSON.stringify([...sk]));
    expect(asJson.solanaAddress).toBe(g.solanaAddress);
  });

  it('rejects malformed keys', async () => {
    await expect(parseImport('0x12', '[1,2,3]')).rejects.toThrow(/32 bytes/);
    await expect(parseImport(`0x${'11'.repeat(32)}`, '[1,2,3]')).rejects.toThrow(/64 bytes/);
  });
});
