/**
 * Outbound HTTP with timeouts, bounded retries (exponential backoff + full jitter) and a
 * per-provider token bucket so we never exceed upstream rate limits.
 */

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly maxQueue = 200,
  ) {
    this.tokens = capacity;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
  }

  /**
   * Resolves when a token is available. Rejects immediately when the queue is full (backpressure).
   * `priority` requests (something a visitor is waiting for) go to the front of the queue.
   */
  take(priority = false): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new UpstreamError('Local rate-limit queue full', 429, true));
    return new Promise((res) => {
      if (priority) this.queue.unshift(res);
      else this.queue.push(res);
      this.schedule();
    });
  }

  get pending() {
    return this.queue.length;
  }

  private schedule() {
    if (this.timer) return;
    const wait = Math.max(5, ((1 - this.tokens) / this.refillPerSec) * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refill();
      while (this.tokens >= 1 && this.queue.length) {
        this.tokens -= 1;
        this.queue.shift()!();
      }
      if (this.queue.length) this.schedule();
    }, wait);
    this.timer.unref?.();
  }
}

export interface FetchOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  bucket?: TokenBucket;
  /** Jump the bucket queue (see TokenBucket.take). */
  priority?: boolean;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T>(url: string, o: FetchOpts = {}): Promise<T> {
  const retries = o.retries ?? 2;
  let attempt = 0;
  for (;;) {
    if (o.bucket) await o.bucket.take(o.priority);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, {
        method: o.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(o.body ? { 'content-type': 'application/json' } : {}),
          ...o.headers,
        },
        body: o.body ? JSON.stringify(o.body) : undefined,
        signal: ctl.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new UpstreamError(`HTTP ${res.status}`, res.status, retryable);
      }
      const text = await res.text();
      if (text.length > 5_000_000) throw new UpstreamError('Upstream response too large', null, false);
      return JSON.parse(text) as T;
    } catch (e) {
      const err =
        e instanceof UpstreamError
          ? e
          : new UpstreamError(
              e instanceof Error && e.name === 'AbortError' ? 'Upstream timeout' : 'Upstream network error',
              null,
              true,
            );
      if (!err.retryable || attempt >= retries || o.signal?.aborted) throw err;
      attempt++;
      const backoff = Math.random() * Math.min(4000, 300 * 2 ** attempt);
      await sleep(backoff);
    } finally {
      clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
    }
  }
}
