import { randomBytes } from 'node:crypto';
import { getAddress, recoverMessageAddress, type PublicClient } from 'viem';
import { parseSiweMessage, type SiweMessage } from 'viem/siwe';

export const NONCE_TTL_MS = 5 * 60_000;
export const MAX_MESSAGE_AGE_MS = 10 * 60_000;
export const SIWE_STATEMENT =
  'Sign in to Chog Toolhub. This proves you control this wallet so we can check Chog Genesis ownership. It does not authorise any transaction or token approval and costs no gas.';

export function newNonce(): string {
  // SIWE nonces must be alphanumeric, ≥ 8 chars.
  return randomBytes(16).toString('hex');
}

export type SiweCheck =
  { ok: true; message: SiweMessage; address: `0x${string}` } | { ok: false; error: string };

/**
 * Validates every field we rely on. Nonce single-use is enforced separately in the database
 * (atomic UPDATE … WHERE used_at IS NULL).
 */
export function validateSiweFields(
  raw: string,
  expected: { domain: string; origin: string; now: number },
): SiweCheck {
  if (raw.length > 2000) return { ok: false, error: 'Message too long' };
  let m: Partial<SiweMessage>;
  try {
    m = parseSiweMessage(raw);
  } catch {
    return { ok: false, error: 'Malformed SIWE message' };
  }
  if (!m.address || !m.nonce || !m.domain || !m.uri || !m.version || !m.chainId || !m.issuedAt)
    return { ok: false, error: 'SIWE message missing required fields' };
  if (m.domain !== expected.domain) return { ok: false, error: 'SIWE domain mismatch' };
  try {
    if (new URL(m.uri).origin !== expected.origin) return { ok: false, error: 'SIWE URI mismatch' };
  } catch {
    return { ok: false, error: 'SIWE URI invalid' };
  }
  if (m.version !== '1') return { ok: false, error: 'Unsupported SIWE version' };
  if (m.statement !== SIWE_STATEMENT) return { ok: false, error: 'Unexpected SIWE statement' };
  const issued = m.issuedAt.getTime();
  if (issued > expected.now + 60_000) return { ok: false, error: 'SIWE issuedAt is in the future' };
  if (expected.now - issued > MAX_MESSAGE_AGE_MS) return { ok: false, error: 'SIWE message too old' };
  if (!m.expirationTime) return { ok: false, error: 'SIWE expirationTime required' };
  if (m.expirationTime.getTime() <= expected.now) return { ok: false, error: 'SIWE message expired' };
  if (m.expirationTime.getTime() - issued > MAX_MESSAGE_AGE_MS)
    return { ok: false, error: 'SIWE validity window too long' };
  if (m.notBefore && m.notBefore.getTime() > expected.now)
    return { ok: false, error: 'SIWE message not yet valid' };
  return { ok: true, message: m as SiweMessage, address: getAddress(m.address) };
}

export interface SignatureVerifier {
  verify(address: `0x${string}`, message: string, signature: `0x${string}`): Promise<boolean>;
}

/**
 * EOA signatures are verified locally (ecrecover). If that fails, fall back to an on-chain check
 * so ERC-1271 smart-contract wallets work too.
 */
export class ViemSignatureVerifier implements SignatureVerifier {
  constructor(private readonly client?: PublicClient) {}
  async verify(address: `0x${string}`, message: string, signature: `0x${string}`): Promise<boolean> {
    try {
      const rec = await recoverMessageAddress({ message, signature });
      if (rec.toLowerCase() === address.toLowerCase()) return true;
    } catch {
      /* not a plain EOA signature */
    }
    if (!this.client) return false;
    try {
      return await this.client.verifyMessage({ address, message, signature });
    } catch {
      return false;
    }
  }
}
