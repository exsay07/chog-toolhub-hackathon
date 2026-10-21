import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { injectTestWallet, signIn } from './wallet';

test.describe('desktop-only', () => {
  test('phones get the notice and no terminal is rendered', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByTestId('mobile-notice')).toBeVisible();
    await expect(page.getByText('Chog Toolhub is currently available on desktop only.')).toBeVisible();
    await expect(page.getByText('Holder access')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await ctx.close();
  });

  for (const [w, h] of [
    [1280, 720],
    [1440, 900],
    [1920, 1080],
  ]) {
    test(`renders the gate at ${w}×${h}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.goto('/');
      await expect(page.getByText('Holder access')).toBeVisible();
      await expect(page.getByTestId('mobile-notice')).toHaveCount(0);
      // No horizontal overflow at common desktop sizes.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await ctx.close();
    });
  }
});

test.describe('authentication', () => {
  test('rejected signature shows an error and no session', async ({ page }) => {
    await injectTestWallet(page, { reject: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'CONNECT WALLET' }).click();
    const picker = page.getByRole('dialog', { name: 'Connect wallet' });
    // The installed wallet is listed as detected; popular ones that are missing link to their official sites.
    await expect(picker.getByRole('button', { name: /E2E Test Wallet.*Detected/ })).toBeVisible();
    await expect(picker.getByRole('link', { name: 'MetaMask' })).toHaveAttribute(
      'href',
      'https://metamask.io/download/',
    );
    await expect(picker.getByRole('link', { name: 'Rabby' })).toHaveAttribute('href', 'https://rabby.io/');
    // No WalletConnect project id configured in tests → no phone option.
    await expect(picker.getByText('Phone wallet')).toHaveCount(0);
    await picker.getByRole('button', { name: /E2E Test Wallet/ }).click();
    await expect(picker.getByText('Signature request was rejected')).toBeVisible();
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(401);
  });

  test('first sign-in shows the guide once; Welcome glows until it is read; Guide reopens it', async ({
    page,
  }) => {
    await signIn(page, { keepGuide: true });
    const guide = page.getByRole('dialog', { name: 'Guide' });
    await expect(guide).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByText('NEW', { exact: true })).toBeVisible();
    await expect(guide.getByText('01 / 11')).toBeVisible();
    await guide.getByRole('button', { name: 'Next' }).click();
    await expect(guide.getByRole('heading', { name: 'CREATE YOUR TRADING WALLET' })).toBeVisible();
    await expect(guide.getByRole('img', { name: /trading wallet screenshot/i })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(guide.getByText('03 / 11')).toBeVisible();
    await page.getByRole('button', { name: 'Close guide' }).click();
    await expect(guide).toHaveCount(0);
    await expect(nav.getByText('NEW', { exact: true })).toHaveCount(0);
    // Remembered server-side: not after a reload, not after signing out and in again.
    await page.reload();
    await page.getByText('WELCOME TO CHOG TOOLHUB').waitFor();
    await page.waitForTimeout(800);
    await expect(guide).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'CONNECT WALLET' }).click();
    await page
      .getByRole('dialog', { name: 'Connect wallet' })
      .getByRole('button', { name: /E2E Test Wallet/ })
      .click();
    await page.getByText('WELCOME TO CHOG TOOLHUB').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await expect(guide).toHaveCount(0);
    // …but the Guide button opens it again on demand.
    await page.getByRole('button', { name: 'Guide', exact: true }).click();
    await expect(guide).toBeVisible();
  });

  test('SIWE sign-in → welcome, dev-access is clearly labelled, logout works', async ({ page }) => {
    await signIn(page);
    await expect(page.getByText('DEV ACCESS (NFT gate bypassed)')).toBeVisible();
    // Sign out from inside a section: the address goes back to "/", not the section you were in.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByText('Holder access')).toBeVisible();
    await expect(page).toHaveURL(/:\d+\/$/);
    // Signing in again starts on Welcome.
    await page.getByRole('button', { name: 'CONNECT WALLET' }).click();
    await page
      .getByRole('dialog', { name: 'Connect wallet' })
      .getByRole('button', { name: /E2E Test Wallet/ })
      .click();
    await page.getByText('WELCOME TO CHOG TOOLHUB').first().waitFor({ timeout: 20_000 });
    await expect(page).toHaveURL(/:\d+\/$/);
  });

  test('hackathon judges sign in with the access code (wrong code is refused)', async ({ page }) => {
    await injectTestWallet(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Hackathon judge/ }).click();
    const code = page.getByLabel('Judge access code');
    await code.fill('not-the-right-code-0000');
    await page.getByRole('button', { name: 'CONTINUE' }).click();
    const picker = page.getByRole('dialog', { name: 'Connect wallet' });
    await picker.getByRole('button', { name: /E2E Test Wallet/ }).click();
    await expect(picker.getByText(/judge access code is not valid/i)).toBeVisible();
    await picker.getByRole('button', { name: 'Close' }).click();
    await code.fill('e2e-judge-code-123456');
    await page.getByRole('button', { name: 'CONTINUE' }).click();
    await picker.getByRole('button', { name: /E2E Test Wallet/ }).click();
    await page.getByText('WELCOME TO CHOG TOOLHUB').first().waitFor({ timeout: 20_000 });
    await expect(page.getByText('JUDGE ACCESS', { exact: true })).toBeVisible();
    const me = await (await page.request.get('/api/auth/me')).json();
    expect(me.accessBasis).toBe('judge');
  });

  test('a link opened while signed out keeps its section after sign-in', async ({ page }) => {
    await injectTestWallet(page);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'CONNECT WALLET' }).click();
    await page
      .getByRole('dialog', { name: 'Connect wallet' })
      .getByRole('button', { name: /E2E Test Wallet/ })
      .click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('app', () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test('navigates every section', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    const checks: Array<[string, RegExp | string]> = [
      ['Token Terminal', 'DISCOVER'],
      ['Token Sniper', 'Snipers'],
      ['Wallet Tracker', 'Tracked wallets'],
      ['NFT Sniper', 'Mint tasks'],
      ['Top Collections', 'OPENSEA_API_KEY'],
      ['Mint Tracker', 'MINTS_ENABLED=false'],
      ['Perps Farm', 'How it works'],
      ['Portfolio', 'PnL calendar'],
      ['Settings', 'Appearance'],
      ['Dashboard', 'Net realized PnL'],
      ['Welcome', 'WELCOME TO CHOG TOOLHUB'],
    ];
    for (const [link, text] of checks) {
      await nav.getByRole('link', { name: link }).click();
      await expect(page.getByText(text).first()).toBeVisible();
    }
  });

  test('sidebar groups: Memecoins, NFT, Perps, Account', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const g of ['Memecoins', 'NFT', 'Perps', 'Account'])
      await expect(nav.getByText(g, { exact: true })).toBeVisible();
    await expect(nav.getByText('Trade', { exact: true })).toHaveCount(0);
    await expect(nav.getByText('Automate', { exact: true })).toHaveCount(0);
  });

  test('music player: hovering the upper part of the card opens it steadily (no flicker)', async ({
    page,
  }) => {
    const tile = page.getByRole('region', { name: 'Music player' });
    const box = (await tile.boundingBox())!;
    // Near the top of the card: after the card shrinks into the bar, this point is above the bar.
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    const heights: number[] = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(120);
      heights.push(Math.round((await tile.boundingBox())!.height));
    }
    // Opens once (bar height) and stays open; no bouncing back to the full card.
    expect(heights.slice(4).every((h) => h === heights[heights.length - 1])).toBe(true);
    expect(heights[heights.length - 1]).toBeLessThan(box.height);
    await page.mouse.move(5, 5);
    await expect
      .poll(async () => Math.round((await tile.boundingBox())!.height))
      .toBe(Math.round(box.height));
  });

  test('music player: volume moves in 10 % steps and the label matches the bars; the scrubber is easy to grab', async ({
    page,
  }) => {
    const tile = page.getByRole('region', { name: 'Music player' });
    const box = (await tile.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30);
    const vol = tile.getByRole('slider', { name: 'Volume' });
    await expect(vol).toBeVisible();
    const vb = (await vol.boundingBox())!;
    // Middle of the 7th of 10 bars → exactly 70 %.
    await page.mouse.click(vb.x + (vb.width * 6.5) / 10, vb.y + vb.height - 2);
    await expect(vol).toHaveAttribute('aria-valuetext', '70%');
    await expect(tile.getByText('70%', { exact: true })).toBeVisible();
    await vol.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(vol).toHaveAttribute('aria-valuetext', '60%');
    await expect(tile.getByText('60%', { exact: true })).toBeVisible();
    const seek = tile.getByRole('slider', { name: 'Seek' });
    const sb = (await seek.boundingBox())!;
    expect(sb.height).toBeGreaterThanOrEqual(14); // a real target, not a 3 px line on the edge
    expect(sb.width).toBeGreaterThan(150);
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.screenshot({
      path: 'test-results/music-player.png',
      clip: { x: 0, y: 500, width: 260, height: 400 },
    });
  });

  test('sidebar collapses to icons, the mini player pops out, and it expands back', async ({ page }) => {
    const aside = page.locator('aside');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBe(56);
    await page.getByRole('button', { name: 'Show player' }).click();
    await expect(page.getByRole('dialog', { name: 'Music player controls' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Music player controls' })).toHaveCount(0);
    // Icons still navigate.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Portfolio' }).click();
    await expect(page.getByText('PnL calendar').first()).toBeVisible();
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBe(224);
  });

  test('Top Collections: quick chains plus a picker with every OpenSea chain; choice is remembered', async ({
    page,
  }) => {
    const asked: string[] = [];
    await page.route('**/api/nft/top?**', async (r) => {
      const u = new URL(r.request().url());
      asked.push(u.searchParams.get('chain')!);
      await r.fulfill({
        json: {
          configured: true,
          pending: 0,
          updatedAt: Date.now(),
          error: null,
          rows: [1, 2, 3].map((i) => ({
            rank: i,
            slug: `c${i}`,
            name: `${u.searchParams.get('chain')} collection ${i}`,
            image: null,
            verified: i === 1,
            contract: null,
            url: `https://opensea.io/collection/c${i}`,
            floor: 1.5 * i,
            floorSymbol: 'ETH',
            floor24hAgo: 1.4 * i,
            volume24h: 10 * i,
            volume7d: 70 * i,
            volumeSymbol: 'ETH',
            sales24h: 5 * i,
            owners: 1000 * i,
            supply: 5000,
          })),
        },
      });
    });
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Top Collections' })
      .click();
    await expect(page.getByText('monad collection 1')).toBeVisible();
    await page.getByRole('tab', { name: 'ETH' }).click();
    await expect(page.getByText('ethereum collection 1')).toBeVisible();
    await expect(page.getByText(/Top by 24h volume · Ethereum/)).toBeVisible();
    await page.getByRole('combobox', { name: 'Chain', exact: true }).click();
    const options = page.getByRole('option');
    expect(await options.count()).toBeGreaterThanOrEqual(25);
    await page.getByRole('option', { name: /^Abstract/ }).click();
    await expect(page.getByText('abstract collection 1')).toBeVisible();
    await page.screenshot({ path: 'test-results/top-chains.png' });
    await page.reload();
    await expect(page.getByText('abstract collection 1')).toBeVisible({ timeout: 20_000 });
    expect(asked).toContain('abstract');
  });

  test('mint tracker "Mint task" opens a prefilled NFT Sniper task', async ({ page }) => {
    await page.goto('/nft?network=monad&address=0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763&name=Chog');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole('dialog')
          .locator('input')
          .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
      )
      .toContain('0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763');
  });

  test('mint tracker: collection avatars, and the name opens the mint task', async ({ page }) => {
    const row = (i: number, image: string | null) => ({
      contract: `0x${String(i).repeat(40).slice(0, 40)}`,
      m10: 10 - i,
      m60: 50,
      wallets: 40,
      topWalletShare: 0.1,
      firstSeen: Date.now() - 600_000,
      lastMint: Date.now() - 60_000,
      air: false,
      sus: null,
      chain: 'base',
      name: `Collection ${i}`,
      symbol: `C${i}`,
      minted: 100,
      links: { explorer: 'https://basescan.org', opensea: null, twitter: null, site: null },
      verified: false,
      image,
    });
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const stale = { ...row(3, null), name: 'Old collection', lastMint: Date.now() - 50 * 60_000 };
    await page.route('**/api/nft/mints?**', (r) =>
      r.fulfill({ json: { enabled: true, rows: [row(1, png), row(2, null), stale], status: {} } }),
    );
    const H = 3_600_000;
    const stage = (start: number, end: number | null, price: string) => ({
      label: 'Public',
      type: 'public_sale',
      price,
      currency: '0x0000000000000000000000000000000000000000',
      start,
      end,
      maxPerWallet: 5,
    });
    await page.route('**/api/nft/drops', (r) =>
      r.fulfill({
        json: {
          updatedAt: Date.now(),
          rows: [
            {
              slug: 'live-drop',
              name: 'Live Drop',
              chain: 'ethereum',
              contract: '0x' + 'a'.repeat(40),
              image: null,
              url: 'https://opensea.io/collection/live-drop',
              live: true,
              stage: stage(Date.now() - H, Date.now() + 3 * H, '30000000000000000'),
              next: null,
              at: Date.now() + 3 * H + 120_000,
            },
            {
              slug: 'abstract-soon',
              name: 'Abstract Soon',
              chain: 'abstract',
              contract: '0x' + 'b'.repeat(40),
              image: null,
              url: 'https://opensea.io/collection/abstract-soon',
              live: false,
              stage: null,
              next: stage(Date.now() + 5 * H, null, '0'),
              at: Date.now() + 5 * H + 120_000,
            },
          ],
        },
      }),
    );
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Mint Tracker' }).click();
    // Drops: live now with price + countdown + OpenSea mint link + mint task; upcoming in its own tab.
    const live = page.getByRole('row').filter({ hasText: 'Live Drop' });
    await expect(live).toContainText('0.03 ETH');
    await expect(live).toContainText(/3h [12]m/);
    await expect(live.getByRole('link', { name: 'Mint ↗' })).toHaveAttribute(
      'href',
      'https://opensea.io/collection/live-drop',
    );
    await expect(live.getByRole('link', { name: 'Mint task' })).toBeVisible();
    await page.getByRole('tab', { name: /UPCOMING · 72H 1/ }).click();
    const soon = page.getByRole('row').filter({ hasText: 'Abstract Soon' });
    await expect(soon).toContainText('Free');
    await expect(soon).toContainText(/5h [12]m/);
    await expect(soon.getByRole('link', { name: 'Mint task' })).toHaveCount(0); // not one of our chains
    // Live table: only collections that minted in the last 15 minutes.
    await expect(page.getByText('Old collection')).toHaveCount(0);
    const first = page.getByRole('row').filter({ hasText: 'Collection 1' });
    await expect(first.locator('img[src^="data:"]')).toHaveAttribute('src', png);
    await expect(first.getByRole('img', { name: 'Base' })).toHaveAttribute('src', '/chains/base.webp');
    // No OpenSea image yet → a coloured tile with initials.
    await expect(
      page.getByRole('row').filter({ hasText: 'Collection 2' }).getByText('CO', { exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: 'test-results/mint-tracker.png' });
    await first.getByRole('link', { name: 'Collection 1' }).click();
    await expect(page).toHaveURL(/\/nft\?network=base&address=0x1111111111111111111111111111111111111111/);
    await expect(page.getByRole('dialog', { name: 'New mint task' })).toBeVisible();
  });

  test('chain picker: the wheel scrolls the list, keeps it open and never moves the page', async ({
    page,
  }) => {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Top Collections' })
      .click();
    await page.getByRole('combobox', { name: 'Chain', exact: true }).click();
    const list = page.getByRole('listbox', { name: 'Chain' });
    await expect(list).toBeVisible();
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600);
    await expect(list).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
    const pageTop = await page.evaluate(() => document.querySelector('main')?.scrollTop ?? window.scrollY);
    expect(pageTop).toBe(0);
  });

  test('tracks a wallet and validates addresses per network', async ({ page }) => {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Wallet Tracker' })
      .click();
    await page.getByRole('button', { name: 'Add' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('textbox').first().fill('not-an-address');
    await expect(dlg.getByText(/Not a valid Monad address/)).toBeVisible();
    await dlg.getByRole('textbox').first().fill('0x4200000000000000000000000000000000000006');
    await dlg.getByRole('textbox').nth(1).fill('E2E whale');
    await dlg.getByRole('button', { name: 'Track' }).click();
    await expect(page.getByText('E2E whale')).toBeVisible();
  });

  test('settings persist server-side (theme + notifications)', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Theme', { exact: true }).click();
    await page.getByRole('option', { name: 'Light' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Notifications' }).click();
    await page.getByRole('switch', { name: 'Sound' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.reload();
    await page.getByRole('heading', { name: 'Appearance' }).waitFor();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const s = await (await page.request.get('/api/settings')).json();
    expect(s.appearance.theme).toBe('light');
    expect(s.notifications.sound).toBe(true);
  });

  test('creates a local trading wallet with mandatory backup step; server only gets public addresses', async ({
    page,
  }) => {
    // The trading wallet lives only in the Token Terminal.
    await expect(page.getByRole('button', { name: /Set up trading wallet/ })).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Token Terminal' })
      .click();
    await page.getByRole('button', { name: /Set up trading wallet|Unlock trading wallet/ }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Create new wallet' }).click();
    await expect(dlg.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await dlg.getByRole('checkbox').check();
    await dlg.getByRole('button', { name: 'Continue' }).click();
    await dlg.getByLabel('Password', { exact: true }).fill('e2e password 123');
    await dlg.getByLabel('Confirm password').fill('e2e password 123');
    await dlg.getByRole('button', { name: 'Encrypt & save' }).click();
    await expect(page.getByRole('button', { name: /Trading 0x/ })).toBeVisible({ timeout: 20_000 });
    const tw = (await (await page.request.get('/api/trading-wallets')).json()) as Array<
      Record<string, string>
    >;
    expect(tw.map((t) => t.kind).sort()).toEqual(['evm', 'solana']);
    for (const t of tw)
      expect(Object.keys(t).sort()).toEqual([
        'address',
        'createdAt',
        'id',
        'kind',
        'label',
        'role',
        'userId',
      ]);
  });

  test('multi-wallet: add extra wallets, survive lock/unlock, pick them in the NFT Sniper, remove one', async ({
    page,
  }) => {
    const PW = 'e2e password 123';
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Token Terminal' })
      .click();
    await page.getByRole('button', { name: /Set up trading wallet|Unlock trading wallet/ }).click();
    let dlg = page.getByRole('dialog', { name: 'Trading wallet' });
    await dlg.getByRole('button', { name: 'Create new wallet' }).click();
    await dlg.getByRole('checkbox').check();
    await dlg.getByRole('button', { name: 'Continue' }).click();
    await dlg.getByLabel('Password', { exact: true }).fill(PW);
    await dlg.getByLabel('Confirm password').fill(PW);
    await dlg.getByRole('button', { name: 'Encrypt & save' }).click();
    await expect(page.getByRole('button', { name: /Trading 0x/ })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: /Trading 0x/ }).click();
    dlg = page.getByRole('dialog', { name: 'Trading wallet' });
    await dlg.getByText(/Wallets \(1\)/).click();
    await dlg.getByLabel('Vault password').fill(PW);
    await dlg.getByLabel('How many').click();
    await page.getByRole('option', { name: '2', exact: true }).click();
    await dlg.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dlg.getByText(/Now 3 wallets/)).toBeVisible({ timeout: 20_000 });
    await expect(dlg.getByText('W2', { exact: true })).toBeVisible();
    await expect(dlg.getByText('W3', { exact: true })).toBeVisible();
    const tw = (await (await page.request.get('/api/trading-wallets')).json()) as Array<{ role: string }>;
    expect(tw.filter((w) => w.role === 'extra')).toHaveLength(2);

    // Lock + unlock: the extra keys must decrypt and match their stored addresses.
    await dlg.getByRole('button', { name: 'Lock now' }).click();
    await page.getByRole('button', { name: 'Unlock trading wallet' }).click();
    dlg = page.getByRole('dialog', { name: 'Trading wallet' });
    await dlg.getByLabel('Password').fill(PW);
    await dlg.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('button', { name: /Trading 0x/ })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'NFT Sniper' }).click();
    await page.getByRole('button', { name: 'New mint' }).click();
    const mint = page.getByRole('dialog', { name: 'New mint task' });
    const picker = mint.getByRole('group', { name: /Mint from wallets/ });
    await expect(picker.getByRole('button')).toHaveCount(3);
    await mint.getByRole('button', { name: 'All', exact: true }).click();
    await expect(mint.getByText('(3 selected)')).toBeVisible();
    await mint.getByRole('button', { name: 'Cancel' }).click();

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Token Terminal' })
      .click();
    await page.getByRole('button', { name: /Trading 0x/ }).click();
    dlg = page.getByRole('dialog', { name: 'Trading wallet' });
    await dlg.getByText(/Wallets \(3\)/).click();
    await dlg.getByLabel('Vault password').fill(PW);
    await dlg.getByRole('button', { name: 'Remove W3' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dlg.getByText('W3 removed.')).toBeVisible({ timeout: 20_000 });
    const after = (await (await page.request.get('/api/trading-wallets')).json()) as Array<{ role: string }>;
    expect(after.filter((w) => w.role === 'extra')).toHaveLength(1);
  });

  test('mouse wheel scrolls smoothly (eases over several frames), and can be turned off', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'wheel-box';
      box.style.cssText =
        'position:fixed;left:300px;top:100px;width:400px;height:300px;overflow:auto;z-index:9999';
      box.innerHTML = '<div style="height:3000px">tall</div>';
      document.body.appendChild(box);
    });
    const top = () => page.locator('#wheel-box').evaluate((el) => el.scrollTop);
    await page.mouse.move(500, 250);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(40);
    const early = await top();
    await page.waitForTimeout(700);
    const settled = await top();
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(settled); // still gliding after 40 ms
    expect(settled).toBeGreaterThanOrEqual(95);
    expect(settled).toBeLessThanOrEqual(105);
    // Off → the browser's own (instant) scrolling.
    await page.evaluate(() => localStorage.setItem('chog.smoothScroll', 'off'));
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(40);
    expect(await top()).toBeGreaterThanOrEqual(settled + 95);
  });

  test('configures and arms an alert-only sniper', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Token Sniper' }).click();
    await page.getByRole('button', { name: 'New' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name', { exact: true }).fill('E2E alerts');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('E2E alerts')).toBeVisible();
    await page.getByRole('button', { name: 'Arm' }).first().click();
    await expect(page.getByText('armed').first()).toBeVisible();
  });

  test('auto sniper: anti-rug, ladder exits and trailing stop are saved; positions tab is empty', async ({
    page,
  }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Token Sniper' }).click();
    await page.getByRole('button', { name: 'New' }).click();
    const dlg = page.getByRole('dialog', { name: 'New sniper' });
    await dlg.getByLabel('Name', { exact: true }).fill('E2E auto');
    await dlg.getByLabel('Mode').click();
    await page.getByRole('option', { name: 'Auto-buy' }).click();
    await expect(dlg.getByText('Anti-rug')).toBeVisible();
    await expect(dlg.getByLabel('Step 1 trigger %')).toHaveValue('100');
    await dlg.getByRole('button', { name: 'Add step' }).click();
    await expect(dlg.getByLabel('Step 3 trigger %')).toHaveValue('600');
    await dlg.getByLabel('Step 3 sell %').fill('20');
    await dlg.getByLabel('Max FDV $').fill('2000000');
    await page.screenshot({ path: 'test-results/sniper-form.png' });
    await dlg.getByRole('button', { name: 'Save' }).click();
    const row = page.getByRole('listitem').filter({ hasText: 'E2E auto' });
    await expect(row).toContainText('ladder +100%:50% +300%:25% +600%:20%');
    await expect(row).toContainText('trail 30%');
    await expect(row).toContainText('dev-sell 25%');
    const saved = (await (await page.request.get('/api/automations/sniper')).json()) as Array<{
      data: { name: string; filters: { maxFdvUsd: number }; antiRug: { blockMintable: boolean } };
    }>;
    const mine = saved.find((s) => s.data.name === 'E2E auto')!;
    expect(mine.data.filters.maxFdvUsd).toBe(2_000_000);
    expect(mine.data.antiRug.blockMintable).toBe(true);
    await expect(page.getByText('No open sniper positions')).toBeVisible();
  });

  test('NFT sniper: a pasted contract is detected on-chain (network, name, standard)', async ({ page }) => {
    test.skip(!!process.env.OFFLINE, 'needs internet');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'NFT Sniper' }).click();
    await page.getByRole('button', { name: 'New mint' }).click();
    const dlg = page.getByRole('dialog', { name: 'New mint task' });
    // Bare address: the network is found by looking for code on every supported chain.
    await dlg.getByLabel('Collection link or contract').fill('0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763');
    await dlg.getByRole('button', { name: 'Detect' }).click();
    await expect(dlg.getByText('Chog Genesis', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(dlg.getByText(/ERC-721/)).toBeVisible();
    await expect(dlg.getByText(/on Monad/)).toBeVisible();
    await expect(dlg.getByLabel('Name', { exact: true })).toHaveValue('Chog Genesis');
    await page.screenshot({ path: 'test-results/nft-detect.png' });
  });

  test('perps farm: Perpl Start Bot saves the bot and opens the launch checklist', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Perps Farm' }).click();
    await page.getByRole('button', { name: /PERPL/ }).click();
    await expect(page.getByRole('heading', { name: 'Configure & start' })).toBeVisible();
    await expect(page.getByText(/runs in this tab/)).toBeVisible();
    // Picking a pair applies the market's max leverage (capped at 10x); order size stays.
    await page.getByRole('button', { name: 'SOL', exact: true }).click();
    await expect(page.getByText('Applied SOL preset: 8.3x leverage.')).toBeVisible();
    await page.getByRole('button', { name: /^Long/ }).click();
    await page.getByRole('button', { name: 'Start Bot' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Perpl exchange account')).toBeVisible();
    await expect(dlg.getByText('Trading key')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('SOL-USD').first()).toBeVisible();
    await page.getByRole('button', { name: 'Back to platforms' }).click();
    await expect(page.getByRole('button', { name: /BULK/ })).toBeVisible();
  });

  test('perps farm: Bulk opens the Phantom checklist and the signing library loads', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Perps Farm' }).click();
    await page.getByRole('button', { name: /BULK/ }).click();
    await expect(page.getByRole('heading', { name: 'Configure & start' })).toBeVisible();
    await page.getByRole('button', { name: 'Start Bot' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByText('Phantom wallet')).toBeVisible();
    await expect(dlg.getByText('Authorise the bot')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Start bot' })).toBeDisabled();
    // The official Bulk signing library (WebAssembly) loads in the browser (dev server serves sources).
    if (process.env.E2E_PROD) return;
    const ok = await page.evaluate(async () => {
      const m = await import('/src/lib/perps/bulk.ts' as string);
      const k = await m.keychain();
      return typeof k.prepareOrder === 'function' && typeof k.prepareAgentWallet === 'function';
    });
    expect(ok).toBe(true);
  });

  test('perpl relay: streams live market state and rejects a bad trading key', async ({ page }) => {
    test.skip(!!process.env.OFFLINE, 'needs internet');
    const r = await page.evaluate(async () => {
      const url = (k: string) => `ws://${location.host}/api/perpl/mainnet/ws/${k}`;
      const md = await new Promise<string>((res) => {
        const ws = new WebSocket(url('market-data'));
        ws.onopen = () =>
          ws.send(JSON.stringify({ mt: 5, subs: [{ stream: 'market-state@143', subscribe: true }] }));
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.mt === 9) {
            ws.close();
            res('state:' + (m.d['20']?.bid > 0));
          }
        };
        ws.onclose = (e) => res('closed ' + e.code);
        setTimeout(() => res('timeout'), 20_000);
      });
      const tr = await new Promise<string>((res) => {
        const ws = new WebSocket(url('trading'));
        ws.onopen = () =>
          ws.send(
            JSON.stringify({
              mt: 29,
              chain_id: 143,
              api_key: 'bogus-key',
              timestamp: String(Date.now()),
              nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
              signature: 'AA',
            }),
          );
        ws.onclose = (e) => res('closed ' + e.code);
        setTimeout(() => res('timeout'), 20_000);
      });
      return { md, tr };
    });
    expect(r.md).toBe('state:true');
    expect(r.tr).toMatch(/^closed 4(401|008|011)$/);
  });

  test('terminal quick-buy amounts follow the account (survive a cleared browser)', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'Token Terminal' }).click();
    await page.getByRole('button', { name: 'Quick buy' }).click();
    const first = page.getByRole('spinbutton').first();
    await first.fill('7.5');
    await page.waitForTimeout(1500); // synced to the server shortly after the edit
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page
      .getByText('WELCOME TO CHOG TOOLHUB')
      .or(page.getByRole('button', { name: 'Quick buy' }))
      .first()
      .waitFor();
    await nav.getByRole('link', { name: 'Token Terminal' }).click();
    await page.getByRole('button', { name: 'Quick buy' }).click();
    await expect(page.getByRole('spinbutton').first()).toHaveValue('7.5');
  });

  test('exports a real PNG PnL card matching the preview size', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Portfolio' }).click();
    await page.getByRole('button', { name: 'Share card' }).click();
    await page.getByTestId('pnl-canvas').waitFor();
    await page.waitForTimeout(500);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download PNG' }).click(),
    ]);
    const path = await dl.path();
    const buf = readFileSync(path!);
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    expect(buf.readUInt32BE(16)).toBe(2400); // width
    expect(buf.readUInt32BE(20)).toBe(1350); // height
  });

  test('token terminal: pasting a contract opens the token directly (Dexscreener-style)', async ({
    page,
  }) => {
    test.skip(!!process.env.OFFLINE, 'needs internet');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Token Terminal' })
      .click();
    await page.getByLabel('Search tokens').fill('0x350035555e10d9afaf1566aaebfced5ba6c27777');
    await expect(page).toHaveURL(/\/terminal\/monad\/0x350035555e10d9afaf1566aaebfced5ba6c27777/i, {
      timeout: 20_000,
    });
    await expect(page.getByRole('heading', { name: 'CHOG', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Pools \(\d+\)$/)).toBeVisible();
    await expect(page.getByText('Market cap').first()).toBeVisible();
    await expect(page.locator('iframe[title="Dexscreener chart"]')).toHaveAttribute(
      'src',
      /dexscreener\.com\/monad\//,
    );
  });

  test('token page: P1/P2/P3 presets, one-click amounts, and a take-profit order that can be cancelled', async ({
    page,
  }) => {
    test.skip(!!process.env.OFFLINE, 'needs internet');
    await page.goto('/terminal/monad/0x350035555e10d9afaf1566aaebfced5ba6c27777');
    await expect(page.getByRole('heading', { name: 'CHOG', exact: true })).toBeVisible({ timeout: 20_000 });
    // Default P1 buy buttons for Monad.
    for (const a of ['1', '5', '10', '25'])
      await expect(page.getByRole('button', { name: a, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'P2', exact: true }).click();
    await expect(page.getByText(/P2 · slippage 5%/)).toBeVisible();
    // Editing a preset syncs to the account.
    await page.getByRole('button', { name: 'Edit presets' }).click();
    const dlg = page.getByRole('dialog', { name: 'Preset P2' });
    await dlg.getByLabel('Buy slippage %').fill('7');
    await dlg.getByLabel('Buy slippage %').blur();
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(/P2 · slippage 7%/)).toBeVisible();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/kv')).json()) as Record<string, any>)['term.presets']
            ?.presets?.[1]?.buy?.slippagePct,
        { timeout: 5_000 },
      )
      .toBe(7);
    // Take-profit: sell side, +50% from the live price.
    await page.getByRole('button', { name: 'Sell', exact: true }).click();
    await page.getByRole('tab', { name: 'Limit · TP/SL' }).click();
    await page.getByRole('button', { name: '+50%' }).click();
    await page.getByRole('button', { name: 'Place take profit' }).click();
    await expect(page.getByText('Take profit placed')).toBeVisible();
    await expect(page.getByText('Orders (1 open)')).toBeVisible();
    await page.screenshot({ path: 'test-results/order-panel.png' });
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('Orders (1 open)')).toHaveCount(0);
  });

  test('token terminal: Discover lists live tokens with quick-buy, Pulse shows its columns', async ({
    page,
  }) => {
    test.skip(!!process.env.OFFLINE, 'needs internet');
    test.setTimeout(120_000);
    // One chain keeps this live test inside GeckoTerminal's free per-IP limit (shared with any dev server).
    await page.evaluate(() => localStorage.setItem('chog.term.chains.v2', JSON.stringify(['base'])));
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Token Terminal' })
      .click();
    const rows = page.locator('tbody tr').first();
    try {
      await rows.waitFor({ timeout: 60_000 });
    } catch {
      const r = await page.request.get('/api/discover?networks=base&view=trending&tf=1h');
      const body = (await r.json()) as { data: unknown[]; errors: string[] };
      test.skip(
        body.data.length === 0 && body.errors.includes('base'),
        'GeckoTerminal is rate-limiting this IP right now (shared with any running dev server)',
      );
      throw new Error('Discover showed no rows although the API had data');
    }
    await expect(
      page
        .locator('tbody tr')
        .first()
        .getByTitle(/^Buy |Trading is disabled/),
    ).toBeVisible();
    // Quick buy without a wallet opens the wallet setup instead of trading.
    const buy = page.locator('tbody tr button[title^="Buy "]').first();
    if (await buy.count()) {
      await buy.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await page.getByRole('link', { name: 'PULSE' }).click();
    for (const c of ['New pairs', 'Heating up', 'Trending'])
      await expect(page.getByRole('heading', { name: c })).toBeVisible();
  });

  test('token terminal: live search hits the real market-data path', async ({ page }) => {
    test.skip(!!process.env.OFFLINE, 'needs internet');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Token Terminal' })
      .click();
    await page.getByLabel('Search tokens').fill('CHOG');
    const first = page.getByRole('listbox').getByRole('button').filter({ hasText: 'CHOG' }).first();
    await expect(first).toBeVisible({ timeout: 20_000 });
    await first.click();
    await expect(page.getByText('Liquidity').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Chog Toolhub fee')).toHaveCount(0); // only inside the confirm dialog
    await expect(page.getByText(/Unlock your trading wallet|Set up a trading wallet/)).toBeVisible();
  });
});
