import type { Usage } from '../types.js';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMTok?: number;
  /** USD per 1M output tokens. */
  outputPerMTok?: number;
  /** USD per 1M cached input tokens (defaults to the input price). */
  cachedInputPerMTok?: number;
  /** Copilot premium requests consumed per call (e.g. 0, 0.33, 1, 10). */
  premiumRequestMultiplier?: number;
}

export interface CostBreakdown {
  usd: number;
  premiumRequests: number;
  /** False when no price was found for the model, so `usd` only reflects premium requests. */
  priced: boolean;
}

export interface PricingOptions {
  /** USD charged per Copilot premium request beyond the plan allowance. */
  premiumRequestUsd?: number;
  /** Price used for models with no explicit entry. */
  fallback?: ModelPrice;
}

/**
 * Model price lookup. Keys are exact model ids or globs such as `openai/*` or `*mini*`.
 * Prices change often, so the package ships none — configure the ones you use.
 */
export class PricingTable {
  private readonly exact = new Map<string, ModelPrice>();
  private readonly patterns: Array<{ re: RegExp; price: ModelPrice }> = [];
  readonly premiumRequestUsd: number;
  private readonly fallback?: ModelPrice;

  constructor(prices: Record<string, ModelPrice> = {}, opts: PricingOptions = {}) {
    this.premiumRequestUsd = opts.premiumRequestUsd ?? 0.04;
    this.fallback = opts.fallback;
    for (const [model, price] of Object.entries(prices)) this.set(model, price);
  }

  set(model: string, price: ModelPrice): this {
    if (model.includes('*')) {
      const re = new RegExp(`^${model.split('*').map(escapeRegExp).join('.*')}$`, 'i');
      this.patterns.push({ re, price });
    } else {
      this.exact.set(model.toLowerCase(), price);
    }
    return this;
  }

  get(model: string): ModelPrice | undefined {
    const key = model.toLowerCase();
    return this.exact.get(key) ?? this.patterns.find((p) => p.re.test(key))?.price ?? this.fallback;
  }

  cost(model: string, usage: Usage, providerPremiumRequests?: number): CostBreakdown {
    const price = this.get(model);
    const cached = usage.cachedInputTokens ?? 0;
    const uncached = Math.max(0, usage.inputTokens - cached);
    const tokenUsd = price
      ? (uncached * (price.inputPerMTok ?? 0) +
          cached * (price.cachedInputPerMTok ?? price.inputPerMTok ?? 0) +
          usage.outputTokens * (price.outputPerMTok ?? 0)) /
        1_000_000
      : 0;
    const premiumRequests = providerPremiumRequests ?? price?.premiumRequestMultiplier ?? 0;
    const hasTokenPrice = Boolean(price && (price.inputPerMTok !== undefined || price.outputPerMTok !== undefined));
    const usd = hasTokenPrice ? tokenUsd : premiumRequests * this.premiumRequestUsd;
    return { usd: round(usd), premiumRequests, priced: Boolean(price) || providerPremiumRequests !== undefined };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
