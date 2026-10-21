import type { PerpsTaskConfig } from '@chog/shared';
import { marketMaxLeverage, relayUrl, signInFrame, type PerplKey, type PerplMarket } from './perpl';

/**
 * Perpl volume farmer, running in this browser tab. One cycle = open a position, hold it, close it.
 * Limit legs are post-only maker orders that join the best bid / ask and are re-priced when the
 * market moves away; market legs are IOC orders with a hard 0.5% price bound. A limit close that
 * has not filled in time falls back to an IOC close (bounded emergency exit, as in the original bot).
 *
 * Protocol rules followed (Perpl api-docs, websocket.md): sign-in is the first frame; nothing trades
 * before wallet/orders/positions snapshots; request ids strictly increase from Account.lfr; every
 * frame has a unique non-zero sn; heartbeat sequence gaps force a reconnect and a fresh snapshot.
 */

export type FarmState =
  | 'connecting'
  | 'needs-forwarding'
  | 'idle'
  | 'opening'
  | 'holding'
  | 'closing'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface FarmSnapshot {
  state: FarmState;
  side: 'long' | 'short';
  cycles: number;
  volumeUsd: number;
  makerVolumeUsd: number;
  feesUsd: number;
  pnlUsd: number;
  availableUsd: number | null;
  startedAt: number;
  mid: number | null;
  position: { side: 'long' | 'short'; sizeUsd: number; entry: number } | null;
  nextAt: number | null;
  error: string | null;
  stopReason: string | null;
}

export interface FarmLog {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

interface AccountWire {
  id: number;
  fw: boolean;
  fr: boolean;
  lfr: number;
  b: string;
  lb: string;
}
interface OrderWire {
  rq: number;
  mkt: number;
  acc: number;
  oid: number;
  st: number;
  sr?: number;
  fr?: number;
  r?: boolean;
}
interface PositionWire {
  mkt: number;
  acc: number;
  pid: number;
  st: number;
  sd: number;
  ep: number;
  s: number;
  lv: number;
}
interface FillWire {
  mkt: number;
  acc: number;
  t: number;
  l: number;
  p?: number;
  s: number;
  f: string;
}

const OT = { OpenLong: 1, OpenShort: 2, CloseLong: 3, CloseShort: 4, Cancel: 5 } as const;
const FL = { GTC: 0, PostOnly: 1, IOC: 4 } as const;
const ST = { Open: 2, Partial: 3, Filled: 4, Failed: 7 } as const;
const TERMINAL = new Set([4, 5, 6, 7, 10]);
/** OrderStatusReason codes worth explaining in the log (types.md). */
const REASONS: Record<number, string> = {
  1: 'amount exceeds available balance',
  2: 'account frozen',
  10: 'close order exceeds position',
  13: 'post-only order would cross the book',
  14: 'order expired before execution',
  32: 'request id too low',
  34: 'One-Click Trading is off',
};

const TICK_MS = 400;
const ACK_TIMEOUT_MS = 15_000;
const REPRICE_MIN_MS = 2_500;
const ENTRY_TIMEOUT_MS = 90_000;
const EXIT_LIMIT_TIMEOUT_MS = 60_000;
const MARKET_BOUND = 0.005;
const MAX_FAILURES = 8;

/** Small reconnecting socket to our relay. */
class RelaySocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private timer: number | null = null;
  constructor(
    private url: string,
    private h: {
      open: (ws: WebSocket) => void;
      message: (m: Record<string, unknown>) => void;
      close: (code: number, reason: string) => void;
    },
  ) {}
  start() {
    this.closed = false;
    this.connect();
  }
  stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000);
  }
  restart(reason: string) {
    this.ws?.close(4000, reason);
  }
  send(m: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }
  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.h.open(ws);
    };
    ws.onmessage = (e) => {
      try {
        this.h.message(JSON.parse(String(e.data)));
      } catch {
        /* ignore non-JSON */
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.h.close(e.code, e.reason);
      if (this.closed) return;
      // Bad credentials / foreign wallet / route: retrying won't help.
      if ([4001, 4003, 4004, 4401, 4403].includes(e.code)) return;
      const delay = Math.min(30_000, 800 * 2 ** this.attempt++) * (0.7 + Math.random() * 0.6);
      this.timer = window.setTimeout(() => !this.closed && this.connect(), delay);
    };
  }
}

