import { createPublicClient, defineChain, fallback, http, type PublicClient } from 'viem';
import { NETWORKS, type NetworkId } from '@chog/shared';

export function viemChain(id: NetworkId, rpcUrls: string[]) {
  const n = NETWORKS[id];
  if (n.kind !== 'evm' || !n.chainId) throw new Error(`${id} is not an EVM network`);
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: { name: n.nativeSymbol, symbol: n.nativeSymbol, decimals: n.nativeDecimals },
    rpcUrls: { default: { http: rpcUrls } },
    blockExplorers: {
      default: { name: n.explorer.name, url: n.explorer.address('').replace(/\/address\/$/, '') },
    },
  });
}

export type EvmClients = Partial<Record<NetworkId, PublicClient>>;

export function createEvmClients(rpc: Partial<Record<NetworkId, string[]>>): EvmClients {
  const out: EvmClients = {};
  for (const id of Object.keys(NETWORKS) as NetworkId[]) {
    if (NETWORKS[id].kind !== 'evm') continue;
    const urls = rpc[id] ?? NETWORKS[id].defaultRpcUrls;
    out[id] = createPublicClient({
      chain: viemChain(id, urls),
      transport: fallback(
        urls.map((u) => http(u, { timeout: 6000, retryCount: 1, batch: { batchSize: 20, wait: 10 } })),
        { rank: false },
      ),
    }) as PublicClient;
  }
  return out;
}

export const ERC721_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const ERC20_META_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
