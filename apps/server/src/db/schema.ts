import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Lower-cased EVM address of the external (authentication) wallet. */
    address: text('address').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [uniqueIndex('users_address_uq').on(t.address)],
);

export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [index('auth_nonces_expires_idx').on(t.expiresAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    /** SHA-256 of the opaque cookie token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    lastSeenAt: ts('last_seen_at'),
    userAgent: text('user_agent'),
    nftVerifiedAt: ts('nft_verified_at').notNull(),
    nftBalance: integer('nft_balance').notNull(),
    /** 'holder' | 'dev-allowlist' */
    accessBasis: text('access_basis').notNull(),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const settings = pgTable('settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Public addresses of the user's local (browser-vault) trading wallets. Never keys. */
export const tradingWallets = pgTable(
  'trading_wallets',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'evm' | 'solana'
    address: text('address').notNull(),
    /** 'primary' (one per kind) or 'extra' (additional EVM wallets for multi-wallet mints / snipes). */
    role: text('role').notNull().default('primary'),
    label: text('label'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('trading_wallets_user_kind_primary_uq')
      .on(t.userId, t.kind)
      .where(sql`${t.role} = 'primary'`),
    uniqueIndex('trading_wallets_user_address_uq').on(t.userId, t.kind, t.address),
  ],
);

export const watchlist = pgTable(
  'watchlist',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    network: text('network').notNull(),
    address: text('address').notNull(),
    symbol: text('symbol'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watchlist_uq').on(t.userId, t.network, t.address)],
);

export const trackedWallets = pgTable(
  'tracked_wallets',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    network: text('network').notNull(),
    address: text('address').notNull(),
    label: text('label').notNull(),
    color: text('color').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    notify: jsonb('notify').notNull(),
    copy: jsonb('copy'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tracked_wallets_uq').on(t.userId, t.network, t.address),
    index('tracked_wallets_addr_idx').on(t.network, t.address),
  ],
);

/** Public on-chain activity of tracked addresses. Shared across users (it is public data). */
export const trackerEvents = pgTable(
  'tracker_events',
  {
    id: id(),
    network: text('network').notNull(),
    wallet: text('wallet').notNull(),
    hash: text('hash').notNull(),
    at: ts('at').notNull(),
    kind: text('kind').notNull(),
    token: text('token'),
    tokenSymbol: text('token_symbol'),
    tokenAmount: doublePrecision('token_amount'),
    counterSymbol: text('counter_symbol'),
    counterAmount: doublePrecision('counter_amount'),
    estUsd: doublePrecision('est_usd'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('tracker_events_uq').on(t.network, t.hash, t.wallet, t.kind, t.token).nullsNotDistinct(),
    index('tracker_events_wallet_idx').on(t.network, t.wallet, t.at),
  ],
);

export const trackerCursors = pgTable('tracker_cursors', {
  key: text('key').primaryKey(), // e.g. 'evm:monad' or 'sol:<address>'
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Transactions the user's trading wallet submitted, reconciled against the chain by the server. */
export const journal = pgTable(
  'journal',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    network: text('network').notNull(),
    hash: text('hash').notNull(),
    wallet: text('wallet').notNull(),
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    side: text('side'),
    token: text('token'),
    tokenSymbol: text('token_symbol'),
    quotedUsd: doublePrecision('quoted_usd'),
    state: text('state').notNull(),
    tokenQty: doublePrecision('token_qty'),
    nativeDelta: doublePrecision('native_delta'),
    usdValue: doublePrecision('usd_value'),
    feeNative: doublePrecision('fee_native'),
    feeUsd: doublePrecision('fee_usd'),
    blockTime: ts('block_time'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('journal_idem_uq').on(t.userId, t.idempotencyKey),
    uniqueIndex('journal_hash_uq').on(t.userId, t.network, t.hash),
    index('journal_state_idx').on(t.state),
    index('journal_user_time_idx').on(t.userId, t.createdAt),
  ],
);

/** Generic per-user automation configs (sniper, mint, perps). Validated by zod at the boundary. */
export const automations = pgTable(
  'automations',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'sniper' | 'mint' | 'perps'
    data: jsonb('data').notNull(),
    status: text('status').notNull().default('idle'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('automations_user_kind_idx').on(t.userId, t.kind)],
);

export const automationLogs = pgTable(
  'automation_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    automationId: uuid('automation_id'),
    kind: text('kind').notNull(),
    level: text('level').notNull(),
    message: text('message').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('automation_logs_user_idx').on(t.userId, t.at)],
);

/** Small server-owned values that must survive restarts (e.g. the auto-minted OpenSea free-tier key). */
export const serverKv = pgTable('server_kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Per-user preferences and small state that must follow the user across devices (terminal quick-buy
 * amounts, filters, chains; sniper entry prices for take-profit / stop-loss). Keys are allow-listed.
 */
export const userKv = pgTable(
  'user_kv',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_kv_user_key').on(t.userId, t.key)],
);