interface Pending {
  rq: number;
  sn: number;
  purpose: 'open' | 'close';
  price: number;
  postOnly: boolean;
  sentAt: number;
  oid: number | null;
  live: boolean;
  cancelSent: boolean;
}

export class PerplFarmer {
  readonly logs: FarmLog[] = [];
  private md: RelaySocket;
  private tr: RelaySocket;
  private listeners = new Set<() => void>();
  private snap: FarmSnapshot;
  private timer: number | null = null;

  // exchange state
  private ready = false;
  private account: AccountWire | null = null;
  private positions = new Map<number, PositionWire>();
  private openOrders = new Map<number, OrderWire>();
  private quote: { bid: number; ask: number; mid: number } | null = null;
  private lastHbSn: number | null = null;

  // engine state
  private sn = 0;
  private rq = 0;
  private pending: Pending | null = null;
  private failures = 0;
  private retryAt = 0;
  private phaseSince = 0;
  private holdUntil = 0;
  private forceMarketClose = false;
  private stopClose = true;
  private signedIn = false;

  // accounting: cash flow + local position give PnL independent of balance semantics
  private cash = 0;
  private qty = 0;

  private readonly pScale: number;
  private readonly sScale: number;
  private readonly lv: number;

  constructor(
    readonly id: string,
    private key: PerplKey,
    private market: PerplMarket,
    readonly cfg: PerpsTaskConfig,
    private onEvent?: (level: FarmLog['level'], msg: string) => void,
  ) {
    this.pScale = 10 ** market.config.price_decimals;
    this.sScale = 10 ** market.config.size_decimals;
    this.lv = Math.round(Math.min(cfg.leverage, marketMaxLeverage(market)) * 100);
    this.snap = {
      state: 'connecting',
      side: cfg.direction === 'short' ? 'short' : 'long',
      cycles: 0,
      volumeUsd: 0,
      makerVolumeUsd: 0,
      feesUsd: 0,
      pnlUsd: 0,
      availableUsd: null,
      startedAt: Date.now(),
      mid: null,
      position: null,
      nextAt: null,
      error: null,
      stopReason: null,
    };
    this.md = new RelaySocket(relayUrl(key.net, 'market-data'), {
      open: () => {
        this.md.send({
          mt: 5,
          subs: [{ stream: `market-state@${PERPL_CHAIN[key.net]}`, subscribe: true }],
        });
      },
      message: (m) => this.onMarket(m),
      close: (code, reason) => {
        this.quote = null;
        if (code !== 1000) this.log('warn', `Market feed dropped (${reason || code}) — reconnecting`);
      },
    });
    this.tr = new RelaySocket(relayUrl(key.net, 'trading'), {
      open: () => {
        this.ready = false;
        this.lastHbSn = null;
        this.signedIn = false;
        void signInFrame(key).then((f) => this.tr.send(f));
      },
      message: (m) => this.onTrading(m),
      close: (code, reason) => {
        this.ready = false;
        if (this.pending) this.pending.live = false;
        if (code === 4401 || code === 3401)
          return this.fail('Perpl rejected the API key — create a new key and start again');
        if (code === 4403) return this.fail(reason || 'This API key belongs to another wallet');
        if (code === 4001) return this.fail('Your Chog session expired — sign in again');
        if (code !== 1000 && this.snap.state !== 'stopped')
          this.log('warn', `Trading link dropped (${reason || code}) — reconnecting`);
      },
    });
  }

  /* --------------------------------------------------------------------------- public ---- */

  get state() {
    return this.snap;
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  start() {
    this.log(
      'info',
      `Starting ${this.cfg.pair} · $${this.cfg.sizeUsd} @ ${this.lv / 100}x · ${dirLabel(this.cfg.direction)} · open ${this.cfg.entry} / close ${this.cfg.exit}`,
    );
    if (this.lv / 100 < this.cfg.leverage)
      this.log('warn', `Leverage capped at ${this.lv / 100}x — the market's maximum`);
    this.md.start();
    this.tr.start();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }
  /** Stops the bot; by default cancels the resting order and closes the position first. */
  stop(reason = 'Stopped by you', closePosition = true) {
    if (this.snap.state === 'stopped' || this.snap.state === 'stopping') return;
    this.snap.stopReason = reason;
    this.stopClose = closePosition;
    this.log('info', `${reason} — ${closePosition ? 'closing out' : 'leaving the position open'}`);
    this.set({ state: 'stopping' });
    this.phaseSince = Date.now();
  }
  /** Re-check after the user enabled One-Click Trading in their wallet. */
  recheck() {
    this.tr.restart('recheck');
  }

  /* ------------------------------------------------------------------------- internals ---- */

  private set(p: Partial<FarmSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((l) => l());
  }
  private log(level: FarmLog['level'], msg: string) {
    this.logs.push({ t: Date.now(), level, msg });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    this.onEvent?.(level, msg);
    this.listeners.forEach((l) => l());
  }
  private fail(msg: string) {
    this.log('error', msg);
    this.shutdown('error', msg);
  }
  private shutdown(state: 'stopped' | 'error', error: string | null = null) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.md.stop();
    this.tr.stop();
    this.set({ state, error, nextAt: null });
  }

