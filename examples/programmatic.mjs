// Run: node examples/programmatic.mjs   (after `npm run build`)
// Uses the mock provider so it works offline; swap in githubModelsProvider() for real runs.
import { createWorkspaceTools, formatReport, MemorySessionStore, MockProvider, Orchestrator } from '../dist/index.js';

const orchestrator = new Orchestrator({
  provider: new MockProvider(undefined, 50),
  model: 'mock',
  tools: createWorkspaceTools({ allowCommands: false }),
  store: new MemorySessionStore(),
  pricing: { mock: { inputPerMTok: 3, outputPerMTok: 15 } },
  budget: { maxCostUsd: 1, warnAt: 0.8 },
  risk: { onReview: async (a) => (console.log(`review: ${a.target} (score ${a.score}) → approved`), true) },
  maxConcurrency: 3,
});

orchestrator
  .on('plan:created', (e) => console.log(`plan: ${e.tasks.map((t) => `${t.id}→${t.agent}`).join(', ')}`))
  .on('agent:spawned', (e) => console.log(`deployed ${e.instanceId}: ${e.reason}`))
  .on('task:completed', (e) => console.log(`done ${e.task.id}`))
  .on('risk:blocked', (a) => console.log(`BLOCKED ${a.target}`));

const result = await orchestrator.run('Add pagination to the /users endpoint');
console.log(`\n${result.output}\n`);
console.log(formatReport(result.report, 'text'));
