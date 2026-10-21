import { and, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  computePositions,
  dailyRealized,
  DEFAULT_SETTINGS,
  isEvmAddress,
  isSolanaAddress,
  NETWORKS,
  normalizeAddress,
  summarize,
  unrealizedUsd,
  zCopyConfig,
  zJournalSubmit,
  zMintTask,
  zPerpsTaskConfig,
  zSettings,
  zSniperConfig,
  zTrackedWalletCreate,
  zTrackedWalletUpdate,
  zWatchlistAdd,
  type Fill,
  type NetworkId,
  type Settings,
} from '@chog/shared';
import { formatUnits } from 'viem';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/guard.js';
import {
  automationLogs,
  automations,
  journal,
  settings,
  trackedWallets,
  trackerEvents,
  tradingWallets,
  watchlist,
} from '../db/schema.js';
import { ERC20_META_ABI } from '../chain/evm.js';

const zUuid = z.uuid();
const bad = (reply: FastifyReply, error = 'Invalid request', details?: unknown) =>
  reply.code(400).send({ error, details });

function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function loadSettings(ctx: AppContext, userId: string): Promise<Settings> {
  const [r] = await ctx.db.select().from(settings).where(eq(settings.userId, userId));
  if (!r) return DEFAULT_SETTINGS;
  const p = zSettings.safeParse(r.data);
  return p.success ? p.data : DEFAULT_SETTINGS;
}

