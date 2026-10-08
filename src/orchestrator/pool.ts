import type { Agent, AgentDefinition } from '../agents/agent.js';
import { newId, TypedEmitter } from '../util.js';

export interface PoolEvents extends Record<string, unknown> {
  'agent:spawned': { agent: string; instanceId: string; live: number; reason: string };
  'agent:retired': { agent: string; instanceId: string; live: number; tasksRun: number };
}

export interface PoolStats {
  maxConcurrency: number;
  active: number;
  queued: number;
  live: number;
  spawned: number;
  retired: number;
  peakConcurrency: number;
  byAgent: Record<string, { live: number; busy: number; spawned: number; tasksRun: number }>;
}

interface Instance {
  agent: Agent;
  def: AgentDefinition;
  busy: boolean;
  tasksRun: number;
  timer?: NodeJS.Timeout;
}

export interface Lease {
  agent: Agent;
  release(): void;
}

export interface AgentPoolOptions {
  /** Max agents working at the same time across all types. Default 4. */
  maxConcurrency?: number;
  /** Retire instances idle for this long. Default 60s. */
  idleTimeoutMs?: number;
}

/**
 * Deploys agent instances on demand: an instance is spawned only when a task needs
 * that agent type and no idle instance exists, capped per type (`maxInstances`) and
 * globally (`maxConcurrency`). Idle instances are retired after `idleTimeoutMs`.
 */
export class AgentPool extends TypedEmitter<PoolEvents> {
  private readonly instances = new Map<string, Instance[]>();
  private readonly waiters: Array<{ def: AgentDefinition; resolve: (lease: Lease) => void }> = [];
  private readonly spawnedByAgent = new Map<string, number>();
  private readonly maxConcurrency: number;
  private readonly idleTimeoutMs: number;
  private active = 0;
  private spawned = 0;
  private retired = 0;
  private peak = 0;

  constructor(
    private readonly factory: (def: AgentDefinition, instanceId: string) => Agent,
    opts: AgentPoolOptions = {},
  ) {
    super();
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  }

  acquire(def: AgentDefinition): Promise<Lease> {
    return new Promise((resolve) => {
      this.waiters.push({ def, resolve });
      this.pump();
    });
  }

  stats(): PoolStats {
    const byAgent: PoolStats['byAgent'] = {};
    let live = 0;
    for (const [name, list] of this.instances) {
      live += list.length;
      byAgent[name] = {
        live: list.length,
        busy: list.filter((i) => i.busy).length,
        spawned: this.spawnedByAgent.get(name) ?? 0,
        tasksRun: list.reduce((n, i) => n + i.tasksRun, 0),
      };
    }
    for (const [name, n] of this.spawnedByAgent) byAgent[name] ??= { live: 0, busy: 0, spawned: n, tasksRun: 0 };
    return {
      maxConcurrency: this.maxConcurrency,
      active: this.active,
      queued: this.waiters.length,
      live,
      spawned: this.spawned,
      retired: this.retired,
      peakConcurrency: this.peak,
      byAgent,
    };
  }

  /** Retire every idle instance and stop idle timers. */
  shutdown(): void {
    for (const list of this.instances.values()) {
      for (const inst of [...list]) if (!inst.busy) this.retire(inst);
    }
  }

  private pump(): void {
    for (let i = 0; i < this.waiters.length && this.active < this.maxConcurrency; ) {
      const waiter = this.waiters[i];
      const inst = this.take(waiter.def);
      if (!inst) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      let released = false;
      waiter.resolve({
        agent: inst.agent,
        release: () => {
          if (released) return;
          released = true;
          this.release(inst);
        },
      });
    }
  }

  private take(def: AgentDefinition): Instance | undefined {
    const list = this.instances.get(def.name) ?? [];
    const idle = list.find((i) => !i.busy);
    if (idle) {
      clearTimeout(idle.timer);
      idle.busy = true;
      return idle;
    }
    if (list.length >= (def.maxInstances ?? Infinity)) return undefined;

    const instanceId = newId(def.name);
    const inst: Instance = { agent: this.factory(def, instanceId), def, busy: true, tasksRun: 0 };
    list.push(inst);
    this.instances.set(def.name, list);
    this.spawned++;
    this.spawnedByAgent.set(def.name, (this.spawnedByAgent.get(def.name) ?? 0) + 1);
    const queuedSame = this.waiters.filter((w) => w.def.name === def.name).length;
    this.emit('agent:spawned', {
      agent: def.name,
      instanceId,
      live: list.length,
      reason: list.length === 1 ? 'first task for this agent type' : `scale-out: ${queuedSame} ${def.name} task(s) waiting, no idle instance`,
    });
    return inst;
  }

  private release(inst: Instance): void {
    inst.busy = false;
    inst.tasksRun++;
    this.active--;
    if (this.idleTimeoutMs >= 0) {
      inst.timer = setTimeout(() => {
        if (!inst.busy) this.retire(inst);
      }, this.idleTimeoutMs);
      inst.timer.unref?.();
    }
    this.pump();
  }

  private retire(inst: Instance): void {
    clearTimeout(inst.timer);
    const list = this.instances.get(inst.def.name) ?? [];
    const idx = list.indexOf(inst);
    if (idx === -1) return;
    list.splice(idx, 1);
    this.retired++;
    this.emit('agent:retired', { agent: inst.def.name, instanceId: inst.agent.instanceId, live: list.length, tasksRun: inst.tasksRun });
  }
}
