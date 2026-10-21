#!/usr/bin/env node
/**
 * Realistic multi-user load test: N distinct holders (default 300) at the same time.
 *
 * Each user signs in with real SIWE (own throw-away wallet, dev allowlist), keeps the app WebSocket
 * open, and for DURATION seconds behaves like a person using the app: page reads (me, settings,
 * bots, logs, watchlist, journal, PnL, tracker, discover) plus writes (settings, watchlist, a Perps
 * bot config, an automation log line). Every user goes through its own client IP (X-Forwarded-For
 * with TRUST_PROXY=true, as behind a reverse proxy), so per-IP limits behave as in production.
 *
 * Then it checks the data: every user sees exactly their own records (unique markers), nobody sees
 * anyone else's, and — after restarting the server on the same database — everything is still there.
 *
 *   node scripts/loadtest-users.mjs [--users=300] [--duration=60]
 * Uses embedded PGlite unless DATABASE_URL is set (PGlite = one connection: a pessimistic bound).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const arg = (k, d) => Number(process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const USERS = arg('users', 300);
const DURATION = arg('duration', 60);
const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
const PGLITE_DIR = process.env.DATABASE_URL ? '' : mkdtempSync(join(tmpdir(), 'chog-users-'));
const accts = Array.from({ length: USERS }, () => privateKeyToAccount(generatePrivateKey()));
const ipOf = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${(i & 255) + 1}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      APP_ORIGIN: ORIGIN,
      PGLITE_DIR,
      NFT_GATE_DEV_ALLOWLIST: accts.map((a) => a.address).join(','),
      TRUST_PROXY: 'true',
      TRACKER_ENABLED: 'false',
      MINTS_ENABLED: 'false',
      DISCOVER_WARM: 'false',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
async function waitUp() {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* starting */
    }
    await sleep(500);
  }
  throw new Error('server did not start');
}

const stats = new Map(); // endpoint -> { n, err, lat[] , codes }
function rec(name, ms, status) {
  let s = stats.get(name);
  if (!s) stats.set(name, (s = { n: 0, err: 0, lat: [], codes: {} }));
  s.n++;
  s.lat.push(ms);
  s.codes[status] = (s.codes[status] ?? 0) + 1;
  if (!(status >= 200 && status < 300)) s.err++;
}

