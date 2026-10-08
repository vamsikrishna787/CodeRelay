import path from 'node:path';
import type { RiskLevel } from '../types.js';
import { newId, TypedEmitter } from '../util.js';
import type { InvocationRecord } from './cost.js';

export type ToolRiskClass = 'read' | 'write' | 'exec' | 'network';
export type RiskSubject = 'tool_call' | 'output' | 'invocation';
export type RiskDecision = 'allow' | 'review' | 'block';

export type RiskInput =
  | { subject: 'tool_call'; agent: string; taskId?: string; tool: string; args: Record<string, unknown>; toolRisk?: ToolRiskClass }
  | { subject: 'output'; agent: string; taskId?: string; text: string }
  | { subject: 'invocation'; agent: string; taskId?: string; record: InvocationRecord };

export interface RiskSignal {
  rule: string;
  score: number;
  message: string;
}

export interface RiskAssessment {
  id: string;
  subject: RiskSubject;
  agent: string;
  taskId?: string;
  target: string;
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
  decision: RiskDecision;
  /** Set when a reviewer made the call. */
  reviewedBy?: 'approver' | 'policy';
  timestamp: string;
}

export interface RiskContext {
  workspaceRoot: string;
  history: RiskHistory;
}

export interface RiskRule {
  name: string;
  appliesTo: RiskSubject[];
  evaluate(input: RiskInput, ctx: RiskContext): RiskSignal | RiskSignal[] | null | undefined;
}

export type Approver = (assessment: RiskAssessment, input: RiskInput) => boolean | Promise<boolean>;

export interface RiskPolicy {
  /** Scores at or above this need review (default 50). */
  reviewThreshold?: number;
  /** Scores at or above this are blocked outright (default 80). */
  blockThreshold?: number;
  /**
   * What to do with `review` items: an approver callback, or a fixed answer.
   * Default `'allow'` (logged and surfaced in metrics) so unattended runs proceed.
   */
  onReview?: Approver | 'allow' | 'block';
  workspaceRoot?: string;
  /** Extra rules appended to the built-ins. */
  rules?: RiskRule[];
  /** Replace built-in rules entirely. */
  replaceBuiltinRules?: boolean;
  /** Single invocation cost (USD) considered a spike. Default 0.5. */
  costSpikeUsd?: number;
}

export interface RiskSummary {
  assessments: number;
  byLevel: Record<RiskLevel, number>;
  byDecision: Record<RiskDecision, number>;
  byRule: Record<string, number>;
  byAgent: Record<string, { assessments: number; maxScore: number; blocked: number }>;
  /** 0–100 aggregate: peak score blended with the share of elevated findings. */
  riskIndex: number;
  overallLevel: RiskLevel;
  top: RiskAssessment[];
}

export interface RiskEvents extends Record<string, unknown> {
  assessed: RiskAssessment;
  blocked: RiskAssessment;
  review: RiskAssessment;
}

/** Rolling state that history-aware rules (loops, cost spikes, error rates) read. */
export class RiskHistory {
  readonly toolCalls: string[] = [];
  readonly invocations: InvocationRecord[] = [];
  costSpikeUsd = 0.5;

  repeatCount(fingerprint: string, window = 20): number {
    return this.toolCalls.slice(-window).filter((f) => f === fingerprint).length;
  }
}

export function levelFor(score: number): RiskLevel {
  if (score >= 80) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

const DESTRUCTIVE: Array<[RegExp, number, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\*|\$HOME)(\s|$)/i, 95, 'recursive force delete of root/home'],
  [/\b(mkfs|format\s+[a-z]:|diskpart)\b|\bdd\s+if=/i, 95, 'disk formatting / raw write'],
  [/\brm\s+-[a-z]*r[a-z]*f?|\brm\s+-[a-z]*f[a-z]*r/i, 75, 'recursive delete'],
  [/Remove-Item\b[^\n]*-Recurse|\b(rd|rmdir)\s+\/s\b|\bdel\s+\/[sq]/i, 75, 'recursive delete (Windows)'],
  [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, 85, 'destructive SQL'],
  [/\bdelete\s+from\s+\w+\s*(;|$)/i, 70, 'unbounded SQL DELETE'],
  [/\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease)/i, 70, 'force push'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/i, 60, 'discards git work'],
  [/(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python)/i, 85, 'pipes remote script to shell'],
  [/\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/i, 55, 'broad permission change'],
  [/\b(shutdown|reboot|halt|Stop-Computer|Restart-Computer)\b/i, 80, 'host power operation'],
  [/\b(npm|yarn|pnpm)\s+publish\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+delete\b/i, 70, 'deploy / publish / infra mutation'],
  [/\bsudo\b/i, 45, 'privilege escalation'],
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub token'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/, 'API secret key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'hard-coded credential'],
];

const SENSITIVE_PATHS = /(^|[\\/])(\.env(\.[\w-]+)?|\.ssh|id_rsa|id_ed25519|\.aws[\\/]credentials|\.npmrc|\.netrc|\.git[\\/]config|\.kube[\\/]config)([\\/]|$)/i;

