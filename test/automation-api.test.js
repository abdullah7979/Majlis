'use strict';
// Scheduler timing, and the local OpenAI-compatible API end to end (with the strict fake CLIs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeClis, tempDir } = require('./helpers');
const { Store } = require('../src/core/store');
const { Orchestrator } = require('../src/core/orchestrator');
const { Scheduler, lastDue, nextRun, isDue } = require('../src/core/scheduler');
const { ApiServer } = require('../src/core/api-server');

const fake = installFakeClis();
const at = (s) => new Date(s).getTime();

test('daily task: due once after its time, not again the same day', () => {
  const task = { enabled: true, prompt: 'x', createdAt: at('2026-11-20T00:00'), schedule: { type: 'daily', time: '08:30' } };
  assert.equal(isDue(task, at('2026-11-22T08:00')), false); // yesterday's 08:30 is > 12 h ago → not re-run
  assert.equal(isDue(task, at('2026-11-22T08:31')), true);
  assert.equal(isDue({ ...task, lastRun: at('2026-11-22T08:31') }, at('2026-11-22T15:00')), false);
  assert.equal(lastDue(task, at('2026-11-22T08:31')), at('2026-11-22T08:30'));
  assert.equal(nextRun({ ...task, lastRun: at('2026-11-22T08:31') }, at('2026-11-22T09:00')), at('2026-11-23T08:30'));
});

test('weekly task only on chosen days; hourly task every N hours', () => {
  const sunThu = { enabled: true, prompt: 'x', createdAt: 0, schedule: { type: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4] } };
  assert.equal(isDue(sunThu, at('2026-11-21T09:05')), false); // Saturday
  assert.equal(isDue(sunThu, at('2026-11-22T09:05')), true);  // Sunday
  const hourly = { enabled: true, prompt: 'x', createdAt: at('2026-11-22T10:00'), schedule: { type: 'hours', every: 3 } };
  assert.equal(isDue(hourly, at('2026-11-22T12:59')), false);
  assert.equal(isDue(hourly, at('2026-11-22T13:00')), true);
  assert.equal(nextRun(hourly, at('2026-11-22T13:30')), at('2026-11-22T16:00'));
});

test('missed runs (PC asleep) run once on wake if within 12 h; disabled tasks never run', () => {
  const task = { enabled: true, prompt: 'x', createdAt: 0, schedule: { type: 'daily', time: '07:00' } };
  assert.equal(isDue(task, at('2026-11-22T18:00')), true);
  assert.equal(isDue(task, at('2026-11-22T20:00')), false);
  assert.equal(isDue({ ...task, enabled: false }, at('2026-11-22T07:01')), false);
});

test('scheduler runs a task into its own conversation and reports it', async () => {
  fake.reset();
  const store = new Store(tempDir());
  store.updateSettings({ onboarded: true });
  const orch = new Orchestrator(store); await orch.refreshCatalog(true);
  const done = [];
  const sch = new Scheduler({ store, orch, onFinished: (t, m) => done.push([t.name, m.status]) });
  const task = sch.upsert({ name: 'تقرير الصباح', prompt: 'لخص لي أخبار التقنية اليوم', schedule: { type: 'daily', time: '00:00' } });
  await sch.run(task.id);
  const t = sch.tasks()[0];
  assert.equal(t.lastStatus, 'done');
  const conv = store.getConversation(t.conversationId);
  assert.equal(conv.source, 'automation');
  assert.equal(conv.messages.length, 2);
  assert.deepEqual(done, [['تقرير الصباح', 'done']]);
  await sch.run(task.id); // second run reuses the same conversation
  assert.equal(store.getConversation(t.conversationId).messages.length, 4);
});

async function api() {
  fake.reset();
  const store = new Store(tempDir());
  store.updateSettings({ onboarded: true, api: { port: 0 } });
  const orch = new Orchestrator(store); await orch.refreshCatalog(true);
  const server = new ApiServer({ orch, store, version: 'test' });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const key = store.getSettings().api.key;
  const call = (path, body, k = key) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { store, orch, server, call, key };
}

