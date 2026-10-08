# CodeRelay

[![npm](https://img.shields.io/npm/v/@opensuperlab/coderelay.svg)](https://www.npmjs.com/package/@opensuperlab/coderelay)
[![license](https://img.shields.io/npm/l/@opensuperlab/coderelay.svg)](LICENSE)

**Install it once. GitHub Copilot then works like a team lead: it sets a goal, plans the work, asks for your OK, spawns specialist agents to build it, tests it, and keeps trying until the goal is reached. It also keeps a cost report and a risk report.**

No MCP servers. No configuration. No API keys.

## Install

In your project folder:

```bash
npm install --save-dev @opensuperlab/coderelay
```

That's it. Open **Copilot Chat** in VS Code (Agent mode) and ask for what you want.

> If your package manager skips install scripts (pnpm, `--ignore-scripts`), run `npx coderelay init` once.

## What happens when you ask Copilot something

```
 you ask ─► 1. GOAL      Copilot restates it as a goal + success criteria
            2. PLAN      splits it into tasks for only the agents it needs
            3. ASK       shows you the plan, asks about missing info:
                         "Shall I implement this plan?"   ◄── waits for you
            4. BUILD     spawns agents: Architect · Coder · Tester · Reviewer …
            5. VERIFY    Verifier runs the build/tests, checks every criterion
            6. RETRY     not reached? fixes and re-verifies (up to 5 attempts)
            7. REPORT    result + cost + risk
```

Example:

> **You:** add rate limiting to the login endpoint
>
> **Copilot:** **Goal:** Limit login attempts per IP.
> **Criteria:** ① 6th attempt within a minute gets HTTP 429 ② normal logins unaffected ③ tests pass
> **Plan:** t1 Coder (implement middleware) → t2 Tester (add tests) → t3 Verifier
> Should the limit be 5/min, and is Redis available or in-memory OK? **Shall I implement this plan?**
>
> **You:** 5/min, in-memory, go
>
> **Copilot:** *spawns Coder… Tester… Verifier: 1 test failing → attempt 2: fix → Verifier: all criteria PASS*
> ✅ Goal achieved on attempt 2/5 · 4 agent runs · ~2 premium requests · risk: low

You can also pick **Orchestrator** in the Copilot agent dropdown to make it explicit, but Copilot follows the workflow either way.

## Long-running sessions

Copilot keeps its memory in **`.coderelay/SESSION.md`**: the current goal, the plan with progress, verification results, and the exact next step. Start a new chat tomorrow and just say *"continue"*; Copilot reads the file and picks up where it left off. Each new request becomes the next goal in the same session.

## Reports

**`.coderelay/REPORT.md`** is kept up to date automatically:

- **Cost**: agent runs, Copilot premium requests and estimated $, broken down per goal and per agent, with a budget check. Copilot stops and asks you if the budget is reached (default 300 premium requests).
- **Risk**: every command Copilot wants to run is checked first. Dangerous ones are blocked: `rm -rf`, force-push, `DROP TABLE`, `curl … | sh`, deploys and publishes. Every finished task's changed files are scanned for leaked secrets, disabled TLS checks, SQL/shell injection and similar. You get a risk index plus recommendations.

Ask Copilot *"show the CodeRelay report"* at any time.

## What gets added to your project

| File | Why |
| --- | --- |
| `.github/copilot-instructions.md` | The workflow rules (added as a section; your existing content is kept) |
| `.github/agents/coderelay-*.agent.md` | Orchestrator plus 6 specialists: Architect, Researcher, Coder, Tester, Reviewer, Verifier |
| `.vscode/settings.json` | Lets Copilot run `npx coderelay …` without asking you each time |
| `.coderelay/` | Session memory, reports and settings |

Commit these files so your whole team gets the same workflow. Upgrading the package refreshes them, but any agent file you've edited yourself is left alone.

## Settings (optional)

`.coderelay/config.json`:

```json
{
  "maxAttempts": 5,
  "budget": { "maxPremiumRequests": 300 },
  "models": { "gpt-4.1": 0, "gpt-4o": 0, "gpt-5-mini": 0, "default": 1 },
  "premiumRequestUsd": 0.04,
  "risk": { "review": 50, "block": 80 }
}
```

`models` maps Copilot models to premium requests per run (included models are 0). Match it to your Copilot plan for accurate cost estimates.

## Requirements

- VS Code with GitHub Copilot (Agent mode, custom agents and subagents)
- Node.js 20.3+

## License

MIT
