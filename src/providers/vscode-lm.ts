import type { CompletionRequest, CompletionResponse, Message, ToolCall } from '../types.js';
import { estimateTokens } from '../util.js';
import type { LLMProvider } from './provider.js';

/**
 * Structural subset of the `vscode` module used by this adapter, so the package
 * does not depend on `@types/vscode`. Pass the real `vscode` import at runtime.
 */
export interface VSCodeLike {
  LanguageModelChatMessage: {
    User(content: string | unknown[]): unknown;
    Assistant(content: string | unknown[]): unknown;
  };
  LanguageModelTextPart: new (value: string) => unknown;
  LanguageModelToolCallPart: new (callId: string, name: string, input: object) => unknown;
  LanguageModelToolResultPart: new (callId: string, content: unknown[]) => unknown;
  CancellationTokenSource: new () => { token: unknown; cancel(): void; dispose(): void };
}

export interface VSCodeChatModelLike {
  id: string;
  name?: string;
  family?: string;
  sendRequest(
    messages: unknown[],
    options?: { tools?: Array<{ name: string; description: string; inputSchema?: object }>; justification?: string },
    token?: unknown,
  ): Thenable<{ stream: AsyncIterable<unknown> }>;
  countTokens?(text: string, token?: unknown): Thenable<number>;
}

type Thenable<T> = PromiseLike<T>;

export interface VSCodeLMProviderOptions {
  vscode: VSCodeLike;
  /** A model from `vscode.lm.selectChatModels({ vendor: 'copilot', ... })`. */
  model: VSCodeChatModelLike;
  /** Premium-request multiplier for this Copilot model (defaults to 1). */
  premiumMultiplier?: number;
  justification?: string;
}

/**
 * Runs agents on GitHub Copilot models from inside a VS Code extension via the
 * Language Model API (`vscode.lm`). Each request counts as Copilot premium requests.
 */
export class VSCodeLMProvider implements LLMProvider {
  readonly name = 'vscode-copilot';
  private readonly opts: VSCodeLMProviderOptions;

  constructor(opts: VSCodeLMProviderOptions) {
    this.opts = opts;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const { vscode, model } = this.opts;
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    request.signal?.addEventListener('abort', onAbort);

    try {
      const messages = request.messages.map((m) => this.toVSCodeMessage(m));
      const response = await model.sendRequest(
        messages,
        {
          justification: this.opts.justification,
          tools: request.tools?.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        },
        cts.token,
      );

      let text = '';
      const toolCalls: ToolCall[] = [];
      for await (const part of response.stream) {
        if (isToolCallPart(part)) {
          toolCalls.push({ id: part.callId, name: part.name, arguments: (part.input ?? {}) as Record<string, unknown> });
        } else if (part && typeof part === 'object' && typeof (part as { value?: unknown }).value === 'string') {
          text += (part as { value: string }).value;
        }
      }

      const promptText = request.messages.map((m) => m.content).join('\n');
      const [inputTokens, outputTokens] = await Promise.all([this.count(promptText), this.count(text)]);

      return {
        model: model.id,
        message: { role: 'assistant', content: text, toolCalls: toolCalls.length ? toolCalls : undefined },
        usage: { inputTokens, outputTokens },
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
        premiumRequests: this.opts.premiumMultiplier ?? 1,
      };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }

  private async count(text: string): Promise<number> {
    if (!text) return 0;
    try {
      return this.opts.model.countTokens ? await this.opts.model.countTokens(text) : estimateTokens(text);
    } catch {
      return estimateTokens(text);
    }
  }

  private toVSCodeMessage(m: Message): unknown {
    const { vscode } = this.opts;
    const Msg = vscode.LanguageModelChatMessage;
    switch (m.role) {
      case 'system':
        // The LM API has no system role; prefix so the model still treats it as instructions.
        return Msg.User(`[instructions]\n${m.content}`);
      case 'user':
        return Msg.User(m.content);
      case 'assistant': {
        if (!m.toolCalls?.length) return Msg.Assistant(m.content);
        const parts: unknown[] = [];
        if (m.content) parts.push(new vscode.LanguageModelTextPart(m.content));
        for (const tc of m.toolCalls) parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.arguments));
        return Msg.Assistant(parts);
      }
      case 'tool':
        return Msg.User([
          new vscode.LanguageModelToolResultPart(m.toolCallId ?? '', [new vscode.LanguageModelTextPart(m.content)]),
        ]);
    }
  }
}

function isToolCallPart(part: unknown): part is { callId: string; name: string; input: unknown } {
  return Boolean(part && typeof part === 'object' && 'callId' in part && 'name' in part && 'input' in part);
}
