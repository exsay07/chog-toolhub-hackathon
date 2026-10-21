import { timingSafeEqual } from 'node:crypto';
import type { PublicClient } from 'viem';
import { ERC721_BALANCE_ABI } from '../chain/evm.js';

export type OwnershipResult =
  | { status: 'holder'; balance: number }
  | { status: 'not_holder' }
  | { status: 'unverifiable'; reason: string };

export interface OwnershipVerifier {
  check(address: `0x${string}`): Promise<OwnershipResult>;
}

/**
 * Reads ERC-721 `balanceOf` directly from the canonical chain (authoritative), via the configured
 * RPC fallback set. Results are cached briefly with single-flight per address.
 */
export class OnchainOwnershipVerifier implements OwnershipVerifier {
  private cache = new Map<string, { at: number; r: OwnershipResult }>();
  private inflight = new Map<string, Promise<OwnershipResult>>();

  constructor(
    private readonly client: PublicClient,
    private readonly contract: `0x${string}`,
    private readonly cacheMs = 30_000,
  ) {}

  async check(address: `0x${string}`): Promise<OwnershipResult> {
    const key = address.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs && hit.r.status !== 'unverifiable') return hit.r;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.read(address).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const r = await p;
    if (r.status !== 'unverifiable') this.cache.set(key, { at: Date.now(), r });
    return r;
  }

  private async read(address: `0x${string}`): Promise<OwnershipResult> {
    try {
      const bal = await this.client.readContract({
        address: this.contract,
        abi: ERC721_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [address],
      });
      return bal > 0n ? { status: 'holder', balance: Number(bal) } : { status: 'not_holder' };
    } catch {
      return { status: 'unverifiable', reason: 'NFT ownership could not be verified (RPC unavailable)' };
    }
  }

  invalidate(address: string) {
    this.cache.delete(address.toLowerCase());
  }
}

/** Dev-only wrapper: grants access to explicitly allow-listed addresses. Refused in production by config. */
export class DevAllowlistVerifier implements OwnershipVerifier {
  constructor(
    private readonly inner: OwnershipVerifier,
    private readonly allow: Set<string>,
  ) {}
  async check(address: `0x${string}`): Promise<OwnershipResult> {
    const r = await this.inner.check(address);
    if (r.status === 'holder') return r;
    if (this.allow.has(address.toLowerCase())) return { status: 'holder', balance: 0 };
    return r;
  }
  isAllowlisted(address: string) {
    return this.allow.has(address.toLowerCase());
  }
}

/** The reviewer pass (JUDGE_ACCESS_CODE) is configured and not past JUDGE_ACCESS_UNTIL. */
export function judgePassOpen(
  cfg: { JUDGE_ACCESS_CODE: string; judgeUntil: number | null },
  now = Date.now(),
) {
  return (
    cfg.JUDGE_ACCESS_CODE.length > 0 &&
    (cfg.judgeUntil === null || Number.isNaN(cfg.judgeUntil) || now < cfg.judgeUntil)
  );
}

/** Constant-time comparison of the typed code with the configured one. */
export function judgeCodeMatches(
  cfg: { JUDGE_ACCESS_CODE: string; judgeUntil: number | null },
  typed: string,
) {
  if (!judgePassOpen(cfg)) return false;
  const a = Buffer.from(typed);
  const b = Buffer.from(cfg.JUDGE_ACCESS_CODE);
  return a.length === b.length && timingSafeEqual(a, b);
}
