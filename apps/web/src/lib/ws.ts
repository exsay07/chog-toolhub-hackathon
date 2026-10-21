import { useEffect, useSyncExternalStore } from 'react';
import type { NetworkId, ProviderHealth, WsClientMsg, WsServerMsg } from '@chog/shared';

type Listener = (m: WsServerMsg) => void;
type Status = 'connecting' | 'open' | 'closed';

/**
 * Single multiplexed WebSocket per tab. Re-subscribes after reconnect, backs off with jitter,
 * and reference-counts subscriptions so components can mount/unmount freely.
 */
class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<() => void>();
  private subs = new Map<string, { msg: WsClientMsg; refs: number }>();
  private attempt = 0;
  private stopped = true;
  private timer: number | null = null;
  status: Status = 'closed';
  lastMessageAt = 0;
  health: Record<string, ProviderHealth> = {};

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  private setStatus(s: Status) {
    this.status = s;
    for (const l of this.statusListeners) l();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      for (const s of this.subs.values()) ws.send(JSON.stringify(s.msg));
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now();
      let m: WsServerMsg;
      try {
        m = JSON.parse(e.data as string) as WsServerMsg;
      } catch {
        return;
      }
      if (m.t === 'providerHealth') {
        this.health = m.health;
        for (const l of this.statusListeners) l();
      }
      for (const l of this.listeners) l(m);
    };
    ws.onclose = (e) => {
      this.ws = null;
      this.setStatus('closed');
      if (this.stopped || e.code === 4001 || e.code === 4003) return;
      const delay = Math.min(15_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  onStatus(l: () => void): () => void {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }

  subscribe(key: string, sub: WsClientMsg, unsub: WsClientMsg) {
    const cur = this.subs.get(key);
    if (cur) cur.refs++;
    else {
      this.subs.set(key, { msg: sub, refs: 1 });
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(sub));
    }
    return () => {
      const c = this.subs.get(key);
      if (!c) return;
      if (--c.refs <= 0) {
        this.subs.delete(key);
        if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(unsub));
      }
    };
  }
}

export const socket = new Socket();

export function useSocketStatus() {
  return useSyncExternalStore(
    (cb) => socket.onStatus(cb),
    () => socket.status,
  );
}

export function useWsMessages(fn: Listener, deps: unknown[] = []) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => socket.on(fn), deps);
}

export function usePairSubscription(network: NetworkId | undefined, pair: string | undefined) {
  useEffect(() => {
    if (!network || !pair) return;
    return socket.subscribe(
      `pair:${network}:${pair}`,
      { t: 'subPair', network, pair },
      { t: 'unsubPair', network, pair },
    );
  }, [network, pair]);
}

export function useNewPoolsSubscription(network: NetworkId | undefined, enabled = true) {
  useEffect(() => {
    if (!network || !enabled) return;
    return socket.subscribe(
      `pools:${network}`,
      { t: 'subNewPools', network },
      { t: 'unsubNewPools', network },
    );
  }, [network, enabled]);
}
