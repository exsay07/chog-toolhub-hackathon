import { getAddress, isAddress } from 'viem';
import { NETWORKS, type NetworkId } from './networks.js';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

/** Decodes base58 (Bitcoin alphabet). Returns null on invalid input. */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0 || s.length > 128) return null;
  const bytes: number[] = [];
  for (const ch of s) {
    const v = B58_MAP.get(ch);
    if (v === undefined) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(input: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (const byte of input) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!];
  return out;
}

export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  const d = base58Decode(s);
  return d !== null && d.length === 32;
}

export function isEvmAddress(s: string): boolean {
  // strict: mixed-case input must carry a valid EIP-55 checksum (catches typos).
  return isAddress(s, { strict: true });
}

export function isValidAddress(network: NetworkId, s: string): boolean {
  return NETWORKS[network].kind === 'evm' ? isEvmAddress(s) : isSolanaAddress(s);
}

/**
 * Canonical form used as identity: EVM → lowercase (checksum is presentation), Solana → as-is
 * (base58 is case-sensitive). Throws on invalid input.
 */
export function normalizeAddress(network: NetworkId, s: string): string {
  const t = s.trim();
  if (!isValidAddress(network, t)) throw new Error(`Invalid ${NETWORKS[network].name} address`);
  return NETWORKS[network].kind === 'evm' ? t.toLowerCase() : t;
}

export function displayAddress(network: NetworkId, s: string): string {
  return NETWORKS[network].kind === 'evm' && isEvmAddress(s) ? getAddress(s) : s;
}

export function shortAddress(s: string, n = 4): string {
  return s.length <= n * 2 + 3 ? s : `${s.slice(0, n + (s.startsWith('0x') ? 2 : 0))}…${s.slice(-n)}`;
}

/** Guess which network families an address could belong to (used by search). */
export function addressFamilies(s: string): Array<'evm' | 'solana'> {
  const t = s.trim();
  const out: Array<'evm' | 'solana'> = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) out.push('evm');
  if (isSolanaAddress(t)) out.push('solana');
  return out;
}
