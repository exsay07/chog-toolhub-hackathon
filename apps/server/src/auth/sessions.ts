import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { authNonces, sessions, users } from '../db/schema.js';
import { NONCE_TTL_MS } from './siwe.js';

export const SESSION_COOKIE = 'chog_session';

type SessionRow = { s: typeof sessions.$inferSelect; u: typeof users.$inferSelect };

/**
 * Tiny per-process session cache (default 5 s TTL) so every request doesn't hit the database.
 * Revocations in this process evict immediately; in a multi-instance deployment another instance
 * may honour a revoked session for at most `ttlMs` (documented in docs/SECURITY.md).
 */
export const sessionCache = {
  ttlMs: 5000,
  map: new Map<string, { row: SessionRow; at: number }>(),
  get(hash: string) {
    const e = this.map.get(hash);
    if (!e || Date.now() - e.at > this.ttlMs) return undefined;
    return e.row;
  },
  set(hash: string, row: SessionRow) {
    if (this.ttlMs <= 0) return;
    if (this.map.size > 20_000) this.map.clear();
    this.map.set(hash, { row, at: Date.now() });
  },
  evict(pred: (r: SessionRow) => boolean) {
    for (const [k, v] of this.map) if (pred(v.row)) this.map.delete(k);
  },
};

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function issueNonce(db: Db, nonce: string, now = new Date()) {
  await db
    .insert(authNonces)
    .values({ nonce, createdAt: now, expiresAt: new Date(now.getTime() + NONCE_TTL_MS) });
}

/** Atomically consumes a nonce. Returns false if unknown, expired or already used (replay). */
export async function consumeNonce(db: Db, nonce: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(authNonces)
    .set({ usedAt: now })
    .where(and(eq(authNonces.nonce, nonce), isNull(authNonces.usedAt), gt(authNonces.expiresAt, now)))
    .returning({ nonce: authNonces.nonce });
  return rows.length === 1;
}

export async function upsertUser(db: Db, address: string) {
  const addr = address.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ address: addr, lastLoginAt: new Date() })
    .onConflictDoUpdate({ target: users.address, set: { lastLoginAt: new Date() } })
    .returning();
  return u!;
}

export async function createSession(
  db: Db,
  p: {
    userId: string;
    ttlHours: number;
    userAgent: string | undefined;
    nftBalance: number;
    accessBasis: string;
  },
) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const [s] = await db
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId: p.userId,
      expiresAt: new Date(now.getTime() + p.ttlHours * 3600_000),
      userAgent: p.userAgent?.slice(0, 200) ?? null,
      lastSeenAt: now,
      nftVerifiedAt: now,
      nftBalance: p.nftBalance,
      accessBasis: p.accessBasis,
    })
    .returning();
  return { token, session: s! };
}

export async function findSession(db: Db, token: string, opts: { cached?: boolean } = {}) {
  const hash = hashToken(token);
  if (opts.cached) {
    const hit = sessionCache.get(hash);
    if (hit) return hit;
  }
  const rows = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hash))
    .limit(1);
  const row = rows[0] ?? null;
  if (row && opts.cached) sessionCache.set(hash, row);
  return row;
}

export async function revokeSession(db: Db, id: string) {
  sessionCache.evict((r) => r.s.id === id);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
}

export async function revokeAllForUser(db: Db, userId: string) {
  sessionCache.evict((r) => r.u.id === userId);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function purgeExpired(db: Db, now = new Date()) {
  await db.delete(authNonces).where(lt(authNonces.expiresAt, new Date(now.getTime() - 3600_000)));
  await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now), lt(sessions.revokedAt, new Date(now.getTime() - 7 * 86400_000))));
}
