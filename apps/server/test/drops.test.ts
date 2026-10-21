import { describe, expect, it } from 'vitest';
import { selectDrops } from '../src/nft/opensea.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
const drop = (slug: string, p: Record<string, unknown>) => ({
  collection_slug: slug,
  collection_name: slug,
  chain: 'ethereum',
  contract_address: `0x${slug.padEnd(40, '0').slice(0, 40)}`,
  image_url: 'https://i2c.seadn.io/x.png',
  opensea_url: `https://opensea.io/collection/${slug}`,
  ...p,
});
const stage = (start: number, end: number | null) => ({
  stage_type: 'public_sale',
  label: 'Public',
  price: '30000000000000000',
  price_currency_address: '0x0000000000000000000000000000000000000000',
  start_time: iso(start),
  end_time: end === null ? null : iso(end),
  max_per_wallet: '5',
});

describe('drops calendar', () => {
  it('keeps live drops and ones starting within 72 h; drops ended / far-future / duplicates', () => {
    const rows = selectDrops(
      [
        drop('live', { is_minting: true, active_stage: stage(NOW - 2 * H, NOW + 5 * H) }),
        drop('soon', { is_minting: false, next_stage: stage(NOW + 3 * H, null) }),
        drop('in2days', { is_minting: false, next_stage: stage(NOW + 48 * H, null) }),
        drop('nextweek', { is_minting: false, next_stage: stage(NOW + 7 * 24 * H, null) }),
        drop('ended', { is_minting: true, active_stage: stage(NOW - 10 * H, NOW - H) }),
        drop('nothing', { is_minting: false }),
        drop('live', { is_minting: true, active_stage: stage(NOW - 2 * H, NOW + 5 * H) }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.slug, r.live])).toEqual([
      ['live', true],
      ['soon', false],
      ['in2days', false],
    ]);
    expect(rows[0]!.at).toBe(NOW + 5 * H); // live: when it ends
    expect(rows[1]!.at).toBe(NOW + 3 * H); // upcoming: when it starts
    expect(rows[0]!.stage).toMatchObject({ label: 'Public', price: '30000000000000000', maxPerWallet: 5 });
    expect(rows[0]!.image).toBe('https://i2c.seadn.io/x.png?w=96');
  });

  it('a live drop with no end time stays; junk chains and bad prices are cleaned', () => {
    const rows = selectDrops(
      [
        drop('open', { is_minting: true, active_stage: { ...stage(NOW - H, null), price: 'NaN' } }),
        drop('evil', { chain: '../x', is_minting: true, active_stage: stage(NOW - H, null) }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.slug)).toEqual(['open']);
    expect(rows[0]!.stage!.price).toBeNull();
  });
});
