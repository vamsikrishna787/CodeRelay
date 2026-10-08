import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RiskDecision, RiskLevel, Thresholds } from './risk.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Task {
  id: string;
  agent: string;
  title: string;
  dependsOn: string[];
  status: TaskStatus;
  /** Implementation attempt (1–maxAttempts) this task belongs to. */
  attempt: number;
  runs: number;
  model?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  files?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  riskScore?: number;
  /** Changed-file fingerprints when the task began (to attribute changes). */
  baseline?: Record<string, string>;
}

/**
 * goal → plan → (questions / feedback) → approval → implement → verify → achieved,
 * or back to implement for another attempt until maxAttempts.
 */
export type GoalPhase = 'planning' | 'awaiting-approval' | 'implementing' | 'achieved' | 'failed';

export interface Verification {
  at: string;
  attempt: number;
  passed: boolean;
  evidence: string;
}

export interface Goal {
  id: string;
  /** The user's words. */
  request: string;
  /** What "done" means, in one sentence. */
  statement: string;
  /** Checkable success criteria used for verification. */
  criteria: string[];
  phase: GoalPhase;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  approvedAt?: string;
  endedAt?: string;
  tasks: Task[];
  verifications: Verification[];
}

/** One agent run (an orchestrator turn or a spawned specialist). */
export interface Invocation {
  id: string;
  agent: string;
  goalId?: string;
  taskId?: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  premiumRequests: number;
  costUsd: number;
  tokens?: number;
  outcome: 'done' | 'failed' | 'turn';
}

export interface RiskEvent {
  id: string;
  at: string;
  source: 'command' | 'code';
  goalId?: string;
  taskId?: string;
  agent?: string;
  target: string;
  score: number;
  level: RiskLevel;
  decision: RiskDecision;
  findings: string[];
}

/** A long-running session: many goals over days, one at a time. */
export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  goals: Goal[];
  invocations: Invocation[];
  risks: RiskEvent[];
  notes: Array<{ at: string; goalId?: string; text: string }>;
}

export function currentGoal(session: Session | undefined): Goal | undefined {
  const last = session?.goals.at(-1);
  return last && last.phase !== 'achieved' && last.phase !== 'failed' ? last : undefined;
}

export interface Config {
  /** Premium requests per agent run, by Copilot model (substring match, case-insensitive). */
  models: Record<string, number>;
  defaultModel: string;
  /** USD per premium request (Copilot overage price). */
  premiumRequestUsd: number;
  budget: { maxPremiumRequests?: number; maxUsd?: number };
  risk: Thresholds;
  /** Implement → verify attempts per goal before giving up. */
  maxAttempts: number;
}

export const DEFAULT_CONFIG: Config = {
  models: { 'gpt-4.1': 0, 'gpt-4o': 0, 'gpt-5-mini': 0, default: 1 },
  defaultModel: 'default',
  premiumRequestUsd: 0.04,
  budget: { maxPremiumRequests: 300 },
  risk: { review: 50, block: 80 },
  maxAttempts: 5,
};

export const DIR = '.coderelay';

export function paths(root: string) {
  const dir = path.join(root, DIR);
  return {
    dir,
    state: path.join(dir, 'state.json'),
    config: path.join(dir, 'config.json'),
    session: path.join(dir, 'SESSION.md'),
    report: path.join(dir, 'REPORT.md'),
    history: path.join(dir, 'history'),
    lock: path.join(dir, '.lock'),
  };
}

/** Walk up from `start` to the folder that owns `.coderelay` (else nearest .git / package.json, else start). */
export function findRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  let fallback: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, DIR))) return dir;
    if (!fallback && (existsSync(path.join(dir, '.git')) || existsSync(path.join(dir, 'package.json')))) fallback = dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback ?? path.resolve(start);
    dir = parent;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function loadConfig(root: string): Config {
  const p = paths(root).config;
  if (!existsSync(p)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>;
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    models: { ...DEFAULT_CONFIG.models, ...raw.models },
    budget: { ...raw.budget },
    risk: { ...DEFAULT_CONFIG.risk, ...raw.risk },
  };
}

export function loadSession(root: string): Session | undefined {
  const p = paths(root).state;
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Session) : undefined;
}

export function saveSession(root: string, session: Session): void {
  const p = paths(root);
  mkdirSync(p.dir, { recursive: true });
  session.updatedAt = now();
  const tmp = `${p.state}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  renameWithRetry(tmp, p.state);
}

export function archiveSession(root: string, session: Session): string {
  const p = paths(root);
  mkdirSync(p.history, { recursive: true });
  const file = path.join(p.history, `${session.createdAt.slice(0, 10)}_${session.id}.json`);
  writeFileSync(file, JSON.stringify(session, null, 2));
  if (existsSync(p.state)) unlinkSync(p.state);
  return file;
}

/** Premium requests consumed by one run of `model` (falls back to `default`). */
export function premiumFor(config: Config, model: string): number {
  const m = model.toLowerCase();
  const key = Object.keys(config.models)
    .filter((k) => k !== 'default' && m.includes(k.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  return config.models[key ?? 'default'] ?? 1;
}

export function totals(session: Session, config: Config) {
  const premiumRequests = round(session.invocations.reduce((s, i) => s + i.premiumRequests, 0));
  const costUsd = round(premiumRequests * config.premiumRequestUsd);
  const tokens = session.invocations.reduce((s, i) => s + (i.tokens ?? 0), 0);
  const durationMs = session.invocations.reduce((s, i) => s + i.durationMs, 0);
  return { invocations: session.invocations.length, premiumRequests, costUsd, tokens, durationMs };
}

/** Budget problems, if any (e.g. "premium requests 312/300"). */
export function budgetExceeded(session: Session, config: Config): string | undefined {
  const t = totals(session, config);
  const { maxPremiumRequests, maxUsd } = config.budget;
  if (maxPremiumRequests !== undefined && t.premiumRequests >= maxPremiumRequests) return `premium requests ${t.premiumRequests}/${maxPremiumRequests}`;
  if (maxUsd !== undefined && t.costUsd >= maxUsd) return `cost $${t.costUsd.toFixed(2)}/$${maxUsd.toFixed(2)}`;
  return undefined;
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Cross-process lock so parallel `coderelay` calls (several subagents finishing
 * at once) never clobber state.json.
 */
export function withLock<T>(root: string, fn: () => T): T {
  const p = paths(root);
  mkdirSync(p.dir, { recursive: true });
  const deadline = Date.now() + 15_000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(p.lock, 'wx');
    } catch {
      try {
        if (Date.now() - statSync(p.lock).mtimeMs > 10_000) unlinkSync(p.lock); // stale
      } catch {
        /* lock vanished — retry */
      }
      if (Date.now() > deadline) throw new Error('Timed out waiting for .coderelay/.lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(p.lock);
    } catch {
      /* already gone */
    }
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** i);
    }
  }
}
