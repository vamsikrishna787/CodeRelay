# CodeRelay

[![npm](https://img.shields.io/npm/v/@opensuperlab/coderelay.svg)](https://www.npmjs.com/package/@opensuperlab/coderelay)
[![license](https://img.shields.io/npm/l/@opensuperlab/coderelay.svg)](LICENSE)
![node](https://img.shields.io/node/v/@opensuperlab/coderelay.svg)

**Give GitHub Copilot a memory, a team, and a budget.**

CodeRelay adds Claude Code–style workflows to GitHub Copilot and any other LLM:

| | |
| --- | --- |
| 🧠 **Long-running sessions** | Work is saved to disk and continues across new chats, VS Code restarts and days. Old context is compacted into a summary automatically. |
| 🤖 **Multi-agent orchestrator** | One goal is planned into tasks. Specialist agents (architect, coder, tester, reviewer, researcher) are **deployed only when needed** and run in parallel where possible. |
| 💰 **Cost metrics** | Tokens, USD and Copilot premium requests for every agent call, broken down by agent, model and task. Budgets pause the run, and you can resume it later. |
| 🛡️ **Risk metrics** | Every command, file write and model output is scored 0–100. Things like `rm -rf`, force-push, `DROP TABLE` and leaked tokens are **blocked before they run**. |

Works with **Copilot agent mode** (MCP), **VS Code extensions** (`vscode.lm`), **GitHub Models**, and any **OpenAI-compatible** API. No runtime dependencies. Node ≥ 20.3.

---

## Contents

- [Install](#install)
- [Way 1: Inside GitHub Copilot Chat (recommended)](#way-1-inside-github-copilot-chat-recommended)
- [Way 2: From the terminal (CLI)](#way-2-from-the-terminal-cli)
- [Way 3: In your own code (library)](#way-3-in-your-own-code-library)
- [Configuration](#configuration-coderelayconfigjson)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

## Install

There's nothing to install globally; `npx` runs it on demand. To add it to a project:

```bash
npm install @opensuperlab/coderelay
```

After installing, the command is `coderelay`. Without installing, use `npx @opensuperlab/coderelay …`.

---

## Way 1: Inside GitHub Copilot Chat (recommended)

Copilot keeps its normal chat. CodeRelay adds tools for persistent sessions, risk checks, cost tracking and an agent team.

**Step 1: Set up your project** (run in the project's root folder):

```bash
npx @opensuperlab/coderelay init
```

This creates three things:

| File | Purpose |
| --- | --- |
| `.vscode/mcp.json` | Registers the CodeRelay MCP server with Copilot |
| `.github/copilot-instructions.md` | Tells Copilot to resume sessions, check risky commands and log progress |
| `coderelay.config.json` | Models, budget, risk thresholds and prices (all optional) |

**Step 2: Provide a GitHub token** (only needed for the agent team, `relay_orchestrate`). Create one at https://github.com/settings/tokens with the **`models:read`** permission.

```powershell
# Windows (PowerShell): permanent, then restart VS Code
setx GITHUB_TOKEN "github_pat_xxx"
```

```bash
# macOS / Linux: add to ~/.zshrc or ~/.bashrc
export GITHUB_TOKEN=github_pat_xxx
```

**Step 3: Turn it on in VS Code.** Reload the window. Open Copilot Chat, switch the mode to **Agent**, then click the 🛠️ tools icon and check that the **coderelay** tools are enabled. You can also start the server manually from `.vscode/mcp.json` by clicking **Start** above the `coderelay` entry.

**Step 4: Talk to Copilot.** Example prompts:

| You type | What happens |
| --- | --- |
| *"Start a relay session for migrating auth to OAuth."* | Creates a persistent session and returns its id |
| *"Resume my relay session."* (in a **new chat**, even days later) | Copilot reloads the summary, task list and recent activity, and carries on |
| *"Check if `git push --force` is safe here."* | Risk score and decision (allow, review or block) with reasons |
| *"Use relay to orchestrate: add pagination and tests to the /users API."* | Plans tasks, deploys architect, coder, tester and reviewer agents, and returns the result with a cost and risk report |
| *"Show relay metrics for this session."* | Tokens, USD, premium requests, cost by agent, risk index and blocked actions |

<details>
<summary>All MCP tools Copilot gets</summary>

| Tool | Purpose |
| --- | --- |
| `relay_session_start` | Start a persistent session |
| `relay_session_resume` | Load a session brief in a new chat (latest session if no id is given) |
| `relay_sessions_list` | List sessions with status and cost |
| `relay_session_log` | Record progress and decisions (auto-compacted) |
| `relay_checkpoint` | Create a named checkpoint |
| `relay_record_usage` | Log Copilot's own token or premium-request usage for cost metrics |
| `relay_risk_check` | Score a command, file path or text **before** acting |
| `relay_orchestrate` | Plan a goal and deploy the agent team |
| `relay_resume_tasks` | Finish tasks stopped by a budget limit, an error or a restart |
| `relay_metrics` | Cost and risk report (markdown, json or text) |

</details>

---

## Way 2: From the terminal (CLI)

**Try it offline first.** No token or cost; a built-in mock model is used:

```bash
npx @opensuperlab/coderelay run "Add a /health endpoint" --mock
```

You'll see the plan, the agents being deployed, and the report:

```
plan: 4 task(s)
  t1 → architect: Design approach
  t2 → coder: Implement (after t1)
  t3 → tester: Write tests (after t1)
  t4 → reviewer: Review (after t2, t3)
+ deployed architect_3f9c… — first task for this agent type
▶ t1 Design approach [architect]
✔ t1 (1 turns, 0 tool calls)
...
== Cost ==            invocations, tokens, $, premium requests
== Cost by agent ==   planner / architect / coder / tester / reviewer / orchestrator
== Risk ==            risk index, blocked actions, top risks
== Tasks ==           status, tokens, cost and max risk per task
== Agent deployment == instances spawned, peak concurrency
```

**Real run** (needs `GITHUB_TOKEN`, see Way 1, step 2):

```bash
npx @opensuperlab/coderelay run "Add input validation to the signup form" --budget 0.50
```

**Long-running workflow:**

```bash
coderelay run "Build the billing module" --budget 2      # prints: session ses_ab12…
coderelay run "Now add invoices" --session ses_ab12…     # same session, new round of tasks
coderelay resume ses_ab12…                                # after Ctrl+C / budget stop / crash
coderelay report ses_ab12… --format markdown              # cost & risk report
coderelay brief ses_ab12…                                 # summary to paste into any chat
```

| Command | What it does |
| --- | --- |
| `coderelay init` | Set up a project for Copilot (see Way 1) |
| `coderelay run "<goal>" [--session id]` | Plan and execute. `--session` continues an existing session |
| `coderelay resume <id>` | Continue unfinished, failed or budget-stopped tasks |
| `coderelay sessions` | List sessions with status and cost |
| `coderelay report <id> [--format text\|markdown\|json]` | Cost and risk report |
| `coderelay brief <id>` | Session summary for a fresh chat |
| `coderelay risk "<command>"` | Score a shell command (exit code 2 means block; useful in git hooks and CI) |
| `coderelay mcp` | Start the MCP server (stdio). Normally VS Code starts it for you |

Flags: `--mock`, `--config <file>`, `--concurrency <n>`, `--budget <usd>`, `--quiet`. Ctrl+C stops cleanly, and the session can be resumed.

---

## Way 3: In your own code (library)

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

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Copilot doesn't show the coderelay tools | Make sure Chat is in **Agent** mode, reload the window, then open `.vscode/mcp.json` and click **Start** above `coderelay`. Check the output under *MCP: List Servers → coderelay → Show Output*. |
| `githubModelsProvider requires a token` | Set `GITHUB_TOKEN` (see Way 1, step 2) and restart VS Code or your terminal. You can also add `--mock` to try it offline. |
| `HTTP 401` / `403` from GitHub Models | The token needs the **`models:read`** permission. |
| `HTTP 429` | Rate limit. CodeRelay retries with backoff automatically. Lower `maxConcurrency` if it keeps happening. |
| Report shows `$0.0000` and "unpriced" | Add your models to `pricing` in `coderelay.config.json`. No prices ship with the package. |
| Run stopped with `Budget exceeded` | Raise the budget, then run `coderelay resume <id>`. Completed tasks are not repeated. |
| An agent's command was `BLOCKED` | This is intended. Check the reason with `coderelay report <id>`. Adjust `risk.blockThreshold`, or use an `onReview` approver in library mode. |
| Where is my data? | `.coderelay/sessions/<id>/` in your project: `state.json` holds the current state and `events.jsonl` the full history. Add `.coderelay/` to `.gitignore`. |

## Development

```bash
npm install
npm test        # builds, then runs node:test suites
```

## License

MIT
