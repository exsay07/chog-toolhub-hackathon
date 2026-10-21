/**
 * Trading-vault encryption. Uses only the platform WebCrypto API (reviewed implementations):
 *   KDF:    PBKDF2-HMAC-SHA256, 600 000 iterations (OWASP 2023 guidance), 16-byte random salt
 *   Cipher: AES-256-GCM, 12-byte random IV, 128-bit tag (authenticated — tampering is detected)
 * The plaintext secrets never leave the browser; the server only ever receives public addresses.
 */

export const KDF_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 12;

export interface VaultSecrets {
  /** 0x-prefixed secp256k1 private key (EVM networks). */
  evmPrivateKey: `0x${string}`;
  /** 64-byte ed25519 secret key (Solana), base64. */
  solanaSecretKey: string;
  /** Additional EVM wallets (multi-wallet mints / snipes). */
  extraEvm?: Array<{ key: `0x${string}`; label: string }>;
}

export interface EncryptedVault {
  v: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  ct: string;
  evmAddress: string;
  solanaAddress: string;
  /** Public addresses of the extra EVM wallets (checked against the decrypted keys on unlock). */
  extras?: Array<{ address: string; label: string }>;
  createdAt: number;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function passwordProblems(pw: string): string[] {
  const p: string[] = [];
  if (pw.length < MIN_PASSWORD_LENGTH) p.push(`At least ${MIN_PASSWORD_LENGTH} characters`);
  if (!/[a-z]/i.test(pw) || !/[0-9\W_]/.test(pw)) p.push('Mix letters with numbers or symbols');
  return p;
}

export async function encryptVault(
  secrets: VaultSecrets,
  password: string,
  meta: { evmAddress: string; solanaAddress: string },
  iterations = KDF_ITERATIONS,
): Promise<EncryptedVault> {
  if (passwordProblems(password).length) throw new Error('Password too weak');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  // Addresses are bound as additional authenticated data: swapping them in storage breaks decryption.
  const aad = new TextEncoder().encode(`${meta.evmAddress.toLowerCase()}|${meta.solanaAddress}`);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(secrets)),
  );
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) },
    cipher: { name: 'AES-GCM', iv: b64(iv) },
    ct: b64(new Uint8Array(ct)),
    evmAddress: meta.evmAddress,
    solanaAddress: meta.solanaAddress,
    createdAt: Date.now(),
  };
}

export async function decryptVault(v: EncryptedVault, password: string): Promise<VaultSecrets> {
  if (v.v !== 1 || v.kdf.name !== 'PBKDF2' || v.cipher.name !== 'AES-GCM')
    throw new Error('Unsupported vault format');
  if (v.kdf.iterations < 100_000) throw new Error('Vault KDF parameters too weak');
  const key = await deriveKey(password, unb64(v.kdf.salt), v.kdf.iterations);
  const aad = new TextEncoder().encode(`${v.evmAddress.toLowerCase()}|${v.solanaAddress}`);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(v.cipher.iv) as BufferSource, additionalData: aad as BufferSource },
      key,
      unb64(v.ct) as BufferSource,
    );
  } catch {
    throw new Error('Wrong password or corrupted vault');
  }
  return JSON.parse(new TextDecoder().decode(pt)) as VaultSecrets;
}
