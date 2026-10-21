/**
 * Popular EVM browser wallets. Installed ones announce themselves (EIP-6963) and are matched by `rdns`;
 * the rest are offered with a link to their official download page. Links point only to the wallets'
 * own sites — never to stores or third-party mirrors.
 */
export interface KnownWallet {
  name: string;
  /** EIP-6963 reverse-DNS id the extension announces. */
  rdns: string[];
  url: string;
  /** Brand-ish colour for the letter tile (no third-party images are loaded). */
  color: string;
}

export const KNOWN_WALLETS: KnownWallet[] = [
  {
    name: 'MetaMask',
    rdns: ['io.metamask', 'io.metamask.flask'],
    url: 'https://metamask.io/download/',
    color: '#f6851b',
  },
  { name: 'Rabby', rdns: ['io.rabby'], url: 'https://rabby.io/', color: '#7084ff' },
  {
    name: 'Coinbase Wallet',
    rdns: ['com.coinbase.wallet'],
    url: 'https://www.coinbase.com/wallet/downloads',
    color: '#0052ff',
  },
  { name: 'Phantom', rdns: ['app.phantom'], url: 'https://phantom.com/download', color: '#ab9ff2' },
  { name: 'OKX Wallet', rdns: ['com.okex.wallet'], url: 'https://web3.okx.com/download', color: '#d4d4d4' },
  {
    name: 'Trust Wallet',
    rdns: ['com.trustwallet.app'],
    url: 'https://trustwallet.com/download',
    color: '#3375bb',
  },
  { name: 'Rainbow', rdns: ['me.rainbow'], url: 'https://rainbow.me/download', color: '#ff5ca0' },
  { name: 'Zerion', rdns: ['io.zerion.wallet'], url: 'https://zerion.io/download', color: '#2962ef' },
  { name: 'Backpack', rdns: ['app.backpack'], url: 'https://backpack.app/download', color: '#e33e3f' },
  {
    name: 'Bitget Wallet',
    rdns: ['com.bitget.web3'],
    url: 'https://web3.bitget.com/en/wallet-download',
    color: '#00f0ff',
  },
  {
    name: 'Magic Eden',
    rdns: ['io.magiceden.wallet'],
    url: 'https://wallet.magiceden.io/',
    color: '#e42575',
  },
  {
    name: 'Uniswap Extension',
    rdns: ['org.uniswap.app'],
    url: 'https://wallet.uniswap.org/',
    color: '#ff37c7',
  },
  { name: 'Brave Wallet', rdns: ['com.brave.wallet'], url: 'https://brave.com/wallet/', color: '#fb542b' },
];

/** Known wallets that are NOT among the announced (installed) ones. */
export function notInstalled(installedRdns: string[]): KnownWallet[] {
  const have = new Set(installedRdns.map((r) => r.toLowerCase()));
  return KNOWN_WALLETS.filter((w) => !w.rdns.some((r) => have.has(r)));
}
