#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { changedFiles, changedSince, lineStats, readText } from './git.js';
import { nextStep, renderReport, renderSession } from './render.js';
import { assessCommand, changeSizeFinding, combine, scanFile } from './risk.js';
import { install } from './setup.js';
import {
  archiveSession,
  budgetExceeded,
  currentGoal,
  findRoot,
  loadConfig,
  loadSession,
  newId,
  now,
  paths,
  premiumFor,
  round,
  saveSession,
  withLock,
  type Config,
  type Goal,
  type Session,
  type Task,
} from './state.js';

const HELP = `CodeRelay: makes GitHub Copilot work as an orchestrator.
Installed with npm; Copilot runs these commands itself (you rarely need to).

  coderelay goal "<goal>" --request "<user words>" --criteria "<c1>" --criteria "<c2>"
  coderelay plan "t1|architect|Design X" "t2|coder|Build X|t1" "t3|verifier|Verify|t2"
  coderelay approve                      user approved the plan → implementation allowed
  coderelay begin <task> [--model m]     an agent was spawned for the task
  coderelay done <task> "<summary>"      task finished (changed files are risk-scanned)
  coderelay fail <task> "<reason>"
  coderelay verify pass|fail "<evidence>"  record verification (fail → next attempt, max 5)
  coderelay check "<command>"            risk-check a shell command: ALLOW / REVIEW / BLOCK
  coderelay note "<text>"                remember a decision
  coderelay status                       where are we + next step
  coderelay report                       cost & risk report (.coderelay/REPORT.md)
  coderelay init [--force]               (re)install the Copilot agents & settings
  coderelay new                          archive this session and start fresh
`;

const KNOWN_AGENTS = ['architect', 'researcher', 'coder', 'tester', 'reviewer', 'verifier'];

class CliError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

interface Args {
  _: string[];
  flags: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const value = eq > 0 ? a.slice(eq + 1) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      (out.flags[key] ??= []).push(value);
    } else out._.push(a);
  }
  return out;
}

const flag = (args: Args, key: string) => args.flags[key]?.at(-1);

function print(lines: string | string[]): void {
  process.stdout.write(`${Array.isArray(lines) ? lines.join('\n') : lines}\n`);
}

function persist(root: string, session: Session, config: Config): void {
  saveSession(root, session);
  const p = paths(root);
  writeFileSync(p.session, renderSession(session, config));
  writeFileSync(p.report, renderReport(session, config));
}

function requireGoal(session: Session | undefined): { session: Session; goal: Goal } {
  const goal = currentGoal(session);
  if (!session || !goal) throw new CliError('No goal in progress. Start one with: coderelay goal "<goal>" --criteria "<c1>" --criteria "<c2>"');
  return { session, goal };
}

function findTask(goal: Goal, id: string | undefined): Task {
  if (!id) throw new CliError('Missing task id.');
  const matches = goal.tasks.filter((t) => t.id === id);
  const task = matches.find((t) => t.attempt === goal.attempt) ?? matches.at(-1);
  if (!task) throw new CliError(`Unknown task "${id}". Tasks: ${goal.tasks.map((t) => t.id).join(', ') || '(none)'}`);
  return task;
}

/** An orchestrator turn = one user prompt to Copilot (a premium request × model multiplier). */
function recordTurn(session: Session, config: Config, goal: Goal, model: string): void {
  const premium = premiumFor(config, model);
  const at = now();
  session.invocations.push({ id: newId('inv'), agent: 'orchestrator', goalId: goal.id, model, startedAt: at, endedAt: at, durationMs: 0, premiumRequests: premium, costUsd: round(premium * config.premiumRequestUsd), outcome: 'turn' });
}

function budgetGuard(session: Session, config: Config): void {
  const over = budgetExceeded(session, config);
  if (over) throw new CliError(`BUDGET EXCEEDED (${over}). Stop and ask the user whether to raise the budget in .coderelay/config.json.`, 3);
}

