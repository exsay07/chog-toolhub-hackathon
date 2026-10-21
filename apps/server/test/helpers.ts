import { createSiweMessage } from 'viem/siwe';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/client.js';
import { createLogger } from '../src/lib/log.js';
import { buildApp } from '../src/app.js';
import { ViemSignatureVerifier } from '../src/auth/siwe.js';
import type { OwnershipResult, OwnershipVerifier } from '../src/auth/nftGate.js';
import { MarketService } from '../src/market/service.js';
import { sessionCache } from '../src/auth/sessions.js';
import { Hub } from '../src/ws/hub.js';
import { SolanaRpc } from '../src/chain/solana.js';
import type { AppContext } from '../src/context.js';
import { OpenSea } from '../src/nft/opensea.js';
import { Discover } from '../src/market/discover.js';

// Tests mutate the DB directly; disable the session cache unless a test opts in.
sessionCache.ttlMs = 0;

export const ORIGIN = 'http://localhost:5173';
export const H = { origin: ORIGIN, 'x-chog-csrf': '1' };

/** Deterministic, offline ownership oracle for tests (a mock — not a real chain check). */
export class FakeOwnership implements OwnershipVerifier {
  holders = new Map<string, OwnershipResult>();
  calls = 0;
  async check(a: `0x${string}`): Promise<OwnershipResult> {
    this.calls++;
    return this.holders.get(a.toLowerCase()) ?? { status: 'not_holder' };
  }
  set(a: string, r: OwnershipResult) {
    this.holders.set(a.toLowerCase(), r);
  }
}

export async function makeApp(env: Record<string, string> = {}) {
  const cfg = loadConfig({ NODE_ENV: 'test', APP_ORIGIN: ORIGIN, LOG_LEVEL: 'silent', ...env });
  const log = createLogger('silent');
  const dbh = await openDb({ databaseUrl: '', pgliteDir: 'memory', migrate: true });
  const ownership = new FakeOwnership();
  const market = new MarketService();
  const hub = new Hub(market, log, 30);
  const ctx: AppContext = {
    cfg,
    db: dbh.db,
    dbPing: dbh.ping,
    log,
    ownership,
    signatures: new ViemSignatureVerifier(),
    market,
    discover: new Discover(market),
    hub,
    evm: {},
    sol: new SolanaRpc(['http://127.0.0.1:9']),
    opensea: new OpenSea('', undefined, false),
    mints: null,
    workers: {},
  };
  const app = await buildApp(ctx);
  await app.ready();
  return { app, ctx, ownership, close: async () => (await app.close(), await dbh.close()) };
}

export function newAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

export async function siweMessage(
  app: App,
  account: PrivateKeyAccount,
  over: Partial<Parameters<typeof createSiweMessage>[0]> = {},
) {
  const n = (await app.inject({ method: 'POST', url: '/api/auth/nonce', headers: H })).json();
  const now = new Date();
  return createSiweMessage({
    address: account.address,
    chainId: n.chainId,
    domain: n.domain,
    nonce: n.nonce,
    uri: n.uri,
    version: '1',
    statement: n.statement,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 5 * 60_000),
    ...over,
  });
}

/** Full SIWE login; returns the session cookie header value. */
export async function login(app: App, account: PrivateKeyAccount) {
  const message = await siweMessage(app, account);
  const signature = await account.signMessage({ message });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: H,
    payload: { message, signature },
  });
  const c = res.cookies.find((x) => x.name === 'chog_session');
  return { res, cookie: c ? `chog_session=${c.value}` : '' };
}
