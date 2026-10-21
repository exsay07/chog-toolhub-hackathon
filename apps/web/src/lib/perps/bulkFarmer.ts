import type { PerpsTaskConfig } from '@chog/shared';
import {
  agentSign,
  BULK_NETWORKS,
  bulkAccount,
  keychain,
  nonce,
  submit,
  type BulkAccount,
  type BulkAgent,
  type BulkMarket,
} from './bulk';
import type { FarmLog, FarmSnapshot } from './perplFarmer';

/**
 * Bulk volume farmer, running in this browser tab: same cycle as the Perpl farmer (open → hold →
 * close, alternating sides on "Both"). Prices come from the l2Snapshot stream (every 200 ms); the
 * account (position, orders, margin) is polled over HTTP well inside Bulk's 5 req/s per-IP budget.
 * Limit legs are ALO (post-only) at the touch, re-quoted when the market moves away; market legs are
 * Bulk market orders (exchange slippage guard). Volume is counted from position changes, so maker
 * fills of resting orders are included.
 */

const TICK_MS = 500;
const POLL_MS = 1_500;
const REPRICE_MIN_MS = 3_000;
const ENTRY_TIMEOUT_MS = 90_000;
const EXIT_LIMIT_TIMEOUT_MS = 60_000;
const MAX_FAILURES = 8;

interface Pending {
  oid: string | null;
  purpose: 'open' | 'close';
  price: number;
  postOnly: boolean;
  sentAt: number;
  cancelSent: boolean;
}

export class BulkFarmer {
  readonly logs: FarmLog[] = [];
  private listeners = new Set<() => void>();
  private snap: FarmSnapshot;
  private timer: number | null = null;
  private poller: number | null = null;
  private ws: WebSocket | null = null;
  private wsAttempt = 0;
  private closed = false;

  private quote: { bid: number | null; ask: number | null } = { bid: null, ask: null };
  private account: BulkAccount | null = null;
  private lastPos: number | null = null;
  private pnlBase: number | null = null;
  private pending: Pending | null = null;
  private busy = false;
  private failures = 0;
  private retryAt = 0;
  private phaseSince = 0;
  private holdUntil = 0;
  private forceMarketClose = false;
  private stopClose = true;
  /** Start time of the newest account query that has completed. */
  private polledAt = 0;
  /** When we last changed something on the exchange (order placed / filled / cancelled). */
  private actedAt = 0;

