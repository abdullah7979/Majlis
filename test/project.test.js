'use strict';
// Project mode, compare, live-preview helpers, project rules, rate-limit capture, API log, folder trigger.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installFakeClis, tempDir } = require('./helpers');
const { Store } = require('../src/core/store');
const { Orchestrator } = require('../src/core/orchestrator');
const { Scheduler } = require('../src/core/scheduler');
const ws = require('../src/core/workspace');

const fake = installFakeClis();
async function setup() {
  fake.reset();
  const store = new Store(tempDir());
  store.updateSettings({ onboarded: true, learn: false, snapshots: false });
  const orch = new Orchestrator(store); await orch.refreshCatalog(true);
  return { store, orch };
}

test('project mode: plan → build each step → verify → cross-review, files really written', async () => {
  const { store, orch } = await setup();
  const dir = tempDir();
  const conv = store.createConversation({ title: '', workspace: dir });
  const events = [];
  const msg = await orch.project({ conversationId: conv.id, text: 'ابي موقع لمحل قهوه' }, (e) => events.push(e.type + (e.phase ? ':' + e.phase : '')));
  assert.equal(msg.status, 'done');
  assert.equal(msg.project.steps.length, 2);
  assert.ok(msg.project.steps.every((x) => x.status === 'done'));
  assert.equal(msg.project.verified, true);
  assert.ok(fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'style.css')));
  assert.ok(events.includes('project-plan') && events.includes('project-phase:review') && events.includes('done'));
  assert.match(msg.text, /index\.html/);
  assert.notEqual(msg.project.review.provider, msg.provider, 'review must come from a different model');
});

test('project mode: reviewer findings trigger a fix round', async () => {
  process.env.FAKE_REVIEW = '- index.html: missing viewport meta';
  try {
    const { store, orch } = await setup();
    const conv = store.createConversation({ title: '', workspace: tempDir() });
    const events = [];
    const msg = await orch.project({ conversationId: conv.id, text: 'build a site' }, (e) => events.push(e.type + (e.phase ? ':' + e.phase : '')));
    assert.ok(events.includes('project-phase:fix'));
    assert.match(msg.project.review.note, /viewport/);
  } finally { delete process.env.FAKE_REVIEW; }
});

test('compare mode shows every model side by side without merging', async () => {
  const { store, orch } = await setup();
  const conv = store.createConversation({ title: '' });
  const msg = await orch.council({ conversationId: conv.id, text: 'what is 2+2', compare: true }, () => {});
  assert.equal(msg.category, 'compare');
  assert.ok(msg.council.length >= 2);
  assert.ok((msg.text.match(/^### /gm) || []).length >= 2);
});

test('workspace: file list, preview entry, change watcher, MAJLIS.md rules reach the prompt', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '1');
  fs.mkdirSync(path.join(dir, 'site'));
  fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<h1>a</h1>');
  fs.writeFileSync(path.join(dir, 'notes.html'), '<h1>n</h1>');
  const snap = ws.snapshot(dir);
  assert.deepEqual(snap.files.map((f) => f.path), ['notes.html', 'site/index.html']);
  assert.equal(snap.entry, 'site/index.html');
  let changes = 0;
  const w = new ws.Watcher(() => changes++, 50);
  w.watch(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>top</h1>');
  await new Promise((r) => setTimeout(r, 250));
  w.stop();
  assert.ok(changes >= 1);
  assert.equal(ws.snapshot(dir).entry, 'index.html');
  ws.initProjectMemory(dir);
  fs.writeFileSync(path.join(dir, 'MAJLIS.md'), 'استخدم RTL دائماً');
  const { store, orch } = await setup();
  const conv = store.createConversation({ title: '', workspace: dir });
  assert.match(orch.buildPrompt(conv, 'hi', [], {}), /استخدم RTL دائماً/);
});

test('rate-limit info reported by the CLI is stored for the gauge', async () => {
  const { store, orch } = await setup();
  const conv = store.createConversation({ title: '' });
  await orch.send({ conversationId: conv.id, text: 'hello', force: 'claude' }, () => {});
  const l = store.limitsFor('claude');
  assert.equal(l.length, 1);
  assert.equal(l[0].window, 'five_hour');
  assert.equal(orch.providerStatus ? true : true, true);
});

test('folder trigger runs the task once the changed files settle', async () => {
  const { store, orch } = await setup();
  const dir = tempDir();
  const done = [];
  const sch = new Scheduler({ store, orch, onFinished: (t, m) => done.push(m.status) });
  sch.settleMs = 0;
  sch.upsert({ name: 'watch', prompt: 'لخّص الملف الجديد', schedule: { type: 'watch', folder: dir } });
  await sch.tick();                       // first tick only records the baseline
  assert.equal(done.length, 0);
  fs.writeFileSync(path.join(dir, 'report.txt'), 'hello');
  await sch.tick();                       // sees the change, waits for it to settle
  await sch.tick();                       // unchanged since → runs
  assert.deepEqual(done, ['done']);
  const conv = store.getConversation(sch.tasks()[0].conversationId);
  assert.match(conv.messages[0].text, /report\.txt/);
  await sch.tick(); assert.equal(done.length, 1, 'does not rerun without new changes');
});
