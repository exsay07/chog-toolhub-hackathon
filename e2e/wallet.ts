import type { Page } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToString } from 'viem';

// Public Hardhat test key #0 (TEST ONLY, never funded).
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

/**
 * Injects a minimal EIP-6963 wallet into the page. Signing happens in the Node test process with a
 * real secp256k1 key, so the server verifies a genuine signature (no auth mocking in the browser).
 */
export async function injectTestWallet(page: Page, opts: { reject?: boolean } = {}) {
  await page.exposeFunction('__chogTestSign', async (hexMsg: string) =>
    account.signMessage({ message: hexToString(hexMsg as `0x${string}`) }),
  );
  await page.addInitScript(
    ({ address, reject }) => {
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
          if (method === 'eth_chainId') return '0x8f';
          if (method === 'personal_sign') {
            if (reject) throw Object.assign(new Error('User rejected'), { code: 4001 });
            return (window as unknown as { __chogTestSign: (m: string) => Promise<string> }).__chogTestSign(
              (params as string[])[0]!,
            );
          }
          throw new Error(`unsupported ${method}`);
        },
      };
      const info = { uuid: 'e2e-test-wallet', name: 'E2E Test Wallet', icon: '', rdns: 'test.chog' };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
        );
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { address: account.address, reject: !!opts.reject },
  );
}

export async function signIn(page: Page, opts: { keepGuide?: boolean } = {}) {
  await injectTestWallet(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'CONNECT WALLET' }).click();
  await page
    .getByRole('dialog', { name: 'Connect wallet' })
    .getByRole('button', { name: /E2E Test Wallet/ })
    .click();
  await page.getByText('WELCOME TO CHOG TOOLHUB').first().waitFor({ timeout: 20_000 });
  if (opts.keepGuide) return;
  // The first-login guide opens over the page until it has been closed once for this account.
  await page.getByRole('button', { name: 'Guide', exact: true }).waitFor();
  const guide = page.getByRole('dialog', { name: 'Guide' });
  if (
    (await guide.isVisible().catch(() => false)) ||
    (await guide.waitFor({ timeout: 800 }).then(
      () => true,
      () => false,
    ))
  )
    await page.getByRole('button', { name: 'Close guide' }).click();
}
