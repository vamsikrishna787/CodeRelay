import type { SessionState, TaskStatus } from '../session/session.js';
import type { PoolStats } from '../orchestrator/pool.js';
import { aggregate, CostTracker, type Budget, type CostSummary } from './cost.js';
import { summarizeRisk, type RiskSummary } from './risk.js';

export interface MetricsReport {
  generatedAt: string;
  session: {
    id: string;
    title: string;
    goal?: string;
    status: SessionState['status'];
    createdAt: string;
    updatedAt: string;
    compactions: number;
    checkpoints: number;
    activeMessages: number;
  };
  tasks: {
    total: number;
    byStatus: Partial<Record<TaskStatus, number>>;
    items: Array<{ id: string; title: string; agent?: string; status: TaskStatus; attempts: number; costUsd: number; tokens: number; maxRisk: number }>;
  };
  cost: CostSummary;
  risk: RiskSummary;
  pool?: PoolStats;
}

export function buildReport(state: SessionState, opts: { budget?: Budget; pool?: PoolStats } = {}): MetricsReport {
  const tracker = new CostTracker({ budget: opts.budget });
  tracker.restore(state.invocations);
  const byStatus: Partial<Record<TaskStatus, number>> = {};
  for (const t of state.tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    session: {
      id: state.id,
      title: state.title,
      goal: state.goal,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      compactions: state.compactions,
      checkpoints: state.checkpoints.length,
      activeMessages: state.messages.length,
    },
    tasks: {
      total: state.tasks.length,
      byStatus,
      items: state.tasks.map((t) => {
        const totals = aggregate(state.invocations.filter((r) => r.taskId === t.id));
        return {
          id: t.id,
          title: t.title,
          agent: t.assignedAgent ?? t.agent,
          status: t.status,
          attempts: t.attempts,
          costUsd: totals.costUsd,
          tokens: totals.tokens,
          maxRisk: state.risks.filter((r) => r.taskId === t.id).reduce((m, r) => Math.max(m, r.score), 0),
        };
      }),
    },
    cost: tracker.summary(),
    risk: summarizeRisk(state.risks),
    pool: opts.pool,
  };
}

export type ReportFormat = 'text' | 'markdown' | 'json';

export function formatReport(report: MetricsReport, format: ReportFormat = 'text'): string {
  if (format === 'json') return JSON.stringify(report, null, 2);
  const md = format === 'markdown';
  const h = (s: string) => (md ? `## ${s}` : `== ${s} ==`);
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const c = report.cost.totals;
  const r = report.risk;
  const out: string[] = [];

  out.push(md ? `# CodeRelay report — ${report.session.title}` : `CodeRelay report — ${report.session.title}`);
  out.push(`Session ${report.session.id} · ${report.session.status} · ${report.tasks.total} tasks · ${report.session.compactions} compactions`);
  out.push('', h('Cost'));
  out.push(
    table(
      ['Invocations', 'Failures', 'Input tok', 'Output tok', 'Cost (USD)', 'Premium req', 'Model time'],
      [[c.invocations, c.failures, c.inputTokens, c.outputTokens, usd(c.costUsd), c.premiumRequests, `${(c.durationMs / 1000).toFixed(1)}s`]],
      md,
    ),
  );
  if (c.unpricedInvocations) out.push(`Note: ${c.unpricedInvocations} invocation(s) used models with no configured price.`);

  const budget = report.cost.budget;
  const util = Object.entries(budget.utilization);
  if (util.length) {
    out.push('', 'Budget: ' + util.map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)}%`).join(' · ') + (budget.exceeded.length ? `  EXCEEDED: ${budget.exceeded.join(', ')}` : ''));
  }

  out.push('', h('Cost by agent'));
  out.push(
    table(
      ['Agent', 'Calls', 'Tokens', 'Cost (USD)', 'Premium req', 'Failures'],
      Object.entries(report.cost.byAgent).map(([a, t]) => [a, t.invocations, t.tokens, usd(t.costUsd), t.premiumRequests, t.failures]),
      md,
    ),
  );

  out.push('', h('Risk'));
  out.push(`Risk index ${r.riskIndex}/100 (${r.overallLevel}) · ${r.assessments} flagged event(s) · blocked ${r.byDecision.block} · reviewed ${r.byDecision.review}`);
  out.push(`Levels: low ${r.byLevel.low} · medium ${r.byLevel.medium} · high ${r.byLevel.high} · critical ${r.byLevel.critical}`);
  if (r.top.length) {
    out.push(
      table(
        ['Score', 'Level', 'Decision', 'Agent', 'Target', 'Why'],
        r.top.map((a) => [a.score, a.level, a.decision, a.agent, a.target.slice(0, 50), a.signals.map((s) => s.rule).join(', ')]),
        md,
      ),
    );
  }

  if (report.tasks.items.length) {
    out.push('', h('Tasks'));
    out.push(
      table(
        ['Task', 'Agent', 'Status', 'Tries', 'Tokens', 'Cost (USD)', 'Max risk'],
        report.tasks.items.map((t) => [`${t.id} ${t.title}`.slice(0, 48), t.agent ?? '-', t.status, t.attempts, t.tokens, usd(t.costUsd), t.maxRisk]),
        md,
      ),
    );
  }

  if (report.pool) {
    const p = report.pool;
    out.push('', h('Agent deployment'));
    out.push(`Spawned ${p.spawned} instance(s), peak concurrency ${p.peakConcurrency}/${p.maxConcurrency}, retired ${p.retired}`);
    out.push(table(['Agent', 'Spawned', 'Live', 'Tasks run'], Object.entries(p.byAgent).map(([a, s]) => [a, s.spawned, s.live, s.tasksRun]), md));
  }
  return out.join('\n');
}

function table(headers: string[], rows: Array<Array<string | number>>, md: boolean): string {
  const cells = rows.map((r) => r.map(String));
  if (md) {
    const esc = (s: string) => s.replace(/\|/g, '\\|');
    return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...cells.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
  }
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]?.length ?? 0)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}
