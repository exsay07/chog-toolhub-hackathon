# Development notes

Practical details for working on the codebase. The overview and quick start are in the [README](../README.md).

## Database

- Schema: `apps/server/src/db/schema.ts`. Migrations: `apps/server/drizzle/`, generated with `npm run db:generate`
  after a schema change.
- Migrations run automatically when the server starts, and on demand with `npm run db:migrate`.
- Development and tests use embedded PGlite in `apps/server/.data/pglite`. Stop the dev server with **Ctrl+C**:
  killing the process abruptly can corrupt the PGlite files. If that happens, move the folder aside; a fresh one is
  created on the next start.
- Production uses PostgreSQL 17. For backups and restores see [DEPLOY.md](DEPLOY.md).

## Production build checks

`npm run build -w @chog/web` ends with `scripts/check-chunks.mjs`, which fails the build when two production chunks
import each other in a circle (it crashes only the production build, never dev mode). When it fires, fix the
vendor groups in `apps/web/vite.config.ts`. `E2E_PROD=1 npm run test:e2e` runs the whole E2E suite against the
production build.

## Guide screenshots

The first-login guide uses real screenshots in `apps/web/public/guide/*.webp`. To regenerate them:

```bash
npx playwright test --config=playwright.guide.config.ts    # starts its own servers
# then convert: ffmpeg -i name.png -c:v libwebp -quality 82 name.webp
```

## Recording a demo or promo video

1. Run `npm ci`, then `cp .env.example .env` and set `NFT_GATE_DEV_ALLOWLIST=0x<your wallet>`. That wallet then
   gets in without a Chog Genesis NFT, locally only, with a "DEV ACCESS" badge.
2. Start `npm run dev:server` and `npm run dev:web`, then open http://localhost:5173 in a desktop browser
   (1440 px+ wide looks best). Give the server about two minutes so the terminal lists are warm.
3. Good moments to show:
   - the sign-in screen (CRT Chog, music) and the "channel switch" into the app;
   - Welcome and the guide;
   - Token Terminal: Discover, a token page with the trade panel, and Pulse;
   - Token Sniper with its anti-rug and exit settings;
   - NFT Sniper detecting a pasted link;
   - Mint Tracker and Top Collections;
   - Perps Farm;
   - Portfolio PnL cards;
   - signing out (the TV switching off).
4. Never show or commit a real `.env`, and never put private keys in the repository.

## Local agent and external farming software

The Perps Farm bots run in the browser. `apps/agent` is an optional loopback-only agent for running reviewed
external farming software. Place vendor software in `apps/agent/adapters/vendor/<name>/`. Nothing there runs
automatically; the integration steps are in `apps/agent/adapters/README.md`.

## Brand assets

- **Replaceable files** in `apps/web/public/brand/`: mark, avatar and the mobile-notice background.
- **PnL card moods**: the six drawn Chog moods are in `apps/web/public/pnl-cards/chog/`, generated with
  `scripts/pixelize-chog-art.py`.
- **Sign-in Chog**: the pixel map lives in `apps/web/src/assets/chogPixels.ts`. The Classic PnL cards use the same
  map.
