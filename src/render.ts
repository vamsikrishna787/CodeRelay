import { levelFor } from './risk.js';
import { budgetExceeded, currentGoal, totals, type Config, type Goal, type Session, type Task } from './state.js';

const ICON: Record<Task['status'], string> = { pending: '[ ]', running: '[~]', done: '[x]', failed: '[!]' };

export function readyTasks(goal: Goal): Task[] {
  const byId = new Map(goal.tasks.map((t) => [t.id, t]));
  return goal.tasks.filter((t) => t.status === 'pending' && t.attempt === goal.attempt && t.dependsOn.every((d) => byId.get(d)?.status === 'done'));
}

/** What the orchestrator should do next, in one instruction. */
export function nextStep(session: Session | undefined): string {
  const goal = currentGoal(session);
  if (!goal) return 'No goal in progress. For the next request run `npx coderelay goal "<goal>" --request "<user words>" --criteria "<c1>" --criteria "<c2>"`.';
  switch (goal.phase) {
    case 'planning':
      return 'Plan the work: `npx coderelay plan "t1|<agent>|<title>" ... "tN|verifier|Verify all criteria|<deps>"`.';
    case 'awaiting-approval':
      return 'Show the user the goal, criteria and plan, ask about missing info, and ask "Shall I implement this plan?". After a clear yes: `npx coderelay approve`.';
    case 'implementing': {
      const current = goal.tasks.filter((t) => t.attempt === goal.attempt);
      if (!current.length) return `Attempt ${goal.attempt}/${goal.maxAttempts}: plan the fix tasks with \`npx coderelay plan ...\` (end with a verifier task).`;
      const running = current.filter((t) => t.status === 'running');
      const ready = readyTasks(goal);
      const failed = current.filter((t) => t.status === 'failed');
      if (ready.length) return `Start ${ready.map((t) => `${t.id} (${t.agent})`).join(', ')}: \`npx coderelay begin <id>\`, then spawn the agent with runSubagent.${running.length ? ` Still running: ${running.map((t) => t.id).join(', ')}.` : ''}`;
      if (running.length) return `Wait for ${running.map((t) => `${t.id} (${t.agent})`).join(', ')}, then \`npx coderelay done <id> "<summary>"\`.`;
      if (failed.length) return `Task(s) ${failed.map((t) => t.id).join(', ')} failed: retry with \`npx coderelay begin <id>\`, or record \`npx coderelay verify fail "<reason>"\` to start the next attempt.`;
      return 'All tasks done. Record the verification: `npx coderelay verify pass "<evidence>"` or `npx coderelay verify fail "<what is missing>"`.';
    }
    default:
      return 'Goal finished. Run `npx coderelay report`.';
  }
}

