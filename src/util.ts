import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Message } from './types.js';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Cheap token estimate (~4 chars/token). Providers may supply exact counts instead. */
export function estimateTokens(text: string | undefined): number {
  return Math.ceil((text ?? '').length / 4);
}

export function messageTokens(m: Message): number {
  return estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 4;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  if (!ms || ms <= 0) return promise;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** Pull the first JSON object/array out of model output (handles ```json fences and prose). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fence ? [fence[1], text] : [text];
  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const open = candidate[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error('No valid JSON found in model output');
}

/** Minimal strongly-typed event emitter. */
export class TypedEmitter<Events extends Record<string, unknown>> {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  off<K extends keyof Events & string>(event: K, listener: (payload: Events[K]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  protected emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    this.emitter.emit(event, payload);
  }
}
