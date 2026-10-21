/**
 * Network capability matrix.
 *
 * Every value here was checked against a live endpoint or official documentation on 2026-10-19
 * (see docs/INTEGRATIONS.md). Nothing is silently substituted: each network has its own adapter
 * family and its own explicit trading status.
 */

export type NetworkId =
  'monad' | 'bsc' | 'solana' | 'base' | 'robinhood' | 'ethereum' | 'arc' | 'ink' | 'hyperevm';
export type NetworkKind = 'evm' | 'solana';

/**
 * - `verified`: full critical trading path tested on this network with real funds. (None yet.)
 * - `implemented-unverified`: quote → simulate → sign → submit → reconcile is implemented against a
 *   real aggregator, quotes were verified live, but no real-funds swap has been executed by us.
 * - `data-only`: market data and tracking only; trading disabled.
 */
export type TradingStatus = 'verified' | 'implemented-unverified' | 'data-only';

export interface NetworkInfo {
  id: NetworkId;
  name: string;
  shortName: string;
  kind: NetworkKind;
  /** EVM chain id. Undefined for Solana. */
  chainId?: number;
  mainnet: true;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Wrapped native token, used for USD pricing of the native asset. */
  wrappedNative: string;
  defaultRpcUrls: string[];
  explorer: { name: string; tx: (hash: string) => string; address: (addr: string) => string };
  dexscreenerId: string;
  geckoterminalId: string;
  /** KyberSwap aggregator chain path (EVM only). */
  kyberPath?: string;
  /** GoPlus security API chain id. */
  goplusId: string;
  tradingAdapter: 'kyberswap' | 'jupiter';
  tradingStatus: TradingStatus;
  simulation: string;
  finality: string;
  /** Typical block time used for polling cadence (ms). */
  blockTimeMs: number;
  /** Max blocks per eth_getLogs request that public RPCs accept. */
  logsBlockRange?: number;
  supportsPriorityFee: boolean;
  wallets: string[];
  limitations: string[];
}

const evmExplorer = (base: string, name: string) => ({
  name,
  tx: (h: string) => `${base}/tx/${h}`,
  address: (a: string) => `${base}/address/${a}`,
});

