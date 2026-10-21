import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { NETWORKS } from '@chog/shared';
import type { AppContext } from './context.js';
import { csrfCheck, resolveSession } from './auth/guard.js';
import { SESSION_COOKIE } from './auth/sessions.js';
import { authRoutes } from './routes/auth.js';
import { marketRoutes } from './routes/market.js';
import { nftRoutes } from './routes/nft.js';
import { discoverRoutes } from './routes/discover.js';
import { userRoutes } from './routes/user.js';
import { perplRoutes } from './routes/perpl.js';
import { kvRoutes } from './routes/kv.js';

/**
 * Content-Security-Policy for the SPA when served by this process. Wallet RPC/aggregator calls from
 * the browser go only to the hosts listed in connect-src.
 */
export const WEB_CSP = {
  'default-src': ["'self'"],
  // wasm-unsafe-eval: the Bulk signing library is WebAssembly (no JS eval is allowed).
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'"],
  'connect-src': [
    "'self'",
    'https://aggregator-api.kyberswap.com',
    'https://lite-api.jup.ag',
    // Public RPCs of every network (the trading vault signs and sends from the browser).
    ...[...new Set(Object.values(NETWORKS).flatMap((n) => n.defaultRpcUrls.map((u) => new URL(u).origin)))],
    'http://127.0.0.1:47321',
    // Bulk perps API + market data (the browser farmer talks to Bulk directly; CORS is open).
    'https://mainnet-api1.bulk.trade',
    'https://exchange-api.bulk.trade',
    'wss://mainnet-ws1.bulk.trade',
    'wss://exchange-ws1.bulk.trade',
    // WalletConnect relay (phone-wallet sign-in).
    'https://*.walletconnect.org',
    'wss://*.walletconnect.org',
    'https://*.walletconnect.com',
    'wss://*.walletconnect.com',
  ],
  // Official Dexscreener chart embed (token terminal) and the hidden SoundCloud widget (music dock).
  // WalletConnect's Verify API runs in an iframe (domain verification for phone wallets).
  'frame-src': [
    'https://dexscreener.com',
    'https://w.soundcloud.com',
    'https://verify.walletconnect.org',
    'https://verify.walletconnect.com',
  ],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
  // Would upgrade the loopback agent URL (http://127.0.0.1) and break it; HSTS covers prod.
  'upgrade-insecure-requests': null,
};

/** The visitor's IP: the edge's header when configured (Cloudflare: cf-connecting-ip), else the socket/proxy IP. */
export function clientIp(
  req: { ip: string; headers: Record<string, string | string[] | undefined> },
  header: string,
) {
  if (header) {
    const v = req.headers[header];
    const ip = (Array.isArray(v) ? v[0] : v)?.trim();
    if (ip && ip.length <= 64) return ip;
  }
  return req.ip;
}

export async function buildApp(ctx: AppContext, opts: { webDist?: string } = {}) {
  const app = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    bodyLimit: 64 * 1024,
    trustProxy: ctx.cfg.TRUST_PROXY,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[\w-]{8,64}$/.test(h) ? h : randomUUID();
    },
    requestTimeout: 30_000,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: WEB_CSP },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: ctx.cfg.prod ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: ctx.cfg.RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
    keyGenerator: (req) => clientIp(req, ctx.cfg.CLIENT_IP_HEADER),
    allowList: [],
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  // www.<domain> → the canonical origin (one site, one cookie scope, one CSRF origin).
  const canonical = new URL(ctx.cfg.APP_ORIGIN);
  const wwwHost = canonical.host.startsWith('www.') ? null : `www.${canonical.host}`;
  app.addHook('onRequest', async (req, reply) => {
    if (wwwHost && req.headers.host?.toLowerCase() === wwwHost)
      return reply.code(301).header('location', `${canonical.origin}${req.url}`).send();
  });

  // No CORS plugin on purpose: the API is same-origin only.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
      return csrfCheck(ctx)(req, reply);
    }
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: { message: err.message, code: err.code } }, 'request failed');
    // Never leak internals to clients.
    reply
      .code(status)
      .send({ error: status >= 500 ? 'Internal error' : err.message, code: err.code, requestId: req.id });
  });

  const noLimit = { config: { rateLimit: false } } as const;
  app.get('/healthz', noLimit, async () => ({ ok: true }));
  app.get('/readyz', noLimit, async (_req, reply) => {
    const db = await ctx.dbPing();
    return reply.code(db ? 200 : 503).send({ ok: db, db });
  });
  app.get('/internal/metrics', noLimit, async (req, reply) => {
    // Loopback only AND not proxied: a same-host reverse proxy would otherwise make every public
    // request look local. Optional bearer token for remote scraping.
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    const proxied = !!(req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']);
    const tokenOk =
      !!ctx.cfg.METRICS_TOKEN && req.headers.authorization === `Bearer ${ctx.cfg.METRICS_TOKEN}`;
    if (!tokenOk && (!loopback || proxied)) return reply.code(404).send();
    return {
      ws: { connections: ctx.hub.connectionCount, ...ctx.hub.stats },
      market: {
        health: ctx.market.health,
        cacheSize: ctx.market.cache.size,
        geckoQueue: ctx.market.gecko.queueDepth,
      },
      tracker: ctx.workers.tracker?.stats ?? null,
      reconciler: ctx.workers.reconciler?.stats ?? null,
      memory: process.memoryUsage(),
      uptimeSec: process.uptime(),
    };
  });

  await authRoutes(app, ctx);
  await marketRoutes(app, ctx);
  await nftRoutes(app, ctx);
  await discoverRoutes(app, ctx);
  await userRoutes(app, ctx);
  await perplRoutes(app, ctx);
  await kvRoutes(app, ctx);

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // Auth + Origin checks for WebSocket upgrades (browsers don't apply SameSite/CORS the same way).
    void (async () => {
      const origin = req.headers.origin;
      if (!origin || !ctx.cfg.allowedOrigins.has(origin)) return socket.close(4003, 'origin');
      const r = await resolveSession(ctx, req.cookies[SESSION_COOKIE]);
      if (!r.ok) return socket.close(4001, r.code);
      ctx.hub.add(socket, r.user.id);
    })().catch(() => socket.close(1011, 'error'));
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, {
      root: opts.webDist,
      wildcard: false,
      maxAge: '1h',
      immutable: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET')
        return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html', { maxAge: 0 });
    });
  }

  return app;
}
