import type { WebSocket } from 'ws';
import {
  isNetworkId,
  isValidAddress,
  type NetworkId,
  type WsClientMsg,
  type WsServerMsg,
} from '@chog/shared';
import type { MarketService } from '../market/service.js';
import type { Logger } from '../lib/log.js';

const MAX_BUFFERED = 1_000_000;
const MAX_PAIR_SUBS = 10;

interface Client {
  ws: WebSocket;
  userId: string;
  pairs: Set<string>;
  newPools: Set<NetworkId>;
  msgCount: number;
  windowStart: number;
}

/**
 * Fan-out layer: one upstream poll per (pair | network) regardless of the number of viewers.
 * User-specific messages (tracker events, tx updates) go only to that user's sockets.
 */
export class Hub {
  private clients = new Set<Client>();
  private byUser = new Map<string, Set<Client>>();
  private pairTimers = new Map<string, NodeJS.Timeout>();
  private poolTimers = new Map<NetworkId, NodeJS.Timeout>();
  private seenPools = new Map<NetworkId, Set<string>>();
  stats = { sent: 0, dropped: 0 };

  constructor(
    private readonly market: MarketService,
    private readonly log: Logger,
    private readonly newPoolsPollSec: number,
    private readonly maxPerUser = 8,
  ) {}

  get connectionCount() {
    return this.clients.size;
  }

  add(ws: WebSocket, userId: string) {
    if ((this.byUser.get(userId)?.size ?? 0) >= this.maxPerUser) {
      ws.close(4029, 'too many connections');
      return;
    }
    const c: Client = {
      ws,
      userId,
      pairs: new Set(),
      newPools: new Set(),
      msgCount: 0,
      windowStart: Date.now(),
    };
    this.clients.add(c);
    if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
    this.byUser.get(userId)!.add(c);
    this.send(c, { t: 'hello', serverTime: Date.now() });
    this.send(c, { t: 'providerHealth', health: this.market.health });

    ws.on('message', (raw) => this.onMessage(c, raw.toString()));
    ws.on('close', () => this.remove(c));
    ws.on('error', () => this.remove(c));
  }

  private remove(c: Client) {
    if (!this.clients.delete(c)) return;
    this.byUser.get(c.userId)?.delete(c);
    if (this.byUser.get(c.userId)?.size === 0) this.byUser.delete(c.userId);
    for (const p of c.pairs) this.maybeStopPair(p);
    for (const n of c.newPools) this.maybeStopPools(n);
  }

  private onMessage(c: Client, raw: string) {
    // Per-socket inbound rate limit: 30 msgs / 10s.
    const now = Date.now();
    if (now - c.windowStart > 10_000) {
      c.windowStart = now;
      c.msgCount = 0;
    }
    if (++c.msgCount > 30) {
      c.ws.close(1008, 'rate limit');
      return;
    }
    if (raw.length > 2000) return;
    let m: WsClientMsg;
    try {
      m = JSON.parse(raw) as WsClientMsg;
    } catch {
      return;
    }
    switch (m.t) {
      case 'ping':
        return;
      case 'subPair': {
        if (!isNetworkId(m.network) || typeof m.pair !== 'string' || m.pair.length > 80) return;
        if (!/^(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(m.pair)) return;
        if (c.pairs.size >= MAX_PAIR_SUBS)
          return this.send(c, { t: 'error', message: 'Too many pair subscriptions' });
        const key = `${m.network}|${m.pair}`;
        c.pairs.add(key);
        this.ensurePair(key);
        return;
      }
      case 'unsubPair': {
        const key = `${m.network}|${m.pair}`;
        if (c.pairs.delete(key)) this.maybeStopPair(key);
        return;
      }
      case 'subNewPools':
        if (!isNetworkId(m.network)) return;
        c.newPools.add(m.network);
        this.ensurePools(m.network);
        return;
      case 'unsubNewPools':
        if (c.newPools.delete(m.network)) this.maybeStopPools(m.network);
        return;
    }
  }

  private ensurePair(key: string) {
    if (this.pairTimers.has(key)) return;
    const [network, pair] = key.split('|') as [NetworkId, string];
    const tick = async () => {
      try {
        const r = await this.market.pair(network, pair);
        if (r.value)
          for (const c of this.clients) if (c.pairs.has(key)) this.send(c, { t: 'pair', pair: r.value });
      } catch (e) {
        this.log.debug({ err: String(e), key }, 'pair poll failed');
      }
    };
    void tick();
    const t = setInterval(tick, 5000);
    t.unref();
    this.pairTimers.set(key, t);
  }

  private maybeStopPair(key: string) {
    for (const c of this.clients) if (c.pairs.has(key)) return;
    clearInterval(this.pairTimers.get(key));
    this.pairTimers.delete(key);
  }

  private ensurePools(n: NetworkId) {
    if (this.poolTimers.has(n)) return;
    const seen = this.seenPools.get(n) ?? new Set<string>();
    this.seenPools.set(n, seen);
    let first = seen.size === 0;
    const tick = async () => {
      try {
        const r = await this.market.newPools(n);
        for (const p of [...r.value].reverse()) {
          if (seen.has(p.poolAddress)) continue;
          seen.add(p.poolAddress);
          if (!first)
            for (const c of this.clients) if (c.newPools.has(n)) this.send(c, { t: 'newPool', pool: p });
        }
        first = false;
        if (seen.size > 2000) this.seenPools.set(n, new Set([...seen].slice(-1000)));
      } catch (e) {
        this.log.debug({ err: String(e), n }, 'new pools poll failed');
      }
    };
    void tick();
    const t = setInterval(tick, this.newPoolsPollSec * 1000);
    t.unref();
    this.poolTimers.set(n, t);
  }

  private maybeStopPools(n: NetworkId) {
    for (const c of this.clients) if (c.newPools.has(n)) return;
    clearInterval(this.poolTimers.get(n));
    this.poolTimers.delete(n);
  }

  sendToUser(userId: string, msg: WsServerMsg) {
    for (const c of this.byUser.get(userId) ?? []) this.send(c, msg);
  }

  broadcast(msg: WsServerMsg) {
    for (const c of this.clients) this.send(c, msg);
  }

  /** Kicks every socket of a user (e.g. session revoked / NFT sold). */
  disconnectUser(userId: string) {
    for (const c of this.byUser.get(userId) ?? []) c.ws.close(4001, 'session ended');
  }

  private send(c: Client, msg: WsServerMsg) {
    if (c.ws.readyState !== 1) return;
    // Backpressure: slow consumers lose market ticks rather than growing server memory.
    if (c.ws.bufferedAmount > MAX_BUFFERED) {
      this.stats.dropped++;
      return;
    }
    c.ws.send(JSON.stringify(msg));
    this.stats.sent++;
  }

  close() {
    for (const t of this.pairTimers.values()) clearInterval(t);
    for (const t of this.poolTimers.values()) clearInterval(t);
    for (const c of this.clients) c.ws.close(1001, 'server shutdown');
  }
}

export const validPair = (n: NetworkId, a: string) => isValidAddress(n, a) || /^0x[0-9a-fA-F]{64}$/.test(a);
