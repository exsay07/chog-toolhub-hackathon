import { z } from 'zod';
import { isValidAddress } from './address.js';
import { NETWORK_IDS, type NetworkId } from './networks.js';
import { DEFAULT_RISK_LIMITS } from './risk.js';

export const zNetworkId = z.enum(NETWORK_IDS as [NetworkId, ...NetworkId[]]);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const usd = (max: number) => z.number().finite().min(0).max(max);
const label = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^<>]*$/, 'No angle brackets');

/** Validates `address` against `network` inside an object schema. */
export function withAddress<T extends z.ZodObject<{ network: typeof zNetworkId; address: z.ZodString }>>(
  s: T,
) {
  return s.refine((v) => isValidAddress(v.network as NetworkId, v.address as string), {
    message: 'Invalid address for selected network',
    path: ['address'],
  });
}

export const zAddressRef = withAddress(
  z.object({ network: zNetworkId, address: z.string().trim().min(32).max(64) }),
);

/* ------------------------------- settings ------------------------------- */

export const zRiskLimits = z.object({
  maxTradeUsd: usd(100_000),
  maxDailyExposureUsd: usd(1_000_000),
  maxSlippageBps: z.number().int().min(1).max(5000),
  maxPriceImpactPct: z.number().min(0.01).max(50),
  minLiquidityUsd: usd(1e9),
  cooldownSec: z.number().int().min(0).max(86_400),
  allowNetworks: z.array(zNetworkId).max(10),
  blockTokens: z.array(z.string().max(80)).max(500),
  allowTokens: z.array(z.string().max(80)).max(500),
});

export const zTradingPreset = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/),
  name: label,
  amountNative: z.number().positive().max(1e6),
  slippageBps: z.number().int().min(1).max(5000),
});

export const zSettings = z.object({
  appearance: z.object({
    theme: z.enum(['light', 'dark', 'system']),
    accent: z.enum(['pink', 'blue', 'violet', 'lime', 'cyan', 'amber']),
    reducedMotion: z.enum(['system', 'on', 'off']),
    background: z.enum(['none', 'grid', 'chog']),
    density: z.enum(['compact', 'comfortable']),
  }),
  trading: z.object({
    defaultNetwork: zNetworkId,
    defaultAmountNative: z.number().positive().max(1e6),
    defaultSlippageBps: z.number().int().min(1).max(5000),
    priorityFee: z.enum(['none', 'low', 'medium', 'high']),
    confirmEveryTrade: z.boolean(),
    presets: z.array(zTradingPreset).max(12),
  }),
  notifications: z.object({
    tracker: z.boolean(),
    execution: z.boolean(),
    failed: z.boolean(),
    sniper: z.boolean(),
    perps: z.boolean(),
    sound: z.boolean(),
    durationSec: z.number().int().min(2).max(60),
    position: z.enum(['top-right', 'bottom-right', 'bottom-left']),
  }),
  risk: zRiskLimits,
  timeZone: z.string().max(64),
  /** First-login guide. A default keeps settings saved before this field existed valid. */
  onboarding: z.object({ guideDoneAt: z.number().int().nullable() }).default({ guideDoneAt: null }),
});
export type Settings = z.infer<typeof zSettings>;

export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    theme: 'dark',
    accent: 'violet',
    reducedMotion: 'system',
    background: 'grid',
    density: 'compact',
  },
  trading: {
    defaultNetwork: 'monad',
    defaultAmountNative: 1,
    defaultSlippageBps: 100,
    priorityFee: 'low',
    confirmEveryTrade: true,
    presets: [
      { id: 'small', name: 'Small', amountNative: 0.5, slippageBps: 100 },
      { id: 'medium', name: 'Medium', amountNative: 2, slippageBps: 150 },
    ],
  },
  notifications: {
    tracker: true,
    execution: true,
    failed: true,
    sniper: true,
    perps: true,
    sound: false,
    durationSec: 6,
    position: 'bottom-right',
  },
  risk: DEFAULT_RISK_LIMITS,
  timeZone: 'UTC',
  onboarding: { guideDoneAt: null },
};

/* ------------------------------ watchlist ------------------------------- */

export const zWatchlistAdd = withAddress(
  z.object({
    network: zNetworkId,
    address: z.string().trim().min(32).max(64),
    symbol: z.string().max(32).optional(),
  }),
);

/* --------------------------- wallet tracker ----------------------------- */

export const zTrackedWalletCreate = withAddress(
  z.object({
    network: zNetworkId,
    address: z.string().trim().min(32).max(64),
    label,
    color: hexColor,
    enabled: z.boolean().default(true),
    notify: z
      .object({ buy: z.boolean(), sell: z.boolean(), transfer: z.boolean() })
      .default({ buy: true, sell: true, transfer: false }),
  }),
);
export const zTrackedWalletUpdate = z.object({
  label: label.optional(),
  color: hexColor.optional(),
  enabled: z.boolean().optional(),
  notify: z.object({ buy: z.boolean(), sell: z.boolean(), transfer: z.boolean() }).optional(),
});

