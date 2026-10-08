# CodeRelay

**Long-running, resumable multi-agent coding sessions for GitHub Copilot (and any LLM), with cost and risk metrics on every agent invocation.**

CodeRelay brings Claude Code–style workflows to Copilot:

- **Long-running sessions**: work persists to disk, survives restarts and new chats, and compacts its own context into a rolling summary so it never overflows. Every event is journaled.
- **Orchestrator**: a planner breaks a goal into a dependency graph of tasks. Specialist agents (architect, coder, tester, reviewer, researcher…) are **deployed on demand**, only when a task needs them. Independent tasks run in parallel, and idle agents are retired.
- **Cost metrics**: tokens, USD, Copilot premium requests, latency and failures for every invocation. You can break these down by agent, model and task. Budgets stop the run cleanly, and you can resume it later.
- **Risk metrics**: every tool call, model output and invocation gets a 0–100 score from built-in rules (destructive commands, leaked secrets, paths outside the workspace, loops, cost spikes, error rates). Risky actions are blocked or sent to your approver.
- **Copilot integration**: an MCP server for Copilot agent mode, a `vscode.lm` provider for VS Code extensions, and GitHub Models over HTTP.
- No runtime dependencies. Node ≥ 20.3.

```bash
npm install @opensuperlab/coderelay
```

---

## Quick start (CLI)

```bash
npx @opensuperlab/coderelay init                      # writes coderelay.config.json + .vscode/mcp.json
export GITHUB_TOKEN=...                 # GitHub token with models:read (GitHub Models)
npx @opensuperlab/coderelay run "Add rate limiting to the REST API"
```

Try it offline with the mock provider:

```bash
npx @opensuperlab/coderelay run "Add a /health endpoint" --mock
```

```
plan: 4 task(s)
  t1 → architect: Design approach
  t2 → coder: Implement (after t1)
  t3 → tester: Write tests (after t1)
  t4 → reviewer: Review (after t2, t3)
+ deployed architect_3f9c… — first task for this agent type
▶ t1 Design approach [architect]
...
== Cost ==            invocations, tokens, $, premium requests
== Cost by agent ==   planner / architect / coder / tester / reviewer / orchestrator
== Risk ==            risk index, blocked actions, top risks
== Tasks ==           per-task status, tokens, cost, max risk
== Agent deployment == spawned instances, peak concurrency
```

| Command | What it does |
| --- | --- |
| `coderelay run "<goal>" [--session id]` | Plan and execute; `--session` adds a new round to an existing long-running session |
| `coderelay resume <id>` | Continue unfinished, failed or budget-stopped tasks |
| `coderelay sessions` | List sessions with status and cost |
| `coderelay report <id> [--format text\|markdown\|json]` | Cost and risk report |
| `coderelay brief <id>` | Session brief to paste into a fresh chat |
| `coderelay risk "<command>"` | Score a shell command (exit code 2 = block) |
| `coderelay mcp` | Start the MCP server (stdio) |

Flags: `--mock`, `--config <file>`, `--concurrency <n>`, `--budget <usd>`, `--quiet`. Press Ctrl+C to cancel cleanly; the session can be resumed afterwards.

---

## Using it from GitHub Copilot (agent mode)

`coderelay init` registers the MCP server in `.vscode/mcp.json`:

```json
{
  "servers": {
    "coderelay": { "type": "stdio", "command": "npx", "args": ["-y", "@opensuperlab/coderelay", "mcp"], "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" } }
  }
}
```

Copilot then gets these tools:

| Tool | Purpose |
| --- | --- |
| `relay_session_start` / `relay_session_resume` | Start a persistent session, or reload its brief in a **new chat** so long-running work continues |
| `relay_session_log` | Record progress and decisions (auto-compacted) |
| `relay_checkpoint` | Named checkpoints |
| `relay_record_usage` | Log Copilot's own token or premium-request usage for cost metrics |
| `relay_risk_check` | Score a command, path or text **before** acting |
| `relay_orchestrate` / `relay_resume_tasks` | Deploy a multi-agent team for a big goal |
| `relay_metrics` | Cost and risk report |
| `relay_sessions_list` | All sessions |

