import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodeRelayMcpServer } from '../dist/index.js';

test('MCP server: handshake, sessions, usage, risk check and orchestration', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coderelay-mcp-'));
  try {
    const server = new CodeRelayMcpServer({ workspace: dir, provider: { type: 'mock' }, model: 'mock', pricing: { 'gpt-x': { inputPerMTok: 1, outputPerMTok: 1 } } });
    const call = async (name, args) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;

    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'coderelay');
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.result.tools.length >= 9);

    const started = await call('relay_session_start', { title: 'copilot work' });
    const id = started.content[0].text.match(/ses_\w+/)[0];
    await call('relay_session_log', { sessionId: id, content: 'Refactored auth module' });
    const usage = await call('relay_record_usage', { sessionId: id, model: 'gpt-x', inputTokens: 1_000_000, outputTokens: 0 });
    assert.match(usage.content[0].text, /\$1\.0000/);

    const risk = await call('relay_risk_check', { command: 'rm -rf ~', sessionId: id });
    assert.match(risk.content[0].text, /^BLOCK/);

    const resume = await call('relay_session_resume', {});
    assert.match(resume.content[0].text, /Refactored auth module/);

    const orch = await call('relay_orchestrate', { goal: 'add caching', sessionId: id });
    assert.match(orch.content[0].text, /completed/);

    const metrics = await call('relay_metrics', { sessionId: id, format: 'json' });
    const report = JSON.parse(metrics.content[0].text);
    assert.ok(report.cost.byAgent.copilot);
    assert.ok(report.risk.byDecision.block >= 1);

    const bad = await call('relay_metrics', { sessionId: 'nope' });
    assert.equal(bad.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP server: stdio framing', async () => {
  const server = new CodeRelayMcpServer({ workspace: tmpdir() });
  const input = new PassThrough();
  const output = new PassThrough();
  const done = server.start(input, output);
  const lines = [];
  output.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
  input.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  input.write('not json\n');
  await new Promise((r) => setTimeout(r, 30));
  input.end();
  await done;
  // Parse errors reply synchronously, requests asynchronously — match responses by id.
  const msgs = lines.map((l) => JSON.parse(l));
  assert.deepEqual(msgs.find((m) => m.id === 7), { jsonrpc: '2.0', id: 7, result: {} });
  assert.equal(msgs.find((m) => m.id === null).error.code, -32700);
});
