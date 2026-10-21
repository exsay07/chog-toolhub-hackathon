import { useEffect, useSyncExternalStore } from 'react';
import type { AgentCommand } from '@chog/shared';

/** Loopback agent endpoint. Must match the agent's --port and the CSP connect-src. */
export const AGENT_URL = 'http://127.0.0.1:47321';
const TOKEN_KEY = 'chog.agentToken';

interface AgentState {
  status: 'unknown' | 'offline' | 'unpaired' | 'paired';
  version?: string;
  mode?: 'attended' | 'persistent';
}

let state: AgentState = { status: 'unknown' };
const ls = new Set<() => void>();
const set = (s: AgentState) => {
  state = s;
  ls.forEach((l) => l());
};

// Session-scoped: the pairing token is a short-lived local credential and never leaves this machine.
const token = () => {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as { token: string; expiresAt: number };
    return t.expiresAt > Date.now() ? t.token : null;
  } catch {
    return null;
  }
};

async function call<T>(path: string, body: unknown): Promise<T> {
  const t = token();
  const r = await fetch(`${AGENT_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(t ? { 'x-agent-token': t } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (r.status === 401 && path !== '/v1/pair') {
    sessionStorage.removeItem(TOKEN_KEY);
    set({ ...state, status: 'unpaired' });
  }
  if (!r.ok) throw new Error(j.error ?? `Agent error ${r.status}`);
  return j;
}

export async function probe() {
  try {
    const h = await call<{ version: string; mode: 'attended' | 'persistent' }>('/v1/hello', {});
    if (token()) {
      try {
        await call('/v1/heartbeat', {});
        return set({ status: 'paired', version: h.version, mode: h.mode });
      } catch {
        /* fallthrough */
      }
    }
    set({ status: 'unpaired', version: h.version, mode: h.mode });
  } catch {
    set({ status: 'offline' });
  }
}

export async function pair(code: string) {
  const r = await call<{
    token: string;
    expiresAt: number;
    version: string;
    mode: 'attended' | 'persistent';
  }>('/v1/pair', { code: code.trim().toUpperCase() });
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.token, expiresAt: r.expiresAt }));
  set({ status: 'paired', version: r.version, mode: r.mode });
}

export async function unpair() {
  await call('/v1/unpair', {}).catch(() => {});
  sessionStorage.removeItem(TOKEN_KEY);
  set({ ...state, status: 'unpaired' });
}

export const agentCmd = <T>(c: AgentCommand) => call<T>('/v1/cmd', c);

/** Probes the agent and, when paired, sends heartbeats (attended mode pauses tasks without them). */
export function useAgent() {
  const s = useSyncExternalStore(
    (cb) => {
      ls.add(cb);
      return () => ls.delete(cb);
    },
    () => state,
  );
  useEffect(() => {
    void probe();
    const i = setInterval(() => void probe(), 15_000);
    return () => clearInterval(i);
  }, []);
  return s;
}
