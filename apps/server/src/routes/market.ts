import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isValidAddress, NETWORK_IDS, zNetworkId, type NetworkId } from '@chog/shared';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import { UpstreamError } from '../lib/http.js';
import type { Cached } from '../lib/cache.js';

const poolId = (n: NetworkId, a: string) => isValidAddress(n, a) || /^0x[0-9a-fA-F]{64}$/.test(a);

function send<T>(reply: FastifyReply, r: Cached<T>) {
  reply.header('cache-control', 'private, max-age=2');
  return { data: r.value, fetchedAt: r.fetchedAt, stale: r.stale };
}

function upstreamFail(reply: FastifyReply, e: unknown) {
  const status = e instanceof UpstreamError && e.status === 429 ? 429 : 502;
  return reply.code(status).send({ error: 'Market data provider unavailable', code: 'UPSTREAM' });
}

export async function marketRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = requireAuth(ctx);
  const q = { preHandler: auth };

  app.get<{ Querystring: { q?: string } }>('/api/market/search', q, async (req, reply) => {
    const s = z.string().trim().min(1).max(64).safeParse(req.query.q);
    if (!s.success) return reply.code(400).send({ error: 'Query required' });
    try {
      return send(reply, await ctx.market.search(s.data));
    } catch (e) {
      return upstreamFail(reply, e);
    }
  });

  app.get<{ Params: { network: string; token: string } }>(
    '/api/market/token/:network/:token',
    q,
    async (req, reply) => {
      const n = zNetworkId.safeParse(req.params.network);
      if (!n.success || !isValidAddress(n.data, req.params.token))
        return reply.code(400).send({ error: 'Invalid token address' });
      try {
        return send(reply, await ctx.market.tokenPairs(n.data, req.params.token));
      } catch (e) {
        return upstreamFail(reply, e);
      }
    },
  );

  app.get<{ Params: { network: string; pair: string } }>(
    '/api/market/pair/:network/:pair',
    q,
    async (req, reply) => {
      const n = zNetworkId.safeParse(req.params.network);
      if (!n.success || !poolId(n.data, req.params.pair))
        return reply.code(400).send({ error: 'Invalid pair' });
      try {
        return send(reply, await ctx.market.pair(n.data, req.params.pair));
      } catch (e) {
        return upstreamFail(reply, e);
      }
    },
  );

  const zTf = z.object({
    tf: z.enum(['minute', 'hour', 'day']).default('minute'),
    agg: z.coerce
      .number()
      .int()
      .refine((v) => [1, 4, 5, 12, 15].includes(v))
      .default(5),
  });
  app.get<{ Params: { network: string; pool: string }; Querystring: Record<string, string> }>(
    '/api/market/ohlcv/:network/:pool',
    q,
    async (req, reply) => {
      const n = zNetworkId.safeParse(req.params.network);
      const t = zTf.safeParse(req.query);
      if (!n.success || !t.success || !poolId(n.data, req.params.pool))
        return reply.code(400).send({ error: 'Invalid request' });
      const agg =
        t.data.tf === 'minute'
          ? [1, 5, 15].includes(t.data.agg)
            ? t.data.agg
            : 5
          : t.data.tf === 'hour'
            ? [1, 4, 12].includes(t.data.agg)
              ? t.data.agg
              : 1
            : 1;
      try {
        return send(reply, await ctx.market.ohlcv(n.data, req.params.pool, t.data.tf, agg));
      } catch (e) {
        return upstreamFail(reply, e);
      }
    },
  );

  app.get<{ Params: { network: string; pool: string } }>(
    '/api/market/trades/:network/:pool',
    q,
    async (req, reply) => {
      const n = zNetworkId.safeParse(req.params.network);
      if (!n.success || !poolId(n.data, req.params.pool))
        return reply.code(400).send({ error: 'Invalid request' });
      try {
        return send(reply, await ctx.market.trades(n.data, req.params.pool));
      } catch (e) {
        return upstreamFail(reply, e);
      }
    },
  );

  app.get<{ Params: { network: string } }>('/api/market/new-pools/:network', q, async (req, reply) => {
    const n = zNetworkId.safeParse(req.params.network);
    if (!n.success) return reply.code(400).send({ error: 'Invalid network' });
    try {
      return send(reply, await ctx.market.newPools(n.data));
    } catch (e) {
      return upstreamFail(reply, e);
    }
  });

  app.get<{ Params: { network: string; token: string } }>(
    '/api/market/security/:network/:token',
    q,
    async (req, reply) => {
      const n = zNetworkId.safeParse(req.params.network);
      if (!n.success || !isValidAddress(n.data, req.params.token))
        return reply.code(400).send({ error: 'Invalid token' });
      try {
        return send(reply, await ctx.market.security(n.data, req.params.token));
      } catch (e) {
        return upstreamFail(reply, e);
      }
    },
  );

  app.get<{ Querystring: { network?: string; tokens?: string } }>(
    '/api/market/prices',
    q,
    async (req, reply) => {
      const n = zNetworkId.safeParse(req.query.network);
      const tokens = (req.query.tokens ?? '').split(',').filter(Boolean).slice(0, 60);
      if (!n.success || tokens.some((t) => !isValidAddress(n.data, t)))
        return reply.code(400).send({ error: 'Invalid request' });
      const m = await ctx.market.prices(n.data, tokens);
      return { data: Object.fromEntries(m), fetchedAt: Date.now(), stale: false };
    },
  );

  app.get('/api/market/native-prices', q, async () => {
    const ids: NetworkId[] = NETWORK_IDS;
    const vals = await Promise.all(ids.map((n) => ctx.market.nativePriceUsd(n).catch(() => null)));
    return { data: Object.fromEntries(ids.map((n, i) => [n, vals[i]])), fetchedAt: Date.now(), stale: false };
  });

  app.get('/api/market/health', q, async () => ({
    data: ctx.market.health,
    geckoQueue: ctx.market.gecko.queueDepth,
  }));
}
