import { useEffect, useState } from 'react';

/** EIP-1193 provider as exposed by browser wallets. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193;
}

/**
 * EIP-6963 multi-wallet discovery. Avoids the `window.ethereum` race where several extensions
 * overwrite each other. Falls back to `window.ethereum` if no wallet announces itself.
 */
export function useInjectedWallets(): WalletInfo[] {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  useEffect(() => {
    const found = new Map<string, WalletInfo>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info: Omit<WalletInfo, 'provider'>; provider: Eip1193 }>).detail;
      if (!d?.info?.uuid || found.has(d.info.uuid)) return;
      // Icons are data: URIs supplied by extensions; only accept image data URIs.
      const icon = /^data:image\/(svg\+xml|png|webp|jpeg);/.test(d.info.icon) ? d.info.icon : '';
      found.set(d.info.uuid, {
        ...d.info,
        icon,
        name: String(d.info.name).slice(0, 40),
        provider: d.provider,
      });
      setWallets([...found.values()]);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const t = window.setTimeout(() => {
      const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      if (found.size === 0 && eth)
        setWallets([{ uuid: 'legacy', name: 'Browser wallet', icon: '', rdns: 'legacy', provider: eth }]);
    }, 400);
    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      clearTimeout(t);
    };
  }, []);
  return wallets;
}

/**
 * Finds the browser wallet that controls `address` (outside React, e.g. when a bot needs a
 * signature). Asks every announced wallet for its connected accounts; falls back to window.ethereum.
 */
export async function findProvider(address: string): Promise<Eip1193> {
  const found: Eip1193[] = [];
  const onAnnounce = (e: Event) => {
    const p = (e as CustomEvent<{ provider: Eip1193 }>).detail?.provider;
    if (p && !found.includes(p)) found.push(p);
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 300));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (eth && !found.includes(eth)) found.push(eth);
  const want = address.toLowerCase();
  for (const p of found) {
    try {
      const acc = (await p.request({ method: 'eth_accounts' })) as string[];
      if (acc?.some((a) => a.toLowerCase() === want)) return p;
    } catch {
      /* wallet locked or refused */
    }
  }
  for (const p of found) {
    try {
      const acc = (await p.request({ method: 'eth_requestAccounts' })) as string[];
      if (acc?.some((a) => a.toLowerCase() === want)) return p;
    } catch {
      /* next */
    }
  }
  throw new Error(`Open the wallet that holds ${address.slice(0, 6)}…${address.slice(-4)} and connect it`);
}
