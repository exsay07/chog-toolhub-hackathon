import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PerpsTaskConfig } from '@chog/shared';
import { AgentServer } from '../src/server.js';
import { sanitizeLog, TaskManager, type FarmingAdapter, type TaskContext } from '../src/tasks.js';
import { defaultAdapters } from '../src/adapters/index.js';

const ORIGIN = 'http://localhost:5173';

/** TEST-ONLY adapter: records lifecycle calls, places no orders. Never registered in the real agent. */
class RecordingAdapter implements FarmingAdapter {
  readonly name = 'Recording (test)';
  calls: string[] = [];
  dirs: string[] = [];
  constructor(readonly id: string) {}
  unavailableReason() {
    return null;
  }
  supportedOrderTypes() {
    return { entry: ['market' as const, 'limit' as const], exit: ['market' as const] };
  }
  async start(ctx: TaskContext) {
    this.calls.push(`start:${ctx.taskId}`);
    this.dirs.push(ctx.dataDir);
    ctx.log('info', `cfg ${ctx.config.pair} privateKey=0x${'a'.repeat(64)}`);
  }
  async pause(id: string) {
    this.calls.push(`pause:${id}`);
  }
  async resume(id: string) {
    this.calls.push(`resume:${id}`);
  }
  async stop(id: string) {
    this.calls.push(`stop:${id}`);
  }
}

const cfg = (platform: 'perpl' | 'bulk', over: Partial<PerpsTaskConfig> = {}): PerpsTaskConfig => ({
  platform,
  pair: 'BTC-USD',
  direction: 'long',
  sizeUsd: 100,
  leverage: 2,
  entry: 'market',
  exit: 'market',
  limitOffsetBps: 0,
  holdSec: 60,
  intervalSec: 60,
  risk: {
    maxNotionalUsd: 1000,
    maxLeverage: 5,
    maxOpenPositions: 1,
    maxConcurrentOrders: 2,
    maxDailyLossUsd: 50,
    maxRuntimeMin: 60,
  },
  ...over,
});

function call(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any }>((res, rej) => {
    const data = JSON.stringify(body);
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'content-length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (resp) => {
        let s = '';
        resp.on('data', (d) => (s += d));
        resp.on('end', () => res({ status: resp.statusCode!, json: s ? JSON.parse(s) : null }));
      },
    );
    r.on('error', rej);
    r.end(data);
  });
}

let agent: AgentServer;
let port: number;
let code: string;
let rec: RecordingAdapter;

beforeEach(async () => {
  rec = new RecordingAdapter('perpl');
  const adapters = new Map<string, FarmingAdapter>([
    ['perpl', rec],
    ['bulk', defaultAdapters().get('bulk')!],
  ]);
  const tm = new TaskManager(adapters, mkdtempSync(join(tmpdir(), 'chog-agent-')));
  agent = new AgentServer({
    port: 0,
    allowedOrigins: [ORIGIN],
    tasks: tm,
    mode: 'persistent',
    onPairingCode: (c) => (code = c),
  });
  port = await agent.listen();
  agent.newPairingCode();
});
afterEach(async () => agent.close());

async function pair() {
  const r = await call(port, '/v1/pair', { code });
  expect(r.status).toBe(200);
  return r.json.token as string;
}

