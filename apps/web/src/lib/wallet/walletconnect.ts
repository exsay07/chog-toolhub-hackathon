import type { Eip1193 } from './eip6963';

/**
 * WalletConnect v2 for phone wallets (MetaMask Mobile, Trust, Rainbow, OKX, …): the page shows the
 * pairing URI as a QR code, the phone approves, and we get an EIP-1193-like handle that is good for
 * sign-in (eth_requestAccounts + personal_sign). Loaded only when the user picks it.
 * Needs a free Reown (WalletConnect) project id, served by the API as `walletConnectProjectId`.
 */

const SIGN_CHAINS = ['eip155:143', 'eip155:1'];

export interface WcConnection {
  provider: Eip1193;
  address: string;
  disconnect: () => Promise<void>;
}

export async function connectWalletConnect(
  projectId: string,
  onUri: (uri: string) => void,
  signal: AbortSignal,
): Promise<WcConnection> {
  const { default: UniversalProvider } = await import('@walletconnect/universal-provider');
  const wc = await UniversalProvider.init({
    projectId,
    logger: 'error',
    metadata: {
      name: 'Chog Toolhub',
      description: 'Trading workstation for Chog Genesis holders on Monad',
      url: location.origin,
      icons: [`${location.origin}/brand/favicon.png`],
    },
  });
  const onDisplay = (uri: string) => onUri(uri);
  wc.on('display_uri', onDisplay);
  const abort = () => {
    (wc as unknown as { abortPairingAttempt?: () => void }).abortPairingAttempt?.();
    void wc.disconnect().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const session = await wc.connect({
      optionalNamespaces: {
        eip155: {
          methods: ['personal_sign', 'eth_signTypedData_v4'],
          chains: SIGN_CHAINS,
          events: ['accountsChanged', 'chainChanged'],
          rpcMap: { 143: 'https://rpc.monad.xyz', 1: 'https://ethereum-rpc.publicnode.com' },
        },
      },
    });
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const accounts = session?.namespaces?.eip155?.accounts ?? [];
    // "eip155:<chain>:<address>" — prefer Monad, else whatever chain the wallet approved.
    const pick = accounts.find((a) => a.startsWith('eip155:143:')) ?? accounts[0];
    if (!pick) throw new Error('The phone wallet did not share an EVM account');
    const [ns, ref, address] = pick.split(':') as [string, string, string];
    const chain = `${ns}:${ref}`;
    const provider: Eip1193 = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
        if (method === 'eth_chainId') return `0x${Number(ref).toString(16)}`;
        return wc.request({ method, params: params as unknown[] }, chain);
      },
    };
    return {
      provider,
      address,
      disconnect: async () => {
        await wc.disconnect().catch(() => {});
      },
    };
  } finally {
    wc.off?.('display_uri', onDisplay);
    signal.removeEventListener('abort', abort);
  }
}
