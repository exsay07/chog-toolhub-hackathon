/**
 * Perpl (perps DEX on Monad) endpoints and contracts, from the official api-docs (README → Network
 * Configuration). Market ids, decimals and leverage caps are read at runtime from /v1/pub/context.
 */
export const PERPL_NETWORKS = {
  mainnet: {
    label: 'Mainnet',
    chainId: 143,
    api: 'https://app.perpl.xyz/api',
    ws: 'wss://app.perpl.xyz',
    app: 'https://app.perpl.xyz',
    rpc: 'https://rpc.monad.xyz',
    exchange: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
    collateral: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
  },
  testnet: {
    label: 'Testnet',
    chainId: 10143,
    api: 'https://testnet.perpl.xyz/api',
    ws: 'wss://testnet.perpl.xyz',
    app: 'https://testnet.perpl.xyz',
    rpc: 'https://testnet-rpc.monad.xyz',
    exchange: '0x1964C32f0bE608E7D29302AFF5E61268E72080cc',
    collateral: '0xdF5B718d8FcC173335185a2a1513eE8151e3c027',
  },
} as const;
export type PerplNet = keyof typeof PERPL_NETWORKS;
export const PERPL_NETS = Object.keys(PERPL_NETWORKS) as PerplNet[];
export const isPerplNet = (v: unknown): v is PerplNet => typeof v === 'string' && v in PERPL_NETWORKS;
