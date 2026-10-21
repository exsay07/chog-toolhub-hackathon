import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { zAgentCommand } from '@chog/shared';
import { z } from 'zod';
import { sanitizeLog, type TaskManager } from './tasks.js';

export const AGENT_VERSION = '0.1.0';
const PAIR_TTL_MS = 5 * 60_000;
const TOKEN_TTL_MS = 12 * 3600_000;
const MAX_BODY = 16 * 1024;

export interface AgentOptions {
  port: number;
  allowedOrigins: string[];
  tasks: TaskManager;
  /** 'attended': pause all tasks if the web app stops sending heartbeats. 'persistent': keep running. */
  mode: 'attended' | 'persistent';
  heartbeatTimeoutMs?: number;
  onPairingCode?: (code: string) => void;
}

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Loopback-only control plane. There is intentionally NO endpoint that executes arbitrary commands:
 * the only accepted operations are the typed commands in zAgentCommand.
 */
export class AgentServer {
  private server: Server;
  private pairing: { codeHash: Buffer; expiresAt: number; attempts: number } | null = null;
  private tokens = new Map<string, { origin: string; expiresAt: number }>(); // key = hex sha256(token)
  private lastHeartbeat = Date.now();
  private hbTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: AgentOptions) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  listen(): Promise<number> {
    return new Promise((res, rej) => {
      this.server.once('error', rej);
      // Bind to loopback only — never 0.0.0.0.
      this.server.listen(this.o.port, '127.0.0.1', () => {
        const addr = this.server.address();
        if (this.o.mode === 'attended') {
          this.hbTimer = setInterval(() => {
            if (Date.now() - this.lastHeartbeat > (this.o.heartbeatTimeoutMs ?? 60_000))
              void this.o.tasks.pauseAll('web app disconnected (attended mode)');
          }, 5000);
          this.hbTimer.unref();
        }
        res(typeof addr === 'object' && addr ? addr.port : this.o.port);
      });
    });
  }

  async close() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    await this.o.tasks.stopAll();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Generates a new one-time pairing code, displayed only in the local terminal / tray. */
  newPairingCode(): string {
    const code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
    this.pairing = { codeHash: sha(code), expiresAt: Date.now() + PAIR_TTL_MS, attempts: 0 };
    this.o.onPairingCode?.(code);
    return code;
  }

  private cors(req: IncomingMessage, res: ServerResponse): string | null {
    const origin = req.headers.origin;
    if (!origin || !this.o.allowedOrigins.includes(origin)) return null;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-agent-token');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    // Chrome Private Network Access: public site → loopback requires explicit opt-in.
    if (req.headers['access-control-request-private-network'] === 'true')
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return origin;
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error('Body too large');
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    // DNS-rebinding defence: Host must be the loopback literal we bound to.
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return this.json(res, 421, { error: 'Bad host' });
    const origin = this.cors(req, res);
    if (!origin) return this.json(res, 403, { error: 'Origin not allowed' });
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== 'POST') return this.json(res, 405, { error: 'Method not allowed' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json'))
      return this.json(res, 415, { error: 'JSON only' });

    let body: unknown;
    try {
      body = await this.body(req);
    } catch {
      return this.json(res, 400, { error: 'Invalid body' });
    }

    const path = (req.url ?? '').split('?')[0];
    if (path === '/v1/hello')
      return this.json(res, 200, {
        agent: 'chog-agent',
        version: AGENT_VERSION,
        mode: this.o.mode,
        paired: false,
      });
    if (path === '/v1/pair') return this.pair(res, origin, body);

    const token = req.headers['x-agent-token'];
    const auth = typeof token === 'string' ? this.tokens.get(sha(token).toString('hex')) : undefined;
    if (!auth || auth.expiresAt < Date.now() || auth.origin !== origin)
      return this.json(res, 401, { error: 'Not paired' });

    if (path === '/v1/heartbeat') {
      this.lastHeartbeat = Date.now();
      return this.json(res, 200, { ok: true });
    }
    if (path === '/v1/unpair') {
      this.tokens.delete(sha(token as string).toString('hex'));
      return this.json(res, 200, { ok: true });
    }
    if (path !== '/v1/cmd') return this.json(res, 404, { error: 'Not found' });

    const cmd = zAgentCommand.safeParse(body);
    if (!cmd.success) return this.json(res, 400, { error: 'Invalid command' });
    this.lastHeartbeat = Date.now();
    const t = this.o.tasks;
    try {
      const c = cmd.data;
      switch (c.type) {
        case 'status':
          return this.json(res, 200, { version: AGENT_VERSION, mode: this.o.mode, tasks: t.status() });
        case 'listAdapters':
          return this.json(res, 200, t.listAdapters());
        case 'startTask':
          return this.json(res, 200, { state: await t.start(c.taskId, c.config) });
        case 'pauseTask':
          await t.pause(c.taskId);
          return this.json(res, 200, { ok: true });
        case 'resumeTask':
          await t.resume(c.taskId);
          return this.json(res, 200, { ok: true });
        case 'stopTask':
          await t.stop(c.taskId);
          return this.json(res, 200, { ok: true });
        case 'stopAll':
          await t.stopAll();
          return this.json(res, 200, { ok: true });
        case 'logs':
          return this.json(res, 200, t.logs(c.taskId, c.since));
      }
    } catch (e) {
      return this.json(res, 409, { error: sanitizeLog(e instanceof Error ? e.message : String(e)) });
    }
  }

  private pair(res: ServerResponse, origin: string, body: unknown) {
    const p = z.object({ code: z.string().regex(/^[A-Z2-9]{8}$/) }).safeParse(body);
    const pr = this.pairing;
    if (!p.success || !pr || pr.expiresAt < Date.now())
      return this.json(res, 401, { error: 'No valid pairing code — restart pairing in the agent' });
    pr.attempts++;
    if (pr.attempts > 5) {
      this.pairing = null; // brute-force guard: code burned
      return this.json(res, 429, { error: 'Too many attempts — generate a new code' });
    }
    if (!timingSafeEqual(sha(p.data.code), pr.codeHash)) return this.json(res, 401, { error: 'Wrong code' });
    this.pairing = null; // one-time
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(sha(token).toString('hex'), { origin, expiresAt: Date.now() + TOKEN_TTL_MS });
    this.lastHeartbeat = Date.now();
    return this.json(res, 200, {
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      version: AGENT_VERSION,
      mode: this.o.mode,
    });
  }
}