export const zCopyConfig = z.object({
  enabled: z.boolean(),
  sizing: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('fixed'), amountNative: z.number().positive().max(1e6) }),
    z.object({ mode: z.literal('percent'), percent: z.number().min(0.1).max(100) }),
  ]),
  copySells: z.boolean(),
  maxTradeUsd: usd(100_000),
  maxDailyUsd: usd(1_000_000),
  slippageBps: z.number().int().min(1).max(5000),
  minLiquidityUsd: usd(1e9),
  cooldownSec: z.number().int().min(0).max(86_400),
  tokenBlocklist: z.array(z.string().max(64)).max(500),
  tokenAllowlist: z.array(z.string().max(64)).max(500),
});
export type CopyConfig = z.infer<typeof zCopyConfig>;

/* ------------------------------- sniper -------------------------------- */

export const zSniperConfig = z.object({
  name: label,
  network: zNetworkId,
  enabled: z.boolean(),
  /** Execution mode: alert = notify only; auto = execute within limits while vault is unlocked. */
  mode: z.enum(['alert', 'auto']),
  entryAmountNative: z.number().positive().max(1e6),
  slippageBps: z.number().int().min(1).max(5000),
  priorityFee: z.enum(['none', 'low', 'medium', 'high']),
  deadlineSec: z.number().int().min(10).max(600),
  maxTradeUsd: usd(100_000),
  filters: z.object({
    minLiquidityUsd: usd(1e9),
    maxLiquidityUsd: usd(1e10).nullable(),
    minVolume5mUsd: usd(1e9),
    maxPoolAgeMin: z.number().int().min(1).max(1440),
    quoteSymbols: z.array(z.string().max(12)).max(10),
    nameIncludes: z.string().max(40),
    requireSecurityScan: z.boolean(),
    maxBuyTaxPct: z.number().min(0).max(100),
    maxSellTaxPct: z.number().min(0).max(100),
    // Added later: defaults keep configs saved before them valid.
    minFdvUsd: usd(1e12).default(0),
    maxFdvUsd: usd(1e12).nullable().default(null),
    minBuys5m: z.number().int().min(0).max(100_000).default(0),
    /** Only pools on a DEX whose id contains this text (e.g. "uniswap"); empty = any. */
    dexIncludes: z.string().max(40).default(''),
  }),
  /** Anti-rug checks on the GoPlus scan (BasedBot-style). Unknown values never block. */
  antiRug: z
    .object({
      blockMintable: z.boolean(),
      /** Solana: freeze authority still set. */
      blockFreezable: z.boolean(),
      /** Hidden owner, owner can change balances / reclaim ownership / change taxes. */
      blockOwnerPowers: z.boolean(),
      requireOpenSource: z.boolean(),
      maxTop10Pct: z.number().min(1).max(100).nullable(),
      maxCreatorPct: z.number().min(0).max(100).nullable(),
      minLpLockedPct: z.number().min(0).max(100).nullable(),
      /** Token or creator addresses never to buy. */
      blacklist: z.array(z.string().trim().min(20).max(64)).max(200),
      /** Sell everything when the creator sells this share of their tokens (needs a known creator). */
      devSellExitPct: z.number().min(1).max(100).nullable(),
    })
    .default({
      blockMintable: true,
      blockFreezable: true,
      blockOwnerPowers: true,
      requireOpenSource: false,
      maxTop10Pct: null,
      maxCreatorPct: null,
      minLpLockedPct: null,
      blacklist: [],
      devSellExitPct: 25,
    }),
  limits: z
    .object({
      maxBuysPerHour: z.number().int().min(1).max(100),
      maxOpenPositions: z.number().int().min(1).max(50),
    })
    .default({ maxBuysPerHour: 5, maxOpenPositions: 5 }),
  /** EVM: vault wallets that each buy `entryAmountNative` on a match; empty = the main wallet only. */
  wallets: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
    .max(21)
    .default([]),
  exit: z.object({
    takeProfitPct: z.number().min(1).max(10_000).nullable(),
    stopLossPct: z.number().min(1).max(99).nullable(),
    /** Partial take-profits: at +atPct sell sellPct of the original position. */
    ladder: z
      .array(z.object({ atPct: z.number().min(1).max(10_000), sellPct: z.number().min(1).max(100) }))
      .max(4)
      .default([]),
    /** Sell all when the price falls this far from its peak since entry (while in profit). */
    trailingStopPct: z.number().min(1).max(99).nullable().default(null),
  }),
});
export type SniperConfig = z.infer<typeof zSniperConfig>;

/** Stored configs predate some fields: parse with defaults (null if no longer valid). */
export function sniperConfigOf(raw: unknown): SniperConfig | null {
  const p = zSniperConfig.safeParse(raw);
  return p.success ? p.data : null;
}

/* ------------------------------ nft mint -------------------------------- */

