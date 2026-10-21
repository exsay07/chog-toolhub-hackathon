import { Connection, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { NETWORKS } from '@chog/shared';

/** Jupiter Swap API (https://dev.jup.ag/docs/swap). Lite endpoint, no key, no platform fee set. */
const BASE = 'https://lite-api.jup.ag/swap/v1';
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const WSOL = NETWORKS.solana.wrappedNative;

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  platformFee: unknown;
  routePlan: Array<{ swapInfo: { label?: string } }>;
  [k: string]: unknown;
}

let conn: Connection | null = null;
export const solConnection = () => (conn ??= new Connection(NETWORKS.solana.defaultRpcUrls[0]!, 'confirmed'));

export async function jupQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  slippageBps: number,
  signal?: AbortSignal,
): Promise<JupQuote> {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: 'true',
  });
  const r = await fetch(`${BASE}/quote?${q}`, { signal });
  const j = (await r.json().catch(() => null)) as (JupQuote & { error?: string }) | null;
  if (!r.ok || !j || j.error) throw new Error(`Jupiter: ${j?.error ?? `HTTP ${r.status}`}`);
  if (j.platformFee) throw new Error('Quote carries a platform fee — refusing');
  return j;
}

const PRIORITY = { none: null, low: 'medium', medium: 'high', high: 'veryHigh' } as const;

export async function jupBuild(
  quote: JupQuote,
  signer: Keypair,
  priority: keyof typeof PRIORITY,
): Promise<VersionedTransaction> {
  const lvl = PRIORITY[priority];
  const r = await fetch(`${BASE}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      wrapAndUnwrapSol: true,
      ...(lvl
        ? {
            prioritizationFeeLamports: {
              priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: lvl },
            },
          }
        : {}),
    }),
  });
  const j = (await r.json().catch(() => null)) as { swapTransaction?: string; error?: string } | null;
  if (!r.ok || !j?.swapTransaction) throw new Error(`Jupiter: ${j?.error ?? `HTTP ${r.status}`}`);
  const tx = VersionedTransaction.deserialize(
    Uint8Array.from(atob(j.swapTransaction), (c) => c.charCodeAt(0)),
  );
  validateJupTx(tx, signer.publicKey.toBase58());
  return tx;
}

/** Defensive checks before we sign anything returned by a third party. */
export function validateJupTx(tx: VersionedTransaction, wallet: string) {
  const keys: string[] = tx.message.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== wallet) throw new Error('Fee payer is not our wallet — refusing');
  if (tx.message.header.numRequiredSignatures !== 1)
    throw new Error('Transaction requires extra signers — refusing');
  const programs = new Set(tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]));
  if (!programs.has(JUPITER_PROGRAM))
    throw new Error('Transaction does not call the Jupiter program — refusing');
}