function textOf(input: RiskInput): string {
  if (input.subject === 'output') return input.text;
  if (input.subject === 'tool_call') {
    const cmd = input.args.command ?? input.args.cmd ?? input.args.script;
    return typeof cmd === 'string' ? cmd : JSON.stringify(input.args);
  }
  return '';
}

export const builtinRiskRules: RiskRule[] = [
  {
    name: 'tool-class',
    appliesTo: ['tool_call'],
    evaluate(input) {
      if (input.subject !== 'tool_call' || !input.toolRisk || input.toolRisk === 'read') return null;
      const score = { write: 20, network: 25, exec: 30 }[input.toolRisk];
      return { rule: 'tool-class', score, message: `${input.toolRisk} tool "${input.tool}"` };
    },
  },
  {
    name: 'destructive-command',
    appliesTo: ['tool_call', 'output'],
    evaluate(input) {
      if (input.subject === 'output') return null;
      const text = textOf(input);
      const hits = DESTRUCTIVE.filter(([re]) => re.test(text));
      if (!hits.length) return null;
      const [, score, why] = hits.reduce((a, b) => (b[1] > a[1] ? b : a));
      return { rule: 'destructive-command', score, message: `${why}: ${text.slice(0, 120)}` };
    },
  },
  {
    name: 'secret-exposure',
    appliesTo: ['tool_call', 'output'],
    evaluate(input) {
      const text = input.subject === 'tool_call' ? JSON.stringify(input.args) : textOf(input);
      const found = SECRET_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
      return found.length ? { rule: 'secret-exposure', score: 85, message: `possible ${found.join(', ')}` } : null;
    },
  },
  {
    name: 'path-safety',
    appliesTo: ['tool_call'],
    evaluate(input, ctx) {
      if (input.subject !== 'tool_call') return null;
      const signals: RiskSignal[] = [];
      for (const key of ['path', 'file', 'filePath', 'target', 'cwd', 'dir']) {
        const value = input.args[key];
        if (typeof value !== 'string') continue;
        const resolved = path.resolve(ctx.workspaceRoot, value);
        const rel = path.relative(ctx.workspaceRoot, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          signals.push({ rule: 'path-safety', score: input.toolRisk === 'read' ? 45 : 80, message: `path outside workspace: ${value}` });
        }
        if (SENSITIVE_PATHS.test(value)) {
          signals.push({ rule: 'path-safety', score: input.toolRisk === 'read' ? 60 : 75, message: `sensitive file: ${value}` });
        }
      }
      return signals;
    },
  },
  {
    name: 'network-egress',
    appliesTo: ['tool_call'],
    evaluate(input) {
      if (input.subject !== 'tool_call' || input.toolRisk !== 'exec') return null;
      const text = textOf(input);
      if (/\b(curl|wget|nc|ncat|scp|rsync|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(text) || /https?:\/\//i.test(text)) {
        return { rule: 'network-egress', score: 40, message: 'command reaches the network' };
      }
      return null;
    },
  },
  {
    name: 'repetition-loop',
    appliesTo: ['tool_call'],
    evaluate(input, ctx) {
      if (input.subject !== 'tool_call') return null;
      const n = ctx.history.repeatCount(`${input.tool}:${JSON.stringify(input.args)}`);
      // `n` includes the current call (history is updated before rules run).
      if (n >= 5) return { rule: 'repetition-loop', score: 80, message: `identical ${input.tool} call repeated ${n}x — likely stuck` };
      if (n >= 3) return { rule: 'repetition-loop', score: 55, message: `identical ${input.tool} call repeated ${n}x` };
      return null;
    },
  },
  {
    name: 'cost-spike',
    appliesTo: ['invocation'],
    evaluate(input, ctx) {
      if (input.subject !== 'invocation') return null;
      const cost = input.record.costUsd;
      if (cost >= ctx.history.costSpikeUsd) {
        return { rule: 'cost-spike', score: 50, message: `single invocation cost $${cost.toFixed(4)}` };
      }
      const prior = ctx.history.invocations.slice(0, -1).slice(-50);
      if (prior.length >= 5 && cost > 0) {
        const avg = prior.reduce((s, r) => s + r.costUsd, 0) / prior.length;
        if (avg > 0 && cost > avg * 4) return { rule: 'cost-spike', score: 35, message: `cost ${(cost / avg).toFixed(1)}x the running average` };
      }
      return null;
    },
  },
  {
    name: 'agent-error-rate',
    appliesTo: ['invocation'],
    evaluate(input, ctx) {
      if (input.subject !== 'invocation') return null;
      const mine = ctx.history.invocations.filter((r) => r.agent === input.agent).slice(-10);
      const failures = mine.filter((r) => !r.success).length;
      if (mine.length >= 4 && failures / mine.length >= 0.5) {
        return { rule: 'agent-error-rate', score: 45, message: `${failures}/${mine.length} recent invocations failed` };
      }
      return null;
    },
  },
];

/** Scores tool calls, model outputs and invocations, and gates risky actions. */
export class RiskEngine extends TypedEmitter<RiskEvents> {
  private readonly rules: RiskRule[];
  private readonly policy: Required<Pick<RiskPolicy, 'reviewThreshold' | 'blockThreshold'>> & RiskPolicy;
  private readonly history = new RiskHistory();
  private readonly assessments: RiskAssessment[] = [];

  constructor(policy: RiskPolicy = {}) {
    super();
    this.policy = { reviewThreshold: 50, blockThreshold: 80, ...policy };
    this.rules = [...(policy.replaceBuiltinRules ? [] : builtinRiskRules), ...(policy.rules ?? [])];
    this.history.costSpikeUsd = policy.costSpikeUsd ?? 0.5;
  }

  get workspaceRoot(): string {
    return path.resolve(this.policy.workspaceRoot ?? process.cwd());
  }

  /** Score an input without applying the review/approval policy. */
  assess(input: RiskInput): RiskAssessment {
    if (input.subject === 'tool_call') this.history.toolCalls.push(`${input.tool}:${JSON.stringify(input.args)}`);
    if (input.subject === 'invocation') this.history.invocations.push(input.record);

    const ctx: RiskContext = { workspaceRoot: this.workspaceRoot, history: this.history };
    const signals: RiskSignal[] = [];
    for (const rule of this.rules) {
      if (!rule.appliesTo.includes(input.subject)) continue;
      const out = rule.evaluate(input, ctx);
      if (out) signals.push(...(Array.isArray(out) ? out : [out]));
    }

    const peak = signals.reduce((m, s) => Math.max(m, s.score), 0);
    const score = Math.min(100, peak + Math.max(0, signals.filter((s) => s.score >= 25).length - 1) * 5);
    const decision: RiskDecision =
      score >= this.policy.blockThreshold ? 'block' : score >= this.policy.reviewThreshold ? 'review' : 'allow';

    return {
      id: newId('risk'),
      subject: input.subject,
      agent: input.agent,
      taskId: input.taskId,
      target: describeTarget(input),
      score,
      level: levelFor(score),
      signals,
      decision,
      timestamp: new Date().toISOString(),
    };
  }

  /** Assess, apply the review policy, record and emit. Returns the final decision. */
  async gate(input: RiskInput): Promise<RiskAssessment> {
    const a = this.assess(input);
    if (a.decision === 'review') {
      const onReview = this.policy.onReview ?? 'allow';
      const approved = typeof onReview === 'function' ? await onReview(a, input) : onReview === 'allow';
      a.reviewedBy = typeof onReview === 'function' ? 'approver' : 'policy';
      this.emit('review', a);
      if (!approved) a.decision = 'block';
    }
    this.track(a);
    return a;
  }

  /** Record an assessment (e.g. one restored from a saved session). */
  track(a: RiskAssessment, silent = false): void {
    this.assessments.push(a);
    if (silent) return;
    this.emit('assessed', a);
    if (a.decision === 'block') this.emit('blocked', a);
  }

  all(): readonly RiskAssessment[] {
    return this.assessments;
  }

  summary(topN = 5): RiskSummary {
    return summarizeRisk(this.assessments, topN);
  }
}

export function summarizeRisk(assessments: readonly RiskAssessment[], topN = 5): RiskSummary {
  const byLevel: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const byDecision: Record<RiskDecision, number> = { allow: 0, review: 0, block: 0 };
  const byRule: Record<string, number> = {};
  const byAgent: RiskSummary['byAgent'] = {};
  let peak = 0;
  for (const a of assessments) {
    byLevel[a.level]++;
    byDecision[a.decision]++;
    if (a.reviewedBy) byDecision.review++;
    for (const s of a.signals) byRule[s.rule] = (byRule[s.rule] ?? 0) + 1;
    const ag = (byAgent[a.agent] ??= { assessments: 0, maxScore: 0, blocked: 0 });
    ag.assessments++;
    ag.maxScore = Math.max(ag.maxScore, a.score);
    if (a.decision === 'block') ag.blocked++;
    peak = Math.max(peak, a.score);
  }
  const elevated = byLevel.medium + byLevel.high + byLevel.critical;
  const share = assessments.length ? elevated / assessments.length : 0;
  const riskIndex = Math.round(peak * 0.7 + share * 100 * 0.3);
  return {
    assessments: assessments.length,
    byLevel,
    byDecision,
    byRule,
    byAgent,
    riskIndex,
    overallLevel: levelFor(riskIndex),
    top: [...assessments].filter((a) => a.score > 0).sort((a, b) => b.score - a.score).slice(0, topN),
  };
}

function describeTarget(input: RiskInput): string {
  if (input.subject === 'tool_call') return `${input.tool}(${JSON.stringify(input.args).slice(0, 160)})`;
  if (input.subject === 'output') return `output(${input.text.length} chars)`;
  return `invocation ${input.record.model}`;
}
