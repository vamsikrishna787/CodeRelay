import path from 'node:path';
import { Agent, type AgentDefinition } from '../agents/agent.js';
import { defaultAgents } from '../agents/defaults.js';
import { InvocationGateway } from '../agents/gateway.js';
import { AgentRegistry } from '../agents/registry.js';
import type { Tool } from '../agents/tools.js';
import { BudgetExceededError, CostTracker, type Budget, type CostEvents, type InvocationRecord } from '../metrics/cost.js';
import { PricingTable, type ModelPrice } from '../metrics/pricing.js';
import { buildReport, type MetricsReport } from '../metrics/report.js';
import { RiskEngine, type RiskAssessment, type RiskPolicy } from '../metrics/risk.js';
import type { LLMProvider } from '../providers/provider.js';
import { Session, type TaskRecord } from '../session/session.js';
import { FileSessionStore, type SessionStore } from '../session/store.js';
import type { Message } from '../types.js';
import { TimeoutError, truncate, TypedEmitter, withTimeout } from '../util.js';
import { LLMPlanner, validatePlan, type Plan, type Planner } from './planner.js';
import { AgentPool, type PoolEvents, type PoolStats } from './pool.js';

export interface OrchestratorOptions {
  /** One provider, or several keyed by name (agents pick one via `provider`; `default` is the fallback). */
  provider: LLMProvider | Record<string, LLMProvider>;
  /** Default model id for agents without their own. */
  model: string;
  /** Model for planning/synthesis/summaries (defaults to `model`). */
  orchestratorModel?: string;
  agents?: AgentDefinition[];
  tools?: Tool[];
  planner?: Planner;
  store?: SessionStore;
  pricing?: PricingTable | Record<string, ModelPrice>;
  /** Budget for the whole session (persisted spend counts on resume). */
  budget?: Budget;
  risk?: RiskPolicy;
  /** Max agents working at once. Default 4. */
  maxConcurrency?: number;
  /** Retries per task after the first attempt. Default 1. */
  taskRetries?: number;
  /** Per-attempt task timeout. Default 15 minutes. */
  taskTimeoutMs?: number;
  /** Retire agent instances idle this long. Default 60s. */
  idleTimeoutMs?: number;
  workspaceRoot?: string;
  /** Context compaction for the long-running session; `false` disables it. */
  compaction?: { maxContextTokens?: number; keepRecent?: number } | false;
  /** Merge task outputs into one final answer with an extra model call. Default true. */
  synthesize?: boolean;
  /** Chars of each dependency output passed to downstream tasks. Default 6000. */
  maxDependencyChars?: number;
}

export interface RunOptions {
  /** Continue an existing session (new goal becomes a new round of tasks). */
  sessionId?: string;
  title?: string;
  /** Skip planning and use this plan. */
  plan?: Plan;
}

export interface RunResult {
  sessionId: string;
  status: 'completed' | 'failed' | 'paused';
  output: string;
  tasks: TaskRecord[];
  report: MetricsReport;
  /** Set when the run stopped early (budget, cancellation). */
  stopReason?: string;
}

export interface OrchestratorEvents extends Record<string, unknown> {
  'session:started': { sessionId: string; resumed: boolean };
  'plan:created': { sessionId: string; tasks: TaskRecord[]; rationale?: string };
  'task:started': { sessionId: string; task: TaskRecord; agent: string; instanceId: string; attempt: number };
  'task:completed': { sessionId: string; task: TaskRecord; turns: number; toolCalls: number; blockedToolCalls: number };
  'task:failed': { sessionId: string; task: TaskRecord; error: string; willRetry: boolean };
  'task:skipped': { sessionId: string; task: TaskRecord; reason: string };
  'agent:spawned': PoolEvents['agent:spawned'];
  'agent:retired': PoolEvents['agent:retired'];
  invocation: InvocationRecord;
  risk: RiskAssessment;
  'risk:blocked': RiskAssessment;
  'budget:warning': CostEvents['budget:warning'];
  'budget:exceeded': CostEvents['budget:exceeded'];
  'session:compacted': { sessionId: string; compactions: number };
  'run:completed': RunResult;
}

interface RunContext {
  session: Session;
  cost: CostTracker;
  risk: RiskEngine;
  gateway: InvocationGateway;
  pool: AgentPool;
  abort: AbortController;
  stopReason?: string;
}

const TERMINAL = new Set(['completed', 'failed', 'skipped', 'cancelled']);

/**
 * Plans a goal into a task DAG, deploys agents on demand to run it in parallel,
 * tracks cost and risk for every invocation, and persists everything to a
 * resumable long-running session.
 */
