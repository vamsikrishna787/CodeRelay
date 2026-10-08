import type { CompletionRequest, CompletionResponse } from '../types.js';
import { estimateTokens } from '../util.js';
import type { LLMProvider } from './provider.js';

export type MockHandler = (
  request: CompletionRequest,
  callIndex: number,
) => Partial<CompletionResponse> | string | Promise<Partial<CompletionResponse> | string>;

/**
 * Deterministic provider for tests, demos and dry runs. Supply a handler or a
 * script of responses; with neither it plans one task per agent and echoes work.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly requests: CompletionRequest[] = [];
  private readonly handler: MockHandler;

  constructor(handlerOrScript?: MockHandler | Array<Partial<CompletionResponse> | string>, private readonly latencyMs = 0) {
    if (Array.isArray(handlerOrScript)) {
      const script = handlerOrScript;
      this.handler = (_req, i) => script[Math.min(i, script.length - 1)] ?? '';
    } else {
      this.handler = handlerOrScript ?? defaultMockHandler;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));

    const out = await this.handler(request, index);
    const partial: Partial<CompletionResponse> = typeof out === 'string' ? { message: { role: 'assistant', content: out } } : out;
    const message = partial.message ?? { role: 'assistant' as const, content: '' };
    const prompt = request.messages.map((m) => m.content).join('\n');

    return {
      model: partial.model ?? request.model,
      message,
      usage: partial.usage ?? { inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(message.content) },
      finishReason: partial.finishReason ?? (message.toolCalls?.length ? 'tool_calls' : 'stop'),
      premiumRequests: partial.premiumRequests,
    };
  }
}

/** Default demo behaviour: answers planner prompts with a plan, everything else with a short result. */
export const defaultMockHandler: MockHandler = (request) => {
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  if (system.includes('CODERELAY_PLANNER')) {
    const agents = [...system.matchAll(/^- (\S+):/gm)].map((m) => m[1]);
    const pick = (name: string) => (agents.includes(name) ? name : agents[0]);
    return JSON.stringify({
      tasks: [
        { id: 't1', title: 'Design approach', description: `Design the approach for: ${user}`, agent: pick('architect'), dependsOn: [] },
        { id: 't2', title: 'Implement', description: 'Implement the design', agent: pick('coder'), dependsOn: ['t1'] },
        { id: 't3', title: 'Write tests', description: 'Write tests for the implementation', agent: pick('tester'), dependsOn: ['t1'] },
        { id: 't4', title: 'Review', description: 'Review implementation and tests', agent: pick('reviewer'), dependsOn: ['t2', 't3'] },
      ],
    });
  }
  if (system.includes('CODERELAY_SUMMARIZER')) return `Summary of earlier work: ${user.slice(0, 200)}`;
  return `[mock] Completed: ${user.split('\n').find((l) => l.trim()) ?? 'task'}`;
};
