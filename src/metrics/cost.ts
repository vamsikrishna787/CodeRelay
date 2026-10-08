import type { Usage } from '../types.js';
import { TypedEmitter } from '../util.js';
import { PricingTable, round } from './pricing.js';

export interface InvocationRecord {
  id: string;
  sessionId?: string;
  agent: string;
  instanceId?: string;
  taskId?: string;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  usage: Usage;
  costUsd: number;
  premiumRequests: number;
  priced: boolean;
  success: boolean;
  error?: string;
}

export interface Budget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxPremiumRequests?: number;
  maxInvocations?: number;
  /** Fraction (0–1) of any limit at which a `budget:warning` fires. Default 0.8. */
  warnAt?: number;
}

export type BudgetMetric = 'costUsd' | 'tokens' | 'premiumRequests' | 'invocations';

export interface Totals {
  invocations: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  tokens: number;
  costUsd: number;
  premiumRequests: number;
  durationMs: number;
  unpricedInvocations: number;
}

export interface CostSummary {
  totals: Totals;
  byAgent: Record<string, Totals>;
  byModel: Record<string, Totals>;
  byTask: Record<string, Totals>;
  budget: BudgetStatus;
}

export interface BudgetStatus {
  limits: Budget;
  usage: Record<BudgetMetric, number>;
  /** Fraction of each configured limit used. */
  utilization: Partial<Record<BudgetMetric, number>>;
  exceeded: BudgetMetric[];
}

export class BudgetExceededError extends Error {
  constructor(readonly metric: BudgetMetric, readonly used: number, readonly limit: number) {
    super(`Budget exceeded: ${metric} ${round(used, 4)} >= limit ${limit}`);
    this.name = 'BudgetExceededError';
  }
}

export interface CostEvents extends Record<string, unknown> {
  invocation: InvocationRecord;
  'budget:warning': { metric: BudgetMetric; used: number; limit: number; utilization: number };
  'budget:exceeded': { metric: BudgetMetric; used: number; limit: number };
}

const LIMIT_KEYS: Record<BudgetMetric, keyof Budget> = {
  costUsd: 'maxCostUsd',
  tokens: 'maxTokens',
  premiumRequests: 'maxPremiumRequests',
  invocations: 'maxInvocations',
};

/** Records every agent invocation and enforces spend budgets. */
export class CostTracker extends TypedEmitter<CostEvents> {
  readonly pricing: PricingTable;
  readonly budget: Budget;
  private readonly records: InvocationRecord[] = [];
  private readonly warned = new Set<BudgetMetric>();
  private readonly exceededNotified = new Set<BudgetMetric>();

  constructor(opts: { pricing?: PricingTable; budget?: Budget } = {}) {
    super();
    this.pricing = opts.pricing ?? new PricingTable();
    this.budget = opts.budget ?? {};
  }

  /** Price a usage sample without recording it. */
  price(model: string, usage: Usage, premiumRequests?: number) {
    return this.pricing.cost(model, usage, premiumRequests);
  }

  record(rec: InvocationRecord): InvocationRecord {
    this.records.push(rec);
    this.emit('invocation', rec);
    this.checkBudget();
    return rec;
  }

  /** Re-load records from a persisted session without firing events. */
  restore(records: InvocationRecord[]): void {
    this.records.push(...records);
    for (const [metric, ratio] of Object.entries(this.status().utilization)) {
      if ((ratio ?? 0) >= (this.budget.warnAt ?? 0.8)) this.warned.add(metric as BudgetMetric);
    }
  }

  all(): readonly InvocationRecord[] {
    return this.records;
  }

  /** Throws BudgetExceededError if any limit is already reached. Call before each invocation. */
  assertWithinBudget(): void {
    const status = this.status();
    const metric = status.exceeded[0];
    if (metric) {
      const limit = this.budget[LIMIT_KEYS[metric]] as number;
      throw new BudgetExceededError(metric, status.usage[metric], limit);
    }
  }

  status(): BudgetStatus {
    const t = aggregate(this.records);
    const usage: Record<BudgetMetric, number> = {
      costUsd: t.costUsd,
      tokens: t.tokens,
      premiumRequests: t.premiumRequests,
      invocations: t.invocations,
    };
    const utilization: Partial<Record<BudgetMetric, number>> = {};
    const exceeded: BudgetMetric[] = [];
    for (const metric of Object.keys(LIMIT_KEYS) as BudgetMetric[]) {
      const limit = this.budget[LIMIT_KEYS[metric]] as number | undefined;
      if (limit === undefined) continue;
      utilization[metric] = limit > 0 ? round(usage[metric] / limit, 4) : 1;
      if (usage[metric] >= limit) exceeded.push(metric);
    }
    return { limits: this.budget, usage, utilization, exceeded };
  }

  summary(): CostSummary {
    return {
      totals: aggregate(this.records),
      byAgent: groupBy(this.records, (r) => r.agent),
      byModel: groupBy(this.records, (r) => r.model),
      byTask: groupBy(this.records, (r) => r.taskId ?? '(none)'),
      budget: this.status(),
    };
  }

  private checkBudget(): void {
    const status = this.status();
    const warnAt = this.budget.warnAt ?? 0.8;
    for (const [metric, ratio] of Object.entries(status.utilization) as Array<[BudgetMetric, number]>) {
      const limit = this.budget[LIMIT_KEYS[metric]] as number;
      if (status.exceeded.includes(metric)) {
        if (this.exceededNotified.has(metric)) continue;
        this.exceededNotified.add(metric);
        this.emit('budget:exceeded', { metric, used: status.usage[metric], limit });
      } else if (ratio >= warnAt && !this.warned.has(metric)) {
        this.warned.add(metric);
        this.emit('budget:warning', { metric, used: status.usage[metric], limit, utilization: ratio });
      }
    }
  }
}

export function aggregate(records: readonly InvocationRecord[]): Totals {
  const t: Totals = {
    invocations: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    tokens: 0,
    costUsd: 0,
    premiumRequests: 0,
    durationMs: 0,
    unpricedInvocations: 0,
  };
  for (const r of records) {
    t.invocations++;
    if (!r.success) t.failures++;
    if (!r.priced) t.unpricedInvocations++;
    t.inputTokens += r.usage.inputTokens;
    t.outputTokens += r.usage.outputTokens;
    t.cachedInputTokens += r.usage.cachedInputTokens ?? 0;
    t.costUsd += r.costUsd;
    t.premiumRequests += r.premiumRequests;
    t.durationMs += r.durationMs;
  }
  t.tokens = t.inputTokens + t.outputTokens;
  t.costUsd = round(t.costUsd);
  t.premiumRequests = round(t.premiumRequests, 4);
  return t;
}

function groupBy(records: readonly InvocationRecord[], key: (r: InvocationRecord) => string): Record<string, Totals> {
  const groups = new Map<string, InvocationRecord[]>();
  for (const r of records) {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return Object.fromEntries([...groups].map(([k, rs]) => [k, aggregate(rs)]));
}