export class Orchestrator extends TypedEmitter<OrchestratorEvents> {
  readonly registry: AgentRegistry;
  readonly store: SessionStore;
  private readonly opts: OrchestratorOptions;
  private readonly providers: Record<string, LLMProvider>;
  private readonly pricing: PricingTable;
  private readonly planner: Planner;
  private readonly tools: Tool[];
  private readonly workspaceRoot: string;
  private current?: RunContext;
  private lastPoolStats?: PoolStats;

  constructor(opts: OrchestratorOptions) {
    super();
    this.opts = opts;
    this.providers = isProvider(opts.provider) ? { default: opts.provider } : { ...opts.provider };
    if (!this.providers.default) this.providers.default = Object.values(this.providers)[0];
    if (!this.providers.default) throw new Error('Orchestrator needs at least one provider');
    this.registry = new AgentRegistry(opts.agents ?? defaultAgents);
    this.store = opts.store ?? new FileSessionStore();
    this.pricing = opts.pricing instanceof PricingTable ? opts.pricing : new PricingTable(opts.pricing ?? {});
    this.planner = opts.planner ?? new LLMPlanner();
    this.tools = opts.tools ?? [];
    this.workspaceRoot = path.resolve(opts.workspaceRoot ?? opts.risk?.workspaceRoot ?? process.cwd());
  }

  /** Plan and execute a goal. Pass `sessionId` to continue a long-running session. */
  async run(goal: string, opts: RunOptions = {}): Promise<RunResult> {
    const existing = opts.sessionId ? await this.store.load(opts.sessionId) : undefined;
    const session = await Session.loadOrCreate(this.store, opts.sessionId, { goal, title: opts.title });
    session.state.goal ??= goal;
    this.emit('session:started', { sessionId: session.id, resumed: Boolean(existing) });
    const rc = this.createRunContext(session);

    const round = Number(session.state.metadata.rounds ?? 0) + 1;
    session.state.metadata.rounds = round;
    await session.append({ role: 'user', content: goal });

    let plan: Plan;
    try {
      plan =
        opts.plan ??
        (await this.planner.plan(goal, {
          registry: this.registry,
          model: this.orchestratorModel,
          sessionBrief: existing ? session.brief(3000) : undefined,
          invoke: (req) => rc.gateway.invoke(this.providers.default, { ...req, model: req.model ?? this.orchestratorModel }, { agent: 'planner', sessionId: session.id }),
        }));
    } catch (err) {
      return this.finish(rc, [], err instanceof BudgetExceededError ? err.message : `Planning failed: ${errorText(err)}`);
    }

    const planned = validatePlan(plan, this.registry, round > 1 ? `r${round}-` : '');
    const tasks: TaskRecord[] = planned.map((t) => ({ ...t, dependsOn: t.dependsOn ?? [], status: 'pending', attempts: 0 }));
    session.state.tasks.push(...tasks);
    await session.note(`Plan (round ${round}): ${plan.rationale ?? ''}`);
    this.emit('plan:created', { sessionId: session.id, tasks, rationale: plan.rationale });
    await session.checkpoint(`plan round ${round}`);

    await this.execute(rc, tasks);
    return this.finish(rc, tasks);
  }

  /** Continue unfinished (and by default failed/cancelled) tasks of a saved session. */
  async resume(sessionId: string, opts: { retryFailed?: boolean } = {}): Promise<RunResult> {
    const session = await Session.load(this.store, sessionId);
    this.emit('session:started', { sessionId, resumed: true });
    const rc = this.createRunContext(session);
    const retry = opts.retryFailed ?? true;

    for (const t of session.state.tasks) {
      if (t.status === 'running' || t.status === 'queued') t.status = 'pending';
      if (retry && (t.status === 'failed' || t.status === 'cancelled' || t.status === 'skipped')) {
        t.status = 'pending';
        t.attempts = 0;
        t.error = undefined;
      }
    }
    await session.setStatus('active');
    const todo = session.state.tasks.filter((t) => t.status === 'pending');
    await this.execute(rc, todo);
    return this.finish(rc, session.state.tasks);
  }

  /** Stop scheduling new tasks and abort in-flight agent calls. */
  cancel(reason = 'cancelled by user'): void {
    if (!this.current) return;
    this.current.stopReason = reason;
    this.current.abort.abort(new Error(reason));
  }

