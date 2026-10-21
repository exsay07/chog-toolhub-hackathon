import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { createLogger } from './lib/log.js';
import { createEvmClients } from './chain/evm.js';
import { SolanaRpc } from './chain/solana.js';
import { DevAllowlistVerifier, OnchainOwnershipVerifier, type OwnershipVerifier } from './auth/nftGate.js';
import { ViemSignatureVerifier } from './auth/siwe.js';
import { purgeExpired, sessionCache } from './auth/sessions.js';
import { MarketService } from './market/service.js';
import { Discover } from './market/discover.js';
import { Hub } from './ws/hub.js';
import { TrackerWorker } from './tracker/worker.js';
import { Reconciler } from './journal/reconciler.js';
import { buildApp } from './app.js';
import { OpenSea, type AutoKey } from './nft/opensea.js';
import { serverKv } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { MintTracker } from './nft/mintTracker.js';
import type { AppContext } from './context.js';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
sessionCache.ttlMs = cfg.SESSION_CACHE_MS;
const dbh = await openDb({
  databaseUrl: cfg.DATABASE_URL,
  pgliteDir: cfg.PGLITE_DIR,
  poolMax: cfg.DB_POOL_MAX,
  migrate: true,
});
log.info({ db: dbh.kind }, 'database ready');

const evm = createEvmClients(cfg.rpc);
const sol = new SolanaRpc(cfg.rpc.solana);
const gateClient = evm[cfg.NFT_GATE_NETWORK]!;
let ownership: OwnershipVerifier = new OnchainOwnershipVerifier(
  gateClient,
  cfg.NFT_GATE_CONTRACT as `0x${string}`,
);
if (cfg.devAllowlist.size > 0) {
  log.warn({ count: cfg.devAllowlist.size }, 'DEV NFT allowlist active — never use in production');
  ownership = new DevAllowlistVerifier(ownership, cfg.devAllowlist);
}
const market = new MarketService(cfg.COINGECKO_PRO_API_KEY);
const hub = new Hub(market, log, cfg.NEWPOOLS_POLL_SEC, cfg.WS_MAX_PER_USER);
const discover = new Discover(market);
const opensea = new OpenSea(cfg.OPENSEA_API_KEY, log, cfg.OPENSEA_AUTO_KEY, {
  load: async () => {
    const [r] = await dbh.db.select().from(serverKv).where(eq(serverKv.key, 'opensea.freeKey'));
    return (r?.value as AutoKey | undefined) ?? null;
  },
  save: async (k) => {
    await dbh.db
      .insert(serverKv)
      .values({ key: 'opensea.freeKey', value: k })
      .onConflictDoUpdate({ target: serverKv.key, set: { value: k, updatedAt: new Date() } });
  },
});
const mints = cfg.MINTS_ENABLED ? new MintTracker(cfg.mintRpc, opensea, log) : null;

const ctx: AppContext = {
  cfg,
  db: dbh.db,
  dbPing: dbh.ping,
  log,
  ownership,
  signatures: new ViemSignatureVerifier(gateClient),
  market,
  discover,
  hub,
  evm,
  sol,
  opensea,
  mints,
  workers: {},
};

const tracker = new TrackerWorker(
  dbh.db,
  evm,
  sol,
  market,
  hub,
  log,
  cfg.TRACKER_POLL_SEC,
  cfg.TRACKER_MAX_ADDRESSES_PER_NETWORK,
);
const reconciler = new Reconciler(dbh.db, evm, sol, market, hub, log);
ctx.workers = { tracker, reconciler, ...(mints ? { mints } : {}) };
mints?.start();
opensea.startWarm();
if (cfg.TRACKER_ENABLED) tracker.start();
reconciler.start();
if (cfg.DISCOVER_WARM) discover.startWarming();
const purge = setInterval(() => void purgeExpired(dbh.db).catch(() => {}), 10 * 60_000);
purge.unref();

const webDist = resolve(fileURLToPath(import.meta.url), '../../../web/dist');
const app = await buildApp(ctx, { webDist: cfg.prod ? webDist : undefined });
await app.listen({ host: cfg.HOST, port: cfg.PORT });

let closing = false;
async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  log.info({ sig }, 'shutting down');
  tracker.stop();
  reconciler.stop();
  mints?.stop();
  opensea.stopWarm();
  discover.stopWarming();
  hub.close();
  await app.close();
  await dbh.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
