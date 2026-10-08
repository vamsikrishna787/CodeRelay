import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createOrchestrator, type CodeRelayConfig } from '../config.js';
import { CostTracker } from '../metrics/cost.js';
import { PricingTable } from '../metrics/pricing.js';
import { buildReport, formatReport, type ReportFormat } from '../metrics/report.js';
import { RiskEngine } from '../metrics/risk.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { Session } from '../session/session.js';
import { FileSessionStore, type SessionStore } from '../session/store.js';
import { newId } from '../util.js';

const VERSION = '0.1.0';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const s = (description: string) => ({ type: 'string', description });
const n = (description: string) => ({ type: 'number', description });

/**
 * Model Context Protocol server (stdio) exposing CodeRelay to GitHub Copilot agent
 * mode, Claude Code, or any MCP client: persistent sessions that survive new chats,
 * cost/risk tracking, risk pre-checks for commands, and multi-agent orchestration.
 */
export class CodeRelayMcpServer {
  private readonly store: SessionStore;
  private readonly tools: McpTool[];
  private orchestrator?: Orchestrator;
  private readonly workspace: string;

  constructor(private readonly config: CodeRelayConfig = {}) {
    this.workspace = path.resolve(config.workspace ?? process.cwd());
    this.store = new FileSessionStore(path.resolve(this.workspace, config.sessionDir ?? path.join('.coderelay', 'sessions')));
    this.tools = this.defineTools();
  }

