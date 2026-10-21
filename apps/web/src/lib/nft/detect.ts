import { formatEther, getAddress, toFunctionSelector, type Hex } from 'viem';
import { NETWORKS, NETWORK_IDS, isNetworkId, type NetworkId } from '@chog/shared';
import { publicClient } from '../trade/evm';

/**
 * umi.bot-style "paste a link" for the NFT Sniper: understands contract addresses, explorer links,
 * OpenSea / Magic Eden item and collection links, then reads the contract to find a simple public
 * mint function, its price and limits. Everything is read from the chain; nothing is guessed silently —
 * every detected value is shown for the user to confirm.
 */

export type MintTarget =
  { kind: 'address'; network: NetworkId | null; address: `0x${string}` } | { kind: 'slug'; slug: string };

const EVM = NETWORK_IDS.filter((n) => NETWORKS[n].kind === 'evm');

/** Chain names used in marketplace URLs → our network ids. */
const ALIASES: Record<string, NetworkId> = {
  eth: 'ethereum',
  mainnet: 'ethereum',
  ethereum: 'ethereum',
  base: 'base',
  monad: 'monad',
  bsc: 'bsc',
  bnb: 'bsc',
  robinhood: 'robinhood',
  ink: 'ink',
  hyperevm: 'hyperevm',
  hyperliquid: 'hyperevm',
  arc: 'arc',
};

function explorerHost(n: NetworkId): string | null {
  try {
    return new URL(NETWORKS[n].explorer.address('0x0000000000000000000000000000000000000000')).hostname;
  } catch {
    return null;
  }
}

/** Parses whatever the user pasted. Returns null when nothing usable is found. */
export function parseMintTarget(input: string): MintTarget | null {
  const s = input.trim();
  const addr = /0x[0-9a-fA-F]{40}/.exec(s)?.[0];
  let url: URL | null;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!url.hostname.includes('.')) url = null;
  } catch {
    url = null;
  }
  if (!addr) {
    const slug =
      url && /opensea\.io$/i.test(url.hostname) ? /^\/collection\/([^/?#]+)/i.exec(url.pathname)?.[1] : null;
    return slug ? { kind: 'slug', slug: decodeURIComponent(slug) } : null;
  }
  let network: NetworkId | null = null;
  if (url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    network = EVM.find((n) => explorerHost(n)?.replace(/^www\./, '') === host) ?? null;
    if (!network)
      for (const seg of url.pathname.toLowerCase().split('/'))
        if (ALIASES[seg]) {
          network = ALIASES[seg];
          break;
        }
    if (!network) {
      const sub = host.split('.')[0]!;
      if (ALIASES[sub]) network = ALIASES[sub];
    }
  }
  return {
    kind: 'address',
    network: network && isNetworkId(network) ? network : null,
    address: getAddress(addr),
  };
}

/* ------------------------------------------------------------------------- detection ---- */

export interface MintCandidate {
  signature: string;
  args: string[];
}

/** Simple public mint shapes, most specific first. Placeholders: {quantity}, {recipient}. */
export const MINT_CANDIDATES: MintCandidate[] = [
  { signature: 'publicMint(uint256)', args: ['{quantity}'] },
  { signature: 'mintPublic(uint256)', args: ['{quantity}'] },
  { signature: 'publicSaleMint(uint256)', args: ['{quantity}'] },
  { signature: 'mint(uint256)', args: ['{quantity}'] },
  { signature: 'mint(uint32)', args: ['{quantity}'] },
  { signature: 'purchase(uint256)', args: ['{quantity}'] },
  { signature: 'claim(uint256)', args: ['{quantity}'] },
  { signature: 'publicMint(address,uint256)', args: ['{recipient}', '{quantity}'] },
  { signature: 'mint(address,uint256)', args: ['{recipient}', '{quantity}'] },
  { signature: 'mintTo(address,uint256)', args: ['{recipient}', '{quantity}'] },
  { signature: 'publicMint()', args: [] },
  { signature: 'mint()', args: [] },
];

const PRICE_FNS = [
  'publicPrice',
  'publicMintPrice',
  'publicSalePrice',
  'mintPrice',
  'MINT_PRICE',
  'price',
  'PRICE',
  'cost',
  'salePrice',
  'pricePerToken',
  'getPrice',
];
const MAX_SUPPLY_FNS = ['maxSupply', 'MAX_SUPPLY', 'collectionSize', 'maxTokens', 'MAX_TOKENS'];
const PER_WALLET_FNS = [
  'maxPerWallet',
  'maxMintPerWallet',
  'MAX_PER_WALLET',
  'maxMintAmountPerWallet',
  'walletLimit',
  'maxPerAddress',
];
const PER_TX_FNS = ['maxPerTx', 'maxMintAmountPerTx', 'MAX_PER_TX', 'maxMintPerTx'];
const ACTIVE_FNS = [
  'publicSaleActive',
  'isPublicSaleActive',
  'publicMintEnabled',
  'saleActive',
  'saleIsActive',
  'isSaleActive',
  'mintEnabled',
  'mintActive',
  'isMintActive',
];

const sel = (sig: string) => toFunctionSelector(`function ${sig}`).slice(2).toLowerCase();

/** True when the runtime code dispatches on this function (PUSH4 <selector>). */
export function codeHasFunction(code: string, signature: string) {
  return code.toLowerCase().includes(`63${sel(signature)}`);
}

const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** EIP-1167 minimal proxy → implementation address. */
export function minimalProxyTarget(code: string): `0x${string}` | null {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code);
  return m ? getAddress(`0x${m[1]}`) : null;
}

