import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { sessions } from '../db/schema.js';
import { findSession, revokeSession, SESSION_COOKIE } from './sessions.js';
import { judgePassOpen } from './nftGate.js';

export const CSRF_HEADER = 'x-chog-csrf';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth for cookie-authenticated requests:
 *  1. SameSite=Strict session cookie;
 *  2. Origin header must match APP_ORIGIN on every state-changing request;
 *  3. a custom header is required (cannot be sent cross-origin without a CORS preflight, which we never allow).
 */
export function csrfCheck(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!UNSAFE.has(req.method)) return;
    const origin = req.headers.origin;
    if (!origin || !ctx.cfg.allowedOrigins.has(origin))
      return reply.code(403).send({ error: 'Origin not allowed', code: 'BAD_ORIGIN' });
    if (req.headers[CSRF_HEADER] !== '1')
      return reply.code(403).send({ error: 'Missing CSRF header', code: 'CSRF' });
  };
}

export type SessionResolution =
  | { ok: true; user: NonNullable<FastifyRequest['user']> }
  | { ok: false; status: number; code: string; error: string };

/** Loads the session and enforces the NFT re-verification policy (docs/SECURITY.md#nft-gate). */
export async function resolveSession(ctx: AppContext, token: string | undefined): Promise<SessionResolution> {
  if (!token || token.length > 100)
    return { ok: false, status: 401, code: 'NO_SESSION', error: 'Not signed in' };
  const row = await findSession(ctx.db, token, { cached: true });
  const now = Date.now();
  if (!row || row.s.revokedAt || row.s.expiresAt.getTime() <= now)
    return { ok: false, status: 401, code: 'SESSION_EXPIRED', error: 'Session expired' };

  const { s, u } = row;
  // Reviewer sessions hold no NFT: they live exactly as long as the judge pass stays open.
  if (s.accessBasis === 'judge') {
    if (!judgePassOpen(ctx.cfg)) {
      await revokeSession(ctx.db, s.id);
      ctx.hub.disconnectUser(u.id);
      return { ok: false, status: 401, code: 'JUDGE_ACCESS_ENDED', error: 'Judge access has ended' };
    }
    return { ok: true, user: { id: u.id, address: u.address, sessionId: s.id, accessBasis: s.accessBasis } };
  }
  const sinceVerify = now - s.nftVerifiedAt.getTime();
  if (sinceVerify > ctx.cfg.NFT_RECHECK_SEC * 1000) {
    const r = await ctx.ownership.check(u.address as `0x${string}`);
    if (r.status === 'not_holder') {
      await revokeSession(ctx.db, s.id);
      ctx.hub.disconnectUser(u.id);
      return {
        ok: false,
        status: 403,
        code: 'NOT_HOLDER',
        error: 'Chog Genesis no longer held by this wallet',
      };
    }
    if (r.status === 'unverifiable') {
      if (sinceVerify > (ctx.cfg.NFT_RECHECK_SEC + ctx.cfg.NFT_GRACE_SEC) * 1000)
        return { ok: false, status: 503, code: 'GATE_UNVERIFIABLE', error: r.reason };
    } else {
      const now2 = new Date();
      await ctx.db
        .update(sessions)
        .set({ nftVerifiedAt: now2, nftBalance: r.balance, lastSeenAt: now2 })
        .where(eq(sessions.id, s.id));
      s.nftVerifiedAt = now2;
      s.lastSeenAt = now2;
    }
  } else if (!s.lastSeenAt || now - s.lastSeenAt.getTime() > 60_000) {
    s.lastSeenAt = new Date();
    await ctx.db.update(sessions).set({ lastSeenAt: s.lastSeenAt }).where(eq(sessions.id, s.id));
  }
  return { ok: true, user: { id: u.id, address: u.address, sessionId: s.id, accessBasis: s.accessBasis } };
}

export function requireAuth(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await resolveSession(ctx, req.cookies[SESSION_COOKIE]);
    if (!r.ok) {
      if (r.status === 401 || r.code === 'NOT_HOLDER') reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(r.status).send({ error: r.error, code: r.code });
    }
    req.user = r.user;
  };
}
