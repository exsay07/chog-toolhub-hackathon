import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { z } from 'zod';
import { isPerplNet, PERPL_NETWORKS, type PerplNet } from '@chog/shared';
import type { AppContext } from '../context.js';
import { requireAuth, resolveSession } from '../auth/guard.js';
import { SESSION_COOKIE } from '../auth/sessions.js';
import { TtlCache } from '../lib/cache.js';

/**
 * Perpl relay. Perpl refuses browser connections from non-whitelisted origins (WebSocket upgrade →
 * 403, no CORS on REST), so the browser bot talks to Perpl through these routes. The relay never
 * holds keys: every frame that matters is signed in the browser with the user's API key (Ed25519),
 * and the relay only forwards it. It is locked to the signed-in holder's own wallet:
 *  - enrollment payloads are only built for the session's address;
 *  - a trading socket is closed unless Perpl's wallet snapshot names the session's address;
 *  - only the message types the farmer needs are forwarded upstream.
 */

const zEnrollPayload = z.object({
  chain_id: z.number().int(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  public_key: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  scope_mask: z.literal(3),
  label: z.string().min(1).max(64),
});
const zEnroll = z.object({
  chain_id: z.number().int(),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  typed_data: z.record(z.string(), z.unknown()),
  mac: z.string().max(200),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  pop_signature: z.string().regex(/^0x[0-9a-fA-F]{128}$/),
});

/** Client → Perpl frames allowed per socket kind (Ping, Subscribe, OrderRequest, ApiKeySignIn). */
const ALLOWED: Record<'trading' | 'market-data', Set<number>> = {
  trading: new Set([1, 22, 29]),
  'market-data': new Set([1, 5]),
};
const MAX_SOCKETS_PER_USER = 6;

export async function perplRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };
  const contexts = new TtlCache(10);
  const open = new Map<string, number>();

  const upstream = async (net: PerplNet, path: string, body?: unknown) => {
    const res = await fetch(PERPL_NETWORKS[net].api + path, {
      method: body ? 'POST' : 'GET',
      // No Origin: Perpl records the enrolling origin, and an empty one is what non-browser clients send.
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text.slice(0, 200) };
    }
    return { status: res.status, json };
  };

  app.get<{ Params: { net: string } }>('/api/perpl/:net/context', auth, async (req, reply) => {
    const net = req.params.net;
    if (!isPerplNet(net)) return reply.code(400).send({ error: 'Unknown network' });
    try {
      const c = await contexts.get(net, 30_000, async () => {
        const r = await upstream(net, '/v1/pub/context');
        if (r.status !== 200) throw new Error('perpl context ' + r.status);
        return r.json;
      });
      return c.value;
    } catch {
      return reply.code(502).send({ error: 'Perpl is unavailable' });
    }
  });

  app.post<{ Params: { net: string; step: string } }>(
    '/api/perpl/:net/enroll/:step',
    { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const net = req.params.net;
      if (!isPerplNet(net)) return reply.code(400).send({ error: 'Unknown network' });
      const step = req.params.step;
      const parsed = step === 'payload' ? zEnrollPayload.safeParse(req.body) : zEnroll.safeParse(req.body);
      if (!parsed.success || (step !== 'payload' && step !== 'key'))
        return reply.code(400).send({ error: 'Invalid enrollment request' });
      const b = parsed.data;
      if (b.chain_id !== PERPL_NETWORKS[net].chainId) return reply.code(400).send({ error: 'Wrong chain' });
      if (b.address.toLowerCase() !== req.user!.address.toLowerCase())
        return reply.code(403).send({ error: 'Keys can only be created for your own wallet' });
      const r = await upstream(net, step === 'payload' ? '/v1/api-key/payload' : '/v1/api-key/enroll', b);
      return reply.code(r.status).send(r.json);
    },
  );

  app.get<{ Params: { net: string; kind: string } }>(
    '/api/perpl/:net/ws/:kind',
    { websocket: true },
    (socket, req) => {
      void (async () => {
        const origin = req.headers.origin;
        if (!origin || !ctx.cfg.allowedOrigins.has(origin)) return socket.close(4003, 'origin');
        const { net, kind } = req.params;
        if (!isPerplNet(net) || (kind !== 'trading' && kind !== 'market-data'))
          return socket.close(4004, 'route');
        const r = await resolveSession(ctx, req.cookies[SESSION_COOKIE]);
        if (!r.ok) return socket.close(4001, r.code);
        const uid = r.user.id;
        if ((open.get(uid) ?? 0) >= MAX_SOCKETS_PER_USER) return socket.close(4029, 'too many sockets');
        open.set(uid, (open.get(uid) ?? 0) + 1);

        const allowed = ALLOWED[kind];
        const me = r.user.address.toLowerCase();
        let verified = kind === 'market-data';
        const queued: string[] = [];
        const up = new WebSocket(`${PERPL_NETWORKS[net].ws}/ws/v1/${kind}`, { handshakeTimeout: 10_000 });

        const closeBoth = (code: number, reason: string) => {
          const c = code >= 4000 && code < 5000 ? code : code === 1000 ? 1000 : 4000 + (code % 1000);
          if (socket.readyState === socket.OPEN) socket.close(c, reason.slice(0, 120));
          if (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING) up.terminate();
        };

        up.on('open', () => {
          for (const m of queued.splice(0)) up.send(m);
        });
        up.on('message', (data) => {
          const text = data.toString();
          if (!verified) {
            // The first wallet snapshot proves which wallet this API key belongs to.
            try {
              const m = JSON.parse(text) as { mt?: number; addr?: string };
              if (m.mt === 19) {
                if ((m.addr ?? '').toLowerCase() !== me)
                  return closeBoth(4403, 'API key belongs to another wallet');
                verified = true;
              } else if (m.mt !== 3) return;
            } catch {
              return;
            }
          }
          if (socket.readyState === socket.OPEN && socket.bufferedAmount < 2_000_000) socket.send(text);
        });
        up.on('close', (code, reason) => closeBoth(code, reason.toString() || 'upstream closed'));
        up.on('unexpected-response', (_q, res) => closeBoth(4502, `perpl ${res.statusCode}`));
        up.on('error', () => closeBoth(4502, 'perpl unreachable'));

        let window = Date.now();
        let count = 0;
        socket.on('message', (raw: Buffer) => {
          const now = Date.now();
          if (now - window > 60_000) {
            window = now;
            count = 0;
          }
          if (++count > 240) return closeBoth(4029, 'relay rate limit');
          let mt: unknown;
          const text = raw.toString();
          try {
            mt = (JSON.parse(text) as { mt?: unknown }).mt;
          } catch {
            return;
          }
          if (typeof mt !== 'number' || !allowed.has(mt)) return;
          if (kind === 'trading' && mt !== 29 && !verified) return;
          if (up.readyState === WebSocket.OPEN) up.send(text);
          else if (up.readyState === WebSocket.CONNECTING && queued.length < 4) queued.push(text);
        });
        socket.on('close', () => {
          open.set(uid, Math.max(0, (open.get(uid) ?? 1) - 1));
          if (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING) up.close(1000);
        });
      })().catch(() => socket.close(1011, 'error'));
    },
  );
}
