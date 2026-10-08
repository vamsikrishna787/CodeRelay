import type { InvocationRecord } from '../metrics/cost.js';
import type { RiskAssessment } from '../metrics/risk.js';
import type { LLMProvider } from '../providers/provider.js';
import type { Message } from '../types.js';
import { messageTokens, newId, truncate } from '../util.js';
import type { SessionStore } from './store.js';

export type TaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  agent?: string;
  capabilities?: string[];
  dependsOn: string[];
  status: TaskStatus;
  attempts: number;
  output?: string;
  error?: string;
  assignedAgent?: string;
  instanceId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
  summary?: string;
  taskStatuses: Record<string, TaskStatus>;
}

export interface SessionState {
  id: string;
  title: string;
  goal?: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  /** Rolling summary of messages that were compacted out of the active window. */
  summary?: string;
  /** Active context window (full history lives in the event log). */
  messages: Message[];
  tasks: TaskRecord[];
  checkpoints: Checkpoint[];
  invocations: InvocationRecord[];
  risks: RiskAssessment[];
  compactions: number;
  metadata: Record<string, unknown>;
}

export type SessionEvent =
  | { type: 'message'; at: string; message: Message }
  | { type: 'compaction'; at: string; removed: number; summary: string }
  | { type: 'checkpoint'; at: string; checkpoint: Checkpoint }
  | { type: 'task'; at: string; task: TaskRecord }
  | { type: 'invocation'; at: string; record: InvocationRecord }
  | { type: 'risk'; at: string; assessment: RiskAssessment }
  | { type: 'status'; at: string; status: SessionState['status'] }
  | { type: 'note'; at: string; text: string };

export interface CompactionOptions {
  /** Compact when the active window exceeds this many (estimated) tokens. Default 24k. */
  maxContextTokens?: number;
  /** Messages always kept verbatim at the end of the window. Default 12. */
  keepRecent?: number;
  provider?: LLMProvider;
  model?: string;
}

/**
 * A long-running, resumable work session. State survives restarts, the context
 * window is compacted into a rolling summary, and every event is journaled.
 */
