import type { LLMProvider } from '../providers/provider.js';
import type { Message, ToolCall } from '../types.js';
import { truncate } from '../util.js';
import type { InvocationGateway } from './gateway.js';
import type { Tool } from './tools.js';

export interface AgentDefinition {
  /** Unique agent type name, e.g. `coder`. */
  name: string;
  description: string;
  systemPrompt: string;
  /** Skills used to route tasks to this agent, e.g. ['typescript', 'implement', 'refactor']. */
  capabilities: string[];
  /** Model override (falls back to the orchestrator default). */
  model?: string;
  /** Provider key override when the orchestrator has several providers. */
  provider?: string;
  /** Tool names this agent may use. `['*']` = all registered tools. */
  tools?: string[];
  /** Max model turns in the tool loop per task. Default 8. */
  maxTurns?: number;
  /** Cap on concurrently deployed instances of this agent. Default: unlimited (bounded by pool). */
  maxInstances?: number;
  temperature?: number;
}

export interface AgentRunContext {
  taskId?: string;
  sessionId?: string;
  /** Extra context messages (session summary, dependency outputs...). */
  context?: Message[];
  signal?: AbortSignal;
}

export interface AgentResult {
  agent: string;
  instanceId: string;
  output: string;
  turns: number;
  toolCalls: number;
  blockedToolCalls: number;
  transcript: Message[];
}

export interface AgentDeps {
  provider: LLMProvider;
  model: string;
  tools: Tool[];
  gateway: InvocationGateway;
  instanceId: string;
  workspaceRoot: string;
}

/** One deployed agent instance: runs a task through a model/tool loop with risk gating. */
export class Agent {
  constructor(
    readonly definition: AgentDefinition,
    private readonly deps: AgentDeps,
  ) {}

  get instanceId(): string {
    return this.deps.instanceId;
  }

  async run(input: string, ctx: AgentRunContext = {}): Promise<AgentResult> {
    const def = this.definition;
    const { gateway, provider, model } = this.deps;
    const tools = new Map(this.deps.tools.map((t) => [t.schema.name, t]));
    const messages: Message[] = [
      { role: 'system', content: def.systemPrompt },
      ...(ctx.context ?? []),
      { role: 'user', content: input },
    ];
    const meta = { agent: def.name, instanceId: this.instanceId, taskId: ctx.taskId, sessionId: ctx.sessionId };
    const maxTurns = def.maxTurns ?? 8;
    let toolCallCount = 0;
    let blocked = 0;

    for (let turn = 1; turn <= maxTurns; turn++) {
      const res = await gateway.invoke(
        provider,
        {
          model,
          messages,
          tools: tools.size ? [...tools.values()].map((t) => t.schema) : undefined,
          temperature: def.temperature,
          signal: ctx.signal,
        },
        meta,
      );
      const reply: Message = { ...res.message, name: def.name };
      messages.push(reply);

      if (reply.content) {
        const outRisk = await gateway.risk.gate({ subject: 'output', agent: def.name, taskId: ctx.taskId, text: reply.content });
        if (outRisk.decision === 'block') {
          reply.content = `[redacted by risk policy: ${outRisk.signals.map((s) => s.message).join('; ')}]`;
        }
      }

      if (!reply.toolCalls?.length) {
        return { agent: def.name, instanceId: this.instanceId, output: reply.content, turns: turn, toolCalls: toolCallCount, blockedToolCalls: blocked, transcript: messages };
      }

      for (const call of reply.toolCalls) {
        toolCallCount++;
        const result = await this.executeTool(call, tools, ctx);
        if (result.blocked) blocked++;
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.content });
      }
    }

    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '';
    return {
      agent: def.name,
      instanceId: this.instanceId,
      output: `${last}\n\n[stopped after ${maxTurns} turns]`.trim(),
      turns: maxTurns,
      toolCalls: toolCallCount,
      blockedToolCalls: blocked,
      transcript: messages,
    };
  }

  private async executeTool(call: ToolCall, tools: Map<string, Tool>, ctx: AgentRunContext): Promise<{ content: string; blocked: boolean }> {
    const tool = tools.get(call.name);
    if (!tool) return { content: `Error: unknown tool "${call.name}"`, blocked: false };

    const assessment = await this.deps.gateway.risk.gate({
      subject: 'tool_call',
      agent: this.definition.name,
      taskId: ctx.taskId,
      tool: call.name,
      args: call.arguments,
      toolRisk: tool.risk,
    });
    if (assessment.decision === 'block') {
      const why = assessment.signals.map((s) => s.message).join('; ');
      return { content: `BLOCKED by risk policy (score ${assessment.score}, ${assessment.level}): ${why}. Choose a safer approach.`, blocked: true };
    }

    try {
      const out = await tool.handler(call.arguments, {
        agent: this.definition.name,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        workspaceRoot: this.deps.workspaceRoot,
        signal: ctx.signal,
      });
      return { content: truncate(out, 20_000), blocked: false };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, blocked: false };
    }
  }
}