  private onMarket(m: Record<string, unknown>) {
    if (m.mt !== 9) return;
    const s = (m.d as Record<string, { bid: number; ask: number; mid: number } | undefined>)?.[
      String(this.market.id)
    ];
    if (!s || !(s.bid > 0) || !(s.ask > 0)) return;
    const q = { bid: s.bid, ask: s.ask, mid: s.mid || (s.bid + s.ask) / 2 };
    const same = this.quote && this.quote.bid === q.bid && this.quote.ask === q.ask;
    this.quote = q;
    if (!same) this.refreshDerived(); // market state repeats every block even when nothing moved
  }

  private onTrading(m: Record<string, unknown>) {
    switch (m.mt) {
      case 3: {
        const st = m.status as { code: number; error?: string } | undefined;
        if (!this.signedIn && st && st.code !== 0)
          return this.fail(`Perpl sign-in failed: ${st.error || st.code}`);
        if (this.pending && m.cid === this.pending.sn && st && st.code !== 0) {
          this.log('warn', `Order rejected: ${st.error || st.code}`);
          this.orderFailed();
        }
        break;
      }
      case 19: {
        this.signedIn = true;
        const as = (m.as as AccountWire[] | undefined) ?? [];
        const acc = as[0];
        if (!acc) return this.fail('No Perpl exchange account on this wallet yet — deposit first');
        this.account = acc;
        this.rq = Math.max(this.rq, acc.lfr);
        this.lastHbSn = (m.sn as number | undefined) ?? null;
        this.maybeReady(m);
        break;
      }
      case 23: {
        this.openOrders.clear();
        for (const o of (m.d as OrderWire[]) ?? []) if (this.mine(o)) this.openOrders.set(o.oid, o);
        this.maybeReady(m);
        break;
      }
      case 26: {
        this.positions.clear();
        for (const p of (m.d as PositionWire[]) ?? [])
          if (this.mine(p) && p.st === 1) this.positions.set(p.pid, p);
        this.maybeReady(m);
        break;
      }
      case 21: {
        const a = m as unknown as AccountWire;
        if (this.account && a.id === this.account.id) {
          const wasFw = this.account.fw;
          this.account = { ...this.account, ...a };
          this.rq = Math.max(this.rq, a.lfr ?? 0);
          if (!wasFw && a.fw) this.log('info', 'One-Click Trading is on');
          if (a.fr) this.fail('Your Perpl account is frozen');
        }
        this.refreshDerived();
        break;
      }
      case 24:
        for (const o of (m.d as OrderWire[]) ?? []) if (this.mine(o)) this.onOrder(o);
        break;
      case 25:
        for (const f of (m.d as FillWire[]) ?? []) if (this.mine(f)) this.onFill(f);
        break;
      case 27:
        for (const p of (m.d as PositionWire[]) ?? []) {
          if (!this.mine(p)) continue;
          if (p.st === 1 && p.s > 0) this.positions.set(p.pid, p);
          else this.positions.delete(p.pid);
        }
        this.refreshDerived();
        break;
      case 100: {
        const sn = m.sn as number;
        if (this.lastHbSn !== null && sn !== this.lastHbSn + 1) {
          this.log('warn', 'Missed exchange updates — resyncing');
          this.tr.restart('sequence gap');
          return;
        }
        this.lastHbSn = sn;
        break;
      }
    }
  }

  private mine(x: { mkt: number; acc: number }) {
    return x.mkt === this.market.id && (!this.account || x.acc === this.account.id);
  }