export class Session {
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    readonly state: SessionState,
    private readonly store: SessionStore,
  ) {}

  static async create(store: SessionStore, opts: { title?: string; goal?: string; id?: string; metadata?: Record<string, unknown> } = {}): Promise<Session> {
    const now = new Date().toISOString();
    const session = new Session(
      {
        id: opts.id ?? newId('ses'),
        title: opts.title ?? opts.goal?.slice(0, 80) ?? 'Untitled session',
        goal: opts.goal,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        messages: [],
        tasks: [],
        checkpoints: [],
        invocations: [],
        risks: [],
        compactions: 0,
        metadata: opts.metadata ?? {},
      },
      store,
    );
    await session.save();
    return session;
  }

  static async load(store: SessionStore, id: string): Promise<Session> {
    const state = await store.load(id);
    if (!state) throw new Error(`Session not found: ${id}`);
    return new Session(state, store);
  }

  static async loadOrCreate(store: SessionStore, id: string | undefined, opts: { title?: string; goal?: string } = {}): Promise<Session> {
    if (id) {
      const state = await store.load(id);
      if (state) return new Session(state, store);
    }
    return Session.create(store, { ...opts, id });
  }

  get id(): string {
    return this.state.id;
  }

  async append(message: Message): Promise<void> {
    const stamped = { ...message, timestamp: message.timestamp ?? new Date().toISOString() };
    this.state.messages.push(stamped);
    await this.log({ type: 'message', at: stamped.timestamp, message: stamped });
  }

  async note(text: string): Promise<void> {
    await this.log({ type: 'note', at: new Date().toISOString(), text });
  }

  recordInvocation(record: InvocationRecord): void {
    this.state.invocations.push(record);
    void this.log({ type: 'invocation', at: record.startedAt, record });
  }

  recordRisk(assessment: RiskAssessment): void {
    this.state.risks.push(assessment);
    void this.log({ type: 'risk', at: assessment.timestamp, assessment });
  }

  async updateTask(task: TaskRecord): Promise<void> {
    await this.log({ type: 'task', at: new Date().toISOString(), task: { ...task } });
    await this.save();
  }

  async setStatus(status: SessionState['status']): Promise<void> {
    this.state.status = status;
    await this.log({ type: 'status', at: new Date().toISOString(), status });
    await this.save();
  }

  async checkpoint(label: string): Promise<Checkpoint> {
    const cp: Checkpoint = {
      id: newId('cp'),
      label,
      createdAt: new Date().toISOString(),
      messageCount: this.state.messages.length,
      summary: this.state.summary,
      taskStatuses: Object.fromEntries(this.state.tasks.map((t) => [t.id, t.status])),
    };
    this.state.checkpoints.push(cp);
    await this.log({ type: 'checkpoint', at: cp.createdAt, checkpoint: cp });
    await this.save();
    return cp;
  }

  contextTokens(): number {
    return this.state.messages.reduce((n, m) => n + messageTokens(m), 0) + (this.state.summary ? messageTokens({ role: 'system', content: this.state.summary }) : 0);
  }

  /** Messages to send to a model: the rolling summary (if any) followed by the active window. */
  contextWindow(): Message[] {
    const head: Message[] = this.state.summary
      ? [{ role: 'system', content: `Summary of earlier work in this session:\n${this.state.summary}` }]
      : [];
    return [...head, ...this.state.messages];
  }

  /** A compact text brief for re-hydrating a fresh chat (e.g. a new Copilot conversation). */
  brief(maxChars = 6000): string {
    const lines = [`# Session ${this.id}: ${this.state.title}`, `Status: ${this.state.status}`];
    if (this.state.goal) lines.push(`Goal: ${this.state.goal}`);
    if (this.state.summary) lines.push('', '## Summary so far', this.state.summary);
    if (this.state.tasks.length) {
      lines.push('', '## Tasks');
      for (const t of this.state.tasks) lines.push(`- [${t.status}] ${t.id} ${t.title}${t.assignedAgent ? ` (${t.assignedAgent})` : ''}`);
    }
    const recent = this.state.messages.slice(-8);
    if (recent.length) {
      lines.push('', '## Recent activity');
      for (const m of recent) lines.push(`- ${m.name ?? m.role}: ${truncate(m.content.replace(/\s+/g, ' '), 300)}`);
    }
    return truncate(lines.join('\n'), maxChars);
  }

  /**
   * Fold older messages into the rolling summary when the window is too large.
   * Uses the provider for an abstractive summary, or an extractive fallback without one.
   * Returns true if compaction happened.
   */
  async compact(opts: CompactionOptions = {}): Promise<boolean> {
    const max = opts.maxContextTokens ?? 24_000;
    const keep = opts.keepRecent ?? 12;
    if (this.contextTokens() <= max || this.state.messages.length <= keep) return false;

    let cut = this.state.messages.length - keep;
    // Never orphan tool results from the assistant message that requested them.
    while (cut > 0 && this.state.messages[cut]?.role === 'tool') cut--;
    if (cut <= 0) return false;

    const old = this.state.messages.slice(0, cut);
    const transcript = old.map((m) => `${m.name ?? m.role}: ${truncate(m.content, 2000)}`).join('\n');
    let summary: string;
    if (opts.provider && opts.model) {
      const res = await opts.provider.complete({
        model: opts.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'CODERELAY_SUMMARIZER. Summarize this work session for seamless continuation. Keep: goals, decisions and their reasons, ' +
              'files/components touched, results, open problems and next steps. Be dense; use bullet points.',
          },
          { role: 'user', content: `${this.state.summary ? `Previous summary:\n${this.state.summary}\n\n` : ''}New transcript:\n${transcript}` },
        ],
      });
      summary = res.message.content.trim();
    } else {
      const bullets = old.map((m) => `- ${m.name ?? m.role}: ${truncate(m.content.replace(/\s+/g, ' '), 200)}`);
      summary = [this.state.summary, ...bullets].filter(Boolean).join('\n');
      summary = summary.length > 8000 ? summary.slice(summary.length - 8000) : summary;
    }

    this.state.summary = summary;
    this.state.messages = this.state.messages.slice(cut);
    this.state.compactions++;
    await this.log({ type: 'compaction', at: new Date().toISOString(), removed: cut, summary });
    await this.save();
    return true;
  }

  events(): Promise<SessionEvent[]> {
    return this.store.readEvents(this.id);
  }

  /** Serialized save: concurrent callers never interleave writes. */
  save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(this.state);
    this.saving = this.saving.catch(() => undefined).then(() => this.store.save(snapshot));
    return this.saving;
  }

  private log(event: SessionEvent): Promise<void> {
    return this.store.appendEvent(this.id, event).catch(() => undefined);
  }
}