Tip: add this to `.github/copilot-instructions.md`: *"At the start of each chat call `relay_session_resume`. Before running any terminal command call `relay_risk_check`. Log important progress with `relay_session_log`."*

---

## Library usage

```ts
import { Orchestrator, githubModelsProvider, createWorkspaceTools, FileSessionStore } from '@opensuperlab/coderelay';

const orchestrator = new Orchestrator({
  provider: githubModelsProvider(),              // uses GITHUB_TOKEN
  model: 'openai/gpt-4.1',
  orchestratorModel: 'openai/gpt-4.1-mini',      // planning / synthesis / summaries
  tools: createWorkspaceTools({ allowCommands: true }),
  store: new FileSessionStore('.coderelay/sessions'),
  pricing: { 'openai/gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 } },
  budget: { maxCostUsd: 3, maxPremiumRequests: 100, warnAt: 0.8 },
  risk: {
    reviewThreshold: 50,
    blockThreshold: 80,
    onReview: async (a) => confirm(`Allow ${a.target}? (risk ${a.score})`), // your approval UI
  },
  maxConcurrency: 4,
});

orchestrator.on('agent:spawned', (e) => console.log('deployed', e.instanceId, e.reason));
orchestrator.on('risk:blocked', (a) => console.warn('blocked', a.target));
orchestrator.on('budget:warning', (e) => console.warn(`${e.metric} at ${e.utilization * 100}%`));

const result = await orchestrator.run('Migrate the user service to async/await');
console.log(result.output);
console.log(result.report.cost.totals, result.report.risk.riskIndex);

// Later, even after a restart: add another goal to the same session
await orchestrator.run('Now add integration tests', { sessionId: result.sessionId });
// or finish what a budget stop interrupted
await orchestrator.resume(result.sessionId);
```

### Inside a VS Code extension (Copilot models via `vscode.lm`)

```ts
import * as vscode from 'vscode';
import { Orchestrator, VSCodeLMProvider } from '@opensuperlab/coderelay';

const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4.1' });
const orchestrator = new Orchestrator({
  provider: new VSCodeLMProvider({ vscode, model, premiumMultiplier: 1 }),
  model: model.id,
});
```

See [`examples/`](examples) for a complete chat participant.

### Custom agents and tools

```ts
import { defaultAgents, defineTool } from '@opensuperlab/coderelay';

const agents = [
  ...defaultAgents,
  {
    name: 'dba',
    description: 'Designs schemas and writes safe migrations.',
    systemPrompt: 'You are a database expert...',
    capabilities: ['sql', 'database', 'migration', 'schema'],
    tools: ['read_file', 'write_file', 'query_db'],
    model: 'openai/gpt-4.1',
    maxInstances: 1,          // never deploy more than one
  },
];

const queryDb = defineTool({
  risk: 'exec',               // baseline risk class: read | write | exec | network
  schema: { name: 'query_db', description: 'Run a read-only SQL query', parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } },
  handler: async ({ sql }) => JSON.stringify(await db.query(String(sql))),
});
```

### Custom risk rules

```ts
const noProdRule = {
  name: 'no-prod',
  appliesTo: ['tool_call'],
  evaluate: (input) =>
    input.subject === 'tool_call' && JSON.stringify(input.args).includes('prod')
      ? { rule: 'no-prod', score: 90, message: 'touches production' }
      : null,
};
new Orchestrator({ ..., risk: { rules: [noProdRule] } });
```

---

## How it works

```
goal ─► Planner (LLM) ─► task DAG ─► Scheduler ─► AgentPool ─► Agent (model ⇄ tools loop)
                                         │            │              │
                                         │   spawn on demand,       every model call ─► InvocationGateway
                                         │   cap per type,           ├─ budget check (CostTracker)
                                         │   retire when idle        ├─ cost record (PricingTable)
                                         ▼                           └─ risk rules (RiskEngine)
                                      Session ◄── messages, tasks, invocations, risks, checkpoints
                                  (state.json + events.jsonl, rolling-summary compaction)
```

