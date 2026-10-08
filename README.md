# CodeRelay

[![npm](https://img.shields.io/npm/v/@opensuperlab/coderelay.svg)](https://www.npmjs.com/package/@opensuperlab/coderelay)
[![license](https://img.shields.io/npm/l/@opensuperlab/coderelay.svg)](LICENSE)

**Make GitHub Copilot plan first, ask you, then build and test your code, step by step.**

---

## The problem

When you ask GitHub Copilot to build something, it usually starts writing code right away. It doesn't:

- check that it understood you,
- show you a plan first,
- test that the result really works,
- remember what it did yesterday,
- tell you what it cost or whether it did something risky.

## The solution

Install CodeRelay and Copilot will handle **every request** like this:

| Step | What Copilot does |
| :---: | --- |
| 1 | **Writes down the goal** and how to check it's done |
| 2 | **Makes a plan** |
| 3 | **Asks you** questions, then *"Shall I implement this plan?"* and **waits for your yes** |
| 4 | **Builds it** using helper agents (a designer, a coder, a tester, a reviewer) |
| 5 | **Tests it** to check the goal is really reached |
| 6 | **Tries again** if something is still broken, up to 5 times |
| 7 | **Tells you** the result, the cost, and any risks |

---

## Setup (2 minutes)

**You need:** VS Code, the GitHub Copilot extension, and Node.js 20 or newer.

**1. Open a terminal in your project folder and run:**

```bash
npm install --save-dev @opensuperlab/coderelay
```

**2. Reload VS Code.** Press `Ctrl+Shift+P` (`Cmd+Shift+P` on Mac) and run **Developer: Reload Window**.

**3. Open Copilot Chat** and set the mode to **Agent**. The mode picker is at the bottom of the chat box.

You're done. There are no accounts, API keys or tokens to set up.

> **Didn't work?** Some setups skip the automatic step (for example pnpm). Run `npx coderelay init` once to finish setup.

---

## How to use it

Just ask Copilot normally:

> **You:** Add a dark mode toggle to the settings page

Copilot answers with a goal and a plan:

> **Goal:** Users can switch between light and dark mode on the settings page.
>
> **Done when:**
> 1. A toggle appears on the settings page
> 2. Clicking it switches the colors
> 3. The choice is remembered after a page refresh
> 4. All tests pass
>
> **Plan:**
> - Coder: add the toggle and dark styles
> - Tester: write tests for the toggle
> - Verifier: run the tests and check everything above
>
> **Question:** Should dark mode follow the computer's system setting by default?
> **Shall I implement this plan?**

Reply with your answer, for example:

> **You:** Yes, follow the system setting. Go ahead.

Copilot then builds, tests and fixes the feature on its own, and finishes with:

> ✅ **Goal reached** (attempt 2 of 5)
> The first test run failed because the choice wasn't saved; fixed and re-tested.
> Cost: about 3 premium requests (~$0.12) · Risk: low

**Nothing gets built until you say yes.**

---

## Picking up where you left off

Copilot keeps notes in the file **`.coderelay/SESSION.md`**: what it's working on, what's done, and what's next.

Close VS Code, come back tomorrow, open a new chat and type:

> **You:** continue

Copilot reads its notes and carries on.

---

## Cost and safety reports

Open **`.coderelay/REPORT.md`** any time, or ask Copilot *"show the CodeRelay report"*.

**💰 Cost:** how much Copilot usage each request took.
- Copilot counts usage in **premium requests**. Your plan includes a monthly amount, and extra ones cost about $0.04 each.
- CodeRelay estimates how many premium requests each request used.
- If the budget runs out (default: 300), Copilot stops and asks you before continuing.

**🛡️ Safety:** what Copilot did that could be risky.
- Before running dangerous terminal commands, Copilot checks them first.
  - Commands like deleting folders (`rm -rf`), force-pushing to git, or deleting database tables are **blocked**.
  - Borderline commands are **shown to you first**.
- After each step, the changed files are scanned for mistakes like **passwords or API keys left in the code**.

---

## Files it adds to your project

| File | What it is |
| --- | --- |
| `.github/copilot-instructions.md` | The rules Copilot follows. Your existing text in this file is kept |
| `.github/agents/` | The helper agents: Orchestrator, Architect, Researcher, Coder, Tester, Reviewer, Verifier |
| `.vscode/settings.json` | Lets Copilot update its notes without asking you every time |
| `.coderelay/` | Copilot's notes (`SESSION.md`), reports (`REPORT.md`) and settings (`config.json`) |

Commit these files to git so your whole team gets the same behavior.

---

## Common questions

**Do I have to type special commands?**
No. Talk to Copilot normally. Copilot runs CodeRelay's commands itself; you'll see them in the chat.

**Does it need a GitHub token or API key?**
No. It uses the Copilot you already have.

**Can I skip the plan for small things?**
Yes. Quick questions and one-line fixes are answered directly, without the full process.

**Can I change the number of retries or the budget?**
Yes. Edit `.coderelay/config.json`:

```json
{
  "maxAttempts": 5,
  "budget": { "maxPremiumRequests": 300 }
}
```

**Can I change how a helper agent behaves?**
Yes. Edit its file in `.github/agents/`. CodeRelay won't overwrite a file you've changed.

**Copilot skipped a step. Why?**
Copilot is an AI, so it sometimes slips. CodeRelay **blocks** the important mistakes: it won't let Copilot start building before you approve, or claim success without testing. Stronger models (chosen in Copilot's model picker) follow the steps more closely.

**How do I start a fresh session?**
Run `npx coderelay new`. The old notes are saved in `.coderelay/history/`.

**I upgraded from version 0.1 and Copilot asks for a GitHub token.**
Delete the `coderelay` entry from `.vscode/mcp.json` (or delete the file) and reload VS Code. The new version doesn't use it.

---

## License

MIT
