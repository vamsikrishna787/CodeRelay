import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileSessionStore, MemorySessionStore, MockProvider, Session } from '../dist/index.js';

test('file store: session persists, reloads and journals events', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coderelay-'));
  try {
    const store = new FileSessionStore(dir);
    const s = await Session.create(store, { title: 'demo', goal: 'build things' });
    await s.append({ role: 'user', content: 'hello' });
    await s.checkpoint('first');
    await s.save();

    const again = await Session.load(store, s.id);
    assert.equal(again.state.messages.length, 1);
    assert.equal(again.state.checkpoints.length, 1);
    const events = await again.events();
    assert.ok(events.some((e) => e.type === 'message'));
    assert.ok(events.some((e) => e.type === 'checkpoint'));
    assert.equal((await store.list())[0].id, s.id);
    assert.match(again.brief(), /build things/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compaction folds old messages into a summary and keeps recent ones', async () => {
  const store = new MemorySessionStore();
  const s = await Session.create(store, { title: 't' });
  for (let i = 0; i < 30; i++) await s.append({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(400)}` });
  const provider = new MockProvider();
  const did = await s.compact({ maxContextTokens: 1000, keepRecent: 5, provider, model: 'm' });
  assert.equal(did, true);
  assert.equal(s.state.messages.length, 5);
  assert.equal(s.state.compactions, 1);
  assert.match(s.state.summary, /Summary of earlier work/);
  assert.equal(s.contextWindow()[0].role, 'system');
  // Under the limit: no-op.
  assert.equal(await s.compact({ maxContextTokens: 100_000 }), false);
});

test('compaction never leaves an orphaned tool result at the window start', async () => {
  const s = await Session.create(new MemorySessionStore(), { title: 't' });
  for (let i = 0; i < 10; i++) await s.append({ role: 'user', content: 'y'.repeat(400) });
  await s.append({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] });
  await s.append({ role: 'tool', toolCallId: 'c1', content: 'z'.repeat(400) });
  await s.append({ role: 'assistant', content: 'done' });
  await s.compact({ maxContextTokens: 200, keepRecent: 2 });
  assert.notEqual(s.state.messages[0].role, 'tool');
});