export const zMintTask = withAddress(
  z.object({
    name: label,
    network: zNetworkId,
    address: z.string().trim().min(32).max(64),
    /** Solidity signature of the public mint function, e.g. `mint(uint256)`. */
    functionSignature: z
      .string()
      .max(120)
      .regex(
        /^[a-zA-Z_][a-zA-Z0-9_]*\((?:(?:uint256|uint32|uint64|address|bytes32)(?:,(?:uint256|uint32|uint64|address|bytes32))*)?\)$/,
        'Only simple public mint signatures (uint/address/bytes32 args) are supported',
      ),
    /** Arguments as strings; `{quantity}` and `{recipient}` placeholders allowed. */
    args: z.array(z.string().max(80)).max(4),
    quantity: z.number().int().min(1).max(100),
    unitPriceNative: z.number().min(0).max(1e6),
    maxTotalSpendNative: z.number().min(0).max(1e6),
    startAt: z.number().int().nullable(),
    maxAttempts: z.number().int().min(1).max(10),
    priorityFee: z.enum(['none', 'low', 'medium', 'high']),
    /** Vault wallets that mint (each mints `quantity`); empty = the main wallet only. */
    wallets: z
      .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
      .max(21)
      .default([]),
  }),
).refine((v) => v.network !== 'solana', {
  message: 'NFT public mint is EVM-only for now',
  path: ['network'],
});
export type MintTask = z.infer<typeof zMintTask>;

/* ------------------------------ journal --------------------------------- */

export const zJournalSubmit = z.object({
  idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
  network: zNetworkId,
  hash: z.string().regex(/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/),
  kind: z.enum(['swap', 'approve', 'mint', 'transfer']),
  source: z.enum(['manual', 'sniper', 'copy', 'mint', 'limit']),
  side: z.enum(['buy', 'sell']).nullable(),
  token: z.string().max(64).nullable(),
  quotedUsd: z.number().finite().nullable(),
  /** Sending wallet when it is not the primary one (must be a registered trading wallet). */
  wallet: z.string().max(64).optional(),
});

/* ----------------------------- perps farm ------------------------------- */

export const PERPS_PLATFORMS = ['perpl', 'bulk'] as const;
export const zPerpsTaskConfig = z.object({
  platform: z.enum(PERPS_PLATFORMS),
  pair: z.string().regex(/^[A-Z0-9]{2,12}-[A-Z]{3,5}$/),
  direction: z.enum(['long', 'short', 'alternate']),
  sizeUsd: usd(1_000_000),
  leverage: z.number().min(1).max(50),
  entry: z.enum(['market', 'limit']),
  exit: z.enum(['market', 'limit']),
  limitOffsetBps: z.number().int().min(0).max(500),
  holdSec: z.number().int().min(5).max(86_400),
  intervalSec: z.number().int().min(5).max(86_400),
  risk: z.object({
    maxNotionalUsd: usd(10_000_000),
    maxLeverage: z.number().min(1).max(50),
    maxOpenPositions: z.number().int().min(1).max(20),
    maxConcurrentOrders: z.number().int().min(1).max(50),
    maxDailyLossUsd: usd(1_000_000),
    maxRuntimeMin: z.number().int().min(1).max(10_080),
  }),
});
export type PerpsTaskConfig = z.infer<typeof zPerpsTaskConfig>;

export function perpsConfigViolations(c: PerpsTaskConfig): string[] {
  const v: string[] = [];
  if (c.leverage > c.risk.maxLeverage) v.push('Leverage exceeds max leverage');
  if (c.sizeUsd > c.risk.maxNotionalUsd) v.push('Size exceeds max notional exposure');
  if (c.sizeUsd <= 0) v.push('Size must be positive');
  if (c.entry === 'limit' && c.limitOffsetBps === 0) v.push('Limit entry needs a non-zero offset');
  return v;
}

/* ----------------------------- local agent ------------------------------ */

export const zAgentCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('listAdapters') }),
  z.object({
    type: z.literal('startTask'),
    taskId: z.string().regex(/^[a-zA-Z0-9-]{4,64}$/),
    config: zPerpsTaskConfig,
  }),
  z.object({ type: z.literal('pauseTask'), taskId: z.string().regex(/^[a-zA-Z0-9-]{4,64}$/) }),
  z.object({ type: z.literal('resumeTask'), taskId: z.string().regex(/^[a-zA-Z0-9-]{4,64}$/) }),
  z.object({ type: z.literal('stopTask'), taskId: z.string().regex(/^[a-zA-Z0-9-]{4,64}$/) }),
  z.object({ type: z.literal('stopAll') }),
  z.object({
    type: z.literal('logs'),
    taskId: z.string().regex(/^[a-zA-Z0-9-]{4,64}$/),
    since: z.number().int().min(0).optional(),
  }),
]);
export type AgentCommand = z.infer<typeof zAgentCommand>;

/* ------------------------------------------------------------ per-user synced state ------- */

/** Keys a client may store server-side (GET/PUT /api/kv). Small JSON values, ≤ 32 KB each. */
export const USER_KV_KEYS = [
  'term.quick',
  'term.filters',
  'term.chains',
  'term.view',
  'term.tf',
  'term.recent',
  'sniper.entries',
  'term.presets',
  'term.orders',
] as const;
export type UserKvKey = (typeof USER_KV_KEYS)[number];
export const USER_KV_MAX_BYTES = 32 * 1024;