- **Planning**: `LLMPlanner` asks the orchestrator model for JSON tasks with `dependsOn`. Invalid plans fall back to a single routed task, and cycles are rejected. You can also use `StaticPlanner`, `SingleTaskPlanner` or your own planner.
- **Routing**: a task names an agent, or is matched to one by capability and keyword overlap (`AgentRegistry.match`).
- **Deployment**: `AgentPool` creates an instance only when a ready task needs that agent type and none is idle. It respects `maxConcurrency` and per-agent `maxInstances`, and retires instances after `idleTimeoutMs`.
- **Reliability**: per-task retries and timeouts. Dependents of failed tasks are skipped. Budget exhaustion cancels the remaining tasks and pauses the session so it can be resumed later.
- **Context**: each task sees the session brief and its dependencies' outputs. The session compacts older messages into a summary when it grows past `maxContextTokens`.

### Cost metrics

Each `InvocationRecord` has the agent, instance, task, model, input/output/cached tokens, USD, premium requests, duration, and success or failure. `PricingTable` accepts exact ids or globs (`openai/*`). If a model has token prices, cost is computed from tokens. Otherwise it is `premiumRequests × premiumRequestUsd` (default $0.04). **No prices ship with the package.** Configure the models you use. Unpriced calls are counted and flagged in reports.

### Risk metrics

| Rule | Looks at | Example |
| --- | --- | --- |
| `destructive-command` | tool calls | `rm -rf`, `git push --force`, `DROP TABLE`, `curl … \| sh`, `terraform destroy` |
| `secret-exposure` | args and outputs | GitHub/AWS/OpenAI/Slack tokens, private keys, hard-coded passwords |
| `path-safety` | file args | paths outside the workspace, `.env`, `.ssh`, credentials |
| `network-egress` | shell commands | `curl`, `wget`, URLs |
| `repetition-loop` | tool calls | the same call repeated 3+ (review) or 5+ (block) times |
| `tool-class` | tool calls | baseline for write, exec and network tools |
| `cost-spike` | invocations | an invocation over `costSpikeUsd`, or more than 4× the running average |
| `agent-error-rate` | invocations | 50% or more of an agent's recent calls failed |

Score is 0–100 (low, medium, high, critical). By default, a score of 50 or more is sent for review and 80 or more is blocked. Blocked tool calls are not executed; the agent is told to choose a safer approach. Blocked outputs are redacted. The session **risk index** blends the peak score with the share of elevated findings.

## Configuration (`coderelay.config.json`)

```json
{
  "provider": { "type": "github-models", "apiKeyEnv": "GITHUB_TOKEN" },
  "model": "openai/gpt-4.1",
  "orchestratorModel": "openai/gpt-4.1-mini",
  "maxConcurrency": 4,
  "taskRetries": 1,
  "budget": { "maxCostUsd": 5, "maxPremiumRequests": 150, "warnAt": 0.8 },
  "pricing": { "openai/gpt-4.1": { "inputPerMTok": 2, "outputPerMTok": 8 } },
  "risk": { "reviewThreshold": 50, "blockThreshold": 80, "onReview": "allow" },
  "tools": { "allowCommands": false, "allowWrites": true },
  "compaction": { "maxContextTokens": 24000, "keepRecent": 12 },
  "agents": [{ "name": "coder", "model": "openai/gpt-4.1", "maxInstances": 2 }]
}
```

Provider types: `github-models`, `openai-compatible` (`baseUrl`, `apiKeyEnv`, works with Azure OpenAI, OpenRouter, Ollama and others), and `mock`. Entries in `agents` are merged over the defaults by name.

## Development

```bash
npm install
npm test        # builds, then runs node:test suites
```

## License

MIT