export async function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const uid = (req: { user?: { id: string } }) => req.user!.id;

  /* --------------------------------- settings --------------------------------- */

  app.get('/api/settings', auth, async (req) => loadSettings(ctx, uid(req)));

  app.put('/api/settings', auth, async (req, reply) => {
    const p = zSettings.safeParse(req.body);
    if (!p.success) return bad(reply, 'Invalid settings', p.error.issues.slice(0, 5));
    if (!validTimeZone(p.data.timeZone)) return bad(reply, 'Unknown time zone');
    await ctx.db
      .insert(settings)
      .values({ userId: uid(req), data: p.data, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.userId, set: { data: p.data, updatedAt: new Date() } });
    return p.data;
  });

  /* ----------------------------- trading wallets ------------------------------ */

  app.get('/api/trading-wallets', auth, async (req) =>
    ctx.db
      .select()
      .from(tradingWallets)
      .where(eq(tradingWallets.userId, uid(req))),
  );

  const zTw = z.object({ evm: z.string().nullable(), solana: z.string().nullable() });
  app.put('/api/trading-wallets', auth, async (req, reply) => {
    const p = zTw.safeParse(req.body);
    if (!p.success) return bad(reply);
    if (p.data.evm && !isEvmAddress(p.data.evm)) return bad(reply, 'Invalid EVM address');
    if (p.data.solana && !isSolanaAddress(p.data.solana)) return bad(reply, 'Invalid Solana address');
    for (const [kind, address] of [
      ['evm', p.data.evm?.toLowerCase()],
      ['solana', p.data.solana],
    ] as const) {
      const mine = and(eq(tradingWallets.userId, uid(req)), eq(tradingWallets.kind, kind));
      // Removing the primary wallet (vault deleted) also forgets the extra ones.
      if (!address) {
        await ctx.db.delete(tradingWallets).where(mine);
        continue;
      }
      await ctx.db.transaction(async (tx) => {
        await tx
          .delete(tradingWallets)
          .where(and(mine, or(eq(tradingWallets.role, 'primary'), eq(tradingWallets.address, address))));
        await tx.insert(tradingWallets).values({ userId: uid(req), kind, address, role: 'primary' });
      });
    }
    return ctx.db
      .select()
      .from(tradingWallets)
      .where(eq(tradingWallets.userId, uid(req)));
  });

  /* --------------------------------- watchlist -------------------------------- */

  app.get('/api/watchlist', auth, async (req) =>
    ctx.db
      .select()
      .from(watchlist)
      .where(eq(watchlist.userId, uid(req)))
      .orderBy(desc(watchlist.createdAt)),
  );

  app.post('/api/watchlist', auth, async (req, reply) => {
    const p = zWatchlistAdd.safeParse(req.body);
    if (!p.success) return bad(reply, 'Invalid token');
    const count = await ctx.db.$count(watchlist, eq(watchlist.userId, uid(req)));
    if (count >= 200) return bad(reply, 'Watchlist limit reached (200)');
    const [r] = await ctx.db
      .insert(watchlist)
      .values({
        userId: uid(req),
        network: p.data.network,
        address: normalizeAddress(p.data.network, p.data.address),
        symbol: p.data.symbol?.slice(0, 32) ?? null,
      })
      .onConflictDoNothing()
      .returning();
    return r ?? { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/watchlist/:id', auth, async (req, reply) => {
    if (!zUuid.safeParse(req.params.id).success) return bad(reply);
    await ctx.db
      .delete(watchlist)
      .where(and(eq(watchlist.id, req.params.id), eq(watchlist.userId, uid(req))));
    return { ok: true };
  });

  /* ------------------------------ tracked wallets ----------------------------- */

  app.get('/api/tracker/wallets', auth, async (req) =>
    ctx.db
      .select()
      .from(trackedWallets)
      .where(eq(trackedWallets.userId, uid(req)))
      .orderBy(trackedWallets.createdAt),
  );

  app.post('/api/tracker/wallets', auth, async (req, reply) => {
    const p = zTrackedWalletCreate.safeParse(req.body);
    if (!p.success) return bad(reply, 'Invalid wallet', p.error.issues.slice(0, 3));
    const count = await ctx.db.$count(trackedWallets, eq(trackedWallets.userId, uid(req)));
    if (count >= 100) return bad(reply, 'Tracked wallet limit reached (100)');
    const [r] = await ctx.db
      .insert(trackedWallets)
      .values({
        userId: uid(req),
        ...p.data,
        address: normalizeAddress(p.data.network, p.data.address),
        copy: null,
      })
      .onConflictDoNothing()
      .returning();
    if (!r) return reply.code(409).send({ error: 'Already tracking this wallet' });
    return r;
  });

  app.patch<{ Params: { id: string } }>('/api/tracker/wallets/:id', auth, async (req, reply) => {
    const p = zTrackedWalletUpdate.safeParse(req.body);
    if (!zUuid.safeParse(req.params.id).success || !p.success) return bad(reply);
    const [r] = await ctx.db
      .update(trackedWallets)
      .set(p.data)
      .where(and(eq(trackedWallets.id, req.params.id), eq(trackedWallets.userId, uid(req))))
      .returning();
    return r ?? reply.code(404).send({ error: 'Not found' });
  });

  app.put<{ Params: { id: string } }>('/api/tracker/wallets/:id/copy', auth, async (req, reply) => {
    const p = zCopyConfig.nullable().safeParse(req.body);
    if (!zUuid.safeParse(req.params.id).success || !p.success)
      return bad(reply, 'Invalid copy config', p.error?.issues.slice(0, 3));
    const [r] = await ctx.db
      .update(trackedWallets)
      .set({ copy: p.data })
      .where(and(eq(trackedWallets.id, req.params.id), eq(trackedWallets.userId, uid(req))))
      .returning();
    return r ?? reply.code(404).send({ error: 'Not found' });
  });

  app.delete<{ Params: { id: string } }>('/api/tracker/wallets/:id', auth, async (req, reply) => {
    if (!zUuid.safeParse(req.params.id).success) return bad(reply);
    await ctx.db
      .delete(trackedWallets)
      .where(and(eq(trackedWallets.id, req.params.id), eq(trackedWallets.userId, uid(req))));
    return { ok: true };
  });

  app.get<{ Querystring: { walletId?: string; kind?: string; limit?: string } }>(
    '/api/tracker/events',
    auth,
    async (req, reply) => {
      const mine = await ctx.db
        .select()
        .from(trackedWallets)
        .where(eq(trackedWallets.userId, uid(req)));
      const scope = req.query.walletId ? mine.filter((w) => w.id === req.query.walletId) : mine;
      if (scope.length === 0) return [];
      const kinds = req.query.kind
        ? req.query.kind
            .split(',')
            .filter((k) => ['buy', 'sell', 'transfer_in', 'transfer_out', 'other'].includes(k))
        : null;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      if (kinds && kinds.length === 0) return bad(reply);
      const rows = await ctx.db
        .select()
        .from(trackerEvents)
        .where(
          and(
            or(
              ...scope.map((w) =>
                and(eq(trackerEvents.network, w.network), eq(trackerEvents.wallet, w.address)),
              ),
            ),
            kinds ? inArray(trackerEvents.kind, kinds) : undefined,
          ),
        )
        .orderBy(desc(trackerEvents.at))
        .limit(limit);
      const byKey = new Map(scope.map((w) => [`${w.network}:${w.address}`, w]));
      return rows.map((e) => {
        const w = byKey.get(`${e.network}:${e.wallet}`)!;
        return {
          ...e,
          at: e.at.getTime(),
          walletId: w.id,
          walletLabel: w.label,
          walletColor: w.color,
          explorerUrl: NETWORKS[e.network as NetworkId].explorer.tx(e.hash),
        };
      });
    },
  );

  // Extra EVM wallets (multi-wallet mints / snipes). Public addresses only; replaces the whole list.
  const zExtra = z.object({
    evm: z.array(z.object({ address: z.string(), label: z.string().trim().max(24) })).max(20),
  });
  app.put('/api/trading-wallets/extra', auth, async (req, reply) => {
    const p = zExtra.safeParse(req.body);
    if (!p.success) return bad(reply);
    const addrs = p.data.evm.map((w) => ({ ...w, address: w.address.toLowerCase() }));
    if (addrs.some((w) => !isEvmAddress(w.address))) return bad(reply, 'Invalid EVM address');
    if (new Set(addrs.map((w) => w.address)).size !== addrs.length) return bad(reply, 'Duplicate address');
    const mine = and(eq(tradingWallets.userId, uid(req)), eq(tradingWallets.kind, 'evm'));
    const [primary] = await ctx.db
      .select()
      .from(tradingWallets)
      .where(and(mine, eq(tradingWallets.role, 'primary')));
    if (!primary) return bad(reply, 'Register the primary trading wallet first');
    if (addrs.some((w) => w.address === primary.address)) return bad(reply, 'That is the primary wallet');
    await ctx.db.transaction(async (tx) => {
      await tx.delete(tradingWallets).where(and(mine, eq(tradingWallets.role, 'extra')));
      if (addrs.length)
        await tx.insert(tradingWallets).values(
          addrs.map((w) => ({
            userId: uid(req),
            kind: 'evm',
            address: w.address,
            role: 'extra',
            label: w.label || null,
          })),
        );
    });
    return ctx.db
      .select()
      .from(tradingWallets)
      .where(eq(tradingWallets.userId, uid(req)));
  });

  /* ---------------------------------- journal --------------------------------- */

  app.post(
    '/api/journal',
    { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const p = zJournalSubmit.safeParse(req.body);
      if (!p.success) return bad(reply, 'Invalid journal entry', p.error.issues.slice(0, 3));
      const d = p.data;
      const kind = NETWORKS[d.network].kind;
      const wallets = await ctx.db
        .select()
        .from(tradingWallets)
        .where(and(eq(tradingWallets.userId, uid(req)), eq(tradingWallets.kind, kind)));
      const want = d.wallet ? (kind === 'evm' ? d.wallet.toLowerCase() : d.wallet) : null;
      const tw = want ? wallets.find((w) => w.address === want) : wallets.find((w) => w.role === 'primary');
      if (!tw)
        return bad(
          reply,
          want ? 'Not one of your trading wallets' : 'No trading wallet registered for this network',
        );
      if (kind === 'evm' && !/^0x[0-9a-fA-F]{64}$/.test(d.hash)) return bad(reply, 'Invalid EVM tx hash');
      // Bound unreconciled entries per user so junk hashes cannot starve the shared reconciler.
      const inflight = await ctx.db.$count(
        journal,
        and(eq(journal.userId, uid(req)), inArray(journal.state, ['submitted', 'pending', 'unknown'])),
      );
      if (inflight >= ctx.cfg.JOURNAL_MAX_INFLIGHT_PER_USER)
        return reply.code(429).send({ error: 'Too many unconfirmed transactions; wait for reconciliation' });
      if (d.token) {
        try {
          normalizeAddress(d.network, d.token);
        } catch {
          return bad(reply, 'Invalid token');
        }
      }
      const [r] = await ctx.db
        .insert(journal)
        .values({
          userId: uid(req),
          idempotencyKey: d.idempotencyKey,
          network: d.network,
          hash: kind === 'evm' ? d.hash.toLowerCase() : d.hash,
          wallet: tw.address,
          kind: d.kind,
          source: d.source,
          side: d.side,
          token: d.token ? normalizeAddress(d.network, d.token) : null,
          quotedUsd: d.quotedUsd,
          state: 'submitted',
        })
        .onConflictDoNothing()
        .returning();
      if (!r) {
        const [existing] = await ctx.db
          .select()
          .from(journal)
          .where(and(eq(journal.userId, uid(req)), eq(journal.idempotencyKey, d.idempotencyKey)));
        return existing ?? reply.code(409).send({ error: 'Duplicate transaction' });
      }
      return r;
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/api/journal', auth, async (req) =>
    ctx.db
      .select()
      .from(journal)
      .where(eq(journal.userId, uid(req)))
      .orderBy(desc(journal.createdAt))
      .limit(Math.min(500, Number(req.query.limit) || 100)),
  );

  /* --------------------------------- portfolio -------------------------------- */

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/portfolio/pnl', auth, async (req, reply) => {
    const s = await loadSettings(ctx, uid(req));
    const from = req.query.from ? Number(req.query.from) : 0;
    const to = req.query.to ? Number(req.query.to) : Date.now();
    if (!Number.isFinite(from) || !Number.isFinite(to)) return bad(reply);
    const rows = await ctx.db
      .select()
      .from(journal)
      .where(and(eq(journal.userId, uid(req)), eq(journal.kind, 'swap'), eq(journal.state, 'confirmed')));
    // Fills before `from` still matter for cost basis, so compute over all history then filter.
    const fills: Fill[] = rows
      .filter((r) => r.token && r.side && r.tokenQty && r.blockTime)
      .map((r) => ({
        id: r.id,
        at: r.blockTime!.getTime(),
        network: r.network,
        token: r.token!,
        symbol: r.tokenSymbol ?? undefined,
        side: r.side as 'buy' | 'sell',
        qty: r.tokenQty!,
        usd: r.usdValue,
        feeUsd: r.feeUsd,
      }));
    const { positions, events } = computePositions(fills);
    const inRange = events.filter((e) => e.at >= from && e.at <= to);
    const days = [...dailyRealized(inRange, s.timeZone).values()].sort((a, b) => a.day.localeCompare(b.day));

    const open = [...positions.values()].filter((p) => p.qty > 0);
    const byNet = new Map<NetworkId, string[]>();
    for (const p of open)
      byNet.set(p.network as NetworkId, [...(byNet.get(p.network as NetworkId) ?? []), p.token]);
    const prices = new Map<string, number | null>();
    for (const [n, toks] of byNet) {
      const m = await ctx.market.prices(n, toks).catch(() => new Map<string, number | null>());
      for (const [k, v] of m) prices.set(`${n}:${k}`, v);
    }
    return {
      timeZone: s.timeZone,
      days,
      summary: summarize(days),
      positions: [...positions.values()].map((p) => {
        const px = prices.get(`${p.network}:${p.token.toLowerCase()}`) ?? null;
        return {
          ...p,
          priceUsd: px,
          valueUsd: px === null ? null : px * p.qty,
          unrealizedUsd: unrealizedUsd(p, px),
        };
      }),
      methodology:
        'Weighted-average cost per token from reconciled on-chain fills. USD values use the native-asset price at reconciliation time (third-party estimate). Fees shown separately. Transfers/deposits are not PnL.',
    };
  });

  app.get('/api/portfolio/balances', auth, async (req) => {
    const tws = await ctx.db
      .select()
      .from(tradingWallets)
      .where(eq(tradingWallets.userId, uid(req)));
    const out: Array<{
      network: NetworkId;
      address: string;
      native: number | null;
      nativeUsd: number | null;
      tokens: Array<{ token: string; symbol: string; amount: number; usd: number | null }>;
      error?: string;
    }> = [];
    const held = await ctx.db
      .selectDistinct({ network: journal.network, token: journal.token })
      .from(journal)
      .where(and(eq(journal.userId, uid(req)), eq(journal.state, 'confirmed')));
    for (const n of Object.values(NETWORKS)) {
      const tw = tws.find((t) => t.kind === n.kind);
      if (!tw) continue;
      try {
        let native: number;
        const tokens: Array<{ token: string; symbol: string; amount: number; usd: number | null }> = [];
        const toks = held.filter((h) => h.network === n.id && h.token).map((h) => h.token!);
        const px = toks.length
          ? await ctx.market.prices(n.id, toks).catch(() => new Map<string, number | null>())
          : new Map<string, number | null>();
        if (n.kind === 'evm') {
          const c = ctx.evm[n.id]!;
          native = Number(formatUnits(await c.getBalance({ address: tw.address as `0x${string}` }), 18));
          for (const t of toks.slice(0, 50)) {
            const [bal, dec, sym] = await Promise.all([
              c.readContract({
                address: t as `0x${string}`,
                abi: ERC20_META_ABI,
                functionName: 'balanceOf',
                args: [tw.address as `0x${string}`],
              }),
              c.readContract({ address: t as `0x${string}`, abi: ERC20_META_ABI, functionName: 'decimals' }),
              c
                .readContract({ address: t as `0x${string}`, abi: ERC20_META_ABI, functionName: 'symbol' })
                .catch(() => '?'),
            ]);
            const amount = Number(formatUnits(bal, Number(dec)));
            if (amount > 0)
              tokens.push({
                token: t,
                symbol: String(sym).slice(0, 16),
                amount,
                usd: px.get(t.toLowerCase()) != null ? px.get(t.toLowerCase())! * amount : null,
              });
          }
        } else {
          const r = await ctx.sol.call<{ value: number }>('getBalance', [
            tw.address,
            { commitment: 'confirmed' },
          ]);
          native = r.value / 1e9;
          const ta = await ctx.sol.call<{
            value: Array<{
              account: {
                data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } };
              };
            }>;
          }>('getTokenAccountsByOwner', [
            tw.address,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed', commitment: 'confirmed' },
          ]);
          for (const a of ta.value.slice(0, 100)) {
            const info = a.account.data.parsed.info;
            const amount = info.tokenAmount.uiAmount ?? 0;
            if (amount > 0)
              tokens.push({
                token: info.mint,
                symbol: '',
                amount,
                usd:
                  px.get(info.mint.toLowerCase()) != null ? px.get(info.mint.toLowerCase())! * amount : null,
              });
          }
        }
        const npx = await ctx.market.nativePriceUsd(n.id).catch(() => null);
        out.push({
          network: n.id,
          address: tw.address,
          native,
          nativeUsd: npx === null ? null : npx * native,
          tokens,
        });
      } catch {
        out.push({
          network: n.id,
          address: tw.address,
          native: null,
          nativeUsd: null,
          tokens: [],
          error: 'RPC unavailable',
        });
      }
    }
    return { data: out, fetchedAt: Date.now() };
  });

  /* -------------------------------- automations ------------------------------- */

  const schemas = { sniper: zSniperConfig, mint: zMintTask, perps: zPerpsTaskConfig } as const;
  type Kind = keyof typeof schemas;
  const kindOk = (k: string): k is Kind => k in schemas;

  app.get<{ Params: { kind: string } }>('/api/automations/:kind', auth, async (req, reply) => {
    if (!kindOk(req.params.kind)) return bad(reply);
    return ctx.db
      .select()
      .from(automations)
      .where(and(eq(automations.userId, uid(req)), eq(automations.kind, req.params.kind)))
      .orderBy(automations.createdAt);
  });

  app.post<{ Params: { kind: string } }>('/api/automations/:kind', auth, async (req, reply) => {
    if (!kindOk(req.params.kind)) return bad(reply);
    const p = schemas[req.params.kind].safeParse(req.body);
    if (!p.success) return bad(reply, 'Invalid configuration', p.error.issues.slice(0, 5));
    const count = await ctx.db.$count(
      automations,
      and(eq(automations.userId, uid(req)), eq(automations.kind, req.params.kind)),
    );
    if (count >= 25) return bad(reply, 'Limit reached (25)');
    const [r] = await ctx.db
      .insert(automations)
      .values({ userId: uid(req), kind: req.params.kind, data: p.data })
      .returning();
    return r;
  });

  app.put<{ Params: { kind: string; id: string } }>(
    '/api/automations/:kind/:id',
    auth,
    async (req, reply) => {
      if (!kindOk(req.params.kind) || !zUuid.safeParse(req.params.id).success) return bad(reply);
      const p = schemas[req.params.kind].safeParse(req.body);
      if (!p.success) return bad(reply, 'Invalid configuration', p.error.issues.slice(0, 5));
      const [r] = await ctx.db
        .update(automations)
        .set({ data: p.data, updatedAt: new Date() })
        .where(
          and(
            eq(automations.id, req.params.id),
            eq(automations.userId, uid(req)),
            eq(automations.kind, req.params.kind),
          ),
        )
        .returning();
      return r ?? reply.code(404).send({ error: 'Not found' });
    },
  );

  app.patch<{ Params: { kind: string; id: string } }>(
    '/api/automations/:kind/:id/status',
    auth,
    async (req, reply) => {
      const s = z
        .object({ status: z.enum(['idle', 'armed', 'running', 'paused', 'stopped', 'done', 'error']) })
        .safeParse(req.body);
      if (!kindOk(req.params.kind) || !zUuid.safeParse(req.params.id).success || !s.success)
        return bad(reply);
      const [r] = await ctx.db
        .update(automations)
        .set({ status: s.data.status, updatedAt: new Date() })
        .where(and(eq(automations.id, req.params.id), eq(automations.userId, uid(req))))
        .returning();
      return r ?? reply.code(404).send({ error: 'Not found' });
    },
  );

  app.delete<{ Params: { kind: string; id: string } }>(
    '/api/automations/:kind/:id',
    auth,
    async (req, reply) => {
      if (!zUuid.safeParse(req.params.id).success) return bad(reply);
      await ctx.db
        .delete(automations)
        .where(and(eq(automations.id, req.params.id), eq(automations.userId, uid(req))));
      return { ok: true };
    },
  );

  /** Emergency stop: disarms every automation of this user server-side. Clients also halt locally. */
  app.post('/api/automations/emergency-stop', auth, async (req) => {
    await ctx.db
      .update(automations)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(
        and(eq(automations.userId, uid(req)), inArray(automations.status, ['armed', 'running', 'paused'])),
      );
    const ws = await ctx.db
      .select()
      .from(trackedWallets)
      .where(eq(trackedWallets.userId, uid(req)));
    for (const w of ws) {
      const c = w.copy as { enabled?: boolean } | null;
      if (c?.enabled)
        await ctx.db
          .update(trackedWallets)
          .set({ copy: { ...c, enabled: false } })
          .where(eq(trackedWallets.id, w.id));
    }
    await ctx.db
      .insert(automationLogs)
      .values({ userId: uid(req), kind: 'system', level: 'warn', message: 'Emergency stop activated' });
    return { ok: true };
  });

  const zLog = z.object({
    automationId: z.uuid().nullable(),
    kind: z.enum(['sniper', 'mint', 'perps', 'copy', 'system', 'trade']),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string().min(1).max(500),
  });
  app.post(
    '/api/automation-logs',
    { ...auth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const p = zLog.safeParse(req.body);
      if (!p.success) return bad(reply);
      await ctx.db.insert(automationLogs).values({ userId: uid(req), ...p.data });
      return { ok: true };
    },
  );

  app.get<{ Querystring: { kind?: string; since?: string } }>('/api/automation-logs', auth, async (req) => {
    const since = Number(req.query.since) || 0;
    return ctx.db
      .select()
      .from(automationLogs)
      .where(
        and(
          eq(automationLogs.userId, uid(req)),
          req.query.kind ? eq(automationLogs.kind, req.query.kind) : undefined,
          since ? gte(automationLogs.at, new Date(since)) : undefined,
          lte(automationLogs.at, new Date()),
        ),
      )
      .orderBy(desc(automationLogs.at))
      .limit(200);
  });
}