function parsePlan(specs: string[], goal: Goal): Task[] {
  if (!specs.length) throw new CliError('Usage: coderelay plan "t1|agent|title" "t2|agent|title|t1" ...');
  const existing = new Set(goal.tasks.filter((t) => t.attempt !== goal.attempt || goal.phase === 'implementing').map((t) => t.id));
  const prefix = goal.phase === 'implementing' ? `a${goal.attempt}-` : '';
  const raw = specs.map((spec) => {
    const [id, agent, title, deps] = spec.split('|').map((s) => s?.trim() ?? '');
    if (!id || !agent || !title) throw new CliError(`Bad task "${spec}". Format: "id|agent|title|dep1,dep2"`);
    return { id, agent: agent.toLowerCase(), title, deps: deps ? deps.split(',').map((d) => d.trim()).filter(Boolean) : [] };
  });
  const rename = new Map(raw.map((r) => [r.id, existing.has(r.id) ? `${prefix || 'x-'}${r.id}` : r.id]));
  const ids = new Set(rename.values());
  return raw.map((r) => {
    const deps = r.deps.map((d) => rename.get(d) ?? d);
    for (const d of deps) {
      if (!ids.has(d) && !goal.tasks.some((t) => t.id === d)) throw new CliError(`Task ${r.id} depends on unknown task "${d}".`);
    }
    return { id: rename.get(r.id)!, agent: r.agent, title: r.title, dependsOn: deps, status: 'pending', attempt: goal.attempt, runs: 0 };
  });
}

function hasCycle(tasks: Task[]): string | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, number>();
  const visit = (id: string, trail: string[]): string | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...trail, id].join(' → ');
    state.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      const c = visit(d, [...trail, id]);
      if (c) return c;
    }
    state.set(id, 2);
    return undefined;
  };
  for (const t of tasks) {
    const c = visit(t.id, []);
    if (c) return c;
  }
  return undefined;
}

function planLines(goal: Goal): string[] {
  return goal.tasks
    .filter((t) => t.attempt === goal.attempt)
    .map((t) => `  ${t.id.padEnd(8)} ${t.agent.padEnd(10)} ${t.title}${t.dependsOn.length ? `  (after ${t.dependsOn.join(', ')})` : ''}`);
}

