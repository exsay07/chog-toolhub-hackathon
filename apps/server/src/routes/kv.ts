import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { USER_KV_KEYS, USER_KV_MAX_BYTES, type UserKvKey } from '@chog/shared';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import { userKv } from '../db/schema.js';

/**
 * Per-user synced state: terminal preferences and sniper entry prices. Allow-listed keys, small JSON
 * values; every row is scoped to the signed-in user.
 */
export async function kvRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const isKey = (k: string): k is UserKvKey => (USER_KV_KEYS as readonly string[]).includes(k);

  app.get('/api/kv', auth, async (req) => {
    const rows = await ctx.db.select().from(userKv).where(eq(userKv.userId, req.user!.id));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.put<{ Params: { key: string }; Body: { value?: unknown } }>(
    '/api/kv/:key',
    { ...auth, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const key = req.params.key;
      if (!isKey(key)) return reply.code(400).send({ error: 'Unknown key' });
      const value = req.body?.value;
      if (value === undefined) return reply.code(400).send({ error: 'Missing value' });
      if (JSON.stringify(value).length > USER_KV_MAX_BYTES)
        return reply.code(413).send({ error: 'Value too large' });
      await ctx.db
        .insert(userKv)
        .values({ userId: req.user!.id, key, value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [userKv.userId, userKv.key], set: { value, updatedAt: new Date() } });
      return { ok: true };
    },
  );

  app.delete<{ Params: { key: string } }>('/api/kv/:key', auth, async (req, reply) => {
    if (!isKey(req.params.key)) return reply.code(400).send({ error: 'Unknown key' });
    await ctx.db.delete(userKv).where(and(eq(userKv.userId, req.user!.id), eq(userKv.key, req.params.key)));
    return { ok: true };
  });
}
