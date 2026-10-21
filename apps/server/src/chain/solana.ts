import { fetchJson, TokenBucket, UpstreamError } from '../lib/http.js';

/** Minimal Solana JSON-RPC client (read-only). Avoids pulling a full SDK into the server. */
export class SolanaRpc {
  private i = 0;
  // Public mainnet RPC allows ~10 rps per IP for most methods; stay well below.
  private bucket = new TokenBucket(5, 4);

  constructor(private readonly urls: string[]) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let k = 0; k < this.urls.length; k++) {
      const url = this.urls[(this.i + k) % this.urls.length]!;
      try {
        const r = await fetchJson<{ result?: T; error?: { message: string } }>(url, {
          method: 'POST',
          body: { jsonrpc: '2.0', id: 1, method, params },
          bucket: this.bucket,
          timeoutMs: 8000,
          retries: 1,
        });
        if (r.error) throw new UpstreamError(`Solana RPC: ${r.error.message}`, null, false);
        return r.result as T;
      } catch (e) {
        lastErr = e;
        this.i = (this.i + 1) % this.urls.length;
      }
    }
    throw lastErr;
  }
}

export interface SolParsedTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: SolTokenBalance[];
    postTokenBalances?: SolTokenBalance[];
  } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: string; signer: boolean } | string> } };
}

export interface SolTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmount: number | null; decimals: number; amount: string };
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

function keyAt(tx: SolParsedTx, i: number): string | undefined {
  const k = tx.transaction.message.accountKeys[i];
  return typeof k === 'string' ? k : k?.pubkey;
}

/** Net balance changes for `owner` in a parsed transaction. SOL delta excludes the fee when owner paid it. */
export function solanaDeltas(tx: SolParsedTx, owner: string) {
  const meta = tx.meta;
  if (!meta) return null;
  const tokens = new Map<string, { delta: number; decimals: number }>();
  const add = (b: SolTokenBalance, sign: 1 | -1) => {
    if (b.owner !== owner) return;
    const cur = tokens.get(b.mint) ?? { delta: 0, decimals: b.uiTokenAmount.decimals };
    const amt = Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;
    cur.delta += sign * amt;
    tokens.set(b.mint, cur);
  };
  for (const b of meta.preTokenBalances ?? []) add(b, -1);
  for (const b of meta.postTokenBalances ?? []) add(b, 1);
  let solDelta = 0;
  let feePaid = false;
  const n = tx.transaction.message.accountKeys.length;
  for (let i = 0; i < n; i++) {
    if (keyAt(tx, i) === owner) {
      solDelta = ((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0)) / 1e9;
      if (i === 0) {
        feePaid = true;
        solDelta += meta.fee / 1e9;
      }
      break;
    }
  }
  for (const [k, v] of tokens) if (Math.abs(v.delta) < 1e-12) tokens.delete(k);
  return { tokens, solDelta, feeSol: feePaid ? meta.fee / 1e9 : 0, failed: meta.err != null };
}
