import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentPool,
  AgentRegistry,
  defaultAgents,
  defineTool,
  MemorySessionStore,
  MockProvider,
  Orchestrator,
  validatePlan,
} from '../dist/index.js';

const pricing = { mock: { inputPerMTok: 1000, outputPerMTok: 2000 } };

test('end-to-end: plans, deploys agents on demand, runs deps in parallel, reports cost', async () => {
  const store = new MemorySessionStore();
  const o = new Orchestrator({ provider: new MockProvider(undefined, 20), model: 'mock', store, pricing, maxConcurrency: 4 });
  const spawned = [];
  const started = [];
  o.on('agent:spawned', (e) => spawned.push(e.agent));
  o.on('task:started', (e) => started.push(e.task.id));

  const res = await o.run('Add a /health endpoint');
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.tasks.map((t) => t.status), ['completed', 'completed', 'completed', 'completed']);
  assert.deepEqual(spawned.sort(), ['architect', 'coder', 'reviewer', 'tester']);
  assert.equal(started[0], 't1');
  assert.equal(started[3], 't4'); // reviewer waits for t2 + t3
  assert.equal(res.report.pool.peakConcurrency, 2); // t2 and t3 ran in parallel

  const c = res.report.cost;
  assert.ok(c.totals.costUsd > 0);
  assert.ok(c.byAgent.planner && c.byAgent.coder && c.byAgent.orchestrator);
  assert.equal(res.report.tasks.items.length, 4);

  // Session persisted and resumable as a long-running session: second goal = new round.
  const res2 = await o.run('Now add metrics', { sessionId: res.sessionId });
  assert.equal(res2.sessionId, res.sessionId);
  assert.ok(res2.tasks.every((t) => t.id.startsWith('r2-')));
  const state = await store.load(res.sessionId);
  assert.equal(state.tasks.length, 8);
  assert.ok(state.invocations.length > res.report.cost.totals.invocations);
});

test('risky tool calls are blocked before execution and surface in risk metrics', async () => {
  let executed = 0;
  const shell = defineTool({
    risk: 'exec',
    schema: { name: 'run_command', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    handler: () => (executed++, 'ok'),
  });
  const provider = new MockProvider((req) => {
    const last = req.messages.at(-1);
    if (last.role === 'tool') return `saw: ${last.content.slice(0, 40)}`;
    return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'rm -rf /' } }] } };
  });
  const o = new Orchestrator({
    provider,
    model: 'mock',
    store: new MemorySessionStore(),
    tools: [shell],
    synthesize: false,
    planner: { plan: async () => ({ tasks: [{ id: 'x', title: 'cleanup', description: 'clean', agent: 'coder' }] }) },
  });
  const blocked = [];
  o.on('risk:blocked', (a) => blocked.push(a));
  const res = await o.run('clean up');
  assert.equal(executed, 0);
  assert.equal(blocked.length, 1);
  assert.match(res.output, /saw: BLOCKED by risk policy/);
  assert.equal(res.report.risk.byDecision.block, 1);
  assert.equal(res.report.risk.overallLevel, 'critical');
});

test('budget stop pauses the session; resume finishes it', async () => {
  const store = new MemorySessionStore();
  const make = (budget) => new Orchestrator({ provider: new MockProvider(), model: 'mock', store, pricing, budget, maxConcurrency: 1, synthesize: false });
  const first = await make({ maxInvocations: 3 }).run('Build feature');
  assert.equal(first.status, 'paused');
  assert.match(first.stopReason, /Budget exceeded: invocations/);
  assert.ok(first.tasks.some((t) => t.status === 'cancelled'));

  const resumed = await make({ maxInvocations: 50 }).resume(first.sessionId);
  assert.equal(resumed.status, 'completed');
  assert.ok(resumed.tasks.every((t) => t.status === 'completed'));
});

test('failed tasks retry, then dependents are skipped', async () => {
  const provider = new MockProvider((req) => {
    if (req.messages[0].content.includes('CODERELAY_PLANNER')) return '{}';
    if (req.messages.at(-1).content.includes('Task a')) throw new Error('boom');
    return 'fine';
  });
  const o = new Orchestrator({
    provider,
    model: 'mock',
    store: new MemorySessionStore(),
    taskRetries: 1,
    synthesize: false,
    planner: { plan: async () => ({ tasks: [{ id: 'a', title: 'A', description: 'a' }, { id: 'b', title: 'B', description: 'b', dependsOn: ['a'] }, { id: 'c', title: 'C', description: 'c' }] }) },
  });
  const res = await o.run('x');
  const byId = Object.fromEntries(res.tasks.map((t) => [t.id, t]));
  assert.equal(byId.a.status, 'failed');
  assert.equal(byId.a.attempts, 2);
  assert.equal(byId.b.status, 'skipped');
  assert.equal(byId.c.status, 'completed');
  assert.equal(res.status, 'failed');
});

test('agent pool scales out per demand and respects maxInstances', async () => {
  let made = 0;
  const pool = new AgentPool((def, id) => (made++, { instanceId: id, definition: def }), { maxConcurrency: 3, idleTimeoutMs: -1 });
  const def = { ...defaultAgents[1], maxInstances: 2 };
  const l1 = await pool.acquire(def);
  const l2 = await pool.acquire(def);
  let third = false;
  const p3 = pool.acquire(def).then((l) => ((third = true), l));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(third, false); // capped at 2 instances
  assert.equal(made, 2);
  l1.release();
  const l3 = await p3;
  assert.equal(made, 2); // reused idle instance, no new spawn
  l2.release();
  l3.release();
  assert.equal(pool.stats().peakConcurrency, 2);
});

test('plans are validated: unknown deps dropped, cycles rejected, routing works', () => {
  const reg = new AgentRegistry(defaultAgents);
  const tasks = validatePlan({ tasks: [{ id: 'a', title: 'write tests', description: 'add unit tests', dependsOn: ['zzz'] }, { id: 'a', title: 'dup', description: 'd', agent: 'nope' }] }, reg);
  assert.deepEqual(tasks.map((t) => t.id), ['a', 'a_2']);
  assert.deepEqual(tasks[0].dependsOn, []);
  assert.equal(tasks[1].agent, undefined);
  assert.equal(reg.match(tasks[0]).name, 'tester');
  assert.throws(() => validatePlan({ tasks: [{ id: 'x', title: 'x', description: '', dependsOn: ['y'] }, { id: 'y', title: 'y', description: '', dependsOn: ['x'] }] }, reg), /cycle/);
});