function run(argv: string[]): number {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  if (!cmd || cmd === 'help' || args.flags.help) {
    print(HELP);
    return 0;
  }
  const root = findRoot();

  if (cmd === 'init') {
    const log = install(root, { force: flag(args, 'force') === 'true' });
    print([...(log.length ? log : ['Already up to date.']), '', 'Done. Open Copilot Chat in Agent mode and ask for what you want, or pick the "Orchestrator" agent.']);
    return 0;
  }

  const config = loadConfig(root);

  if (cmd === 'check') {
    const command = rest.join(' ').trim();
    if (!command) throw new CliError('Usage: coderelay check "<command>"');
    const a = assessCommand(command, config.risk);
    withLock(root, () => {
      const session = loadSession(root);
      if (!session) return;
      session.risks.push({ id: newId('risk'), at: now(), source: 'command', goalId: currentGoal(session)?.id, target: command.slice(0, 200), score: a.score, level: a.level, decision: a.decision, findings: a.findings.map((f) => f.message) });
      persist(root, session, config);
    });
    const advice = { allow: 'OK to run.', review: 'Ask the user before running this.', block: 'Do NOT run this. Find a safer approach or ask the user to run it themselves.' }[a.decision];
    print([`${a.decision.toUpperCase()} (risk ${a.score}/100, ${a.level}): ${advice}`, ...a.findings.map((f) => `  - ${f.message}`)]);
    return a.decision === 'block' ? 2 : 0;
  }

  if (cmd === 'status') {
    print(renderSession(loadSession(root), config));
    return 0;
  }

  if (cmd === 'report') {
    const session = loadSession(root);
    const md = renderReport(session, config);
    if (session) {
      mkdirSync(paths(root).dir, { recursive: true });
      writeFileSync(paths(root).report, md);
    }
    print(md);
    return 0;
  }

  return withLock(root, () => {
    let session = loadSession(root);

    switch (cmd) {
      case 'new': {
        if (session) print(`Archived previous session to ${path.relative(root, archiveSession(root, session))}`);
        writeFileSync(paths(root).session, renderSession(undefined, config));
        print('Started fresh. The next request begins a new session.');
        return 0;
      }

      case 'goal': {
        const statement = rest.join(' ').trim();
        const criteria = args.flags.criteria ?? [];
        if (!statement) throw new CliError('Usage: coderelay goal "<goal>" --request "<user words>" --criteria "<c1>" --criteria "<c2>"');
        if (!criteria.length) throw new CliError('Add 2–5 checkable success criteria: --criteria "<c1>" --criteria "<c2>"');
        if (session) budgetGuard(session, config);
        session ??= { id: newId('ses'), title: path.basename(root), createdAt: now(), updatedAt: now(), goals: [], invocations: [], risks: [], notes: [] };

        const open = currentGoal(session);
        if (open && open.phase === 'implementing' && flag(args, 'replace') !== 'true') {
          throw new CliError(`Goal ${open.id} is being implemented (attempt ${open.attempt}). Finish it with \`coderelay verify ...\`, or pass --replace to abandon it.`);
        }
        let goal: Goal;
        if (open && open.phase !== 'implementing') {
          // Refining the goal after user feedback: keep the id, reset the plan.
          goal = open;
          Object.assign(goal, { statement, criteria, request: flag(args, 'request') ?? goal.request, phase: 'planning', tasks: [] });
          print(`Updated goal ${goal.id}.`);
        } else {
          if (open) {
            open.phase = 'failed';
            open.endedAt = now();
            session.notes.push({ at: now(), goalId: open.id, text: `Goal ${open.id} abandoned (replaced by a new goal).` });
          }
          goal = { id: `g${session.goals.length + 1}`, request: flag(args, 'request') ?? statement, statement, criteria, phase: 'planning', attempt: 1, maxAttempts: config.maxAttempts, createdAt: now(), tasks: [], verifications: [] };
          session.goals.push(goal);
          recordTurn(session, config, goal, flag(args, 'model') ?? config.defaultModel);
          print(`Goal ${goal.id} created.`);
        }
        persist(root, session, config);
        print([`Goal: ${statement}`, 'Success criteria:', ...criteria.map((c, i) => `  ${i + 1}. ${c}`), '', `Next: ${nextStep(session)}`]);
        return 0;
      }

      case 'plan': {
        const r = requireGoal(session);
        const tasks = parsePlan(rest, r.goal);
        if (r.goal.phase !== 'implementing') r.goal.tasks = [];
        r.goal.tasks.push(...tasks);
        const cycle = hasCycle(r.goal.tasks);
        if (cycle) throw new CliError(`Plan has a dependency cycle: ${cycle}`);
        const unknown = [...new Set(tasks.map((t) => t.agent))].filter((a) => !KNOWN_AGENTS.includes(a));
        if (r.goal.phase === 'planning') r.goal.phase = 'awaiting-approval';
        persist(root, r.session, config);
        const hasVerifier = r.goal.tasks.some((t) => t.attempt === r.goal.attempt && t.agent === 'verifier');
        print([
          `Plan for ${r.goal.id}${r.goal.attempt > 1 ? `, attempt ${r.goal.attempt}/${r.goal.maxAttempts}` : ''}:`,
          ...planLines(r.goal),
          ...(unknown.length ? [`Note: custom agent(s) ${unknown.join(', ')}; make sure a matching .github/agents file exists.`] : []),
          ...(hasVerifier ? [] : ['Warning: no verifier task. Add one that depends on the others so the goal gets verified.']),
          '',
          `Next: ${nextStep(r.session)}`,
        ]);
        return 0;
      }

      case 'approve': {
        const r = requireGoal(session);
        if (r.goal.phase === 'implementing') {
          print('Already approved.');
          return 0;
        }
        if (r.goal.phase !== 'awaiting-approval') throw new CliError('Nothing to approve yet. Create the plan first with `coderelay plan ...`.');
        budgetGuard(r.session, config);
        r.goal.phase = 'implementing';
        r.goal.approvedAt = now();
        recordTurn(r.session, config, r.goal, flag(args, 'model') ?? config.defaultModel);
        persist(root, r.session, config);
        print([`Approved. Implementing ${r.goal.id} (attempt 1/${r.goal.maxAttempts}).`, `Next: ${nextStep(r.session)}`]);
        return 0;
      }

      case 'begin': {
        const r = requireGoal(session);
        if (r.goal.phase !== 'implementing') throw new CliError('The plan is not approved yet. Show it to the user, ask "Shall I implement this plan?", then run `coderelay approve`.');
        budgetGuard(r.session, config);
        const task = findTask(r.goal, rest[0]);
        if (task.status === 'done') throw new CliError(`Task ${task.id} is already done.`);
        const waiting = task.dependsOn.filter((d) => r.goal.tasks.find((t) => t.id === d)?.status !== 'done');
        if (waiting.length) throw new CliError(`Task ${task.id} must wait for: ${waiting.join(', ')}.`);
        Object.assign(task, { status: 'running', runs: task.runs + 1, startedAt: now(), endedAt: undefined, error: undefined, model: flag(args, 'model') ?? task.model, baseline: changedFiles(root) });
        persist(root, r.session, config);
        print(`Started ${task.id} → spawn the ${capital(task.agent)} agent (runSubagent) with the goal, criteria, task "${task.title}" and its dependencies' summaries.`);
        return 0;
      }

      case 'done':
      case 'fail': {
        const r = requireGoal(session);
        const task = findTask(r.goal, rest[0]);
        const text = rest.slice(1).join(' ').trim();
        if (!text) throw new CliError(`Usage: coderelay ${cmd} <task> "<${cmd === 'done' ? 'summary' : 'reason'}>"`);
        const ended = now();
        const started = task.startedAt ?? ended;
        const model = flag(args, 'model') ?? task.model ?? config.defaultModel;
        const tokens = flag(args, 'tokens') ? Number(flag(args, 'tokens')) : undefined;
        const premium = premiumFor(config, model);
        const out: string[] = [];

        // Attribute changed files to this task and scan them for risk.
        const files = flag(args, 'files')?.split(',').map((f) => f.trim()).filter(Boolean) ?? changedSince(root, task.baseline);
        const stats = lineStats(root, files);
        const findings = files.flatMap((f) => {
          const content = readText(root, f);
          return content === undefined ? [] : scanFile(f, content);
        });
        const size = changeSizeFinding(stats.added + stats.removed);
        if (size) findings.push(size);
        const a = combine(findings, config.risk);
        if (findings.length) {
          r.session.risks.push({ id: newId('risk'), at: ended, source: 'code', goalId: r.goal.id, taskId: task.id, agent: task.agent, target: files.slice(0, 5).join(', ') + (files.length > 5 ? ` +${files.length - 5}` : ''), score: a.score, level: a.level, decision: a.decision, findings: findings.map((f) => f.message) });
          out.push(`Risk scan of ${files.length} changed file(s): ${a.level.toUpperCase()} (${a.score}/100)`, ...findings.map((f) => `  - ${f.message}`));
          if (a.decision !== 'allow') out.push('  → Tell the user about these findings and fix them (e.g. add a fix task) before verifying.');
        }

        Object.assign(task, { status: cmd === 'done' ? 'done' : 'failed', endedAt: ended, model, files, linesAdded: stats.added, linesRemoved: stats.removed, riskScore: a.score, baseline: undefined });
        if (cmd === 'done') task.summary = text;
        else task.error = text;
        r.session.invocations.push({ id: newId('inv'), agent: task.agent, goalId: r.goal.id, taskId: task.id, model, startedAt: started, endedAt: ended, durationMs: Date.parse(ended) - Date.parse(started), premiumRequests: premium, costUsd: round(premium * config.premiumRequestUsd), tokens, outcome: cmd === 'done' ? 'done' : 'failed' });
        persist(root, r.session, config);
        print([`${cmd === 'done' ? 'Done' : 'Failed'}: ${task.id} (${task.agent}), ${files.length} file(s), +${stats.added}/-${stats.removed} lines.`, ...out, `Next: ${nextStep(r.session)}`]);
        return 0;
      }

      case 'verify': {
        const r = requireGoal(session);
        const verdict = rest[0];
        const evidence = rest.slice(1).join(' ').trim();
        if ((verdict !== 'pass' && verdict !== 'fail') || !evidence) throw new CliError('Usage: coderelay verify pass "<evidence>"  |  coderelay verify fail "<what is missing>"');
        if (r.goal.phase !== 'implementing') throw new CliError('Nothing to verify: the plan has not been approved/implemented yet.');
        const pending = r.goal.tasks.filter((t) => t.attempt === r.goal.attempt && (t.status === 'pending' || t.status === 'running') && t.agent !== 'verifier');
        if (verdict === 'pass' && pending.length) throw new CliError(`Cannot pass: tasks still open: ${pending.map((t) => t.id).join(', ')}.`);
        r.goal.verifications.push({ at: now(), attempt: r.goal.attempt, passed: verdict === 'pass', evidence });
        // Close any verifier task of this attempt that the orchestrator didn't mark.
        for (const t of r.goal.tasks) if (t.attempt === r.goal.attempt && t.agent === 'verifier' && t.status !== 'done') Object.assign(t, { status: 'done', summary: evidence, endedAt: now() });

        if (verdict === 'pass') {
          r.goal.phase = 'achieved';
          r.goal.endedAt = now();
          persist(root, r.session, config);
          print([`GOAL ACHIEVED: ${r.goal.id} on attempt ${r.goal.attempt}/${r.goal.maxAttempts}.`, 'Next: run `npx coderelay report` and give the user a short summary (result, attempts, cost, risk).']);
          return 0;
        }
        if (r.goal.attempt >= r.goal.maxAttempts) {
          r.goal.phase = 'failed';
          r.goal.endedAt = now();
          persist(root, r.session, config);
          print([`GOAL NOT REACHED after ${r.goal.maxAttempts} attempts. Marked as failed.`, 'Next: tell the user what is blocking it (see the verification history in .coderelay/SESSION.md), then run `npx coderelay report`.']);
          return 0;
        }
        r.goal.attempt++;
        persist(root, r.session, config);
        print([`Verification failed. Starting attempt ${r.goal.attempt}/${r.goal.maxAttempts}.`, `Missing: ${evidence}`, `Next: plan ONLY the fix tasks (no new approval needed), ending with a verifier task, e.g. coderelay plan "fix1|coder|Fix <issue>" "v${r.goal.attempt}|verifier|Re-verify all criteria|fix1"`]);
        return 0;
      }

      case 'note': {
        const text = rest.join(' ').trim();
        if (!text) throw new CliError('Usage: coderelay note "<text>"');
        if (!session) throw new CliError('No session yet.');
        session.notes.push({ at: now(), goalId: currentGoal(session)?.id, text });
        persist(root, session, config);
        print('Noted.');
        return 0;
      }

      default:
        throw new CliError(`Unknown command "${cmd}".\n\n${HELP}`);
    }
  });
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`coderelay: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = err instanceof CliError ? err.code : 1;
}

