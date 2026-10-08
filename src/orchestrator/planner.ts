import type { AgentRegistry } from '../agents/registry.js';
import type { CompletionRequest, CompletionResponse } from '../types.js';
import { extractJson } from '../util.js';

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  /** Agent name; omitted = route by capabilities. */
  agent?: string;
  capabilities?: string[];
  dependsOn?: string[];
}

export interface Plan {
  tasks: PlannedTask[];
  rationale?: string;
}

export interface PlannerContext {
  registry: AgentRegistry;
  model: string;
  /** Tracked model call (cost + risk recorded as agent `planner`). */
  invoke(request: Omit<CompletionRequest, 'model'> & { model?: string }): Promise<CompletionResponse>;
  /** Brief of the session so far, for follow-up goals in a long-running session. */
  sessionBrief?: string;
}

export interface Planner {
  plan(goal: string, ctx: PlannerContext): Promise<Plan>;
}

/** Asks a model to decompose the goal into a dependency graph of agent tasks. */
export class LLMPlanner implements Planner {
  constructor(private readonly opts: { maxTasks?: number; model?: string } = {}) {}

  async plan(goal: string, ctx: PlannerContext): Promise<Plan> {
    const maxTasks = this.opts.maxTasks ?? 8;
    const system = [
      'CODERELAY_PLANNER. You are the orchestrator of a team of software agents.',
      `Break the goal into the smallest set of tasks (at most ${maxTasks}) that fully accomplishes it.`,
      'Use dependsOn so independent tasks run in parallel; a task sees the outputs of its dependencies.',
      'Only deploy the agents that are actually needed. Simple goals should be a single task.',
      'Available agents:',
      ctx.registry.catalog(),
      '',
      'Respond with JSON only, no prose:',
      '{"rationale":"...","tasks":[{"id":"t1","title":"...","description":"precise instructions","agent":"<agent name>","dependsOn":[]}]}',
    ].join('\n');

    const user = ctx.sessionBrief ? `Session so far:\n${ctx.sessionBrief}\n\nNew goal:\n${goal}` : goal;
    const res = await ctx.invoke({ model: this.opts.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });

    try {
      const parsed = extractJson(res.message.content) as Partial<Plan>;
      if (!Array.isArray(parsed.tasks) || !parsed.tasks.length) throw new Error('empty task list');
      return { rationale: parsed.rationale, tasks: parsed.tasks.slice(0, maxTasks) };
    } catch {
      // Unparseable plan: degrade gracefully to a single routed task.
      return new SingleTaskPlanner().plan(goal, ctx);
    }
  }
}

/** One task, routed to the best-matching agent. */
export class SingleTaskPlanner implements Planner {
  async plan(goal: string, ctx: PlannerContext): Promise<Plan> {
    const task = { title: goal.slice(0, 80), description: goal };
    return { tasks: [{ id: 't1', ...task, agent: ctx.registry.match(task).name, dependsOn: [] }] };
  }
}

/** Fixed plan supplied by the caller. */
export class StaticPlanner implements Planner {
  constructor(private readonly fixed: Plan | PlannedTask[]) {}
  async plan(): Promise<Plan> {
    return Array.isArray(this.fixed) ? { tasks: this.fixed } : this.fixed;
  }
}

/**
 * Normalize a plan: unique ids (optionally prefixed), known dependencies only,
 * unknown agents dropped (they get routed), and no dependency cycles.
 */
export function validatePlan(plan: Plan, registry: AgentRegistry, idPrefix = ''): PlannedTask[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const idMap = new Map<string, string>();
  plan.tasks.forEach((t, i) => {
    const original = String(t.id ?? `t${i + 1}`);
    let id = original.replace(/[^\w-]/g, '') || `t${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    ids.push(`${idPrefix}${id}`);
    if (!idMap.has(original)) idMap.set(original, ids[i]);
  });

  const tasks: PlannedTask[] = plan.tasks.map((t, i) => {
    const id = ids[i];
    return {
      id,
      title: String(t.title ?? t.description ?? id).slice(0, 120),
      description: String(t.description ?? t.title ?? ''),
      agent: t.agent && registry.get(t.agent) ? t.agent : undefined,
      capabilities: Array.isArray(t.capabilities) ? t.capabilities.map(String) : undefined,
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : [])
        .map((d) => idMap.get(String(d)))
        .filter((d): d is string => Boolean(d) && d !== id),
    };
  });

  // Cycle check (DFS).
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new Error(`Plan has a dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  tasks.forEach((t) => visit(t.id, []));
  return tasks;
}
