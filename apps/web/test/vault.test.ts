import { describe, expect, it } from 'vitest';
import { decryptVault, encryptVault, passwordProblems } from '../src/lib/vault/crypto';

const secrets = { evmPrivateKey: `0x${'11'.repeat(32)}` as const, solanaSecretKey: btoa('x'.repeat(64)) };
const meta = {
  evmAddress: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  solanaAddress: 'So11111111111111111111111111111111111111112',
};

describe('vault crypto (WebCrypto PBKDF2 + AES-GCM)', () => {
  it('round-trips and never stores plaintext', async () => {
    const v = await encryptVault(secrets, 'correct horse 42', meta, 1000_00);
    expect(JSON.stringify(v)).not.toContain(secrets.evmPrivateKey.slice(2));
    expect(JSON.stringify(v)).not.toContain(secrets.solanaSecretKey);
    expect(v.kdf.iterations).toBe(100_000);
    expect(await decryptVault(v, 'correct horse 42')).toEqual(secrets);
  });
  it('rejects wrong password, tampered ciphertext and swapped addresses (AAD)', async () => {
    const v = await encryptVault(secrets, 'correct horse 42', meta, 100_000);
    await expect(decryptVault(v, 'wrong password 42')).rejects.toThrow(/Wrong password/);
    const ct = atob(v.ct);
    const flipped = btoa(String.fromCharCode(ct.charCodeAt(0) ^ 1) + ct.slice(1));
    await expect(decryptVault({ ...v, ct: flipped }, 'correct horse 42')).rejects.toThrow();
    await expect(
      decryptVault({ ...v, evmAddress: '0x0000000000000000000000000000000000000001' }, 'correct horse 42'),
    ).rejects.toThrow();
    await expect(
      decryptVault({ ...v, kdf: { ...v.kdf, iterations: 10 } }, 'correct horse 42'),
    ).rejects.toThrow(/too weak/);
  });
  it('uses fresh salt/iv each time', async () => {
    const a = await encryptVault(secrets, 'correct horse 42', meta, 100_000);
    const b = await encryptVault(secrets, 'correct horse 42', meta, 100_000);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
  });
  it('enforces a password policy', () => {
    expect(passwordProblems('short')).not.toHaveLength(0);
    expect(passwordProblems('onlyletterslong')).not.toHaveLength(0);
    expect(passwordProblems('letters and 123')).toHaveLength(0);
  });
});