export const NETWORKS: Record<NetworkId, NetworkInfo> = {
  monad: {
    id: 'monad',
    name: 'Monad',
    shortName: 'MON',
    kind: 'evm',
    chainId: 143,
    mainnet: true,
    nativeSymbol: 'MON',
    nativeDecimals: 18,
    wrappedNative: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
    defaultRpcUrls: ['https://rpc.monad.xyz', 'https://rpc3.monad.xyz'],
    explorer: evmExplorer('https://monadscan.com', 'MonadScan'),
    dexscreenerId: 'monad',
    geckoterminalId: 'monad',
    kyberPath: 'monad',
    goplusId: '143',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'implemented-unverified',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'Receipt status after inclusion; Monad has single-slot finality (~0.8s).',
    blockTimeMs: 400,
    logsBlockRange: 100,
    supportsPriorityFee: true,
    wallets: ['Injected EIP-1193 (MetaMask, Rabby, Phantom EVM, Backpack)'],
    limitations: ['Public RPCs are rate-limited (15–25 rps); production needs a dedicated RPC.'],
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    shortName: 'BSC',
    kind: 'evm',
    chainId: 56,
    mainnet: true,
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    defaultRpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
    explorer: evmExplorer('https://bscscan.com', 'BscScan'),
    dexscreenerId: 'bsc',
    geckoterminalId: 'bsc',
    kyberPath: 'bsc',
    goplusId: '56',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'implemented-unverified',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'Receipt status; fast finality after ~2 blocks.',
    blockTimeMs: 750,
    logsBlockRange: 50,
    supportsPriorityFee: false,
    wallets: ['Injected EIP-1193'],
    limitations: ['Public mempool: MEV sandwich risk is significant; keep slippage tight.'],
  },
  base: {
    id: 'base',
    name: 'Base',
    shortName: 'BASE',
    kind: 'evm',
    chainId: 8453,
    mainnet: true,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x4200000000000000000000000000000000000006',
    defaultRpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: evmExplorer('https://basescan.org', 'BaseScan'),
    dexscreenerId: 'base',
    geckoterminalId: 'base',
    kyberPath: 'base',
    goplusId: '8453',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'implemented-unverified',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'L2 receipt status (soft finality); L1 finality later.',
    blockTimeMs: 2000,
    logsBlockRange: 500,
    supportsPriorityFee: true,
    wallets: ['Injected EIP-1193'],
    limitations: ['Sequencer-ordered; L1 data fee included in gas cost.'],
  },
  robinhood: {
    id: 'robinhood',
    name: 'Robinhood Chain',
    shortName: 'RH',
    kind: 'evm',
    chainId: 4663,
    mainnet: true,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    defaultRpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    explorer: evmExplorer('https://robinhoodchain.blockscout.com', 'Blockscout'),
    dexscreenerId: 'robinhood',
    geckoterminalId: 'robinhood',
    kyberPath: 'robinhood',
    goplusId: '4663',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'data-only',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'Arbitrum Orbit L2 receipt status (soft finality).',
    blockTimeMs: 250,
    logsBlockRange: 500,
    supportsPriorityFee: false,
    wallets: ['Injected EIP-1193'],
    limitations: [
      'Robinhood Chain = Robinhood’s Arbitrum-Orbit EVM L2 (chain id 4663), not the Robinhood brokerage app.',
      'KyberSwap recognises the chain path but returned no route for tested tokens; trading disabled until a route is verified.',
      'Public RPC is rate-limited and not intended for production.',
    ],
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    shortName: 'ETH',
    kind: 'evm',
    chainId: 1,
    mainnet: true,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    defaultRpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth'],
    explorer: evmExplorer('https://etherscan.io', 'Etherscan'),
    dexscreenerId: 'ethereum',
    geckoterminalId: 'eth',
    kyberPath: 'ethereum',
    goplusId: '1',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'implemented-unverified',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'Receipt status after inclusion; economic finality after ~2 epochs (~13 min).',
    blockTimeMs: 12_000,
    logsBlockRange: 500,
    supportsPriorityFee: true,
    wallets: ['Injected EIP-1193'],
    limitations: [
      'Gas is expensive relative to small memecoin buys; public mempool → MEV sandwich risk.',
      'KyberSwap routes verified live 2026-10-20 (ETH → USDC via Uniswap v3).',
    ],
  },
  arc: {
    id: 'arc',
    name: 'Arc',
    shortName: 'ARC',
    kind: 'evm',
    chainId: 5042,
    mainnet: true,
    // Circle's Arc pays gas in USDC: the native balance has 18 decimals; the ERC-20 view at 0x3600… has 6.
    nativeSymbol: 'USDC',
    nativeDecimals: 18,
    wrappedNative: '0x3600000000000000000000000000000000000000',
    defaultRpcUrls: ['https://rpc.mainnet.arc.io'],
    explorer: evmExplorer('https://explorer.arc.io', 'Arc Explorer'),
    dexscreenerId: 'arc',
    geckoterminalId: 'arc',
    kyberPath: 'arc',
    goplusId: '5042',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'implemented-unverified',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'Instant (deterministic) finality, ~0.5 s blocks.',
    blockTimeMs: 500,
    logsBlockRange: 100,
    supportsPriorityFee: false,
    wallets: ['Injected EIP-1193'],
    limitations: [
      'Circle Arc mainnet (chain id 5042, live since 2026-09-16); native gas token is USDC.',
      'KyberSwap routes verified live 2026-10-20 (USDC → token via Uniswap v3/v4). GoPlus may not cover Arc yet.',
    ],
  },
  ink: {
    id: 'ink',
    name: 'Ink',
    shortName: 'INK',
    kind: 'evm',
    chainId: 57073,
    mainnet: true,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x4200000000000000000000000000000000000006',
    defaultRpcUrls: ['https://rpc-gel.inkonchain.com', 'https://rpc-qnd.inkonchain.com'],
    explorer: evmExplorer('https://explorer.inkonchain.com', 'Ink Explorer'),
    dexscreenerId: 'ink',
    geckoterminalId: 'ink',
    goplusId: '57073',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'data-only',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'OP-stack L2 receipt status (soft finality); L1 finality later.',
    blockTimeMs: 1000,
    logsBlockRange: 500,
    supportsPriorityFee: true,
    wallets: ['Injected EIP-1193'],
    limitations: [
      'Kraken’s OP-stack L2. KyberSwap has no Ink route (404, checked 2026-10-20): market data only until an aggregator is added.',
    ],
  },
  hyperevm: {
    id: 'hyperevm',
    name: 'HyperEVM',
    shortName: 'HYPE',
    kind: 'evm',
    chainId: 999,
    mainnet: true,
    nativeSymbol: 'HYPE',
    nativeDecimals: 18,
    wrappedNative: '0x5555555555555555555555555555555555555555',
    defaultRpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
    explorer: evmExplorer('https://hyperevmscan.io', 'HyperEVMScan'),
    dexscreenerId: 'hyperevm',
    geckoterminalId: 'hyperevm',
    kyberPath: 'hyperevm',
    goplusId: '999',
    tradingAdapter: 'kyberswap',
    tradingStatus: 'implemented-unverified',
    simulation: 'eth_call + eth_estimateGas',
    finality: 'HyperBFT one-block finality (~1 s small blocks).',
    blockTimeMs: 1000,
    logsBlockRange: 50,
    supportsPriorityFee: true,
    wallets: ['Injected EIP-1193'],
    limitations: [
      'Hyperliquid’s EVM. Public RPC is rate-limited. KyberSwap routes verified live 2026-10-20 (HYPE → USD₮0).',
    ],
  },
  solana: {
    id: 'solana',
    name: 'Solana',
    shortName: 'SOL',
    kind: 'solana',
    mainnet: true,
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    wrappedNative: 'So11111111111111111111111111111111111111112',
    defaultRpcUrls: ['https://api.mainnet-beta.solana.com'],
    explorer: {
      name: 'Solscan',
      tx: (h) => `https://solscan.io/tx/${h}`,
      address: (a) => `https://solscan.io/account/${a}`,
    },
    dexscreenerId: 'solana',
    geckoterminalId: 'solana',
    goplusId: 'solana',
    tradingAdapter: 'jupiter',
    tradingStatus: 'implemented-unverified',
    simulation: 'simulateTransaction',
    finality: '`confirmed` commitment for UI, `finalized` for reconciliation.',
    blockTimeMs: 400,
    supportsPriorityFee: true,
    wallets: ['Trading vault (ed25519 keypair)'],
    limitations: [
      'Public mainnet RPC is heavily rate-limited; set SOLANA_RPC_URL for real use.',
      'NFT gate is EVM-only (Chog Genesis lives on Monad); Solana is used for trading only.',
    ],
  },
};

export const NETWORK_IDS = Object.keys(NETWORKS) as NetworkId[];

export function isNetworkId(v: unknown): v is NetworkId {
  return typeof v === 'string' && v in NETWORKS;
}

export function networkByChainId(chainId: number): NetworkInfo | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}

export function canTrade(id: NetworkId): boolean {
  return NETWORKS[id].tradingStatus !== 'data-only';
}

/** EVM sentinel used by KyberSwap for the native asset. */
export const EVM_NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Chog Genesis (verified on-chain 2026-10-19: name()="Chog Genesis", symbol()="CHOG", totalSupply()=1969, ERC-721). */
export const CHOG_GENESIS = {
  network: 'monad' as NetworkId,
  chainId: 143,
  address: '0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763',
  standard: 'ERC-721',
  totalSupply: 1969,
} as const;
