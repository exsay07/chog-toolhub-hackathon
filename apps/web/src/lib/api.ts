export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Fired on 401/403-NOT_HOLDER so the app can return to the gate screen. */
export const authEvents = new EventTarget();

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    signal: init.signal,
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      // CSRF: custom header the server requires on state-changing requests.
      ...(method !== 'GET' ? { 'x-chog-csrf': '1' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string; details?: unknown };
    if (res.status === 401 || d.code === 'NOT_HOLDER')
      authEvents.dispatchEvent(new CustomEvent('logout', { detail: d.code }));
    throw new ApiError(d.error ?? `Request failed (${res.status})`, res.status, d.code, d.details);
  }
  return data as T;
}

export interface Envelope<T> {
  data: T;
  fetchedAt: number;
  stale: boolean;
}

export const get = <T>(p: string, signal?: AbortSignal) => api<T>(p, { signal });
export const post = <T>(p: string, body: unknown = {}) => api<T>(p, { method: 'POST', body });
export const put = <T>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const patch = <T>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T>(p: string) => api<T>(p, { method: 'DELETE' });

export function uid(prefix = 'k') {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