export interface MintDetection {
  network: NetworkId;
  address: `0x${string}`;
  hasCode: boolean;
  standard: 'ERC-721' | 'ERC-1155' | 'unknown';
  proxy: `0x${string}` | null;
  name: string | null;
  symbol: string | null;
  totalSupply: bigint | null;
  maxSupply: bigint | null;
  perWallet: bigint | null;
  perTx: bigint | null;
  priceWei: bigint | null;
  priceFn: string | null;
  saleActive: boolean | null;
  paused: boolean | null;
  candidates: MintCandidate[];
}

const view = (name: string, out: 'uint256' | 'bool' | 'string') =>
  ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: out }],
  }) as const;

export async function detectMint(network: NetworkId, address: `0x${string}`): Promise<MintDetection> {
  const pc = publicClient(network);
  const base: MintDetection = {
    network,
    address,
    hasCode: false,
    standard: 'unknown',
    proxy: null,
    name: null,
    symbol: null,
    totalSupply: null,
    maxSupply: null,
    perWallet: null,
    perTx: null,
    priceWei: null,
    priceFn: null,
    saleActive: null,
    paused: null,
    candidates: [],
  };
  const code = (await pc.getCode({ address })) ?? '0x';
  if (code === '0x') return base;
  base.hasCode = true;
  // Proxies dispatch in the implementation: read its code too.
  let all = code;
  let impl = minimalProxyTarget(code);
  if (!impl) {
    const slot = await pc.getStorageAt({ address, slot: EIP1967_IMPL as Hex }).catch(() => null);
    if (slot && BigInt(slot) !== 0n) impl = getAddress(`0x${slot.slice(-40)}`);
  }
  if (impl) {
    base.proxy = impl;
    all += ((await pc.getCode({ address: impl }).catch(() => null)) ?? '').slice(2);
  }
  const has = (sig: string) => codeHasFunction(all, sig);
  const read = async <T>(name: string, out: 'uint256' | 'bool' | 'string'): Promise<T | null> => {
    if (!has(`${name}()`)) return null;
    try {
      return (await pc.readContract({ address, abi: [view(name, out)], functionName: name })) as T;
    } catch {
      return null;
    }
  };
  const first = async <T>(names: string[], out: 'uint256' | 'bool'): Promise<[T | null, string | null]> => {
    for (const n of names) {
      const v = await read<T>(n, out);
      if (v !== null) return [v, n];
    }
    return [null, null];
  };
  const iface = async (id: Hex) => {
    try {
      return (await pc.readContract({
        address,
        abi: [
          {
            type: 'function',
            name: 'supportsInterface',
            stateMutability: 'view',
            inputs: [{ type: 'bytes4' }],
            outputs: [{ type: 'bool' }],
          },
        ],
        functionName: 'supportsInterface',
        args: [id],
      })) as boolean;
    } catch {
      return false;
    }
  };
  const [name, symbol, totalSupply, is721, is1155] = await Promise.all([
    read<string>('name', 'string'),
    read<string>('symbol', 'string'),
    read<bigint>('totalSupply', 'uint256'),
    iface('0x80ac58cd'),
    iface('0xd9b67a26'),
  ]);
  const [[priceWei, priceFn], [maxSupply], [perWallet], [perTx], [saleActive], paused] = await Promise.all([
    first<bigint>(PRICE_FNS, 'uint256'),
    first<bigint>(MAX_SUPPLY_FNS, 'uint256'),
    first<bigint>(PER_WALLET_FNS, 'uint256'),
    first<bigint>(PER_TX_FNS, 'uint256'),
    first<boolean>(ACTIVE_FNS, 'bool'),
    read<boolean>('paused', 'bool'),
  ]);
  return {
    ...base,
    standard: is721 ? 'ERC-721' : is1155 ? 'ERC-1155' : 'unknown',
    name,
    symbol,
    totalSupply,
    maxSupply,
    perWallet,
    perTx,
    priceWei,
    priceFn,
    saleActive,
    paused,
    candidates: MINT_CANDIDATES.filter((c) => has(c.signature)),
  };
}

/** Human summary line for the form. */
export function describeDetection(d: MintDetection) {
  const sym = NETWORKS[d.network].nativeSymbol;
  const parts = [
    d.standard,
    d.proxy ? 'proxy' : null,
    d.totalSupply !== null
      ? `minted ${d.totalSupply}${d.maxSupply !== null ? ` / ${d.maxSupply}` : ''}`
      : d.maxSupply !== null
        ? `max ${d.maxSupply}`
        : null,
    d.priceWei !== null ? `price ${formatEther(d.priceWei)} ${sym} (${d.priceFn})` : 'price not readable',
    d.perWallet !== null ? `${d.perWallet}/wallet` : null,
    d.perTx !== null ? `${d.perTx}/tx` : null,
    d.totalSupply !== null && d.maxSupply !== null && d.maxSupply > 0n && d.totalSupply >= d.maxSupply
      ? 'SOLD OUT'
      : null,
    d.saleActive === true ? 'sale active' : d.saleActive === false ? 'sale NOT active' : null,
    d.paused === true ? 'PAUSED' : null,
  ];
  return parts.filter(Boolean).join(' · ');
}
