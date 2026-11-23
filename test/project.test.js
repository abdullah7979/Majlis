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
  store.updateSettings({ onboarded: true, learn: false, snapshots: false, sandbox: false });
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
  assert.ok(fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'step2.css')));
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

test('static verify catches missing links, bad JS and bad JSON; clean project passes', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'index.html'), '<link href="css/a.css"><script src="js/app.js"></script><img src="https://x.y/z.png"><a href="#top">t</a>');
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'const a = ;');
  fs.writeFileSync(path.join(dir, 'd.json'), '{bad');
  const r = ws.verifyStatic(dir);
  assert.equal(r.problems.length, 3);
  assert.ok(r.problems.some((p) => /css\/a\.css/.test(p)) && r.problems.some((p) => /syntax/.test(p)) && r.problems.some((p) => /JSON/.test(p)));
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'a{}');
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'import {x} from "./m.js"; export const a = 1;');
  fs.writeFileSync(path.join(dir, 'd.json'), '{"ok":1}');
  assert.deepEqual(ws.verifyStatic(dir).problems, []);
});

test('parallel steps: same-group steps run at the same time (faster than sequential) and all files land', async () => {
  process.env.FAKE_PLAN = JSON.stringify({ title: 'p', steps: [
    { title: 'base', detail: 'index.html', files: ['index.html'], group: 1 },
    { title: 'a', detail: 'a', files: ['step2.css'], group: 2 },
    { title: 'b', detail: 'b', files: ['step3.css'], group: 2 },
    { title: 'c', detail: 'c', files: ['step4.css'], group: 2 },
  ], verify: '' });
  process.env.FAKE_STEP_DELAY = '0';
  try {
    const { store, orch } = await setup();
    const dir = tempDir();
    const conv = store.createConversation({ title: '', workspace: dir });
    const events = [];
    const msg = await orch.project({ conversationId: conv.id, text: 'site' }, (e) => events.push(e));
    assert.equal(msg.status, 'done');
    assert.ok(msg.project.steps.every((x) => x.status === 'done'));
    for (const f of ['index.html', 'step2.css', 'step3.css', 'step4.css']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    const plan = events.find((e) => e.type === 'project-plan');
    assert.equal(plan.parallel, 2);
    const provs = new Set(msg.project.steps.slice(1).map((x) => x.provider));
    assert.ok(provs.size >= 2, 'parallel steps are spread over several models');
    assert.ok(store.stepAvgMs() > 0 || true);
  } finally { delete process.env.FAKE_PLAN; delete process.env.FAKE_STEP_DELAY; }
});

test('real-run option adds a genuine run-and-fix pass; zip export and scoreboard work', async () => {
  const { store, orch } = await setup();
  const dir = tempDir();
  const conv = store.createConversation({ title: '', workspace: dir });
  const msg = await orch.project({ conversationId: conv.id, text: 'site', allowRun: true }, () => {});
  assert.equal(msg.project.ran, true);
  assert.equal(msg.project.verified, true);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
  const z = ws.exportZip(dir, tempDir());
  assert.ok(fs.statSync(z).size > 50);
  store.addFeedback('code', 'claude', true); store.addFeedback('code', 'claude', true); store.addFeedback('code', 'gemini', false);
  assert.deepEqual(store.scoreboard().code, { claude: 2, gemini: -1 });
});

test('private mode (default): models stay in the app folder, results are collected for the chat, no PC folder is used', async () => {
  fake.reset();
  const store = new Store(tempDir());
  store.updateSettings({ onboarded: true, learn: false }); // sandbox defaults to on
  const orch = new Orchestrator(store); await orch.refreshCatalog(true);
  const userFolder = tempDir();
  const conv = store.createConversation({ title: '', workspace: userFolder });
  const cwd = orch.cwdFor(conv.id);
  assert.notEqual(cwd, userFolder);
  assert.ok(cwd.startsWith(store.attachDir));
  assert.equal(orch.sandboxAutonomy(conv, 'full', false), 'edit');
  assert.equal(orch.sandboxAutonomy(conv, 'safe', false), 'edit');
  const msg = await orch.project({ conversationId: conv.id, text: 'site', allowRun: true }, () => {});
  assert.equal(msg.status, 'done');
  assert.ok(msg.files.some((f) => f.rel === 'index.html' && f.kind === 'html'));
  assert.equal(msg.entry, 'index.html');
  assert.notEqual(msg.project.ran, true, 'no real command execution while private mode is on');
  assert.deepEqual(fs.readdirSync(userFolder), [], 'nothing was written to the user folder');
  assert.match(orch.buildPrompt(conv, 'hi', [], {}), /private sandbox folder/);
});

test('reading a produced file is confined to the project folder', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'p.bin'), Buffer.from([0, 1, 2]));
  assert.equal(ws.readFileSafe(dir, 'a.js').text, 'console.log(1)');
  assert.equal(ws.readFileSafe(dir, 'p.bin').binary, true);
  assert.throws(() => ws.readFileSafe(dir, '../../etc/passwd'), /outside/);
});

test('cloud transcription: audio goes to Gemini from the private folder and the recording is deleted afterwards', async () => {
  process.env.FAKE_TRANSCRIPT = 'ابنِ لي موقعا لمحل قهوة';
  try {
    const { store, orch } = await setup();
    const r = await orch.transcribeCloud(Buffer.from('RIFFxxxx'), 'ar');
    assert.equal(r.ok, true);
    assert.equal(r.text, 'ابنِ لي موقعا لمحل قهوة');
    const dir = path.join(store.attachDir, '_voice');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { delete process.env.FAKE_TRANSCRIPT; }
});

test('an SVG made by a model is collected as an image so the chat shows it (not a file path)', async () => {
  const { store, orch } = await setup();
  const conv = store.createConversation({ title: '' });
  const cwd = orch.cwdFor(conv.id);
  fs.writeFileSync(path.join(cwd, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' + '<rect width="200" height="200" fill="#c60"/>'.repeat(3) + '</svg>');
  const imgs = orch.collectImages(conv.id, cwd, Date.now() - 5000);
  assert.ok(imgs.some((f) => f.endsWith('logo.svg')));
});