  /** Cost & risk report for a stored session. */
  async report(sessionId: string): Promise<MetricsReport> {
    const state = await this.store.load(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    return buildReport(state, { budget: this.opts.budget, pool: this.current?.session.id === sessionId ? this.current.pool.stats() : this.lastPoolStats });
  }

  private get orchestratorModel(): string {
    return this.opts.orchestratorModel ?? this.opts.model;
  }

  private createRunContext(session: Session): RunContext {
    const cost = new CostTracker({ pricing: this.pricing, budget: this.opts.budget });
    cost.restore(session.state.invocations);
    const risk = new RiskEngine({ workspaceRoot: this.workspaceRoot, ...this.opts.risk });
    for (const a of session.state.risks) risk.track(a, true);
    const gateway = new InvocationGateway(cost, risk);

    cost.on('invocation', (r) => {
      session.recordInvocation(r);
      this.emit('invocation', r);
    });
    cost.on('budget:warning', (e) => this.emit('budget:warning', e));
    cost.on('budget:exceeded', (e) => this.emit('budget:exceeded', e));
    risk.on('assessed', (a) => {
      if (a.score > 0 || a.decision !== 'allow') session.recordRisk(a);
      this.emit('risk', a);
    });
    risk.on('blocked', (a) => this.emit('risk:blocked', a));

    const pool = new AgentPool((def, instanceId) => this.spawnAgent(def, instanceId, gateway), {
      maxConcurrency: this.opts.maxConcurrency,
      idleTimeoutMs: this.opts.idleTimeoutMs,
    });
    pool.on('agent:spawned', (e) => {
      void session.note(`spawned ${e.instanceId} (${e.reason})`);
      this.emit('agent:spawned', e);
    });
    pool.on('agent:retired', (e) => this.emit('agent:retired', e));

    const rc: RunContext = { session, cost, risk, gateway, pool, abort: new AbortController() };
    this.current = rc;
    return rc;
  }

  private spawnAgent(def: AgentDefinition, instanceId: string, gateway: InvocationGateway): Agent {
    const provider = (def.provider && this.providers[def.provider]) || this.providers.default;
    const allowed = def.tools ?? [];
    const tools = allowed.includes('*') ? this.tools : this.tools.filter((t) => allowed.includes(t.schema.name));
    return new Agent(def, { provider, model: def.model ?? this.opts.model, tools, gateway, instanceId, workspaceRoot: this.workspaceRoot });
  }

  /** Dependency-aware scheduler: dispatches every ready task; the pool enforces concurrency. */
  private async execute(rc: RunContext, tasks: TaskRecord[]): Promise<void> {
    const all = new Map(rc.session.state.tasks.map((t) => [t.id, t]));
    const inflight = new Map<string, Promise<void>>();

    for (;;) {
      for (const t of tasks) {
        if (t.status !== 'pending') continue;
        if (rc.stopReason) {
          t.status = 'cancelled';
          t.error = rc.stopReason;
          await rc.session.updateTask(t);
          continue;
        }
        const deps = t.dependsOn.map((d) => all.get(d));
        const bad = deps.find((d) => d && d.status !== 'completed' && TERMINAL.has(d.status));
        if (bad) {
          t.status = bad.status === 'cancelled' ? 'cancelled' : 'skipped';
          t.error = `dependency ${bad.id} ${bad.status}`;
          this.emit('task:skipped', { sessionId: rc.session.id, task: t, reason: t.error });
          await rc.session.updateTask(t);
          continue;
        }
        if (deps.every((d) => !d || d.status === 'completed') && !inflight.has(t.id)) {
          t.status = 'queued';
          inflight.set(t.id, this.runTask(rc, t, all).finally(() => inflight.delete(t.id)));
        }
      }
      if (!inflight.size) break;
      await Promise.race(inflight.values());
    }
  }

  private async runTask(rc: RunContext, task: TaskRecord, all: Map<string, TaskRecord>): Promise<void> {
    const { session } = rc;
    const def = (task.agent && this.registry.get(task.agent)) || this.registry.match(task);
    task.assignedAgent = def.name;
    const prompt = this.taskPrompt(task, all);
    const context: Message[] = [{ role: 'system', content: `Shared session context (you are one of several agents):\n${session.brief(3000)}` }];
    const retries = this.opts.taskRetries ?? 1;

    for (;;) {
      if (rc.stopReason) {
        task.status = 'cancelled';
        task.error = rc.stopReason;
        break;
      }
      const lease = await rc.pool.acquire(def);
      task.status = 'running';
      task.attempts++;
      task.instanceId = lease.agent.instanceId;
      task.startedAt = new Date().toISOString();
      this.emit('task:started', { sessionId: session.id, task, agent: def.name, instanceId: lease.agent.instanceId, attempt: task.attempts });
      void session.save();

      const attemptAbort = new AbortController();
      const onStop = () => attemptAbort.abort(rc.abort.signal.reason);
      rc.abort.signal.addEventListener('abort', onStop);
      try {
        const result = await withTimeout(
          lease.agent.run(prompt, { taskId: task.id, sessionId: session.id, context, signal: attemptAbort.signal }),
          this.opts.taskTimeoutMs ?? 15 * 60_000,
          `task ${task.id}`,
        );
        task.status = 'completed';
        task.output = result.output;
        task.error = undefined;
        task.completedAt = new Date().toISOString();
        await session.append({ role: 'assistant', name: def.name, content: `[${task.id}] ${task.title}\n${truncate(result.output, 4000)}` });
        this.emit('task:completed', { sessionId: session.id, task, turns: result.turns, toolCalls: result.toolCalls, blockedToolCalls: result.blockedToolCalls });
        break;
      } catch (err) {
        if (err instanceof TimeoutError) attemptAbort.abort(err);
        if (err instanceof BudgetExceededError) {
          rc.stopReason = err.message;
          task.status = 'cancelled';
          task.error = err.message;
          break;
        }
        const willRetry = !rc.stopReason && task.attempts <= retries;
        task.error = errorText(err);
        this.emit('task:failed', { sessionId: session.id, task, error: task.error, willRetry });
        if (!willRetry) {
          task.status = rc.stopReason ? 'cancelled' : 'failed';
          break;
        }
        task.status = 'pending';
      } finally {
        rc.abort.signal.removeEventListener('abort', onStop);
        lease.release();
      }
    }

    await session.updateTask(task);
    await this.maybeCompact(rc);
  }

  private taskPrompt(task: TaskRecord, all: Map<string, TaskRecord>): string {
    const max = this.opts.maxDependencyChars ?? 6000;
    const parts = [`# Task ${task.id}: ${task.title}`, task.description];
    const deps = task.dependsOn.map((d) => all.get(d)).filter((d): d is TaskRecord => Boolean(d?.output));
    if (deps.length) {
      parts.push('', '## Results from tasks this depends on');
      for (const d of deps) parts.push(`### ${d.id} (${d.assignedAgent}): ${d.title}`, truncate(d.output ?? '', max));
    }
    return parts.join('\n');
  }

  private async maybeCompact(rc: RunContext): Promise<void> {
    if (this.opts.compaction === false) return;
    const provider = this.providers.default;
    const tracked: LLMProvider = {
      name: provider.name,
      complete: (req) => rc.gateway.invoke(provider, req, { agent: 'summarizer', sessionId: rc.session.id }),
    };
    try {
      const did = await rc.session.compact({ ...this.opts.compaction, provider: tracked, model: this.orchestratorModel });
      if (did) this.emit('session:compacted', { sessionId: rc.session.id, compactions: rc.session.state.compactions });
    } catch {
      // Compaction is best-effort (e.g. budget exhausted); fall back to extractive summary.
      await rc.session.compact({ ...(this.opts.compaction || {}) }).catch(() => undefined);
    }
  }

  private async finish(rc: RunContext, tasks: TaskRecord[], failure?: string): Promise<RunResult> {
    const { session } = rc;
    const done = tasks.filter((t) => t.status === 'completed');
    const stopReason = failure ?? rc.stopReason;
    let output = '';

    if (done.length > 1 && this.opts.synthesize !== false && !stopReason) {
      try {
        const res = await rc.gateway.invoke(
          this.providers.default,
          {
            model: this.orchestratorModel,
            temperature: 0,
            messages: [
              { role: 'system', content: 'You are the orchestrator. Merge the agents\' task results into one clear final report for the user: what was done, key results, open issues.' },
              { role: 'user', content: `Goal: ${session.state.goal}\n\n${done.map((t) => `## ${t.id} (${t.assignedAgent}) ${t.title}\n${truncate(t.output ?? '', 4000)}`).join('\n\n')}` },
            ],
          },
          { agent: 'orchestrator', sessionId: session.id },
        );
        output = res.message.content;
      } catch {
        // fall through to concatenation
      }
    }
    if (!output) {
      const dependedOn = new Set(tasks.flatMap((t) => t.dependsOn));
      const leaves = done.filter((t) => !dependedOn.has(t.id));
      output = (leaves.length ? leaves : done).map((t) => (done.length > 1 ? `## ${t.title}\n${t.output}` : t.output ?? '')).join('\n\n');
    }
    if (stopReason) output = `${output}\n\n[stopped: ${stopReason}]`.trim();

    const failed = tasks.some((t) => t.status === 'failed' || t.status === 'skipped');
    const status: RunResult['status'] = stopReason && !failure ? 'paused' : failed || failure ? 'failed' : 'completed';
    await session.append({ role: 'assistant', name: 'orchestrator', content: truncate(output, 8000) });
    await this.maybeCompact(rc);
    await session.setStatus(status);
    await session.checkpoint(`run ${status}`);

    this.lastPoolStats = rc.pool.stats();
    rc.pool.shutdown();
    const result: RunResult = {
      sessionId: session.id,
      status,
      output,
      tasks,
      stopReason,
      report: buildReport(session.state, { budget: this.opts.budget, pool: this.lastPoolStats }),
    };
    if (this.current === rc) this.current = undefined;
    this.emit('run:completed', result);
    return result;
  }
}

function isProvider(p: unknown): p is LLMProvider {
  return Boolean(p && typeof (p as LLMProvider).complete === 'function');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
