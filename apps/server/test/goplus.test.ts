import { afterEach, describe, expect, it, vi } from 'vitest';
import { goplusSecurity } from '../src/market/providers.js';

const reply = (result: Record<string, unknown>) =>
  vi.fn(async () => new Response(JSON.stringify({ code: 1, result }), { status: 200 }));

afterEach(() => vi.unstubAllGlobals());

describe('GoPlus normalisation (anti-rug fields)', () => {
  it('EVM: creator, LP locked/burned share and owner powers', async () => {
    vi.stubGlobal(
      'fetch',
      reply({
        '0xaa': {
          is_honeypot: '0',
          is_mintable: '0',
          creator_address: '0x1111111111111111111111111111111111111111',
          creator_percent: '0.12',
          slippage_modifiable: '1',
          lp_holders: [
            { address: '0x000000000000000000000000000000000000dead', percent: '0.6', is_locked: 0 },
            { address: '0x2222222222222222222222222222222222222222', percent: '0.3', is_locked: 1 },
            { address: '0x3333333333333333333333333333333333333333', percent: '0.1', is_locked: 0 },
          ],
        },
      }),
    );
    const s = (await goplusSecurity('base', '0xaa'))!;
    expect(s.creator).toBe('0x1111111111111111111111111111111111111111');
    expect(s.creatorPct).toBeCloseTo(12);
    expect(s.lpLockedPct).toBeCloseTo(90);
    expect(s.ownerPowers).toBe(true);
    expect(s.isFreezable).toBeNull();
    expect(s.flags).toContain('Owner can change taxes / ownership');
  });

  it('Solana: freeze authority and creator; junk creator ignored', async () => {
    vi.stubGlobal(
      'fetch',
      reply({
        Mint111: {
          mintable: { status: '0' },
          freezable: { status: '1' },
          balance_mutable_authority: { status: '0' },
          creators: [{ address: 'not an address <script>' }],
        },
      }),
    );
    const s = (await goplusSecurity('solana', 'Mint111'))!;
    expect(s.isFreezable).toBe(true);
    expect(s.isMintable).toBe(false);
    expect(s.ownerPowers).toBe(false);
    expect(s.creator).toBeNull();
    expect(s.lpLockedPct).toBeNull();
    expect(s.flags).toContain('Freezable');
  });
});