  private snapshotsSeen = new Set<number>();
  private seeded = false;
  private maybeReady(m: Record<string, unknown>) {
    this.snapshotsSeen.add(m.mt as number);
    if (this.ready || ![19, 23, 26].every((t) => this.snapshotsSeen.has(t))) return;
    this.snapshotsSeen.clear();
    this.ready = true;
    // Orders from before a reconnect: adopt the first as ours, cancel any others.
    const orders = [...this.openOrders.values()];
    if (this.pending && !orders.some((o) => o.oid === this.pending!.oid)) this.pending = null;
    for (const o of orders) if (!this.pending || o.oid !== this.pending.oid) this.cancel(o.oid);
    this.log('info', `Connected to Perpl · account #${this.account!.id}`);
    if (!this.seeded) {
      // A position left from before counts at its entry price, so PnL covers only this run.
      this.seeded = true;
      const p = this.position();
      if (p) {
        const q = ((p.sd === 1 ? 1 : -1) * p.s) / this.sScale;
        this.qty = q;
        this.cash = -q * (p.ep / this.pScale);
        this.log('info', `Found an open ${p.sd === 1 ? 'long' : 'short'} — it will be closed first`);
      }
    }
    if (!this.account!.fw) {
      this.log('warn', 'One-Click Trading is off — enable it to let the bot place orders');
      this.set({ state: 'needs-forwarding' });
    } else if (this.snap.state === 'connecting' || this.snap.state === 'needs-forwarding') {
      this.set({ state: 'idle', nextAt: Date.now() });
    }
    this.refreshDerived();
  }

  private onOrder(o: OrderWire) {
    if (o.r || TERMINAL.has(o.st)) this.openOrders.delete(o.oid);
    else this.openOrders.set(o.oid, o);
    const p = this.pending;
    if (!p || (o.rq !== p.rq && (p.oid === null || o.oid !== p.oid))) return;
    if (o.oid) p.oid = o.oid;
    if (o.st === ST.Failed) {
      const why = REASONS[o.sr ?? -1] ?? `reason ${o.sr ?? '?'}${o.fr ? `/${o.fr}` : ''}`;
      if (o.sr === 13) this.log('info', 'Post-only would cross — re-quoting');
      else this.log('warn', `Order failed: ${why}`);
      if (o.sr === 34) {
        this.pending = null;
        if (this.account) this.account.fw = false;
        this.set({ state: 'needs-forwarding' });
        return;
      }
      if (o.sr === 32) this.rq = Math.max(this.rq, o.rq);
      this.orderFailed(o.sr === 13);
      return;
    }
    if (TERMINAL.has(o.st) || o.r) {
      this.pending = null;
      return;
    }
    p.live = o.st === ST.Open || o.st === ST.Partial || o.st === 8;
  }

  private orderFailed(benign = false) {
    this.pending = null;
    if (!benign && ++this.failures >= MAX_FAILURES)
      return this.fail('Too many failed orders in a row — stopped to protect your balance');
    this.retryAt = Date.now() + (benign ? 300 : 1500);
  }

  private onFill(f: FillWire) {
    const price = (f.p ?? 0) / this.pScale;
    const size = f.s / this.sScale;
    const notional = price * size;
    const buy = f.t === OT.OpenLong || f.t === OT.CloseShort;
    this.cash += buy ? -notional : notional;
    this.qty += buy ? size : -size;
    const fee = Number(f.f ?? '0') / 1e6;
    this.failures = 0;
    this.set({
      volumeUsd: this.snap.volumeUsd + notional,
      makerVolumeUsd: this.snap.makerVolumeUsd + (f.l === 1 ? notional : 0),
      feesUsd: this.snap.feesUsd + fee,
    });
    this.log(
      'info',
      `Filled ${buy ? 'buy' : 'sell'} ${fmtSize(size)} @ ${fmtPrice(price)} (${f.l === 1 ? 'maker' : 'taker'}) · $${notional.toFixed(2)}`,
    );
    this.refreshDerived();
  }

  private position() {
    let best: PositionWire | null = null;
    for (const p of this.positions.values()) if (!best || p.s > best.s) best = p;
    return best;
  }