test('API: key required; models list; auto routing returns OpenAI format', async () => {
  const { server, call, key } = await api();
  try {
    assert.match(key, /^mj-/);
    assert.equal((await call('/v1/models', null, 'wrong')).status, 401);
    const models = await (await call('/v1/models')).json();
    const ids = models.data.map((m) => m.id);
    for (const id of ['majlis-auto', 'majlis-council', 'claude:opus', 'codex:gpt-6.2-sol', 'gemini:gemini-3.8-flash-medium']) assert.ok(ids.includes(id), id);
    const r = await call('/v1/chat/completions', { model: 'majlis-auto', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'refactor the entire codebase to TypeScript' }] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.object, 'chat.completion');
    assert.equal(j.model, 'claude:opus');
    assert.match(j.choices[0].message.content, /^CLAUDE\[opus\]/);
    assert.equal(j.majlis.category, 'code_heavy');
    const call0 = fake.calls().find((c) => c.name === 'claude');
    assert.match(call0.input, /Be brief\./, 'system message reaches the model');
    assert.ok(call0.args.includes('plan'), 'API runs read-only by default');
  } finally { await server.stop(); }
});

test('API: specific model by name, streaming (SSE), council and conversation continuation', async () => {
  const { server, call } = await api();
  try {
    const j = await (await call('/v1/chat/completions', { model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(j.model, 'codex:gpt-6.2-sol');
    const s = await call('/v1/chat/completions', { model: 'claude:haiku', stream: true, messages: [{ role: 'user', content: 'مرحبا' }] });
    assert.match(s.headers.get('content-type'), /text\/event-stream/);
    const raw = await s.text();
    const events = raw.split('\n\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
    const text = events.map((e) => (e.choices[0] && e.choices[0].delta.content) || '').join('');
    assert.equal(text, 'CLAUDE[haiku]: مرحبا');
    assert.ok(raw.trim().endsWith('data: [DONE]'));
    const council = await (await call('/v1/chat/completions', { model: 'majlis-council', messages: [{ role: 'user', content: 'compare React and Vue' }] })).json();
    assert.equal(council.majlis.category, 'council');
    const first = await (await call('/v1/chat/completions', { model: 'claude:sonnet', messages: [{ role: 'user', content: 'remember 42' }] })).json();
    const again = await (await call('/v1/chat/completions', { model: 'claude:sonnet', conversation_id: first.majlis.conversation_id, messages: [{ role: 'user', content: 'what number?' }] })).json();
    assert.match(again.choices[0].message.content, /turn 2/);
    assert.equal((await call('/v1/chat/completions', { model: 'nope-9', messages: [{ role: 'user', content: 'x' }] })).status, 404);
  } finally { await server.stop(); }
});

test('API: all models down -> 503 with the reason trail', async () => {
  const { server, call } = await api();
  try {
    for (const n of ['claude', 'codex', 'agy']) process.env[`FAKE_MODE_${n}`] = 'limit';
    const r = await call('/v1/chat/completions', { model: 'majlis-auto', messages: [{ role: 'user', content: 'fix this python bug' }] });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error.code, 'all_models_unavailable');
    assert.equal(j.error.majlis.trail.length, 3);
  } finally { for (const n of ['claude', 'codex', 'agy']) delete process.env[`FAKE_MODE_${n}`]; await server.stop(); }
});

test('prompt tools: "write me a prompt" goes to the prompt engineer; ✨ improves a rough request', async () => {
  fake.reset();
  const store = new Store(tempDir());
  store.updateSettings({ onboarded: true });
  const orch = new Orchestrator(store); await orch.refreshCatalog(true);
  const conv = store.createConversation();
  const msg = await orch.send({ conversationId: conv.id, text: 'سو لي برومبت احترافي لتوليد صور منتجات' }, () => {});
  assert.equal(msg.category, 'prompt');
  assert.equal(msg.provider, 'claude');
  assert.match(fake.calls().find((c) => c.name === 'claude').input, /expert prompt engineer/);
  fake.reset();
  const r = await orch.improvePrompt('ابي موقع لمطعمي');
  assert.equal(r.ok, true);
  const c = fake.calls()[0];
  assert.equal(c.name, 'claude');
  assert.ok(c.args.includes('haiku'));
  assert.match(c.input, /Rewrite the user's rough request/);
  assert.match(c.input, /Write it in Arabic/);
});
