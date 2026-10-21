import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

/** Behind Cloudflare every request arrives from the tunnel; limits must follow the visitor's IP. */
let t: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  t = await makeApp({ CLIENT_IP_HEADER: 'cf-connecting-ip', RATE_LIMIT_PER_MIN: '10' });
});
afterAll(async () => t.close());

const hit = (ip: string) =>
  t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { 'cf-connecting-ip': ip } });

describe('per-visitor rate limits via the edge header', () => {
  it('gives every visitor their own budget', async () => {
    for (let i = 0; i < 10; i++) expect((await hit('203.0.113.1')).statusCode).not.toBe(429);
    expect((await hit('203.0.113.1')).statusCode).toBe(429); // this visitor is out of budget…
    expect((await hit('203.0.113.2')).statusCode).not.toBe(429); // …the next one is not affected
  });
});