  private refreshDerived() {
    const mid = this.quote ? this.quote.mid / this.pScale : null;
    const p = this.position();
    const pnl = mid === null ? this.snap.pnlUsd : this.cash + this.qty * mid - this.snap.feesUsd;
    this.set({
      mid,
      pnlUsd: pnl,
      availableUsd: this.account ? (Number(this.account.b) - Number(this.account.lb)) / 1e6 : null,
      position: p
        ? {
            side: p.sd === 1 ? 'long' : 'short',
            sizeUsd: (p.s / this.sScale) * (mid ?? p.ep / this.pScale),
            entry: p.ep / this.pScale,
          }
        : null,
    });
  }

  /* --------------------------------------------------------------------- order sending ---- */

  private sendOrder(spec: Record<string, number>, before?: (ids: { sn: number; rq: number }) => void) {
    const sn = ++this.sn;
    const rq = ++this.rq;
    // Register first: the exchange's answer can never arrive before we know what we asked for.
    before?.({ sn, rq });
    const ok = this.tr.send({ mt: 22, sn, rq, mkt: this.market.id, acc: this.account!.id, lb: 0, ...spec });
    return ok ? { sn, rq } : null;
  }

  private cancel(oid: number) {
    this.sendOrder({ t: OT.Cancel, oid, s: 0, fl: 0, lv: 0 });
  }

  private place(purpose: 'open' | 'close', side: 'long' | 'short', size: number, market: boolean) {
    const q = this.quote!;
    const buy = purpose === 'open' ? side === 'long' : side === 'short';
    const t =
      purpose === 'open'
        ? side === 'long'
          ? OT.OpenLong
          : OT.OpenShort
        : side === 'long'
          ? OT.CloseLong
          : OT.CloseShort;
    const price = market
      ? Math.round(buy ? q.ask * (1 + MARKET_BOUND) : q.bid * (1 - MARKET_BOUND))
      : buy
        ? q.bid
        : q.ask;
    const sent = this.sendOrder(
      { t, p: price, s: size, fl: market ? FL.IOC : FL.PostOnly, lv: this.lv },
      (ids) =>
        (this.pending = {
          ...ids,
          purpose,
          price,
          postOnly: !market,
          sentAt: Date.now(),
          oid: null,
          live: false,
          cancelSent: false,
        }),
    );
    if (!sent) this.pending = null;
  }

  /** A resting maker order that the market has moved away from gets cancelled (then re-posted). */
  private repriceIfStale() {
    const p = this.pending;
    if (!p || !p.live || !p.postOnly || p.cancelSent || p.oid === null || !this.quote) return;
    if (Date.now() - p.sentAt < REPRICE_MIN_MS) return;
    const buy = p.purpose === 'open' ? this.snap.side === 'long' : this.position()?.sd === 2;
    const best = buy ? this.quote.bid : this.quote.ask;
    const offBps = (Math.abs(best - p.price) / best) * 10_000;
    if (offBps >= Math.max(1, this.cfg.limitOffsetBps)) this.cancelPending();
  }

  private cancelPending() {
    const p = this.pending;
    if (!p || p.cancelSent || p.oid === null) return;
    p.cancelSent = true;
    this.cancel(p.oid);
  }

  /* ------------------------------------------------------------------------------ tick ---- */

