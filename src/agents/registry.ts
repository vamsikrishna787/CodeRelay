import type { AgentDefinition } from './agent.js';

export interface RoutableTask {
  title: string;
  description: string;
  capabilities?: string[];
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'this', 'that', 'it', 'is', 'be']);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9+#.-]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Catalog of agent types and capability-based routing. */
export class AgentRegistry {
  private readonly defs = new Map<string, AgentDefinition>();

  constructor(defs: AgentDefinition[] = []) {
    defs.forEach((d) => this.register(d));
  }

  register(def: AgentDefinition): this {
    if (!/^[\w-]+$/.test(def.name)) throw new Error(`Invalid agent name: ${def.name}`);
    this.defs.set(def.name, def);
    return this;
  }

  get(name: string): AgentDefinition | undefined {
    return this.defs.get(name);
  }

  list(): AgentDefinition[] {
    return [...this.defs.values()];
  }

  /** Score each agent for a task; higher is better. */
  rank(task: RoutableTask): Array<{ agent: AgentDefinition; score: number }> {
    const taskWords = words(`${task.title} ${task.description}`);
    const required = (task.capabilities ?? []).map((c) => c.toLowerCase());
    return this.list()
      .map((agent) => {
        const caps = agent.capabilities.map((c) => c.toLowerCase());
        let score = required.filter((c) => caps.includes(c)).length * 10;
        for (const cap of caps) if (taskWords.has(cap)) score += 3;
        for (const w of words(agent.description)) if (taskWords.has(w)) score += 1;
        return { agent, score };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** Best agent for a task; falls back to `generalist` (or the first agent) when nothing matches. */
  match(task: RoutableTask): AgentDefinition {
    const ranked = this.rank(task);
    if (!ranked.length) throw new Error('No agents registered');
    if (ranked[0].score > 0) return ranked[0].agent;
    return this.get('generalist') ?? ranked[0].agent;
  }

  /** Markdown-ish catalog used in planner prompts. */
  catalog(): string {
    return this.list()
      .map((a) => `- ${a.name}: ${a.description} [capabilities: ${a.capabilities.join(', ')}]`)
      .join('\n');
  }
}