describe('local agent security', () => {
  it('rejects foreign origins and DNS-rebinding Host headers', async () => {
    expect((await call(port, '/v1/hello', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(port, '/v1/hello', {}, { host: 'evil.example:47321' })).status).toBe(421);
    expect((await call(port, '/v1/hello', {})).status).toBe(200);
  });

  it('requires pairing for commands; pairing code is single-use', async () => {
    expect((await call(port, '/v1/cmd', { type: 'status' })).status).toBe(401);
    const token = await pair();
    expect((await call(port, '/v1/pair', { code })).status).toBe(401);
    expect((await call(port, '/v1/cmd', { type: 'status' }, { 'x-agent-token': token })).status).toBe(200);
    expect(
      (await call(port, '/v1/cmd', { type: 'status' }, { 'x-agent-token': 'x'.repeat(43) })).status,
    ).toBe(401);
  });

  it('burns the pairing code after 5 wrong attempts (brute-force guard)', async () => {
    for (let i = 0; i < 5; i++) expect((await call(port, '/v1/pair', { code: 'AAAAAAAA' })).status).toBe(401);
    expect((await call(port, '/v1/pair', { code })).status).toBe(429);
  });

  it('accepts only schema-valid commands — no shell/exec surface', async () => {
    const token = await pair();
    const h = { 'x-agent-token': token };
    for (const bad of [
      { type: 'exec', cmd: 'calc.exe' },
      { type: 'startTask', taskId: '../../etc', config: cfg('perpl') },
      { type: 'logs', taskId: 'a;rm -rf /' },
    ]) {
      expect((await call(port, '/v1/cmd', bad, h)).status).toBe(400);
    }
  });

  it('runs task lifecycle start → pause → resume → stop and redacts secrets from logs', async () => {
    const token = await pair();
    const h = { 'x-agent-token': token };
    expect(
      (await call(port, '/v1/cmd', { type: 'startTask', taskId: 'task-0001', config: cfg('perpl') }, h)).json
        .state,
    ).toBe('running');
    expect((await call(port, '/v1/cmd', { type: 'pauseTask', taskId: 'task-0001' }, h)).status).toBe(200);
    expect((await call(port, '/v1/cmd', { type: 'resumeTask', taskId: 'task-0001' }, h)).status).toBe(200);
    expect((await call(port, '/v1/cmd', { type: 'stopTask', taskId: 'task-0001' }, h)).status).toBe(200);
    expect(rec.calls).toEqual(['start:task-0001', 'pause:task-0001', 'resume:task-0001', 'stop:task-0001']);
    const logs = (await call(port, '/v1/cmd', { type: 'logs', taskId: 'task-0001' }, h)).json as Array<{
      msg: string;
    }>;
    expect(logs.some((l) => l.msg.includes('[redacted]'))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('a'.repeat(64));
  });

  it('refuses unsupported order combos, risk-limit violations and unavailable platforms', async () => {
    const token = await pair();
    const h = { 'x-agent-token': token };
    expect(
      (
        await call(
          port,
          '/v1/cmd',
          {
            type: 'startTask',
            taskId: 'task-0002',
            config: cfg('perpl', { exit: 'limit', limitOffsetBps: 5 }),
          },
          h,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          port,
          '/v1/cmd',
          { type: 'startTask', taskId: 'task-0003', config: cfg('perpl', { leverage: 10 }) },
          h,
        )
      ).status,
    ).toBe(409);
    const b = await call(port, '/v1/cmd', { type: 'startTask', taskId: 'task-0004', config: cfg('bulk') }, h);
    expect(b.status).toBe(409);
    expect(b.json.error).toMatch(/not installed/);
  });

  it('isolates concurrent tasks (separate dirs, separate logs) and stopAll stops everything', async () => {
    const token = await pair();
    const h = { 'x-agent-token': token };
    await call(port, '/v1/cmd', { type: 'startTask', taskId: 'task-a001', config: cfg('perpl') }, h);
    await call(
      port,
      '/v1/cmd',
      { type: 'startTask', taskId: 'task-b001', config: cfg('perpl', { pair: 'ETH-USD' }) },
      h,
    );
    expect(new Set(rec.dirs).size).toBe(2);
    const la = (await call(port, '/v1/cmd', { type: 'logs', taskId: 'task-a001' }, h)).json as Array<{
      msg: string;
    }>;
    expect(la.every((l) => !l.msg.includes('ETH-USD'))).toBe(true);
    await call(port, '/v1/cmd', { type: 'stopAll' }, h);
    const st = (await call(port, '/v1/cmd', { type: 'status' }, h)).json.tasks as Array<{ state: string }>;
    expect(st.every((t) => t.state === 'stopped')).toBe(true);
  });

  it('answers CORS preflight with Private-Network opt-in only for the allowed origin', async () => {
    const res = await new Promise<{ status: number; h: Record<string, unknown> }>((resolve) => {
      const r = request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/cmd',
          method: 'OPTIONS',
          headers: { origin: ORIGIN, 'access-control-request-private-network': 'true' },
        },
        (resp) => resolve({ status: resp.statusCode!, h: resp.headers }),
      );
      r.end();
    });
    expect(res.status).toBe(204);
    expect(res.h['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.h['access-control-allow-private-network']).toBe('true');
  });
});

describe('log sanitizer', () => {
  it('redacts keys and seed-like strings', () => {
    expect(sanitizeLog(`key 0x${'1'.repeat(64)}`)).not.toContain('1'.repeat(64));
    expect(sanitizeLog('mnemonic: apple banana')).toContain('[redacted]');
  });
});
