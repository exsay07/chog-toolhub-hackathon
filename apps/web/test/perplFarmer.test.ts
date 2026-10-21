import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PerpsTaskConfig } from '@chog/shared';

/**
 * The Perpl farmer against a simulated exchange speaking the documented wire protocol
 * (sign-in → wallet/orders/positions snapshots → mt 22 orders → mt 24/25/27 updates).
 */

type Msg = Record<string, unknown>;
const sockets: FakeWS[] = [];
class FakeWS {
  static OPEN = 1;
  readyState = 0;
  sent: Msg[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  constructor(readonly url: string) {
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(s: string) {
    const m = JSON.parse(s) as Msg;
    this.sent.push(m);
    exchange.onFrame(this, m);
  }
  push(m: Msg) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const MKT = 31; // SOL: price 3 decimals, size 3 decimals
const ACC = 7;
let exchange: Exchange;

class Exchange {
  fill = true;
  bid = 100_000; // $100.000
  ask = 100_050;
  pos: { sd: number; s: number; ep: number } | null = null;
  oid = 100;
  orders: Msg[] = [];
  trading: FakeWS | null = null;
  md: FakeWS | null = null;
  sn = 1;

  onFrame(ws: FakeWS, m: Msg) {
    if (ws.url.endsWith('market-data')) {
      this.md = ws;
      this.quote();
      return;
    }
    this.trading = ws;
    if (m.mt === 29) {
      ws.push({
        mt: 19,
        sn: this.sn,
        as: [{ id: ACC, fw: true, fr: false, lfr: 5, b: '1000000000', lb: '0' }],
      });
      ws.push({ mt: 23, d: [] });
      ws.push({ mt: 26, d: [] });
      return;
    }
    if (m.mt !== 22) return;
    expect(m.acc).toBe(ACC);
    expect(m.mkt).toBe(MKT);
    expect(m.sn).toBeGreaterThan(0);
    this.orders.push(m);
    ws.push({ mt: 3, cid: m.sn, status: { code: 0 } });
    const t = m.t as number;
    if (t === 5) {
      ws.push({ mt: 24, d: [{ rq: m.rq, mkt: MKT, acc: ACC, oid: m.oid, st: 5, r: true }] });
      return;
    }
    const oid = ++this.oid;
    ws.push({ mt: 24, d: [{ rq: m.rq, mkt: MKT, acc: ACC, oid, st: 2 }] });
    const ioc = m.fl === 4;
    if (!this.fill && !ioc) return;
    const price = ioc ? (t === 1 || t === 4 ? this.ask : this.bid) : (m.p as number);
    ws.push({ mt: 25, d: [{ mkt: MKT, acc: ACC, oid, t, l: ioc ? 2 : 1, p: price, s: m.s, f: '1000' }] });
    if (t === 1 || t === 2) this.pos = { sd: t, s: m.s as number, ep: price };
    else this.pos = null;
    ws.push({
      mt: 27,
      d: [
        {
          mkt: MKT,
          acc: ACC,
          pid: 1,
          st: this.pos ? 1 : 2,
          sd: this.pos?.sd ?? 1,
          s: this.pos?.s ?? 0,
          ep: price,
          lv: 500,
        },
      ],
    });
    ws.push({ mt: 24, d: [{ rq: m.rq, mkt: MKT, acc: ACC, oid, st: 4, r: true }] });
  }
  quote() {
    this.md?.push({ mt: 9, d: { [MKT]: { bid: this.bid, ask: this.ask, mid: (this.bid + this.ask) / 2 } } });
  }
}

const cfg: PerpsTaskConfig = {
  platform: 'perpl',
  pair: 'SOL-USD',
  direction: 'alternate',
  sizeUsd: 50,
  leverage: 5,
  entry: 'limit',
  exit: 'limit',
  limitOffsetBps: 5,
  holdSec: 5,
  intervalSec: 10,
  risk: {
    maxNotionalUsd: 500,
    maxLeverage: 10,
    maxOpenPositions: 1,
    maxConcurrentOrders: 2,
    maxDailyLossUsd: 25,
    maxRuntimeMin: 240,
  },
};
const market = {
  id: MKT,
  symbol: 'SOL',
  config: {
    is_open: true,
    price_decimals: 3,
    size_decimals: 3,
    initial_margin: 1200,
    maker_fee: 45,
    taker_fee: 345,
  },
  order_ttl_blocks: 20,
};

async function farmer(c: PerpsTaskConfig = cfg) {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const { PerplFarmer } = await import('../src/lib/perps/perplFarmer');
  const key = {
    net: 'mainnet' as const,
    address: '0x0000000000000000000000000000000000000001',
    apiKey: 'test-key-token',
    privateKey: kp.privateKey,
    publicKeyHex: '',
    source: 'pasted' as const,
    createdAt: 0,
  };
  return new PerplFarmer('bot1', key, market, c);
}

/** Lets microtasks (WebCrypto sign-in) settle while fake timers advance. */
/**
 * Waits for the farmer to be signed in. The sign-in signature is real WebCrypto, which completes on
 * real time, not on the fake clock — so this waits on real I/O (no fake time passes) until it lands.
 */
async function signedIn() {
  // setImmediate and performance.now are not faked: up to 10 s of real time for the signature.
  const t0 = performance.now();
  while (
    !sockets.some((s) => s.url.endsWith('/trading') && s.sent.length) &&
    performance.now() - t0 < 10_000
  ) {
    await vi.advanceTimersByTimeAsync(0); // let the fake-clock socket open fire
    await new Promise((r) => setImmediate(r));
  }
  await run(400); // snapshots + first quote
}

async function run(ms: number) {
  for (let t = 0; t < ms; t += 200) {
    // Real WebCrypto (sign-in) completes off the fake clock: yield to I/O on every step.
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(200);
    exchange.quote();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
  sockets.length = 0;
  exchange = new Exchange();
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Perpl farmer', () => {
  it('signs in first, then runs maker cycles that alternate long and short', async () => {
    const f = await farmer();
    f.start();
    await signedIn();
    const tr = sockets.find((s) => s.url.endsWith('/api/perpl/mainnet/ws/trading'))!;
    expect(tr.sent[0]).toMatchObject({ mt: 29, chain_id: 143, api_key: 'test-key-token' });
    await run(35_000);
    const s = f.state;
    expect(s.cycles).toBeGreaterThanOrEqual(2);
    const opens = exchange.orders.filter((o) => o.t === 1 || o.t === 2).map((o) => o.t);
    expect(opens.slice(0, 2)).toEqual([1, 2]); // long, then short
    // Maker legs: post-only at the touch; leverage x100; rq strictly above lfr and increasing.
    const first = exchange.orders[0]!;
    expect(first).toMatchObject({ fl: 1, p: 100_000, lv: 500, lb: 0 });
    const rqs = exchange.orders.map((o) => o.rq as number);
    expect(rqs[0]).toBeGreaterThan(5);
    expect(rqs.every((r, i) => i === 0 || r > rqs[i - 1]!)).toBe(true);
    // $50 at $100.025 mid → 0.499 SOL each leg.
    expect(first.s).toBe(499);
    expect(s.volumeUsd).toBeGreaterThan(150);
    expect(s.makerVolumeUsd).toBe(s.volumeUsd);
    f.stop();
    await run(2000);
    expect(f.state.state).toBe('stopped');
  });

  it('re-quotes a resting order when the market moves away', async () => {
    exchange.fill = false;
    const f = await farmer({ ...cfg, direction: 'long' });
    f.start();
    await signedIn();
    await run(1600);
    expect(exchange.orders.filter((o) => o.t === 1)).toHaveLength(1);
    exchange.bid = 100_500; // +50 bps
    exchange.ask = 100_550;
    // Under a loaded test run the sign-in/crypto can lag the fake clock: give it up to 10 s.
    for (let i = 0; i < 25 && !exchange.orders.some((o) => o.t === 1 && o.p === 100_500); i++) await run(400);
    expect(exchange.orders.some((o) => o.t === 5)).toBe(true);
    const longs = exchange.orders.filter((o) => o.t === 1);
    expect(longs.length).toBeGreaterThanOrEqual(2);
    expect(longs.at(-1)!.p).toBe(100_500);
    f.stop();
    await run(25_000);
    expect(f.state.state).toBe('stopped');
  });

  it('stop closes an open position at market (IOC)', async () => {
    const f = await farmer({ ...cfg, direction: 'short', holdSec: 600 });
    f.start();
    await signedIn();
    await run(2600);
    expect(f.state.state).toBe('holding');
    expect(exchange.pos?.sd).toBe(2);
    f.stop();
    await run(2000);
    const last = exchange.orders.at(-1)!;
    expect(last).toMatchObject({ t: 4, fl: 4 });
    expect(exchange.pos).toBeNull();
    expect(f.state.state).toBe('stopped');
  });

  it('waits for One-Click Trading when the account has it off', async () => {
    const f = await farmer();
    const orig = exchange.onFrame.bind(exchange);
    exchange.onFrame = (ws, m) => {
      if (m.mt === 29) {
        ws.push({ mt: 19, sn: 1, as: [{ id: ACC, fw: false, fr: false, lfr: 0, b: '1000000000', lb: '0' }] });
        ws.push({ mt: 23, d: [] });
        ws.push({ mt: 26, d: [] });
        return;
      }
      orig(ws, m);
    };
    f.start();
    await signedIn();
    await run(2600);
    expect(f.state.state).toBe('needs-forwarding');
    expect(exchange.orders).toHaveLength(0);
    f.stop();
  });
});
