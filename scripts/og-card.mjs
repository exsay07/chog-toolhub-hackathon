// Renders scripts/og-card.html to apps/web/public/og.png (1200x630 social preview).
// Run: node scripts/og-card.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(root, 'scripts/og-card.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: join(root, 'apps/web/public/og.png'), type: 'png' });
await browser.close();
console.log('wrote apps/web/public/og.png');
