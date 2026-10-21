import { test, type Page } from '@playwright/test';
import { signIn } from '../../e2e/wallet';

const OUT = 'apps/web/public/guide';
/** Content area only (sidebar 224px + top bar 48px cropped away). */
const CONTENT = { x: 224, y: 48, width: 1216, height: 852 };

/** A modal dialog, framed with a margin. */
async function dialogShot(page: Page, name: string) {
  await page.waitForTimeout(700);
  const b = (await page.locator('dialog[open]').first().boundingBox())!;
  const m = 28;
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: Math.max(0, b.x - m),
      y: Math.max(0, b.y - m),
      width: Math.min(1440, b.width + m * 2),
      height: Math.min(900, b.height + m * 2),
    },
  });
}

async function shot(page: Page, name: string, clip = CONTENT) {
  await page.waitForTimeout(900);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
}

test('guide screenshots', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('chog.sfx', 'off');
    localStorage.setItem('chog.music', JSON.stringify({ volume: 0.5, off: true }));
  });
  await signIn(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const go = async (label: string) => {
    await nav.getByRole('link', { name: label }).click();
    await page.waitForTimeout(1500);
  };

  // Trading wallet: Token Terminal → Set up trading wallet.
  await go('Token Terminal');
  await page.locator('tbody tr').first().waitFor({ timeout: 60_000 });
  await shot(page, 'terminal');
  await page.getByRole('button', { name: /Set up trading wallet/ }).click();
  await dialogShot(page, 'wallet');
  await page.keyboard.press('Escape');

  await page.locator('tbody tr').first().click();
  await page.getByText('Market cap').first().waitFor();
  await page.waitForTimeout(3500);
  await shot(page, 'token');

  await page.getByRole('link', { name: 'PULSE' }).click();
  await page.getByText(/^New pairs$/).waitFor();
  await page
    .locator('section')
    .first()
    .getByTitle(/^Buy |^Trading is disabled/)
    .first()
    .waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  await shot(page, 'pulse');

  await go('Token Sniper');
  // New pools stream in over the WebSocket (polled every ~30 s); give the list a moment to fill.
  await page
    .waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 75_000 })
    .catch(() => {});
  await shot(page, 'sniper');
  await go('Wallet Tracker');
  await shot(page, 'tracker');

  await go('NFT Sniper');
  await page.getByRole('button', { name: 'New mint' }).click();
  await page.getByLabel('Collection link or contract').fill('0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763');
  await page.getByRole('button', { name: 'Detect' }).click();
  await page.getByText(/ERC-721/).waitFor({ timeout: 30_000 });
  await dialogShot(page, 'nft-sniper');
  await page.keyboard.press('Escape');

  await go('Mint Tracker');
  await page.waitForTimeout(2500);
  await shot(page, 'mints');
  await go('Top Collections');
  await shot(page, 'top');

  await go('Perps Farm');
  await page.waitForTimeout(1500);
  await shot(page, 'perps');
  await page.getByRole('button', { name: /PERPL/ }).click();
  await page.getByRole('button', { name: 'SOL', exact: true }).click();
  await shot(page, 'perps-config');

  await go('Portfolio');
  await shot(page, 'portfolio');
  await go('Settings');
  await shot(page, 'settings');
  await go('Dashboard');
  await shot(page, 'dashboard');
});
