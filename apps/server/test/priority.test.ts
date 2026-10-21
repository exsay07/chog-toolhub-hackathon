import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/lib/http.js';
import { thumb } from '../src/nft/opensea.js';

describe('rate-limit queue', () => {
  it('priority requests (a visitor is waiting) jump ahead of background work', async () => {
    const b = new TokenBucket(1, 20, 100);
    const order: string[] = [];
    await b.take(); // use the only token
    const bg = Array.from({ length: 5 }, (_, i) => b.take().then(() => order.push(`bg${i}`)));
    const vip = b.take(true).then(() => order.push('vip'));
    await Promise.all([...bg, vip]);
    expect(order[0]).toBe('vip');
    expect(order.slice(1)).toEqual(['bg0', 'bg1', 'bg2', 'bg3', 'bg4']);
  });
});

describe('collection thumbnails', () => {
  it('asks OpenSea’s CDN for a small image and leaves other hosts alone', () => {
    expect(thumb('https://i2c.seadn.io/collection/x/logo.png')).toBe(
      'https://i2c.seadn.io/collection/x/logo.png?w=96',
    );
    expect(thumb('https://i2c.seadn.io/a.png?w=500', 64)).toBe('https://i2c.seadn.io/a.png?w=64');
    expect(thumb('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(thumb(null)).toBeNull();
  });
});
