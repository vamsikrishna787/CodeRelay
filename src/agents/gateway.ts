import { CostTracker, type InvocationRecord } from '../metrics/cost.js';
import { RiskEngine } from '../metrics/risk.js';
import type { LLMProvider } from '../providers/provider.js';
import type { CompletionRequest, CompletionResponse } from '../types.js';
import { newId } from '../util.js';

export interface InvocationMeta {
  agent: string;
  instanceId?: string;
  taskId?: string;
  sessionId?: string;
}

/**
 * Single choke point for every model call: enforces budgets before the call,
 * then records cost and runs invocation-level risk rules afterwards.
 */
export class InvocationGateway {
  constructor(
    readonly cost: CostTracker,
    readonly risk: RiskEngine,
  ) {}

  async invoke(provider: LLMProvider, request: CompletionRequest, meta: InvocationMeta): Promise<CompletionResponse> {
    this.cost.assertWithinBudget();
    const started = Date.now();
    const base = {
      id: newId('inv'),
      sessionId: meta.sessionId,
      agent: meta.agent,
      instanceId: meta.instanceId,
      taskId: meta.taskId,
      provider: provider.name,
      startedAt: new Date(started).toISOString(),
    };

    let response: CompletionResponse;
    try {
      response = await provider.complete(request);
    } catch (err) {
      const record: InvocationRecord = {
        ...base,
        model: request.model,
        durationMs: Date.now() - started,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        premiumRequests: 0,
        priced: true,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.cost.record(record);
      await this.risk.gate({ subject: 'invocation', agent: meta.agent, taskId: meta.taskId, record });
      throw err;
    }

    const price = this.cost.price(response.model, response.usage, response.premiumRequests);
    const record: InvocationRecord = {
      ...base,
      model: response.model,
      durationMs: Date.now() - started,
      usage: response.usage,
      costUsd: price.usd,
      premiumRequests: price.premiumRequests,
      priced: price.priced,
      success: true,
    };
    this.cost.record(record);
    await this.risk.gate({ subject: 'invocation', agent: meta.agent, taskId: meta.taskId, record });
    return response;
  }
}