  constructor(
    readonly id: string,
    private agent: BulkAgent,
    private market: BulkMarket,
    readonly cfg: PerpsTaskConfig,
    private onEvent?: (level: FarmLog['level'], msg: string) => void,
  ) {
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
      `Starting ${this.market.symbol} on Bulk ${this.agent.net} · $${this.cfg.sizeUsd} · ${this.cfg.direction === 'alternate' ? 'long + short' : `${this.cfg.direction} only`} · open ${this.cfg.entry} / close ${this.cfg.exit}`,
    );
    this.connect();
    void this.poll();
    this.poller = window.setInterval(() => void this.poll(), POLL_MS);
    this.timer = window.setInterval(() => void this.tick(), TICK_MS);
  }
  stop(reason = 'Stopped by you', closePosition = true) {
    if (this.snap.state === 'stopped' || this.snap.state === 'stopping') return;
    this.snap.stopReason = reason;
    this.stopClose = closePosition;
    this.log('info', `${reason} — ${closePosition ? 'closing out' : 'leaving the position open'}`);
    this.phaseSince = Date.now();
    this.set({ state: 'stopping' });
  }
  recheck() {
    void this.poll();
  }

  /* ------------------------------------------------------------------------ internals ---- */

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
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.poller) clearInterval(this.poller);
    this.timer = this.poller = null;
    this.ws?.close(1000);
    this.set({ state, error, nextAt: null });
  }

  private connect() {
    const ws = new WebSocket(BULK_NETWORKS[this.agent.net].ws);
    this.ws = ws;
    ws.onopen = () => {
      this.wsAttempt = 0;
      ws.send(
        JSON.stringify({
          method: 'subscribe',
          subscription: [{ type: 'l2Snapshot', symbol: this.market.symbol, nlevels: 1 }],
        }),
      );
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.type !== 'l2Snapshot' || m.data?.book?.symbol !== this.market.symbol) return;
        const [bids, asks] = m.data.book.levels as Array<Array<{ px: number | string }>>;
        this.quote = {
          bid: bids?.[0] ? Number(bids[0].px) : null,
          ask: asks?.[0] ? Number(asks[0].px) : null,
        };
        const { bid, ask } = this.quote;
        const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
        if (mid !== this.snap.mid) this.set({ mid }); // snapshots repeat every 200 ms
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.quote = { bid: null, ask: null };
      if (this.closed) return;
      const delay = Math.min(30_000, 800 * 2 ** this.wsAttempt++);
      if (this.wsAttempt > 1) this.log('warn', 'Bulk price feed dropped — reconnecting');
      window.setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  private position() {
    const p = this.account?.positions.find((x) => x.symbol === this.market.symbol && Math.abs(x.size) > 0);
    return p ?? null;
  }

  private async poll() {
    if (this.closed) return;
    const startedAt = Date.now();
    try {
      const a = await bulkAccount(this.agent.net, this.agent.owner);
      // An answer older than a newer one already applied would roll the view back.
      if (startedAt < this.polledAt) return;
      if (!a) {
        if (this.snap.state === 'connecting') this.fail('This Bulk account has no funds yet — deposit first');
        return;
      }
      if (a.authorizedAgentWallets && !a.authorizedAgentWallets.includes(this.agent.pubkey))
        return this.fail(
          'This bot key is no longer authorised on Bulk — connect Phantom and authorise again',
        );
      this.account = a;
      this.polledAt = startedAt;
      const m = a.margin;
      const pnlNow = m.realizedPnl + m.unrealizedPnl - m.fees + m.funding;
      if (this.pnlBase === null) this.pnlBase = pnlNow;
      const p = this.position();
      const size = p?.size ?? 0;
      if (this.lastPos !== null && size !== this.lastPos) {
        const d = Math.abs(size - this.lastPos);
        const maker = !!this.pending?.postOnly && this.pending.oid !== null;
        const px = maker ? this.pending!.price : (this.snap.mid ?? p?.price ?? 0);
        const usd = d * px;
        this.failures = 0;
        this.set({
          volumeUsd: this.snap.volumeUsd + usd,
          makerVolumeUsd: this.snap.makerVolumeUsd + (maker ? usd : 0),
        });
        if (usd >= 0.01)
          this.log(
            'info',
            `Filled ${size > this.lastPos ? 'buy' : 'sell'} ${d.toPrecision(4)} @ ~${px} · $${usd.toFixed(2)}`,
          );
      }
      this.lastPos = size;
      // A resting order that left the book (filled or cancelled) is no longer pending.
      if (
        this.pending?.oid &&
        startedAt > this.pending.sentAt &&
        !a.openOrders.some((o) => o.orderId === this.pending!.oid)
      )
        this.pending = null;
      this.set({
        pnlUsd: pnlNow - this.pnlBase,
        feesUsd: m.fees - (this.feesBase ??= m.fees),
        availableUsd: m.availableMargin,
        position: p
          ? {
              side: p.size > 0 ? 'long' : 'short',
              sizeUsd: Math.abs(p.size) * (this.snap.mid ?? p.price),
              entry: p.price,
            }
          : null,
      });
      if (this.snap.state === 'connecting') {
        this.log('info', `Connected to Bulk · free margin $${m.availableMargin.toFixed(2)}`);
        // Clean slate: our own resting orders on this market from an earlier run are cancelled.
        for (const o of a.openOrders.filter((x) => x.symbol === this.market.symbol))
          void this.cancel(o.orderId);
        this.set({ state: 'idle', nextAt: Date.now() });
      }
    } catch (e) {
      this.log('warn', (e as Error).message);
    }
  }
  private feesBase: number | undefined;

  /* -------------------------------------------------------------------- order sending ---- */

  private roundPx(px: number, buy: boolean) {
    const t = this.market.tickSize;
    const v = buy ? Math.floor(px / t + 1e-9) * t : Math.ceil(px / t - 1e-9) * t;
    return Number(v.toFixed(Math.max(0, Math.ceil(-Math.log10(t)))));
  }
  private roundSz(sz: number) {
    const inc = this.market.sizeIncrement;
    const v = Math.floor(sz / inc + 1e-9) * inc;
    return Number(v.toFixed(Math.min(8, this.market.sizeDecimals)));
  }

  private async send(order: Record<string, unknown>) {
    const k = await keychain();
    const prepared = k.prepareOrder(order, {
      signatureDomain: this.agent.net,
      account: this.agent.owner,
      signer: this.agent.pubkey,
      nonce: nonce(),
    });
    const ourOid = (prepared as unknown as { orderId?: string }).orderId ?? null;
    const tx = await agentSign(this.agent, prepared as never);
    const st = await submit(this.agent.net, tx);
    // Statuses can include the resting orders we traded against; ours carries the pre-computed id.
    const mine = st.find((s) => Object.values(s)[0]?.oid === ourOid) ?? st[st.length - 1] ?? {};
    const [kind, body] = Object.entries(mine)[0] ?? ['error', { message: 'empty response' }];
    return { kind, body: body as Record<string, unknown>, oid: (body?.oid as string | undefined) ?? ourOid };
  }

  private async cancel(oid: string) {
    try {
      await this.send({ type: 'cancel', symbol: this.market.symbol, orderId: oid });
    } catch (e) {
      this.log('warn', `Cancel failed: ${(e as Error).message}`);
    }
  }

  private async place(purpose: 'open' | 'close', side: 'long' | 'short', size: number, market: boolean) {
    const buy = purpose === 'open' ? side === 'long' : side === 'short';
    const { bid, ask } = this.quote;
    const touch = buy ? bid : ask;
    if (!market && touch === null) return; // no quote on our side yet
    if (market && (buy ? ask : bid) === null) {
      this.log('warn', 'No liquidity on the other side of the book — waiting');
      this.retryAt = Date.now() + 3000;
      return;
    }
    const sz = this.roundSz(size);
    if (sz <= 0) return;
    const price = market ? 0 : this.roundPx(touch!, buy);
    const order = {
      type: 'order',
      symbol: this.market.symbol,
      isBuy: buy,
      price,
      size: sz,
      reduceOnly: purpose === 'close',
      iso: false,
      orderType: market ? { type: 'market', isMarket: true, triggerPx: 0 } : { type: 'limit', tif: 'ALO' },
    };
    this.busy = true;
    try {
      const r = await this.send(order);
      this.actedAt = Date.now();
      const k = r.kind;
      if (k === 'resting' || k === 'working') {
        this.pending = {
          oid: r.oid,
          purpose,
          price,
          postOnly: !market,
          sentAt: Date.now(),
          cancelSent: false,
        };
      } else if (k === 'filled' || k === 'partiallyFilled' || k === 'cancelledIoc') {
        this.pending = null;
        if (k === 'cancelledIoc' && !Number(r.body.filledSz)) {
          this.log(
            'warn',
            `Market order found no fill within the exchange price guard (book ${this.quote.bid ?? '–'} / ${this.quote.ask ?? '–'})`,
          );
          this.retryAt = Date.now() + 3000;
        }
        await this.poll();
      } else if (k === 'rejectedCrossing') {
        this.retryAt = Date.now() + 300; // the touch moved; re-quote
      } else {
        const why = String(r.body.reason ?? r.body.message ?? k);
        this.log('warn', `Order rejected: ${why}`);
        if (++this.failures >= MAX_FAILURES)
          this.fail('Too many failed orders in a row — stopped to protect your balance');
        this.retryAt = Date.now() + 2000;
      }
    } catch (e) {
      this.log('warn', (e as Error).message);
      if (++this.failures >= MAX_FAILURES)
        this.fail('Too many failed orders in a row — stopped to protect your balance');
      this.retryAt = Date.now() + 3000;
    } finally {
      this.busy = false;
    }
  }

  private async cancelPending() {
    const p = this.pending;
    if (!p || p.cancelSent || !p.oid) return;
    p.cancelSent = true;
    this.busy = true;
    try {
      await this.cancel(p.oid);
      this.actedAt = Date.now();
      this.pending = null;
      await this.poll();
    } finally {
      this.busy = false;
    }
  }

  private repriceIfStale() {
    const p = this.pending;
    if (!p || !p.postOnly || p.cancelSent || Date.now() - p.sentAt < REPRICE_MIN_MS) return;
    const buy = p.purpose === 'open' ? this.snap.side === 'long' : (this.position()?.size ?? 0) < 0;
    const best = buy ? this.quote.bid : this.quote.ask;
    if (best === null) return;
    const offBps = (Math.abs(best - p.price) / best) * 10_000;
    if (offBps >= Math.max(1, this.cfg.limitOffsetBps)) void this.cancelPending();
  }

  /* ----------------------------------------------------------------------------- tick ---- */

  private async tick() {
    if (this.busy || this.closed) return;
    const now = Date.now();
    const s = this.snap.state;
    if (s === 'connecting') return;
    // Never decide on a view of the account taken before our own last action (no double entries).
    if (this.polledAt <= this.actedAt) return;
    if (s === 'stopping') return this.tickStopping(now);
    if (now < this.retryAt || this.snap.mid === null) return;
    // Act only on a fresh account view (position and orders), never on a stale one.
    if (now - this.polledAt > POLL_MS * 4) return;

    const r = this.cfg.risk;
    if (now - this.snap.startedAt > r.maxRuntimeMin * 60_000)
      return this.stop(`Max runtime of ${r.maxRuntimeMin} min reached`);
    if (-this.snap.pnlUsd >= r.maxDailyLossUsd)
      return this.stop(`Loss limit of $${r.maxDailyLossUsd} reached`);

    const pos = this.position();
    const side = this.snap.side;
    const target = this.cfg.sizeUsd / this.snap.mid;

    if (s === 'idle') {
      if (pos) {
        this.phaseSince = now;
        return this.set({ state: 'closing' });
      }
      if (now >= (this.snap.nextAt ?? 0)) {
        this.phaseSince = now;
        this.set({ state: 'opening', nextAt: now + this.cfg.intervalSec * 1000 });
        this.log('info', `Cycle ${this.snap.cycles + 1}: opening ${side}`);
      }
      return;
    }

    if (s === 'opening') {
      if (pos && (pos.size > 0 ? 'long' : 'short') !== side) {
        this.phaseSince = now;
        return this.set({ state: 'closing' });
      }
      const have = Math.abs(pos?.size ?? 0);
      const timedOut = now - this.phaseSince > ENTRY_TIMEOUT_MS;
      if (have >= target * 0.95 || (timedOut && have > 0)) {
        if (this.pending) return void this.cancelPending();
        this.holdUntil = now + this.cfg.holdSec * 1000;
        this.log('info', `Holding ${side} for ${this.cfg.holdSec}s`);
        return this.set({ state: 'holding' });
      }
      if (this.pending) return this.repriceIfStale();
      if (timedOut) this.phaseSince = now;
      const margin = (this.cfg.sizeUsd / this.cfg.leverage) * 1.05;
      if ((this.snap.availableUsd ?? 0) < margin)
        return this.stop(
          `Not enough free margin on Bulk: need ~$${margin.toFixed(2)}, have $${(this.snap.availableUsd ?? 0).toFixed(2)}`,
        );
      return void this.place('open', side, target - have, this.cfg.entry === 'market');
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
        if (this.pending) return void this.cancelPending();
        return this.finishCycle(now);
      }
      if (
        this.cfg.exit === 'limit' &&
        !this.forceMarketClose &&
        now - this.phaseSince > EXIT_LIMIT_TIMEOUT_MS
      ) {
        this.log('warn', 'Limit close did not fill in time — closing at market');
        this.forceMarketClose = true;
        if (this.pending) return void this.cancelPending();
      }
      if (this.pending) return this.repriceIfStale();
      return void this.place(
        'close',
        pos.size > 0 ? 'long' : 'short',
        Math.abs(pos.size),
        this.cfg.exit === 'market' || this.forceMarketClose,
      );
    }
  }

  private async tickStopping(now: number) {
    if (this.pending) {
      if (!this.pending.cancelSent && this.pending.oid) return void this.cancelPending();
      if (now - this.phaseSince < 15_000) return;
      this.pending = null;
    }
    const pos = this.position();
    if (!this.stopClose || !pos || !this.account) return this.shutdown('stopped');
    if (now - this.phaseSince > 45_000) {
      this.log('error', 'Could not confirm the position closed — check it on Bulk');
      return this.shutdown('stopped');
    }
    if (now < this.retryAt) return;
    await this.place('close', pos.size > 0 ? 'long' : 'short', Math.abs(pos.size), true);
  }

  private finishCycle(now: number) {
    const cycles = this.snap.cycles + 1;
    const next =
      this.cfg.direction === 'alternate' ? (this.snap.side === 'long' ? 'short' : 'long') : this.snap.side;
    this.log(
      'info',
      `Cycle ${cycles} done · volume $${this.snap.volumeUsd.toFixed(0)} · PnL ${this.snap.pnlUsd >= 0 ? '+' : ''}$${this.snap.pnlUsd.toFixed(2)}`,
    );
    this.set({ state: 'idle', cycles, side: next, nextAt: Math.max(now + 1000, this.snap.nextAt ?? now) });
  }
}