function table(headers: string[], rows: Array<Array<string | number>>): string {
  if (!rows.length) return '_none_';
  const esc = (v: string | number) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

/** `.coderelay/SESSION.md`: Copilot's memory. Read at the start of every chat. */
export function renderSession(session: Session | undefined, config: Config): string {
  if (!session) return '# CodeRelay session\n\nNo goal yet.\n';
  const goal = currentGoal(session) ?? session.goals.at(-1);
  const out: string[] = [`# CodeRelay session: ${session.title}`, '', `**Next step:** ${nextStep(session)}`, ''];

  if (goal) {
    out.push(`## Current goal (${goal.id}): ${goal.phase}${goal.phase === 'implementing' ? `, attempt ${goal.attempt}/${goal.maxAttempts}` : ''}`);
    out.push('', `**Goal:** ${goal.statement}`, `**User asked:** ${goal.request}`, '', '**Success criteria:**');
    goal.criteria.forEach((c, i) => out.push(`${i + 1}. ${c}`));
    if (goal.tasks.length) {
      out.push('', '**Plan:**');
      for (const t of goal.tasks) {
        out.push(`- ${ICON[t.status]} \`${t.id}\` **${t.agent}**: ${t.title}${t.dependsOn.length ? ` _(after ${t.dependsOn.join(', ')})_` : ''}${goal.attempt > 1 ? ` · attempt ${t.attempt}` : ''}`);
        if (t.summary) out.push(`  - ${t.summary.replace(/\n+/g, ' ')}`);
        if (t.error) out.push(`  - ❗ ${t.error}`);
      }
    }
    if (goal.verifications.length) {
      out.push('', '**Verification history:**');
      for (const v of goal.verifications) out.push(`- attempt ${v.attempt}: ${v.passed ? 'PASS' : 'FAIL'}: ${v.evidence}`);
    }
  }

  const notes = session.notes.slice(-8);
  if (notes.length) {
    out.push('', '## Recent notes');
    for (const n of notes) out.push(`- ${n.at.slice(0, 16).replace('T', ' ')}: ${n.text}`);
  }

  const past = session.goals.filter((g) => g !== goal);
  if (past.length) {
    out.push('', '## Earlier goals');
    for (const g of past.slice(-10)) out.push(`- ${g.id} **${g.phase}** (${g.attempt} attempt${g.attempt > 1 ? 's' : ''}): ${g.statement}`);
  }

  const t = totals(session, config);
  out.push('', `_Cost so far: ${t.premiumRequests} premium requests ≈ $${t.costUsd.toFixed(2)} · ${t.invocations} agent runs · risk: ${riskIndex(session).level}. Full report: .coderelay/REPORT.md_`);
  return `${out.join('\n')}\n`;
}

export function riskIndex(session: Session) {
  const peak = session.risks.reduce((m, r) => Math.max(m, r.score), 0);
  const elevated = session.risks.filter((r) => r.score >= 25).length;
  const share = session.risks.length ? elevated / session.risks.length : 0;
  const index = Math.round(peak * 0.7 + share * 30);
  return { index, level: levelFor(index), peak, blocked: session.risks.filter((r) => r.decision === 'block').length, review: session.risks.filter((r) => r.decision === 'review').length };
}

/** `.coderelay/REPORT.md`: cost and risk analysis. */
export function renderReport(session: Session | undefined, config: Config): string {
  if (!session) return '# CodeRelay report\n\nNo session yet.\n';
  const t = totals(session, config);
  const r = riskIndex(session);
  const over = budgetExceeded(session, config);
  const out: string[] = [`# CodeRelay report: ${session.title}`, '', `_Updated ${session.updatedAt.slice(0, 16).replace('T', ' ')} UTC · session ${session.id}_`, ''];

  out.push('## Summary', '');
  out.push(
    table(
      ['Goals', 'Achieved', 'Failed', 'In progress', 'Agent runs', 'Premium requests', 'Est. cost', 'Agent time', 'Risk'],
      [[
        session.goals.length,
        session.goals.filter((g) => g.phase === 'achieved').length,
        session.goals.filter((g) => g.phase === 'failed').length,
        session.goals.filter((g) => !['achieved', 'failed'].includes(g.phase)).length,
        t.invocations,
        t.premiumRequests,
        `$${t.costUsd.toFixed(2)}`,
        dur(t.durationMs),
        `${r.level} (${r.index}/100)`,
      ]],
    ),
  );
  const b = config.budget;
  if (b.maxPremiumRequests !== undefined || b.maxUsd !== undefined) {
    const parts = [];
    if (b.maxPremiumRequests !== undefined) parts.push(`${t.premiumRequests}/${b.maxPremiumRequests} premium requests (${Math.round((t.premiumRequests / b.maxPremiumRequests) * 100)}%)`);
    if (b.maxUsd !== undefined) parts.push(`$${t.costUsd.toFixed(2)}/$${b.maxUsd.toFixed(2)}`);
    out.push('', `**Budget:** ${parts.join(' · ')}${over ? ' · ⛔ **EXCEEDED**' : ''}`);
  }

  out.push('', '## Goals', '');
  out.push(
    table(
      ['Goal', 'Status', 'Attempts', 'Tasks', 'Agents used', 'Premium req.', 'Max risk'],
      session.goals.map((g) => {
        const inv = session.invocations.filter((i) => i.goalId === g.id);
        return [
          `${g.id}: ${g.statement}`,
          g.phase,
          `${g.attempt}/${g.maxAttempts}`,
          g.tasks.length,
          [...new Set(g.tasks.map((x) => x.agent))].join(', '),
          Math.round(inv.reduce((s, i) => s + i.premiumRequests, 0) * 100) / 100,
          session.risks.filter((x) => x.goalId === g.id).reduce((m, x) => Math.max(m, x.score), 0),
        ];
      }),
    ),
  );

  out.push('', '## Cost by agent', '');
  const agents = new Map<string, { runs: number; failed: number; premium: number; ms: number; tokens: number }>();
  for (const i of session.invocations) {
    const a = agents.get(i.agent) ?? { runs: 0, failed: 0, premium: 0, ms: 0, tokens: 0 };
    a.runs++;
    if (i.outcome === 'failed') a.failed++;
    a.premium += i.premiumRequests;
    a.ms += i.durationMs;
    a.tokens += i.tokens ?? 0;
    agents.set(i.agent, a);
  }
  out.push(
    table(
      ['Agent', 'Runs', 'Failed', 'Premium req.', 'Est. cost', 'Time', 'Tokens (reported)'],
      [...agents].map(([name, a]) => [name, a.runs, a.failed, Math.round(a.premium * 100) / 100, `$${(a.premium * config.premiumRequestUsd).toFixed(2)}`, dur(a.ms), a.tokens || '-']),
    ),
  );

  out.push('', '## Risk analysis', '');
  out.push(`Risk index **${r.index}/100 (${r.level})**: peak ${r.peak}, ${r.blocked} blocked, ${r.review} needed review, ${session.risks.length} findings total.`, '');
  const top = [...session.risks].filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);
  out.push(table(['Score', 'Decision', 'Source', 'Task', 'What', 'Why'], top.map((x) => [x.score, x.decision.toUpperCase(), x.source, x.taskId ?? '-', x.target.slice(0, 60), x.findings.join('; ').slice(0, 160)])));

  const recs = recommendations(session);
  if (recs.length) out.push('', '## Recommendations', '', ...recs.map((x) => `- ${x}`));

  out.push('', '---', '_Premium requests are estimates from the per-model multipliers in `.coderelay/config.json` (Copilot bills per request × model multiplier). Adjust them to match your plan._');
  return `${out.join('\n')}\n`;
}

function recommendations(session: Session): string[] {
  const recs: string[] = [];
  const secrets = session.risks.filter((r) => r.findings.some((f) => /secret|token|key|credential/i.test(f)) && r.source === 'code');
  if (secrets.length) recs.push(`**Possible secrets in code** (${secrets.map((s) => s.target).join(', ')}): move them to environment variables and rotate them if they were ever committed.`);
  const blocked = session.risks.filter((r) => r.decision === 'block' && r.source === 'command');
  if (blocked.length) recs.push(`${blocked.length} dangerous command(s) were blocked. Confirm the work was completed another way.`);
  const retried = session.goals.filter((g) => g.attempt > 2);
  if (retried.length) recs.push(`Goals needing 3+ attempts (${retried.map((g) => g.id).join(', ')}): consider tighter success criteria or splitting the goal.`);
  const failed = session.goals.filter((g) => g.phase === 'failed');
  if (failed.length) recs.push(`Failed goals (${failed.map((g) => g.id).join(', ')}): see their verification history in SESSION.md for what's missing.`);
  return recs;
}