  private tick() {
    const now = Date.now();
    const s = this.snap.state;
    if (s === 'stopping' && (!this.ready || !this.quote) && now - this.phaseSince > 8_000) {
      if (this.stopClose && this.position())
        this.log('error', 'Lost the connection while stopping — check your position on Perpl');
      return this.shutdown('stopped');
    }
    if (!this.ready || !this.account || !this.quote) return;
    // An order that never got any status within the window has expired (lb 0 = market TTL).
    if (this.pending && !this.pending.live && now - this.pending.sentAt > ACK_TIMEOUT_MS) {
      this.log('warn', 'No answer for an order — treating it as expired');
      this.pending = null;
    }
    if (s === 'needs-forwarding') return;
    if (s === 'stopping') return this.tickStopping(now);
    if (now < this.retryAt) return;

    const r = this.cfg.risk;
    if (now - this.snap.startedAt > r.maxRuntimeMin * 60_000)
      return this.stop(`Max runtime of ${r.maxRuntimeMin} min reached`);
    if (-this.snap.pnlUsd >= r.maxDailyLossUsd)
      return this.stop(`Loss limit of $${r.maxDailyLossUsd} reached`);

    const pos = this.position();
    const side = this.snap.side;
    const target = this.targetSize();

    if (s === 'idle') {
      if (pos) return (this.set({ state: 'closing' }), void (this.phaseSince = now));
      if (now >= (this.snap.nextAt ?? 0)) {
        this.phaseSince = now;
        this.set({ state: 'opening', nextAt: now + this.cfg.intervalSec * 1000 });
        this.log('info', `Cycle ${this.snap.cycles + 1}: opening ${side}`);
      }
      return;
    }

    if (s === 'opening') {
      if (pos && (pos.sd === 1 ? 'long' : 'short') !== side) {
        this.phaseSince = now;
        return this.set({ state: 'closing' });
      }
      const have = pos?.s ?? 0;
      const done = have >= target * 0.95;
      const timedOut = now - this.phaseSince > ENTRY_TIMEOUT_MS;
      if (done || (timedOut && have > 0)) {
        if (this.pending) return this.cancelPending();
        this.holdUntil = now + this.cfg.holdSec * 1000;
        this.log('info', `Holding ${side} for ${this.cfg.holdSec}s`);
        return this.set({ state: 'holding' });
      }
      if (this.pending) return this.repriceIfStale();
      if (timedOut) this.phaseSince = now; // nothing filled yet: keep quoting
      const margin = (this.cfg.sizeUsd / (this.lv / 100)) * 1.02;
      if ((this.snap.availableUsd ?? 0) < margin) {
        return this.stop(
          `Not enough free balance on Perpl: need ~$${margin.toFixed(2)} margin, have $${(this.snap.availableUsd ?? 0).toFixed(2)}`,
          true,
        );
      }
      return this.place('open', side, target - have, this.cfg.entry === 'market');
    }

    if (s === 'holding') {
      if (!pos) return this.finishCycle(now);
      if (now >= this.holdUntil) {
        this.phaseSince = now;
        this.forceMarketClose = false;
        this.set({ state: 'closing' });
      }
      return;
    }

    if (s === 'closing') {
      if (!pos) {
        if (this.pending) return this.cancelPending();
        return this.finishCycle(now);
      }
      if (
        this.cfg.exit === 'limit' &&
        !this.forceMarketClose &&
        now - this.phaseSince > EXIT_LIMIT_TIMEOUT_MS
      ) {
        this.log('warn', 'Limit close did not fill in time — closing at market');
        this.forceMarketClose = true;
        if (this.pending) return this.cancelPending();
      }
      if (this.pending) return this.repriceIfStale();
      const posSide = pos.sd === 1 ? 'long' : 'short';
      return this.place('close', posSide, pos.s, this.cfg.exit === 'market' || this.forceMarketClose);
    }
  }

  private tickStopping(now: number) {
    const pos = this.position();
    if (this.pending) {
      if (this.pending.live) this.cancelPending();
      if (now - this.phaseSince < 20_000) return;
      this.pending = null;
    }
    if (!this.stopClose || !pos) return this.shutdown('stopped');
    if (now - this.phaseSince > 45_000) {
      this.log('error', 'Could not confirm the position closed — check it on Perpl');
      return this.shutdown('stopped');
    }
    if (now < this.retryAt) return;
    this.place('close', pos.sd === 1 ? 'long' : 'short', pos.s, true);
  }

  private finishCycle(now: number) {
    const cycles = this.snap.cycles + 1;
    const next =
      this.cfg.direction === 'alternate' ? (this.snap.side === 'long' ? 'short' : 'long') : this.snap.side;
    const nextAt = Math.max(now + 1000, this.snap.nextAt ?? now);
    this.log(
      'info',
      `Cycle ${cycles} done · volume $${this.snap.volumeUsd.toFixed(0)} · PnL ${this.snap.pnlUsd >= 0 ? '+' : ''}$${this.snap.pnlUsd.toFixed(2)}`,
    );
    this.set({ state: 'idle', cycles, side: next, nextAt });
  }

  private targetSize() {
    const mid = this.quote!.mid / this.pScale;
    return Math.max(1, Math.floor((this.cfg.sizeUsd / mid) * this.sScale));
  }
}

const PERPL_CHAIN = { mainnet: 143, testnet: 10143 } as const;
const dirLabel = (d: PerpsTaskConfig['direction']) => (d === 'alternate' ? 'long + short' : `${d} only`);
const fmtPrice = (p: number) => (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const fmtSize = (s: number) => (s >= 1 ? s.toFixed(3) : s.toPrecision(3));
