// Example VS Code extension: an `@relay` Copilot Chat participant that runs a
// multi-agent team on Copilot models and streams progress, cost and risk into chat.
// package.json needs: "contributes": { "chatParticipants": [{ "id": "coderelay.relay", "name": "relay", "isSticky": true }] }
import * as vscode from 'vscode';
import { createWorkspaceTools, FileSessionStore, formatReport, Orchestrator, VSCodeLMProvider } from '@opensuperlab/coderelay';

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const store = new FileSessionStore(`${root}/.coderelay/sessions`);
  let sessionId = context.workspaceState.get<string>('coderelay.session');

  const participant = vscode.chat.createChatParticipant('coderelay.relay', async (request, _ctx, stream, token) => {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4.1' });
    if (!model) {
      stream.markdown('No Copilot model available.');
      return;
    }

    const orchestrator = new Orchestrator({
      provider: new VSCodeLMProvider({ vscode, model, premiumMultiplier: 1 }),
      model: model.id,
      store,
      workspaceRoot: root,
      tools: createWorkspaceTools({ allowCommands: true }),
      budget: { maxPremiumRequests: 50 },
      risk: {
        workspaceRoot: root,
        onReview: async (a) =>
          (await vscode.window.showWarningMessage(`CodeRelay: allow risky action (score ${a.score})?\n${a.target}`, { modal: true }, 'Allow')) === 'Allow',
      },
    });
    token.onCancellationRequested(() => orchestrator.cancel('cancelled in chat'));

    orchestrator
      .on('plan:created', (e) => stream.markdown(`**Plan**\n${e.tasks.map((t) => `- \`${t.id}\` ${t.title} → *${t.agent ?? 'auto'}*`).join('\n')}\n\n`))
      .on('agent:spawned', (e) => stream.progress(`Deploying ${e.agent}…`))
      .on('task:completed', (e) => stream.markdown(`✔ \`${e.task.id}\` ${e.task.title}\n`))
      .on('risk:blocked', (a) => stream.markdown(`⛔ blocked: \`${a.target}\`\n`));

    // Same session across chats: long-running work keeps its context.
    const result = await orchestrator.run(request.prompt, { sessionId });
    sessionId = result.sessionId;
    await context.workspaceState.update('coderelay.session', sessionId);

    stream.markdown(`\n${result.output}\n\n<details><summary>Cost & risk</summary>\n\n${formatReport(result.report, 'markdown')}\n\n</details>`);
  });

  context.subscriptions.push(participant);
}
