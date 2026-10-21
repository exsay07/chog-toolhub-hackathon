import type { NetworkId } from './networks.js';

/**
 * Pure risk-limit engine. Every automated or manual trade passes through `evaluateTrade` before it
 * is signed. All amounts are USD estimates (from quotes), so they are conservative gates, not
 * accounting truth.
 */
export interface RiskLimits {
  /** Hard cap on a single trade, USD. */
  maxTradeUsd: number;
  /** Rolling 24h cap on buys, USD. 0 = disabled (no automated buys allowed). */
  maxDailyExposureUsd: number;
  /** Basis points. */
  maxSlippageBps: number;
  /** Percent. Reject quotes with higher price impact. */
  maxPriceImpactPct: number;
  /** Minimum pool liquidity, USD. */
  minLiquidityUsd: number;
  /** Seconds between two automated trades of the same token. */
  cooldownSec: number;
  allowNetworks: NetworkId[];
  /** Lower-cased token identities `network:address`. */
  blockTokens: string[];
  /** If non-empty, only these tokens may be traded automatically. */
  allowTokens: string[];
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxTradeUsd: 50,
  maxDailyExposureUsd: 200,
  maxSlippageBps: 300,
  maxPriceImpactPct: 5,
  minLiquidityUsd: 10_000,
  cooldownSec: 60,
  allowNetworks: ['monad', 'base', 'bsc', 'solana'],
  blockTokens: [],
  allowTokens: [],
};

export interface TradeIntent {
  network: NetworkId;
  token: string;
  side: 'buy' | 'sell';
  amountUsd: number | null;
  slippageBps: number;
  priceImpactPct: number | null;
  liquidityUsd: number | null;
  automated: boolean;
  /** Security flags from a third-party scanner; undefined = not available. */
  security?: { honeypot?: boolean; cannotSell?: boolean; buyTaxPct?: number; sellTaxPct?: number };
}

export interface RiskContext {
  now: number;
  /** USD of buys in the trailing 24h (confirmed + in-flight). */
  spentLast24hUsd: number;
  /** Last automated trade timestamp per token key. */
  lastTradeAt: Record<string, number>;
  /** Global kill switch. */
  emergencyStop: boolean;
}

export interface RiskVerdict {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

export const tokenKey = (network: NetworkId, token: string) => `${network}:${token.toLowerCase()}`;

export function evaluateTrade(intent: TradeIntent, limits: RiskLimits, ctx: RiskContext): RiskVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const key = tokenKey(intent.network, intent.token);

  if (ctx.emergencyStop && intent.automated) reasons.push('Emergency stop is active');
  if (!limits.allowNetworks.includes(intent.network)) reasons.push(`Network ${intent.network} not allowed`);
  if (limits.blockTokens.map((t) => t.toLowerCase()).includes(key)) reasons.push('Token is blocklisted');
  if (
    intent.automated &&
    limits.allowTokens.length > 0 &&
    !limits.allowTokens.map((t) => t.toLowerCase()).includes(key)
  )
    reasons.push('Token not in allowlist');

  if (intent.slippageBps > limits.maxSlippageBps)
    reasons.push(`Slippage ${intent.slippageBps / 100}% exceeds max ${limits.maxSlippageBps / 100}%`);
  if (intent.slippageBps <= 0) reasons.push('Slippage must be positive');

  if (intent.amountUsd === null) {
    if (intent.side === 'buy')
      reasons.push('Trade value could not be estimated in USD; refusing (limits cannot be enforced)');
    else warnings.push('Sale value could not be estimated in USD');
  } else {
    if (intent.side === 'buy' && intent.amountUsd > limits.maxTradeUsd)
      reasons.push(`Trade $${intent.amountUsd.toFixed(2)} exceeds per-trade max $${limits.maxTradeUsd}`);
    if (
      intent.side === 'buy' &&
      intent.automated &&
      ctx.spentLast24hUsd + intent.amountUsd > limits.maxDailyExposureUsd
    )
      reasons.push(`Daily exposure limit $${limits.maxDailyExposureUsd} would be exceeded`);
  }

  if (intent.priceImpactPct === null) warnings.push('Price impact unknown');
  else if (intent.priceImpactPct > limits.maxPriceImpactPct)
    reasons.push(
      `Price impact ${intent.priceImpactPct.toFixed(2)}% exceeds max ${limits.maxPriceImpactPct}%`,
    );

  if (intent.side === 'buy') {
    if (intent.liquidityUsd === null) {
      if (intent.automated) reasons.push('Pool liquidity unknown');
      else warnings.push('Pool liquidity unknown');
    } else if (intent.liquidityUsd < limits.minLiquidityUsd) {
      (intent.automated ? reasons : warnings).push(
        `Liquidity $${Math.round(intent.liquidityUsd)} below minimum $${limits.minLiquidityUsd}`,
      );
    }
  }

  if (intent.automated) {
    const last = ctx.lastTradeAt[key];
    if (last !== undefined && ctx.now - last < limits.cooldownSec * 1000)
      reasons.push('Token cooldown active');
  }

  const s = intent.security;
  if (!s) warnings.push('No security scan available — honeypot/tax risk unknown');
  else {
    if (s.honeypot) reasons.push('Scanner flags token as honeypot');
    if (s.cannotSell) reasons.push('Scanner reports token cannot be sold');
    if ((s.sellTaxPct ?? 0) > 10) reasons.push(`Sell tax ${s.sellTaxPct}% is above 10%`);
    if ((s.buyTaxPct ?? 0) > 10) reasons.push(`Buy tax ${s.buyTaxPct}% is above 10%`);
    if ((s.sellTaxPct ?? 0) > 0 || (s.buyTaxPct ?? 0) > 0) warnings.push('Token has transfer taxes');
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

/** Trailing 24h spend from a list of buys. */
export function spentInWindow(
  buys: Array<{ at: number; usd: number }>,
  now: number,
  windowMs = 86_400_000,
): number {
  return buys.filter((b) => now - b.at < windowMs).reduce((s, b) => s + b.usd, 0);
}
