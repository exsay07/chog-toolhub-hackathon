#!/usr/bin/env node
/**
 * Repeatable load test. Spawns the API server (embedded PGlite unless DATABASE_URL is set), logs in
 * a dev-allowlisted TEST wallet via real SIWE, then measures:
 *   1. /healthz baseline           4. cached market search
 *   2. session-authenticated reads  5. 1000 concurrent authenticated WebSockets (+ fan-out)
 *   3. DB write path (watchlist)    6. per-route auth rate limiting
 * Results are printed and written to docs/perf-results.json.
 *
 *   node scripts/loadtest.mjs [--conns=100] [--duration=10] [--ws=1000]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { cpus, totalmem, tmpdir, platform, release } from 'node:os';
import { join } from 'node:path';
import autocannon from 'autocannon';
import WebSocket from 'ws';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const CONNS = arg('conns', 100);
const DURATION = arg('duration', 10);
const WS_N = arg('ws', 1000);
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
// Ephemeral throw-away test wallets (dev allowlist only). WS fan-out is spread across users because
// the server caps WebSockets per user (WS_MAX_PER_USER).
const WS_PER_USER = 100;
const accts = Array.from({ length: Math.ceil(WS_N / WS_PER_USER) }, () =>
  privateKeyToAccount(generatePrivateKey()),
);

const srv = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    APP_ORIGIN: ORIGIN,
    PGLITE_DIR: process.env.DATABASE_URL ? '' : mkdtempSync(join(tmpdir(), 'chog-load-')),
    NFT_GATE_DEV_ALLOWLIST: accts.map((a) => a.address).join(','),
    WS_MAX_PER_USER: String(WS_PER_USER),
    RATE_LIMIT_PER_MIN: '100000000', // single load-generator IP; production default is 600/min/IP
    TRACKER_ENABLED: 'false',
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('server did not start');
}

const H = { origin: ORIGIN, 'x-chog-csrf': '1', 'content-type': 'application/json' };
async function login(acct) {
  const n = await (await fetch(`${BASE}/api/auth/nonce`, { method: 'POST', headers: H, body: '{}' })).json();
  const now = new Date();
  const message = createSiweMessage({
    address: acct.address,
    chainId: n.chainId,
    domain: n.domain,
    nonce: n.nonce,
    uri: n.uri,
    version: '1',
    statement: n.statement,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 300_000),
  });
  const signature = await acct.signMessage({ message });
  const r = await fetch(`${BASE}/api/auth/verify`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ message, signature }),
  });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}

function run(title, opts) {
  return new Promise((res) => {
    autocannon({ url: BASE, connections: CONNS, duration: DURATION, ...opts }, (err, r) => {
      if (err) throw err;
      const out = {
        title,
        connections: CONNS,
        durationSec: DURATION,
        reqPerSec: Math.round(r.requests.average),
        totalRequests: r.requests.total,
        latencyMs: { p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, max: r.latency.max },
        non2xx: r.non2xx,
        errors: r.errors,
        timeouts: r.timeouts,
        status: r.statusCodeStats,
      };
      console.log(
        `${title}: ${out.reqPerSec} req/s · p50 ${out.latencyMs.p50}ms · p99 ${out.latencyMs.p99}ms · non2xx ${out.non2xx} · errors ${out.errors}`,
      );
      res(out);
    });
  });
}

async function wsTest(cookies) {
  const t0 = Date.now();
  const lat = [];
  let hello = 0;
  let failed = 0;
  let msgs = 0;
  const socks = await Promise.all(
    Array.from(
      { length: WS_N },
      (_, i) =>
        new Promise((res) => {
          const s0 = Date.now();
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`, {
            headers: { cookie: cookies[i % cookies.length], origin: ORIGIN },
          });
          ws.on('message', (d) => {
            msgs++;
            if (JSON.parse(d.toString()).t === 'hello') {
              hello++;
              lat.push(Date.now() - s0);
              res(ws);
            }
          });
          ws.on('error', () => (failed++, res(null)));
          ws.on('close', () => res(null));
        }),
    ),
  );
  const open = socks.filter(Boolean);
  const before = await (await fetch(`${BASE}/internal/metrics`)).json();
  // Hold for a few seconds to observe stability.
  await sleep(5000);
  const stillOpen = open.filter((w) => w.readyState === 1).length;
  const metrics = await (await fetch(`${BASE}/internal/metrics`)).json();
  for (const w of open) w.close();
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] ?? null;
  const out = {
    title: `WebSocket ${WS_N} concurrent authenticated connections (${accts.length} users)`,
    attempted: WS_N,
    connected: hello,
    failed,
    stillOpenAfter5s: stillOpen,
    connectMs: { p50: q(50), p95: q(95), p99: q(99) },
    totalSetupMs: Date.now() - t0,
    serverConnectionsReported: before.ws.connections,
    serverRssMB: Math.round(metrics.memory.rss / 1e6),
    serverHeapUsedMB: Math.round(metrics.memory.heapUsed / 1e6),
    messagesReceived: msgs,
  };
  console.log(
    `${out.title}: connected ${hello}/${WS_N}, failed ${failed}, open after 5s ${stillOpen}, connect p95 ${out.connectMs.p95}ms, server RSS ${out.serverRssMB}MB`,
  );
  return out;
}

try {
  await waitUp();
  const cookies = [];
  for (const a of accts) cookies.push(await login(a));
  const cookie = cookies[0];
  const results = [];
  results.push(await run('GET /readyz (baseline + DB ping)', { url: `${BASE}/readyz` }));
  results.push(
    await run('GET /api/auth/me (session lookup + DB)', { url: `${BASE}/api/auth/me`, headers: { cookie } }),
  );
  results.push(
    await run('GET /api/settings (authenticated DB read)', {
      url: `${BASE}/api/settings`,
      headers: { cookie },
    }),
  );
  // Warm the shared cache, then hammer it: this is the market-data fan-out path.
  await fetch(`${BASE}/api/market/search?q=chog`, { headers: { cookie } });
  results.push(
    await run('GET /api/market/search (shared cache)', {
      url: `${BASE}/api/market/search?q=chog`,
      headers: { cookie },
    }),
  );
  results.push(
    await run('POST /api/automation-logs (DB write, per-route limit 120/min)', {
      url: `${BASE}/api/automation-logs`,
      method: 'POST',
      headers: { cookie, ...H },
      body: JSON.stringify({ automationId: null, kind: 'system', level: 'info', message: 'load test' }),
    }),
  );
  results.push(
    await run('POST /api/auth/nonce (auth rate limit 20/min/IP)', {
      url: `${BASE}/api/auth/nonce`,
      method: 'POST',
      headers: H,
      body: '{}',
      duration: 3,
    }),
  );
  results.push(await wsTest(cookies));
  const report = {
    date: new Date().toISOString(),
    machine: {
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memGB: Math.round(totalmem() / 1e9),
      node: process.version,
    },
    database: process.env.DATABASE_URL
      ? 'postgres'
      : 'pglite (embedded, single connection — NOT representative of production Postgres)',
    note: 'Load generator and server on the same machine; single server process; no reverse proxy.',
    results,
  };
  writeFileSync('docs/perf-results.json', JSON.stringify(report, null, 2));
  console.log('\nwritten docs/perf-results.json');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  srv.kill();
}
