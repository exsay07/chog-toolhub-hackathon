import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from 'viem';
import { NETWORKS, type NetworkId } from '@chog/shared';
import { evmSignerFor } from '../vault/vault';

const chains = new Map<NetworkId, Chain>();
const clients = new Map<NetworkId, PublicClient>();

export function chainFor(id: NetworkId): Chain {
  let c = chains.get(id);
  if (!c) {
    const n = NETWORKS[id];
    if (n.kind !== 'evm' || !n.chainId) throw new Error(`${n.name} is not EVM`);
    c = defineChain({
      id: n.chainId,
      name: n.name,
      nativeCurrency: { name: n.nativeSymbol, symbol: n.nativeSymbol, decimals: n.nativeDecimals },
      rpcUrls: { default: { http: n.defaultRpcUrls } },
    });
    chains.set(id, c);
  }
  return c;
}

export function publicClient(id: NetworkId): PublicClient {
  let c = clients.get(id);
  if (!c) {
    c = createPublicClient({
      chain: chainFor(id),
      transport: fallback(NETWORKS[id].defaultRpcUrls.map((u) => http(u, { timeout: 8000, retryCount: 1 }))),
    }) as PublicClient;
    clients.set(id, c);
  }
  return c;
}

/** Wallet client for one of the vault's EVM wallets (default: main). */
export function walletClient(id: NetworkId, wallet?: string | null) {
  return createWalletClient({
    account: evmSignerFor(wallet),
    chain: chainFor(id),
    transport: http(NETWORKS[id].defaultRpcUrls[0]),
  });
}

/**
 * Serialises sends per network and wallet so concurrent automations never reuse a nonce. The nonce
 * is read from the 'pending' tag each time, so external sends are respected.
 */
const locks = new Map<string, Promise<unknown>>();
export async function withNonceLock<T>(
  id: NetworkId,
  fn: (nonce: number) => Promise<T>,
  wallet?: string | null,
): Promise<T> {
  const address = evmSignerFor(wallet).address;
  const k = `${id}:${address.toLowerCase()}`;
  const prev = locks.get(k) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  locks.set(
    k,
    prev.then(() => next),
  );
  await prev.catch(() => {});
  try {
    const nonce = await publicClient(id).getTransactionCount({ address, blockTag: 'pending' });
    return await fn(nonce);
  } finally {
    release();
  }
}

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

export const PRIORITY_MULT = { none: 1, low: 1.1, medium: 1.5, high: 2.5 } as const;

export async function feeOverrides(id: NetworkId, level: keyof typeof PRIORITY_MULT) {
  const c = publicClient(id);
  try {
    const f = await c.estimateFeesPerGas();
    if (f.maxFeePerGas && f.maxPriorityFeePerGas !== undefined) {
      const m = BigInt(Math.round(PRIORITY_MULT[level] * 100));
      const tip = (f.maxPriorityFeePerGas * m) / 100n;
      return { maxPriorityFeePerGas: tip, maxFeePerGas: f.maxFeePerGas + (tip - f.maxPriorityFeePerGas) };
    }
  } catch {
    /* legacy chain */
  }
  const gp = await c.getGasPrice();
  return { gasPrice: (gp * BigInt(Math.round(PRIORITY_MULT[level] * 100))) / 100n };
}
