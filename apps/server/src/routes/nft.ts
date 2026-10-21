import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import { FEATURED_CHAINS, NFT_CHAINS, TOP_SORTS, type NftChain } from '../nft/opensea.js';

const zChain = z.enum(NFT_CHAINS as [NftChain, ...NftChain[]]);

/** NFT → Top Collections (OpenSea) and Mint Tracker (on-chain). Holder-only like the rest of the app. */
export async function nftRoutes(app: FastifyInstance, ctx: AppContext) {
  const q = { preHandler: requireAuth(ctx) };

  // Every chain OpenSea lists collections for; featured ones first (they are kept warm).
  app.get('/api/nft/chains', q, async (_req, reply) => {
    const all = await ctx.opensea.chains();
    const rank = (id: string) => {
      const i = FEATURED_CHAINS.indexOf(id);
      return i === -1 ? 1000 : i;
    };
    reply.header('cache-control', 'private, max-age=300');
    return {
      chains: [...all]
        .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
        .map((c) => ({ ...c, featured: FEATURED_CHAINS.includes(c.id) })),
    };
  });

  app.get<{ Querystring: { chain?: string; sort?: string } }>('/api/nft/top', q, async (req, reply) => {
    const chain = (req.query.chain ?? 'monad').toLowerCase();
    const sort = z.enum(TOP_SORTS).safeParse(req.query.sort ?? 'one_day_volume');
    const known = (await ctx.opensea.chains()).some((c) => c.id === chain);
    if (!known || !sort.success) return reply.code(400).send({ error: 'Invalid chain or sort' });
    reply.header('cache-control', 'private, max-age=2');
    return ctx.opensea.top(chain, sort.data);
  });

  // OpenSea collection slug → contract(s), for the NFT Sniper's paste-a-link field.
  // Each unknown slug costs a request on the shared OpenSea quota: keep one user from draining it.
  const slugLimit = { ...q, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  app.get<{ Querystring: { slug?: string } }>('/api/nft/collection', slugLimit, async (req, reply) => {
    const slug = z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i)
      .safeParse(req.query.slug);
    if (!slug.success) return reply.code(400).send({ error: 'Invalid collection slug' });
    try {
      return await ctx.opensea.slugContracts(slug.data);
    } catch (e) {
      const status = (e as { status?: number }).status;
      return reply
        .code(status === 404 ? 404 : 502)
        .send({ error: status === 404 ? 'OpenSea has no such collection' : 'OpenSea unavailable' });
    }
  });

  // Drops calendar: minting now or starting within 72 h (OpenSea), shared cache.
  app.get('/api/nft/drops', q, async (_req, reply) => {
    reply.header('cache-control', 'private, max-age=30');
    try {
      return await ctx.opensea.drops();
    } catch {
      return reply.code(502).send({ error: 'OpenSea unavailable' });
    }
  });

  app.get<{ Querystring: { chain?: string } }>('/api/nft/mints', q, async (req, reply) => {
    const c = req.query.chain ?? 'all';
    const chains = c === 'all' ? NFT_CHAINS : zChain.safeParse(c).success ? [c as NftChain] : null;
    if (!chains) return reply.code(400).send({ error: 'Invalid chain' });
    reply.header('cache-control', 'private, max-age=2');
    if (!ctx.mints) return { enabled: false, rows: [], status: {} };
    return { enabled: true, rows: ctx.mints.rows(chains), status: ctx.mints.status() };
  });
}