function client(i) {
  const ip = ipOf(i);
  let cookie = '';
  const call = async (name, method, path, body) => {
    const t = performance.now();
    let status;
    let json = null;
    try {
      const r = await fetch(BASE + path, {
        method,
        headers: {
          origin: ORIGIN,
          'x-forwarded-for': ip,
          ...(cookie ? { cookie } : {}),
          ...(method !== 'GET' ? { 'x-chog-csrf': '1', 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      status = r.status;
      const sc = r.headers.get('set-cookie');
      if (sc && sc.startsWith('chog_session=')) cookie = sc.split(';')[0];
      const text = await r.text();
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    } catch {
      status = 599;
    }
    rec(name, performance.now() - t, status);
    return { status, json };
  };
  return {
    ip,
    call,
    get cookie() {
      return cookie;
    },
  };
}

async function login(i, c) {
  const a = accts[i];
  const n = (await c.call('POST /auth/nonce', 'POST', '/api/auth/nonce', {})).json;
  const now = new Date();
  const message = createSiweMessage({
    address: a.address,
    chainId: n.chainId,
    domain: n.domain,
    nonce: n.nonce,
    uri: n.uri,
    version: '1',
    statement: n.statement,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 300_000),
  });
  const signature = await a.signMessage({ message });
  const r = await c.call('POST /auth/verify', 'POST', '/api/auth/verify', { message, signature });
  if (r.status !== 200) throw new Error(`login ${i} failed ${r.status}`);
}

const perpsCfg = (i) => ({
  platform: i % 2 ? 'bulk' : 'perpl',
  pair: 'SOL-USD',
  direction: 'alternate',
  sizeUsd: 1000 + i, // unique marker per user
  leverage: 5,
  entry: 'limit',
  exit: 'limit',
  limitOffsetBps: 5,
  holdSec: 30,
  intervalSec: 60,
  risk: {
    maxNotionalUsd: 5000,
    maxLeverage: 10,
    maxOpenPositions: 1,
    maxConcurrentOrders: 2,
    maxDailyLossUsd: 25,
    maxRuntimeMin: 240,
  },
});
// A valid-looking unique EVM address per user for the watchlist marker.
const watchAddr = (i) => `0x${(0xc0de0000 + i).toString(16).padStart(40, '0')}`;

/** One person using the app for DURATION seconds. */
async function behave(i, c, until) {
  const reads = [
    ['GET /auth/me', '/api/auth/me'],
    ['GET /settings', '/api/settings'],
    ['GET /automations/perps', '/api/automations/perps'],
    ['GET /automation-logs', '/api/automation-logs?kind=perps'],
    ['GET /watchlist', '/api/watchlist'],
    ['GET /journal', '/api/journal?limit=50'],
    ['GET /portfolio/pnl', '/api/portfolio/pnl'],
    ['GET /tracker/wallets', '/api/tracker/wallets'],
    ['GET /discover', '/api/discover?networks=monad&view=trending&tf=1h'],
    ['GET /discover/pulse', '/api/discover/pulse?networks=monad'],
  ];
  while (Date.now() < until) {
    await sleep(1500 + Math.random() * 3500); // a page view / click every 1.5–5 s
    const r = Math.random();
    if (r < 0.8) {
      const [name, path] = reads[Math.floor(Math.random() * reads.length)];
      await c.call(name, 'GET', path);
    } else if (r < 0.88) {
      await c.call('POST /automation-logs', 'POST', '/api/automation-logs', {
        automationId: null,
        kind: 'perps',
        level: 'info',
        message: `user ${i} cycle done`,
      });
    } else if (r < 0.95) {
      const s = (await c.call('GET /settings', 'GET', '/api/settings')).json;
      if (s) await c.call('PUT /settings', 'PUT', '/api/settings', s);
    } else {
      await c.call('GET /automations/perps', 'GET', '/api/automations/perps');
    }
  }
}

/** The records each user owns, with unique markers to detect loss or cross-user leaks. */
async function writeOwnData(i, c) {
  const s = (await c.call('GET /settings', 'GET', '/api/settings')).json;
  await c.call('PUT /settings', 'PUT', '/api/settings', { ...s, onboarding: { guideDoneAt: 1_000_000 + i } });
  await c.call('POST /watchlist', 'POST', '/api/watchlist', {
    network: 'monad',
    address: watchAddr(i),
    symbol: `U${i}`,
  });
  await c.call('POST /automations/perps', 'POST', '/api/automations/perps', perpsCfg(i));
}

async function verify(i, c) {
  const problems = [];
  const s = (await c.call('GET /settings', 'GET', '/api/settings')).json;
  if (s?.onboarding?.guideDoneAt !== 1_000_000 + i) problems.push('settings lost/changed');
  const w = (await c.call('GET /watchlist', 'GET', '/api/watchlist')).json ?? [];
  if (!w.some((x) => x.address?.toLowerCase() === watchAddr(i))) problems.push('watchlist item lost');
  if (w.some((x) => x.symbol?.startsWith('U') && x.symbol !== `U${i}`))
    problems.push("sees another user's watchlist");
  const bots = (await c.call('GET /automations/perps', 'GET', '/api/automations/perps')).json ?? [];
  if (!bots.some((b) => b.data?.sizeUsd === 1000 + i)) problems.push('perps bot lost');
  if (bots.some((b) => b.data?.sizeUsd >= 1000 && b.data?.sizeUsd !== 1000 + i))
    problems.push("sees another user's bot");
  return problems;
}

async function pool(n, conc, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < n) await fn(next++);
    }),
  );
}

