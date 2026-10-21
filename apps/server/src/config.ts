import { z } from 'zod';
import { CHOG_GENESIS, NETWORK_IDS, NETWORKS, type NetworkId } from '@chog/shared';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Public origin of the web app, e.g. https://toolhub.example. Used for SIWE domain + Origin checks. */
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  /** Extra origins allowed for state-changing requests (dev only). */
  EXTRA_ORIGINS: csv,
  /** Postgres URL. If empty, an embedded PGlite database at PGLITE_DIR is used (dev/test only). */
  DATABASE_URL: z.string().default(''),
  PGLITE_DIR: z.string().default('.data/pglite'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .min(1)
    .max(24 * 30)
    .default(24),
  /** Re-verify NFT ownership when last successful check is older than this. */
  NFT_RECHECK_SEC: z.coerce.number().int().min(30).max(86_400).default(300),
  /** If ownership cannot be verified (RPC outage), keep access this long after the last success. */
  NFT_GRACE_SEC: z.coerce.number().int().min(0).max(86_400).default(900),
  NFT_GATE_CONTRACT: z.string().default(CHOG_GENESIS.address),
  NFT_GATE_NETWORK: z.enum(NETWORK_IDS as [NetworkId, ...NetworkId[]]).default('monad'),
  /** DEV ONLY: addresses granted access without holding the NFT. Refused in production. */
  NFT_GATE_DEV_ALLOWLIST: csv,
  /**
   * Hackathon / reviewer pass: anyone who types this code at sign-in gets in without the NFT (any
   * wallet, normal SIWE signature). Allowed in production; empty = off. 16+ characters.
   */
  JUDGE_ACCESS_CODE: z
    .string()
    .regex(/^([A-Za-z0-9_-]{16,64})?$/, 'JUDGE_ACCESS_CODE must be 16-64 letters, digits, - or _')
    .default(''),
  /** Optional end of the judge pass (ISO date/time); judge sessions end with it. */
  JUDGE_ACCESS_UNTIL: z.string().default(''),
  RPC_MONAD: csv,
  RPC_BSC: csv,
  RPC_BASE: csv,
  RPC_ROBINHOOD: csv,
  RPC_ETHEREUM: csv,
  RPC_ARC: csv,
  RPC_INK: csv,
  RPC_HYPEREVM: csv,
  RPC_SOLANA: csv,
  /** Optional CoinGecko Pro key for GeckoTerminal on-chain endpoints (higher limits). */
  COINGECKO_PRO_API_KEY: z.string().default(''),
  /** Optional OpenSea API key: enables NFT → Top Collections (floor, volume, owners, supply). */
  OPENSEA_API_KEY: z.string().default(''),
  /** Reown (WalletConnect) project id — enables "Phone wallet" (QR) sign-in. Public by design. */
  WALLETCONNECT_PROJECT_ID: z
    .string()
    .regex(/^([0-9a-f]{32})?$/, 'WALLETCONNECT_PROJECT_ID must be 32 hex characters')
    .default(''),
  /** Without OPENSEA_API_KEY, mint OpenSea's documented free-tier key (7 days, 600 reads/h) automatically. */
  OPENSEA_AUTO_KEY: bool.default(true),
  /** NFT → Mint Tracker background log scanning (Monad, Base, Robinhood Chain). */
  MINTS_ENABLED: bool.default(true),
  /** RPCs for the mint log scan; they must allow eth_getLogs without an address filter. */
  MINT_RPC_MONAD: csv,
  MINT_RPC_BASE: csv,
  MINT_RPC_ROBINHOOD: csv,
  MINT_RPC_ETHEREUM: csv,
  /** Keep Token Terminal lists warm in the background so the terminal opens instantly. */
  DISCOVER_WARM: bool.default(true),
  TRACKER_ENABLED: bool.default(true),
  TRACKER_POLL_SEC: z.coerce.number().int().min(2).max(300).default(6),
  NEWPOOLS_POLL_SEC: z.coerce.number().int().min(10).max(600).default(30),
  TRUST_PROXY: bool.default(false),
  /**
   * Header carrying the real visitor IP, set by the edge in front of the app (e.g. "cf-connecting-ip"
   * behind Cloudflare). Rate limits are keyed on it. Only safe when the app is reachable solely through
   * that edge (Cloudflare Tunnel, no public port), since clients could otherwise forge the header.
   */
  CLIENT_IP_HEADER: z
    .string()
    .regex(/^[a-z0-9-]*$/)
    .default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Optional bearer token for /internal/metrics when scraped remotely (min 32 chars). */
  METRICS_TOKEN: z
    .string()
    .refine((s) => s === '' || s.length >= 32, 'METRICS_TOKEN must be ≥ 32 chars')
    .default(''),
  TRACKER_MAX_ADDRESSES_PER_NETWORK: z.coerce.number().int().min(1).max(100_000).default(500),
  WS_MAX_PER_USER: z.coerce.number().int().min(1).max(100).default(8),
  JOURNAL_MAX_INFLIGHT_PER_USER: z.coerce.number().int().min(1).max(1000).default(50),
  SESSION_CACHE_MS: z.coerce.number().int().min(0).max(30_000).default(5000),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(100_000_000).default(600),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const e = parsed.data;
  const origin = new URL(e.APP_ORIGIN);
  const prod = e.NODE_ENV === 'production';

  if (prod) {
    if (!e.DATABASE_URL) throw new Error('DATABASE_URL is required in production (PGlite is dev/test only)');
    if (e.NFT_GATE_DEV_ALLOWLIST.length > 0)
      throw new Error('NFT_GATE_DEV_ALLOWLIST must be empty in production');
    if (origin.protocol !== 'https:') throw new Error('APP_ORIGIN must be https in production');
    if (e.EXTRA_ORIGINS.length > 0) throw new Error('EXTRA_ORIGINS is not allowed in production');
    if (e.RATE_LIMIT_PER_MIN > 100_000)
      throw new Error('RATE_LIMIT_PER_MIN above 100000 is for load testing only');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(e.NFT_GATE_CONTRACT))
    throw new Error('NFT_GATE_CONTRACT must be an EVM address');
  if (NETWORKS[e.NFT_GATE_NETWORK].kind !== 'evm') throw new Error('NFT_GATE_NETWORK must be an EVM network');

  // RPC_<NETWORK> (comma-separated) overrides the public defaults for that network.
  const rpc = Object.fromEntries(
    NETWORK_IDS.map((id) => {
      const own = e[`RPC_${id.toUpperCase()}` as keyof typeof e] as string[];
      return [id, own.length ? own : NETWORKS[id].defaultRpcUrls];
    }),
  ) as Record<NetworkId, string[]>;

  return {
    ...e,
    prod,
    appOrigin: origin.origin,
    appDomain: origin.host,
    allowedOrigins: new Set([origin.origin, ...e.EXTRA_ORIGINS]),
    rpc,
    mintRpc: {
      monad: e.MINT_RPC_MONAD,
      base: e.MINT_RPC_BASE,
      robinhood: e.MINT_RPC_ROBINHOOD,
      ethereum: e.MINT_RPC_ETHEREUM,
    },
    devAllowlist: new Set(e.NFT_GATE_DEV_ALLOWLIST.map((a) => a.toLowerCase())),
    judgeUntil: e.JUDGE_ACCESS_UNTIL ? Date.parse(e.JUDGE_ACCESS_UNTIL) : null,
  };
}
