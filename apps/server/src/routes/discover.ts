import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidAddress, NETWORK_IDS, zNetworkId, type NetworkId } from '@chog/shared';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';

const zNetworks = z
  .string()
  .default(NETWORK_IDS.join(','))
  .transform((s) => [...new Set(s.split(',').filter(Boolean))])
  .pipe(z.array(zNetworkId).min(1).max(NETWORK_IDS.length));

/** Token Terminal → Discover / Pulse / watchlist rows. */
export async function discoverRoutes(app: FastifyInstance, ctx: AppContext) {
  const q = { preHandler: requireAuth(ctx) };

  app.get<{ Querystring: Record<string, string> }>('/api/discover', q, async (req, reply) => {
    const p = z
      .object({
        networks: zNetworks,
        view: z.enum(['trending', 'top']).default('trending'),
        tf: z.enum(['5m', '1h', '6h', '24h']).default('1h'),
      })
      .safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: 'Invalid request' });
    reply.header('cache-control', 'private, max-age=2');
    const r = await ctx.discover.discover(p.data.networks as NetworkId[], p.data.view, p.data.tf);
    return { data: r.rows, errors: r.errors, fetchedAt: r.fetchedAt, stale: r.stale };
  });

  app.get<{ Querystring: Record<string, string> }>('/api/discover/pulse', q, async (req, reply) => {
    const p = z.object({ networks: zNetworks }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: 'Invalid request' });
    reply.header('cache-control', 'private, max-age=2');
    const r = await ctx.discover.pulse(p.data.networks as NetworkId[]);
    return {
      data: { fresh: r.fresh, trending: r.trending },
      errors: r.errors,
      fetchedAt: r.fetchedAt,
      stale: false,
    };
  });

  app.get<{ Querystring: { network?: string; tokens?: string } }>(
    '/api/discover/tokens',
    q,
    async (req, reply) => {
      const n = zNetworkId.safeParse(req.query.network);
      const tokens = [...new Set((req.query.tokens ?? '').split(',').filter(Boolean))].slice(0, 60);
      if (!n.success || tokens.length === 0 || tokens.some((t) => !isValidAddress(n.data, t)))
        return reply.code(400).send({ error: 'Invalid request' });
      try {
        const r = await ctx.discover.tokens(n.data, tokens);
        return { data: r.value, fetchedAt: r.fetchedAt, stale: r.stale };
      } catch {
        return reply.code(502).send({ error: 'Market data provider unavailable', code: 'UPSTREAM' });
      }
    },
  );
}
