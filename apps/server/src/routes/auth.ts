import { judgeCodeMatches, judgePassOpen } from '../auth/nftGate.js';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHOG_GENESIS, NETWORKS } from '@chog/shared';
import type { AppContext } from '../context.js';
import { sessions } from '../db/schema.js';
import { requireAuth } from '../auth/guard.js';
import {
  consumeNonce,
  createSession,
  findSession,
  issueNonce,
  revokeSession,
  sessionCache,
  SESSION_COOKIE,
  upsertUser,
} from '../auth/sessions.js';
import { newNonce, SIWE_STATEMENT, validateSiweFields } from '../auth/siwe.js';

const zVerify = z.object({
  message: z.string().min(50).max(2000),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,2000}$/),
  /** Reviewer pass (see JUDGE_ACCESS_CODE). */
  judgeCode: z.string().max(64).optional(),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = requireAuth(ctx);
  const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/api/gate', async () => ({
    collection: 'Chog Genesis',
    contract: ctx.cfg.NFT_GATE_CONTRACT,
    network: ctx.cfg.NFT_GATE_NETWORK,
    chainId: NETWORKS[ctx.cfg.NFT_GATE_NETWORK].chainId,
    canonical: ctx.cfg.NFT_GATE_CONTRACT.toLowerCase() === CHOG_GENESIS.address,
    devAllowlistActive: ctx.cfg.devAllowlist.size > 0,
    judgeAccess: judgePassOpen(ctx.cfg),
    walletConnectProjectId: ctx.cfg.WALLETCONNECT_PROJECT_ID || null,
    // Public, from memory (never waits on OpenSea): the "Get Chog Genesis" button on the sign-in page.
    collectionUrl: 'https://opensea.io/collection/chog-genesis',
    floor: ctx.opensea.floorOf('chog-genesis'),
  }));

  app.post('/api/auth/nonce', authLimit, async () => {
    const nonce = newNonce();
    await issueNonce(ctx.db, nonce);
    return {
      nonce,
      domain: ctx.cfg.appDomain,
      uri: ctx.cfg.appOrigin,
      chainId: NETWORKS[ctx.cfg.NFT_GATE_NETWORK].chainId,
      statement: SIWE_STATEMENT,
      version: '1',
    };
  });

  app.post('/api/auth/verify', authLimit, async (req, reply) => {
    const body = zVerify.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request', code: 'BAD_REQUEST' });

    const v = validateSiweFields(body.data.message, {
      domain: ctx.cfg.appDomain,
      origin: ctx.cfg.appOrigin,
      now: Date.now(),
    });
    if (!v.ok) return reply.code(401).send({ error: v.error, code: 'SIWE_INVALID' });

    const sigOk = await ctx.signatures.verify(
      v.address,
      body.data.message,
      body.data.signature as `0x${string}`,
    );
    if (!sigOk)
      return reply.code(401).send({ error: 'Signature does not match address', code: 'BAD_SIGNATURE' });

    // Single use: consumed only after the signature is valid, so a garbage request can't burn nonces of others.
    if (!(await consumeNonce(ctx.db, v.message.nonce)))
      return reply.code(401).send({ error: 'Nonce invalid or already used', code: 'NONCE' });

    // A typed judge code is checked first: a reviewer's wallet holds no NFT, and a wrong code must say so.
    let judge = false;
    if (body.data.judgeCode !== undefined && body.data.judgeCode !== '') {
      if (!judgeCodeMatches(ctx.cfg, body.data.judgeCode)) {
        req.log.warn({ address: v.address }, 'judge access: wrong or expired code');
        return reply.code(403).send({ error: 'Judge access code is not valid', code: 'BAD_JUDGE_CODE' });
      }
      judge = true;
    }
    const own = judge ? ({ status: 'holder', balance: 0 } as const) : await ctx.ownership.check(v.address);
    if (own.status === 'unverifiable')
      return reply.code(503).send({ error: own.reason, code: 'GATE_UNVERIFIABLE' });
    if (own.status === 'not_holder')
      return reply
        .code(403)
        .send({ error: 'This wallet does not hold a Chog Genesis NFT', code: 'NOT_HOLDER' });

    const user = await upsertUser(ctx.db, v.address);
    // Session fixation: always a fresh token; revoke whatever session this browser had.
    const old = req.cookies[SESSION_COOKIE];
    if (old) {
      const prev = await findSession(ctx.db, old);
      if (prev) await revokeSession(ctx.db, prev.s.id);
    }
    const accessBasis = judge ? 'judge' : own.balance > 0 ? 'holder' : 'dev-allowlist';
    const { token, session } = await createSession(ctx.db, {
      userId: user.id,
      ttlHours: ctx.cfg.SESSION_TTL_HOURS,
      userAgent: req.headers['user-agent'],
      nftBalance: own.balance,
      accessBasis,
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: ctx.cfg.prod,
      sameSite: 'strict',
      path: '/',
      expires: session.expiresAt,
    });
    req.log.info({ user: user.id, accessBasis }, 'login');
    return { address: user.address, accessBasis, nftBalance: own.balance, expiresAt: session.expiresAt };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) {
      const s = await findSession(ctx.db, t);
      if (s) {
        await revokeSession(ctx.db, s.s.id);
        ctx.hub.disconnectUser(s.u.id);
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: auth }, async (req) => {
    const [s] = await ctx.db.select().from(sessions).where(eq(sessions.id, req.user!.sessionId));
    return {
      address: req.user!.address,
      accessBasis: req.user!.accessBasis,
      session: {
        id: s!.id,
        expiresAt: s!.expiresAt,
        nftVerifiedAt: s!.nftVerifiedAt,
        nftBalance: s!.nftBalance,
      },
    };
  });

  app.get('/api/auth/sessions', { preHandler: auth }, async (req) => {
    const rows = await ctx.db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        userAgent: sessions.userAgent,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, req.user!.id),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(sessions.lastSeenAt));
    return rows.map((r) => ({ ...r, current: r.id === req.user!.sessionId }));
  });

  app.post<{ Params: { id: string } }>(
    '/api/auth/sessions/:id/revoke',
    { preHandler: auth },
    async (req, reply) => {
      if (!z.uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: 'Bad id' });
      // IDOR guard: only the owner's sessions.
      sessionCache.evict((r) => r.s.id === req.params.id && r.u.id === req.user!.id);
      await ctx.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(sessions.id, req.params.id), eq(sessions.userId, req.user!.id), isNull(sessions.revokedAt)),
        );
      return { ok: true };
    },
  );

  app.post('/api/auth/sessions/revoke-others', { preHandler: auth }, async (req) => {
    sessionCache.evict((r) => r.u.id === req.user!.id && r.s.id !== req.user!.sessionId);
    await ctx.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, req.user!.id),
          ne(sessions.id, req.user!.sessionId),
          isNull(sessions.revokedAt),
        ),
      );
    return { ok: true };
  });
}