const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
function summary() {
  const rows = [];
  for (const [name, s] of [...stats.entries()].sort()) {
    const l = [...s.lat].sort((a, b) => a - b);
    rows.push({
      endpoint: name,
      requests: s.n,
      failed: s.err,
      p50: Math.round(q(l, 50)),
      p95: Math.round(q(l, 95)),
      p99: Math.round(q(l, 99)),
      codes: s.codes,
    });
  }
  return rows;
}

let srv = startServer();
const report = { users: USERS, durationSec: DURATION, db: process.env.DATABASE_URL ? 'postgres' : 'pglite' };
try {
  await waitUp();
  const clients = accts.map((_, i) => client(i));

  let t0 = Date.now();
  await pool(USERS, 30, (i) => login(i, clients[i]));
  report.loginAllSec = +((Date.now() - t0) / 1000).toFixed(1);
  console.log(`signed in ${USERS} users in ${report.loginAllSec}s`);

  // Everyone keeps the app socket open, like an open tab.
  let wsOpen = 0;
  let wsFailed = 0;
  const sockets = await Promise.all(
    clients.map(
      (c) =>
        new Promise((res) => {
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`, {
            headers: { cookie: c.cookie, origin: ORIGIN, 'x-forwarded-for': c.ip },
          });
          ws.on('message', (d) => {
            if (JSON.parse(d.toString()).t === 'hello') {
              wsOpen++;
              res(ws);
            }
          });
          ws.on('error', () => (wsFailed++, res(null)));
        }),
    ),
  );

  await pool(USERS, 50, (i) => writeOwnData(i, clients[i]));
  console.log(`each user wrote settings, a watchlist token and a bot config; now ${DURATION}s of activity…`);

  const until = Date.now() + DURATION * 1000;
  const mem = [];
  const sampler = setInterval(async () => {
    try {
      const m = await (await fetch(`${BASE}/internal/metrics`)).json();
      mem.push(Math.round(m.memory.rss / 1e6));
    } catch {
      /* ignore */
    }
  }, 5000);
  t0 = Date.now();
  await Promise.all(clients.map((c, i) => behave(i, c, until)));
  clearInterval(sampler);
  const metrics = await (await fetch(`${BASE}/internal/metrics`)).json();
  report.activity = {
    seconds: Math.round((Date.now() - t0) / 1000),
    wsOpen,
    wsFailed,
    wsStillOpen: sockets.filter((s) => s?.readyState === 1).length,
    serverRssMB: { peak: Math.max(...mem, 0), end: Math.round(metrics.memory.rss / 1e6) },
  };
  report.endpoints = summary();
  const totalReq = report.endpoints.reduce((a, r) => a + r.requests, 0);
  const totalFail = report.endpoints.reduce((a, r) => a + r.failed, 0);
  report.totals = { requests: totalReq, failed: totalFail, reqPerSec: +(totalReq / DURATION).toFixed(1) };
  for (const s of sockets) s?.close();

  const live = [];
  await pool(USERS, 50, async (i) =>
    live.push(...(await verify(i, clients[i])).map((p) => `user ${i}: ${p}`)),
  );
  report.integrityLive = { checked: USERS, problems: live.slice(0, 20), problemCount: live.length };
  console.log(`integrity (live): ${live.length} problems`);

  // Durability: restart the server on the same database, then check again with the same sessions.
  srv.kill();
  await new Promise((r) => srv.once('exit', r));
  srv = startServer();
  await waitUp();
  const after = [];
  await pool(USERS, 50, async (i) =>
    after.push(...(await verify(i, clients[i])).map((p) => `user ${i}: ${p}`)),
  );
  report.integrityAfterRestart = { checked: USERS, problems: after.slice(0, 20), problemCount: after.length };
  console.log(`integrity (after restart): ${after.length} problems`);

  report.machine = { cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 1e9) };
  report.date = new Date().toISOString();
  console.table(report.endpoints.map(({ codes, ...r }) => ({ ...r, codes: JSON.stringify(codes) })));
  console.log(JSON.stringify({ totals: report.totals, activity: report.activity }, null, 1));
  writeFileSync('docs/perf-users.json', JSON.stringify(report, null, 2));
  console.log('written docs/perf-users.json');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  srv.kill();
}
