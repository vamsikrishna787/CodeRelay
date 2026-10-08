#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, createOrchestrator, exampleConfig, loadConfig, type CodeRelayConfig } from './config.js';
import { CodeRelayMcpServer } from './mcp/server.js';
import { buildReport, formatReport, type ReportFormat } from './metrics/report.js';
import { RiskEngine } from './metrics/risk.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import { FileSessionStore } from './session/store.js';

const HELP = `coderelay — long-running multi-agent sessions with cost & risk metrics

Usage:
  coderelay init                         Create ${CONFIG_FILE} and .vscode/mcp.json (Copilot)
  coderelay run "<goal>" [--session id]  Plan the goal and deploy agents to execute it
  coderelay resume <sessionId>           Continue unfinished / failed tasks
  coderelay sessions                     List sessions
  coderelay report <sessionId>           Cost & risk report  [--format text|markdown|json]
  coderelay brief <sessionId>            Session brief for continuing in a new chat
  coderelay risk "<command>"             Score a shell command before running it
  coderelay mcp                          Start the MCP server (stdio) for Copilot / Claude Code

Options:
  --config <file>     Config file (default ./${CONFIG_FILE})
  --mock              Use the offline mock provider (demo / dry run)
  --concurrency <n>   Max agents in parallel
  --budget <usd>      Max spend for the session
  --quiet             Only print the final output
`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) out.flags[k] = inline;
      else if (next !== undefined && !next.startsWith('--') && !['mock', 'quiet', 'help'].includes(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

function configFrom(args: Args): CodeRelayConfig {
  const config: CodeRelayConfig = loadConfig(typeof args.flags.config === 'string' ? args.flags.config : undefined);
  if (args.flags.mock) config.provider = { type: 'mock' };
  if (args.flags.concurrency) config.maxConcurrency = Number(args.flags.concurrency);
  if (args.flags.budget) config.budget = { ...config.budget, maxCostUsd: Number(args.flags.budget) };
  return config;
}

function storeFor(config: CodeRelayConfig): FileSessionStore {
  const ws = path.resolve(config.workspace ?? process.cwd());
  return new FileSessionStore(path.resolve(ws, config.sessionDir ?? path.join('.coderelay', 'sessions')));
}

const c = {
  dim: (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (process.stderr.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  green: (s: string) => (process.stderr.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (process.stderr.isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};

/** Live progress goes to stderr so stdout stays clean for the result. */
function attachProgress(o: Orchestrator): void {
  const log = (s: string) => process.stderr.write(`${s}\n`);
  o.on('session:started', (e) => log(c.dim(`session ${e.sessionId}${e.resumed ? ' (resumed)' : ''}`)));
  o.on('plan:created', (e) => {
    log(c.cyan(`plan: ${e.tasks.length} task(s)${e.rationale ? ` — ${e.rationale}` : ''}`));
    for (const t of e.tasks) log(c.dim(`  ${t.id} → ${t.agent ?? 'auto'}: ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`));
  });
  o.on('agent:spawned', (e) => log(c.green(`+ deployed ${e.instanceId} — ${e.reason}`)));
  o.on('task:started', (e) => log(`▶ ${e.task.id} ${e.task.title} [${e.agent}]${e.attempt > 1 ? ` attempt ${e.attempt}` : ''}`));
  o.on('task:completed', (e) => log(c.green(`✔ ${e.task.id} (${e.turns} turns, ${e.toolCalls} tool calls${e.blockedToolCalls ? `, ${e.blockedToolCalls} blocked` : ''})`)));
  o.on('task:failed', (e) => log(c.red(`✖ ${e.task.id}: ${e.error}${e.willRetry ? ' — retrying' : ''}`)));
  o.on('task:skipped', (e) => log(c.yellow(`↷ ${e.task.id} skipped: ${e.reason}`)));
  o.on('risk', (a) => {
    if (a.score >= 50) log(c.yellow(`⚠ risk ${a.score} ${a.level} → ${a.decision}: ${a.signals.map((s) => s.message).join('; ')}`));
  });
  o.on('budget:warning', (e) => log(c.yellow(`⚠ budget ${e.metric} at ${Math.round(e.utilization * 100)}%`)));
  o.on('budget:exceeded', (e) => log(c.red(`✖ budget ${e.metric} exceeded (${e.used} ≥ ${e.limit})`)));
  o.on('session:compacted', (e) => log(c.dim(`context compacted (#${e.compactions})`)));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  if (!cmd || args.flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case 'init': {
      if (existsSync(CONFIG_FILE)) process.stderr.write(`${CONFIG_FILE} already exists, leaving it unchanged\n`);
      else {
        writeFileSync(CONFIG_FILE, `${JSON.stringify(exampleConfig, null, 2)}\n`);
        process.stderr.write(`created ${CONFIG_FILE}\n`);
      }
      const mcpPath = path.join('.vscode', 'mcp.json');
      const mcp = existsSync(mcpPath) ? (JSON.parse(readFileSync(mcpPath, 'utf8')) as { servers?: Record<string, unknown> }) : {};
      mcp.servers = { ...mcp.servers, coderelay: { type: 'stdio', command: 'npx', args: ['-y', 'coderelay', 'mcp'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } } };
      mkdirSync('.vscode', { recursive: true });
      writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
      process.stderr.write(`registered MCP server in ${mcpPath} (Copilot agent mode)\n`);
      return 0;
    }

    case 'run': {
      const goal = rest.join(' ').trim();
      if (!goal) throw new Error('Usage: coderelay run "<goal>"');
      const o = createOrchestrator(configFrom(args));
      if (!args.flags.quiet) attachProgress(o);
      process.on('SIGINT', () => o.cancel('interrupted (Ctrl+C) — resume later with `coderelay resume`'));
      const res = await o.run(goal, { sessionId: typeof args.flags.session === 'string' ? args.flags.session : undefined });
      process.stdout.write(`\n${res.output}\n`);
      if (!args.flags.quiet) process.stderr.write(`\n${formatReport(res.report, 'text')}\n\nsession: ${res.sessionId}\n`);
      return res.status === 'completed' ? 0 : 1;
    }

    case 'resume': {
      if (!rest[0]) throw new Error('Usage: coderelay resume <sessionId>');
      const o = createOrchestrator(configFrom(args));
      if (!args.flags.quiet) attachProgress(o);
      process.on('SIGINT', () => o.cancel('interrupted (Ctrl+C)'));
      const res = await o.resume(rest[0]);
      process.stdout.write(`\n${res.output}\n`);
      if (!args.flags.quiet) process.stderr.write(`\n${formatReport(res.report, 'text')}\n`);
      return res.status === 'completed' ? 0 : 1;
    }

    case 'sessions': {
      const list = await storeFor(configFrom(args)).list();
      if (!list.length) process.stdout.write('No sessions.\n');
      for (const s of list) process.stdout.write(`${s.id}  ${s.status.padEnd(9)}  $${s.costUsd.toFixed(4).padStart(9)}  ${String(s.tasks).padStart(3)} tasks  ${s.updatedAt}  ${s.title}\n`);
      return 0;
    }

    case 'report': {
      const config = configFrom(args);
      const state = await storeFor(config).load(rest[0] ?? '');
      if (!state) throw new Error(`Session not found: ${rest[0]}`);
      const format = (typeof args.flags.format === 'string' ? args.flags.format : 'text') as ReportFormat;
      process.stdout.write(`${formatReport(buildReport(state, { budget: config.budget }), format)}\n`);
      return 0;
    }

    case 'brief': {
      const { Session } = await import('./session/session.js');
      const session = await Session.load(storeFor(configFrom(args)), rest[0] ?? '');
      process.stdout.write(`${session.brief(20_000)}\n`);
      return 0;
    }

    case 'risk': {
      const command = rest.join(' ');
      if (!command) throw new Error('Usage: coderelay risk "<command>"');
      const config = configFrom(args);
      const a = new RiskEngine({ ...config.risk, workspaceRoot: config.workspace }).assess({
        subject: 'tool_call',
        agent: 'cli',
        tool: 'run_command',
        args: { command },
        toolRisk: 'exec',
      });
      process.stdout.write(`${a.decision.toUpperCase()}  score ${a.score}/100  (${a.level})\n`);
      for (const s of a.signals) process.stdout.write(`  • [${s.rule}] ${s.message}\n`);
      return a.decision === 'block' ? 2 : 0;
    }

    case 'mcp': {
      await new CodeRelayMcpServer(configFrom(args)).start();
      return 0;
    }

    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`coderelay: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
