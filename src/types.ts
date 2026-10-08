export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  /** Agent or tool name that produced the message. */
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export interface CompletionResponse {
  message: Message;
  usage: Usage;
  model: string;
  finishReason: FinishReason;
  /** Copilot-style premium requests consumed, when the provider knows it. */
  premiumRequests?: number;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