  /** Serve newline-delimited JSON-RPC over the given streams (stdin/stdout by default). */
  start(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    const send = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      void this.handle(req).then((res) => {
        if (res !== undefined && req.id !== undefined && req.id !== null) send({ jsonrpc: '2.0', id: req.id, ...res });
      });
    });
    return new Promise((resolve) => rl.on('close', resolve));
  }

  /** Handle one JSON-RPC request; returns `{result}` / `{error}`, or undefined for notifications. */
  async handle(req: JsonRpcRequest): Promise<{ result?: unknown; error?: { code: number; message: string } } | undefined> {
    switch (req.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'coderelay', version: VERSION },
            instructions:
              'CodeRelay keeps long-running coding sessions. At the start of a chat call relay_session_resume (or relay_session_start). ' +
              'Log meaningful progress with relay_session_log, check risky shell commands with relay_risk_check before running them, ' +
              'and use relay_orchestrate to deploy multiple specialist agents for large goals. relay_metrics reports cost and risk.',
          },
        };
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return { result: { tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
        try {
          const text = await tool.handler((req.params?.arguments as Record<string, unknown>) ?? {});
          return { result: { content: [{ type: 'text', text }] } };
        } catch (err) {
          return { result: { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true } };
        }
      }
      default:
        if (req.method.startsWith('notifications/')) return undefined;
        return { error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
  }

  private getOrchestrator(): Orchestrator {
    this.orchestrator ??= createOrchestrator(this.config, { store: this.store });
    return this.orchestrator;
  }

  private defineTools(): McpTool[] {
    const store = this.store;
    const str = (a: Record<string, unknown>, k: string) => {
      if (typeof a[k] !== 'string' || !a[k]) throw new Error(`"${k}" is required`);
      return a[k] as string;
    };

    return [
      {
        name: 'relay_session_start',
        description: 'Start a new persistent long-running session. Returns its id — reuse it in later chats.',
        inputSchema: obj({ title: s('Short session title'), goal: s('Overall goal of the session') }, ['title']),
        handler: async (a) => {
          const session = await Session.create(store, { title: str(a, 'title'), goal: a.goal as string | undefined });
          return `Session started: ${session.id}\n\n${session.brief()}`;
        },
      },
      {
        name: 'relay_session_resume',
        description: 'Load a session brief (summary, tasks, recent activity) to continue work in a fresh chat. Omit sessionId to get the most recent session.',
        inputSchema: obj({ sessionId: s('Session id') }),
        handler: async (a) => {
          let id = a.sessionId as string | undefined;
          if (!id) {
            id = (await store.list())[0]?.id;
            if (!id) return 'No sessions yet. Call relay_session_start.';
          }
          return (await Session.load(store, id)).brief(12_000);
        },
      },
      {
        name: 'relay_sessions_list',
        description: 'List stored sessions with status and cost.',
        inputSchema: obj({}),
        handler: async () => {
          const list = await store.list();
          return list.length ? list.map((x) => `${x.id}  [${x.status}]  $${x.costUsd.toFixed(4)}  ${x.tasks} tasks  ${x.updatedAt}  ${x.title}`).join('\n') : 'No sessions.';
        },
      },
      {
        name: 'relay_session_log',
        description: 'Append progress (decisions, changes, results) to a session so it survives across chats. Older entries are auto-compacted.',
        inputSchema: obj({ sessionId: s('Session id'), content: s('What happened'), role: { type: 'string', enum: ['user', 'assistant'] }, agent: s('Who did it, e.g. copilot') }, ['sessionId', 'content']),
        handler: async (a) => {
          const session = await Session.load(store, str(a, 'sessionId'));
          await session.append({ role: a.role === 'user' ? 'user' : 'assistant', name: (a.agent as string) ?? 'copilot', content: str(a, 'content') });
          const compacted = await session.compact(this.config.compaction || {});
          await session.save();
          return `Logged.${compacted ? ' Older context was compacted into the session summary.' : ''} Context ≈ ${session.contextTokens()} tokens.`;
        },
      },
      {
        name: 'relay_checkpoint',
        description: 'Create a named checkpoint in a session.',
        inputSchema: obj({ sessionId: s('Session id'), label: s('Checkpoint label') }, ['sessionId', 'label']),
        handler: async (a) => {
          const cp = await (await Session.load(store, str(a, 'sessionId'))).checkpoint(str(a, 'label'));
          return `Checkpoint ${cp.id} created.`;
        },
      },
      {
        name: 'relay_record_usage',
        description: "Record a model invocation's token usage (e.g. the current Copilot turn) for cost metrics.",
        inputSchema: obj(
          {
            sessionId: s('Session id'),
            model: s('Model id'),
            inputTokens: n('Prompt tokens'),
            outputTokens: n('Completion tokens'),
            premiumRequests: n('Copilot premium requests consumed'),
            agent: s('Agent name (default copilot)'),
          },
          ['sessionId', 'model'],
        ),
        handler: async (a) => {
          const session = await Session.load(store, str(a, 'sessionId'));
          const tracker = new CostTracker({ pricing: new PricingTable(this.config.pricing ?? {}, { premiumRequestUsd: this.config.premiumRequestUsd }), budget: this.config.budget });
          tracker.restore(session.state.invocations);
          const usage = { inputTokens: Number(a.inputTokens ?? 0), outputTokens: Number(a.outputTokens ?? 0) };
          const model = str(a, 'model');
          const price = tracker.price(model, usage, a.premiumRequests === undefined ? undefined : Number(a.premiumRequests));
          const rec = tracker.record({
            id: newId('inv'),
            sessionId: session.id,
            agent: (a.agent as string) ?? 'copilot',
            provider: 'external',
            model,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            usage,
            costUsd: price.usd,
            premiumRequests: price.premiumRequests,
            priced: price.priced,
            success: true,
          });
          session.recordInvocation(rec);
          await session.save();
          const st = tracker.status();
          return `Recorded $${rec.costUsd.toFixed(4)}. Session total $${st.usage.costUsd.toFixed(4)}, ${st.usage.premiumRequests} premium requests.${st.exceeded.length ? ` BUDGET EXCEEDED: ${st.exceeded.join(', ')}` : ''}`;
        },
      },
      {
        name: 'relay_risk_check',
        description: 'Score a shell command, file path or text for risk BEFORE acting (destructive ops, secrets, paths outside workspace). Returns allow/review/block.',
        inputSchema: obj({ command: s('Shell command to check'), path: s('File path to be written'), text: s('Text/output to scan for secrets'), sessionId: s('Record the result in this session') }),
        handler: async (a) => {
          const engine = new RiskEngine({ ...this.config.risk, workspaceRoot: this.workspace, onReview: 'allow' });
          const results = [];
          if (a.command) results.push(engine.assess({ subject: 'tool_call', agent: 'copilot', tool: 'run_command', args: { command: a.command }, toolRisk: 'exec' }));
          if (a.path) results.push(engine.assess({ subject: 'tool_call', agent: 'copilot', tool: 'write_file', args: { path: a.path }, toolRisk: 'write' }));
          if (a.text) results.push(engine.assess({ subject: 'output', agent: 'copilot', text: String(a.text) }));
          if (!results.length) throw new Error('Provide command, path or text');
          if (a.sessionId) {
            const session = await Session.load(store, String(a.sessionId));
            results.forEach((r) => session.recordRisk(r));
            await session.save();
          }
          return results
            .map((r) => `${r.decision.toUpperCase()} — score ${r.score}/100 (${r.level}) — ${r.target}\n${r.signals.map((x) => `  • [${x.rule}] ${x.message}`).join('\n') || '  • no risk signals'}`)
            .join('\n\n');
        },
      },
      {
        name: 'relay_orchestrate',
        description: 'Plan a goal into tasks and deploy specialist agents (architect, coder, tester, reviewer, ...) on demand to execute them, with cost & risk tracking. Requires a configured provider.',
        inputSchema: obj({ goal: s('What to accomplish'), sessionId: s('Continue this session') }, ['goal']),
        handler: async (a) => {
          const res = await this.getOrchestrator().run(str(a, 'goal'), { sessionId: a.sessionId as string | undefined });
          return `Session ${res.sessionId}: ${res.status}${res.stopReason ? ` (${res.stopReason})` : ''}\n\n${res.output}\n\n${formatReport(res.report, 'markdown')}`;
        },
      },
      {
        name: 'relay_resume_tasks',
        description: 'Resume unfinished/failed tasks of an orchestrated session (e.g. after a budget stop or restart).',
        inputSchema: obj({ sessionId: s('Session id') }, ['sessionId']),
        handler: async (a) => {
          const res = await this.getOrchestrator().resume(str(a, 'sessionId'));
          return `Session ${res.sessionId}: ${res.status}\n\n${res.output}`;
        },
      },
      {
        name: 'relay_metrics',
        description: 'Cost metrics (tokens, USD, premium requests, by agent/model/task, budget) and risk metrics (risk index, blocked actions, top risks) for a session.',
        inputSchema: obj({ sessionId: s('Session id'), format: { type: 'string', enum: ['markdown', 'json', 'text'] } }, ['sessionId']),
        handler: async (a) => {
          const state = await store.load(str(a, 'sessionId'));
          if (!state) throw new Error('Session not found');
          return formatReport(buildReport(state, { budget: this.config.budget }), (a.format as ReportFormat) ?? 'markdown');
        },
      },
    ];
  }
}
