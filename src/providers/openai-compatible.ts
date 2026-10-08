import type { CompletionRequest, CompletionResponse, FinishReason, Message, ToolCall } from '../types.js';
import { sleep } from '../util.js';
import { ProviderError, type LLMProvider } from './provider.js';

export interface OpenAICompatibleOptions {
  /** Base URL without the trailing `/chat/completions`. */
  baseUrl: string;
  apiKey?: string;
  name?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Works with any OpenAI-style `/chat/completions` endpoint (GitHub Models, Azure, OpenRouter, Ollama, ...). */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly opts: OpenAICompatibleOptions;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.name = opts.name ?? 'openai-compatible';
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: request.model,
      messages: request.messages.map(toWireMessage),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      tools: request.tools?.length
        ? request.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined,
    };

    const maxRetries = this.opts.maxRetries ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.send(body, request);
      } catch (err) {
        lastError = err;
        if (!(err instanceof ProviderError) || !err.retryable || attempt === maxRetries) throw err;
        await sleep(Math.min(30_000, 500 * 2 ** attempt + Math.random() * 250));
      }
    }
    throw lastError;
  }

  private async send(body: unknown, request: CompletionRequest): Promise<CompletionResponse> {
    const doFetch = this.opts.fetch ?? fetch;
    const signals = [AbortSignal.timeout(this.opts.timeoutMs ?? 120_000)];
    if (request.signal) signals.push(request.signal);

    const res = await doFetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`${this.name} HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
    }

    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null; tool_calls?: WireToolCall[] };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };

    const choice = json.choices?.[0];
    if (!choice?.message) throw new ProviderError(`${this.name} returned no choices`);

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseArgs(tc.function.arguments),
    }));

    return {
      model: json.model ?? request.model,
      message: {
        role: 'assistant',
        content: choice.message.content ?? '',
        toolCalls: toolCalls?.length ? toolCalls : undefined,
      },
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens,
      },
      finishReason: mapFinish(choice.finish_reason, Boolean(toolCalls?.length)),
    };
  }
}

/** GitHub Models (OpenAI-compatible) — authenticates with a GitHub token (`models:read` scope). */
export function githubModelsProvider(opts: { token?: string; baseUrl?: string } = {}): OpenAICompatibleProvider {
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('githubModelsProvider requires a token (set GITHUB_TOKEN)');
  return new OpenAICompatibleProvider({
    name: 'github-models',
    baseUrl: opts.baseUrl ?? 'https://models.github.ai/inference',
    apiKey: token,
  });
}

function toWireMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  const wire: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls?.length) {
    wire.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return wire;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function mapFinish(reason: string | undefined, hasTools: boolean): FinishReason {
  if (hasTools || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  return 'stop';
}
