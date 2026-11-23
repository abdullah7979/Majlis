'use strict';
// End-to-end engine tests against STRICT fake CLIs modelled on the real tools
// (Claude Code 2.1.x, Codex 0.171, Antigravity CLI 1.5.14): any flag the real CLI would
// reject is rejected here too. On Windows CI these also exercise .cmd spawning,
// argument quoting and UTF-8 (Arabic) stdin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installFakeClis, tempDir } = require('./helpers');
const { Store } = require('../src/core/store');
const { Orchestrator } = require('../src/core/orchestrator');

const fake = installFakeClis();

async function setup(settings = {}) {
  fake.reset();
  const store = new Store(tempDir());
  store.updateSettings({ onboarded: true, learn: false, sandbox: false, ...settings });
  const orch = new Orchestrator(store);
  await orch.refreshCatalog(true);
  fake.reset();
  const conv = store.createConversation();
  return { store, orch, conv };
}
async function send(orch, conv, text, extra = {}) {
  const events = [];
  const msg = await orch.send({ conversationId: conv.id, text, ...extra }, (e) => events.push(e));
  return { msg, events, types: events.map((e) => e.type) };
}
const callsOf = (n) => fake.calls().filter((c) => c.name === (n === 'gemini' ? 'agy' : n));

test('heavy coding goes to Claude Opus instantly (keywords) and streams text', async () => {
  const { orch, conv } = await setup();
  const { msg, events } = await send(orch, conv, 'ابني لي تطبيق كامل من الصفر بـ React مع API');
  assert.equal(msg.status, 'done', JSON.stringify(msg.trail));
  assert.equal(msg.provider, 'claude');
  assert.equal(msg.category, 'code_heavy');
  assert.match(msg.text, /^CLAUDE\[opus\]: ابني لي تطبيق كامل من الصفر بـ React مع API$/);
  assert.ok(events.some((e) => e.type === 'text'));
  assert.ok(events.some((e) => e.type === 'activity' && /Read: x\.js/.test(e.text)));
  assert.ok(!fake.calls().some((c) => c.input.includes('You are a router')), 'clear request must not wait for a router model');
  const a = callsOf('claude')[0].args;
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
});

test('ambiguous request asks the fastest model (Claude Haiku) to route it', async () => {
  const { orch, conv } = await setup();
  process.env.FAKE_CLASSIFY = 'writing';
  const { msg } = await send(orch, conv, 'ابغى شي يساعدني في موضوع الشغل حق بكرة لو تكرمت');
  assert.equal(msg.routeSource, 'smart');
  assert.equal(msg.category, 'writing');
  const router = fake.calls().find((c) => c.input.includes('You are a router'));
  assert.equal(router.name, 'claude');
  assert.ok(router.args.includes('haiku'), router.args.join(' '));
});

test('every autonomy level produces arguments the real CLIs accept', async () => {
  for (const autonomy of ['safe', 'edit', 'full']) {
    for (const prov of ['claude', 'codex', 'gemini']) {
      const { orch, conv } = await setup({ autonomy });
      const { msg } = await send(orch, conv, 'hello there friend', { force: `${prov}|` });
      assert.equal(msg.status, 'done', `${prov}/${autonomy}: ${JSON.stringify(msg.trail)}`);
    }
  }
});

test('Gemini (Antigravity) gets the prompt as a JSON event on stdin, Arabic intact', async () => {
  const { orch, conv } = await setup();
  const { msg } = await send(orch, conv, 'مرحبا يا جيميناي\nسطر ثاني', { force: 'gemini|' });
  assert.equal(msg.status, 'done', JSON.stringify(msg.trail));
  const c = callsOf('agy')[0];
  assert.deepEqual(c.args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.ok(!c.args.some((x) => /مرحبا/.test(x)), 'prompt must not be on the command line');
  assert.match(c.input, /مرحبا يا جيميناي\nسطر ثاني$/);
  assert.match(msg.text, /^AGY\[default\]: سطر ثاني$/);
});

test('signed-out Antigravity is stopped at once (not after its 60 s wait) and skipped next time', async () => {
  const { orch, conv, store } = await setup();
  process.env.FAKE_MODE_agy = 'auth';
  const t0 = Date.now();
  const { msg, events } = await send(orch, conv, 'كيف حالك');
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  assert.ok(events.some((e) => e.type === 'fallback' && e.provider === 'gemini' && e.kind === 'auth'));
  assert.equal(msg.provider, 'claude');
  assert.equal(store.state.auth.gemini.ok, false);
  fake.reset(); process.env.FAKE_MODE_agy = 'auth';
  const second = await send(orch, conv, 'كيف حالك');
  assert.ok(!callsOf('agy').length, 'known signed-out provider must not be started');
  assert.equal(second.msg.provider, 'claude');
});

test('model refresh detects Antigravity sign-in state', async () => {
  const { orch, store } = await setup();
  assert.equal(store.state.auth.gemini.ok, true);
  process.env.FAKE_MODE_agy = 'auth';
  await orch.refreshCatalog(true);
  assert.equal(store.state.auth.gemini.ok, false);
  const st = await orch.providerStatus();
  assert.equal(st.gemini.signedIn, false);
});

test('Arabic questions tell the model to answer in Arabic', async () => {
  const { orch, conv } = await setup();
  await send(orch, conv, 'كم عدد أيام السنة الكبيسة؟', { force: 'claude|haiku' });
  assert.match(callsOf('claude')[0].input, /^\(Reply in Arabic/);
  fake.reset();
  await send(orch, conv, 'how many days in a leap year?', { force: 'claude|haiku' });
  assert.doesNotMatch(callsOf('claude')[0].input, /Reply in Arabic/);
});

test('falls back when a provider hits its limit, cools it down, then skips it', async () => {
  const { orch, conv, store } = await setup();
  process.env.FAKE_MODE_claude = 'limit';
  const { msg, events } = await send(orch, conv, 'refactor the entire codebase to TypeScript');
  assert.equal(msg.provider, 'codex', JSON.stringify(msg.trail));
  assert.equal(msg.text, 'CODEX[default]: refactor the entire codebase to TypeScript');
  const fb = events.find((e) => e.type === 'fallback');
  assert.equal(fb.provider, 'claude');
  assert.equal(fb.kind, 'limit');
  assert.equal(new Date(fb.until).getHours(), 17);
  assert.ok(store.cooldownUntil('claude'));
  assert.ok(events.some((e) => e.type === 'activity' && e.text === 'run: ls -la'));
  fake.reset();
  const second = await send(orch, conv, 'refactor the entire codebase again');
  assert.equal(second.msg.provider, 'codex');
  assert.ok(second.events.some((e) => e.type === 'skip' && e.provider === 'claude' && e.why === 'cooldown'));
  assert.ok(!callsOf('claude').length);
});

test('codex limit inside the JSON stream is detected', async () => {
  const { orch, conv, store } = await setup();
  process.env.FAKE_MODE_codex = 'limit';
  const { msg } = await send(orch, conv, 'hi', { force: 'codex|' });
  assert.equal(msg.status, 'failed');
  assert.equal(msg.trail[0].outcome, 'limit');
  assert.ok(store.cooldownUntil('codex'));
});

test('same model continues its own session (resume) with only the new message', async () => {
  const { orch, conv } = await setup();
  await send(orch, conv, 'fix this python bug please');
  fake.reset();
  const { msg } = await send(orch, conv, 'now add tests for it in python');
  assert.equal(msg.provider, 'claude');
  assert.match(msg.text, /\|turn 2\]/);
  const call = callsOf('claude')[0];
  assert.ok(call.args.includes('--resume'));
  assert.ok(!call.input.includes('fix this python bug'), 'resumed session must not resend history');
});

test('codex and gemini sessions resume too', async () => {
  for (const prov of ['codex', 'gemini']) {
    const { orch, conv } = await setup();
    await send(orch, conv, 'first question', { force: `${prov}|` });
    fake.reset();
    const { msg } = await send(orch, conv, 'second question', { force: `${prov}|` });
    assert.match(msg.text, /\|turn 2\]: second question$/, prov);
    const a = callsOf(prov)[0].args;
    assert.ok(prov === 'codex' ? a[1] === 'resume' : a.includes('--conversation'), a.join(' '));
  }
});

test('turns from other models are passed along when resuming', async () => {
  const { orch, conv } = await setup();
  await send(orch, conv, 'first to claude', { force: 'claude|' });
  await send(orch, conv, 'my name is Abdullah', { force: 'gemini|' });
  fake.reset();
  await send(orch, conv, 'what is my name?', { force: 'claude|' });
  const c = callsOf('claude')[0];
  assert.ok(c.args.includes('--resume'));
  assert.match(c.input, /my name is Abdullah/);
  assert.match(c.input, /AGY\[default\]/);
  assert.doesNotMatch(c.input, /first to claude/);
});

test('an expired session falls back to a fresh one with full context', async () => {
  const { orch, conv, store } = await setup();
  await send(orch, conv, 'remember the word banana', { force: 'claude|' });
  const c = store.getConversation(conv.id);
  c.sessions.claude.id = '00000000-dead-beef-0000-000000000000';
  store.saveConversation(c);
  fake.reset();
  const { msg, events } = await send(orch, conv, 'what word?', { force: 'claude|' });
  assert.equal(msg.status, 'done');
  assert.ok(events.some((e) => e.type === 'retry' && e.reason === 'session'));
  const calls = callsOf('claude');
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /remember the word banana/);
});

test('context is handed to a different model on a fresh session', async () => {
  const { orch, conv } = await setup();
  await send(orch, conv, 'my name is Abdullah', { force: 'gemini|' });
  fake.reset();
  await send(orch, conv, 'what is my name?', { force: 'codex|' });
  const call = callsOf('codex')[0];
  assert.equal(call.args[1], '--skip-git-repo-check');
  assert.match(call.input, /my name is Abdullah/);
  assert.match(call.input, /NEW USER MESSAGE\nwhat is my name\?$/);
});

test('unknown model name retries with the CLI default model', async () => {
  const { orch, conv } = await setup();
  const { msg, events } = await send(orch, conv, 'compare these two', { force: 'gemini|gemini-1.0-retired' });
  assert.equal(msg.status, 'done');
  assert.equal(msg.text, 'AGY[default]: compare these two');
  assert.ok(events.some((e) => e.type === 'retry' && e.reason === 'bad_model'));
});

test('codex "model does not exist" in the JSON stream retries with default', async () => {
  const { orch, conv } = await setup();
  const { msg } = await send(orch, conv, 'hey', { force: 'codex|gpt-4-old' });
  assert.equal(msg.text, 'CODEX[default]: hey');
});

test('signed-out provider is skipped (auth) without cooldown', async () => {
  const { orch, conv, store } = await setup();
  process.env.FAKE_MODE_claude = 'auth';
  const { msg, events } = await send(orch, conv, 'اكتب لي إيميل رسمي لمديري');
  assert.equal(events.find((e) => e.type === 'fallback').kind, 'auth');
  assert.equal(store.cooldownUntil('claude'), null);
  assert.equal(msg.status, 'done');
});

test('forced provider/model bypasses routing', async () => {
  const { orch, conv } = await setup();
  const { msg } = await send(orch, conv, 'hello', { force: 'claude|haiku' });
  assert.equal(msg.category, 'manual');
  assert.equal(msg.text, 'CLAUDE[haiku]: hello');
});

test('all providers exhausted -> failed with full trail', async () => {
  const { orch, conv } = await setup();
  for (const n of ['claude', 'codex', 'agy']) process.env[`FAKE_MODE_${n}`] = 'limit';
  const { msg, types } = await send(orch, conv, 'fix the bug in this python code');
  assert.equal(msg.status, 'failed');
  assert.equal(msg.trail.length, 3);
  assert.ok(msg.trail.every((t) => t.outcome === 'limit'));
  assert.equal(types[types.length - 1], 'failed');
});

test('cancel stops a running request', async () => {
  const { orch, conv } = await setup();
  process.env.FAKE_MODE_agy = 'slow';
  const p = send(orch, conv, 'hi there', { force: 'gemini|' });
  await new Promise((r) => setTimeout(r, 1500));
  orch.cancel(conv.id);
  const { msg } = await p;
  assert.equal(msg.status, 'cancelled');
});

test('workspace folder is the working directory; attachments listed in prompt', async () => {
  const ws = tempDir();
  const { orch, conv, store } = await setup();
  conv.workspace = ws; store.saveConversation(conv);
  const src = path.join(ws, 'notes.txt'); fs.writeFileSync(src, 'x');
  const [att] = store.importAttachments(conv.id, [src]);
  await send(orch, conv, 'لخص الملف', { attachments: [att], force: 'gemini|' });
  const call = callsOf('agy')[0];
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(ws));
  assert.ok(call.input.includes(att));
});

test('feedback re-orders a route only after a clear preference', async () => {
  const { orch, store } = await setup();
  assert.equal(orch.routeFor('code')[0].provider, 'claude');
  store.addFeedback('code', 'codex', true); store.addFeedback('code', 'codex', true);
  assert.equal(orch.routeFor('code')[0].provider, 'claude');
  store.addFeedback('code', 'codex', true);
  assert.equal(orch.routeFor('code')[0].provider, 'codex');
});

test('live model catalog: every model each subscription offers', async () => {
  const { orch } = await setup();
  const st = await orch.providerStatus();
  for (const id of ['claude', 'codex', 'gemini']) assert.equal(st[id].installed, true, id);
  assert.equal(st.codex.version, '0.171.0');
  assert.equal(st.gemini.version, '1.5.14');
  assert.deepEqual(st.claude.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(st.codex.models.map((m) => m.id), ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.5']);
  assert.deepEqual(st.gemini.models.map((m) => m.id), ['gemini-3.8-flash-medium', 'gemini-3.8-flash-lite', 'gemini-4-pro-high']);
  assert.equal(st.gemini.signedIn, true);
  assert.equal(orch.resolveModel('gemini', '@flash'), 'gemini-3.8-flash-medium');
  assert.equal(orch.resolveModel('gemini', '@fast'), 'gemini-3.8-flash-lite');
  assert.equal(orch.resolveModel('gemini', '@best'), 'gemini-4-pro-high');
});

test('quick questions use the newest Gemini Flash from the live list', async () => {
  const { orch, conv } = await setup();
  const { msg } = await send(orch, conv, 'كيف حالك');
  assert.equal(msg.provider, 'gemini');
  assert.equal(msg.text, 'AGY[gemini-3.8-flash-medium]: كيف حالك');
});

test('settings from older versions (retired models, Gemini CLI) are migrated', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, routes: { quick: [{ provider: 'gemini', model: 'gemini-2.5-flash' }] }, voice: { model: 'gemini-2.5-flash', autoSend: false } }));
  const store = new Store(dir);
  assert.equal(store.getSettings().routes.quick[0].model, '@flash');
  assert.equal(store.getSettings().voice.engine, 'auto');
  assert.equal(store.getSettings().voice.autoSend, false);
  assert.equal(store.getSettings().onboarded, true);
});


test('after signing in to Antigravity, the next status check notices it', async () => {
  const { orch, store } = await setup();
  process.env.FAKE_MODE_agy = 'auth';
  await orch.refreshCatalog(true);
  assert.equal(store.state.auth.gemini.ok, false);
  delete process.env.FAKE_MODE_agy;                 // user signs in
  store.state.auth.gemini.at -= 20000;              // a little time passes
  await orch.providerStatus(); await orch.catalogLoading;
  assert.equal(store.state.auth.gemini.ok, true);
  assert.equal((await orch.providerStatus()).gemini.signedIn, true);
});

// ------------------------------------------------------------------ v0.5 features
test('continuity: "نعم" after an image request stays with the same model and task', async () => {
  const { orch, conv } = await setup();
  const first = await send(orch, conv, 'صمم لي شعار لمقهى');
  assert.equal(first.msg.category, 'image');
  fake.reset();
  const { msg } = await send(orch, conv, 'نعم');
  assert.equal(msg.routeSource, 'continue');
  assert.equal(msg.category, 'image');
  assert.equal(msg.provider, first.msg.provider);
  assert.ok(!fake.calls().some((c) => c.input.includes('You are a router')));
});

test('continuity does not trap a clearly new topic', async () => {
  const { orch, conv } = await setup();
  await send(orch, conv, 'صمم لي شعار لمقهى');
  const { msg } = await send(orch, conv, 'refactor the entire codebase to TypeScript with tests');
  assert.equal(msg.category, 'code_heavy');
  assert.equal(msg.provider, 'claude');
});

test('fair balancing: a heavily used subscription hands everyday work to the next one', async () => {
  const { orch, conv, store } = await setup();
  const day = new Date().toISOString().slice(0, 10);
  store.state.usage[day] = { claude: 30, codex: 3 };
  const { msg } = await send(orch, conv, 'fix this python bug: KeyError in my function');
  assert.equal(msg.provider, 'codex');
  assert.equal(msg.routeSource, 'balanced');
  // heavy coding keeps the strongest model regardless
  const heavy = await send(orch, store.createConversation(), 'refactor the entire codebase to TypeScript');
  assert.equal(heavy.msg.provider, 'claude');
});

test('memory: the user\'s saved notes reach every model', async () => {
  const { orch, conv } = await setup({ memory: 'اسمي عبدالله، أشتغل على تطبيق مصروف ذكي بـ Kotlin' });
  await send(orch, conv, 'hello', { force: 'codex|' });
  assert.match(callsOf('codex')[0].input, /اسمي عبدالله/);
});

test('images: generated image files are collected and shown with the answer', async () => {
  const { orch, conv } = await setup();
  const { msg } = await send(orch, conv, 'صمم لي شعار لمقهى');
  assert.equal(msg.provider, 'gemini');
  assert.match(callsOf('agy')[0].input, /wants a real image/);
  assert.equal(msg.images.length, 1);
  assert.ok(fs.existsSync(msg.images[0]));
});

test('images from ChatGPT (~/.codex/generated_images) are copied into the conversation', async () => {
  const { orch, conv, store } = await setup();
  const { msg } = await send(orch, conv, 'ارسم لي صورة قطة', { force: 'codex|' });
  assert.equal(msg.category, 'manual');
  // forced: no image instruction; ask through routing instead
  const r = await send(orch, store.createConversation(), 'design a logo for my bakery', { force: undefined });
  assert.ok(r.msg.images && r.msg.images.length >= 1);
  process.env.FAKE_MODE_agy = 'limit';
  const c = store.createConversation();
  const r2 = await send(orch, c, 'design a poster for my gym');
  assert.equal(r2.msg.provider, 'codex');
  assert.equal(r2.msg.images.length, 1);
  assert.ok(r2.msg.images[0].startsWith(store.attachmentDir(c.id)));
});

test('project changes are listed and can be undone', async (t) => {
  const { which } = require('../src/core/shell');
  if (!(await which('git'))) return t.skip('git not installed');
  const ws = tempDir();
  fs.writeFileSync(path.join(ws, 'a.txt'), 'original');
  const { orch, conv, store } = await setup();
  conv.workspace = ws; store.saveConversation(conv);
  const { msg } = await send(orch, conv, 'EDIT_FILES please', { force: 'claude|' });
  assert.equal(msg.status, 'done');
  const files = Object.fromEntries(msg.changes.files.map((f) => [f.path, f.status]));
  assert.deepEqual(files, { 'a.txt': 'M', 'new.txt': 'A' });
  const r = await orch.undoChanges(conv.id, msg.id);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'original');
  assert.ok(!fs.existsSync(path.join(ws, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(ws, '.git')), 'the project folder itself must not get a .git');
});

test('council: all three answer in parallel, Claude chairs and merges', async () => {
  const { orch, conv } = await setup();
  const events = [];
  const msg = await orch.council({ conversationId: conv.id, text: 'وش أفضل لغة برمجة للمبتدئين؟' }, (e) => events.push(e));
  assert.equal(msg.status, 'done', JSON.stringify(msg));
  assert.equal(msg.category, 'council');
  assert.equal(msg.council.length, 3);
  assert.ok(msg.council.every((m) => m.ok));
  const merge = fake.calls().filter((c) => c.input.includes('You chair "Majlis"'));
  assert.equal(merge.length, 1);
  assert.equal(merge[0].name, 'claude');
  assert.match(merge[0].input, /ANSWER 1/); assert.match(merge[0].input, /ANSWER 3/);
  assert.match(merge[0].input, /Write the answer in Arabic/);
  assert.equal(events.filter((e) => e.type === 'council-member').length, 3);
  // members run read-only so they never edit the same files at once
  assert.ok(callsOf('claude')[0].args.includes('plan'));
});

test('council still answers when one member is out of quota', async () => {
  const { orch, conv } = await setup();
  process.env.FAKE_MODE_codex = 'limit';
  const msg = await orch.council({ conversationId: conv.id, text: 'compare React and Vue' }, () => {});
  assert.equal(msg.status, 'done');
  assert.equal(msg.council.filter((m) => m.ok).length, 2);
  assert.equal(msg.council.find((m) => m.provider === 'codex').kind, 'limit');
});

test('learning: personal facts are saved once, shared with every model, secrets skipped', async () => {
  const { orch, conv, store } = await setup({ learn: true });
  process.env.FAKE_REPLY_claude = '{"add":["يفضّل الردود المختصرة بالعربي","يشتغل على تطبيق مجلس","password is 1234"],"remove":[]}';
  try {
    await send(orch, conv, 'أنا أحب الردود المختصرة، وأشتغل على تطبيق مجلس', { force: 'codex|' });
    await orch.learning;
    const learned = store.getSettings().learned.map((x) => x.text);
    assert.deepEqual(learned, ['يفضّل الردود المختصرة بالعربي', 'يشتغل على تطبيق مجلس']);
    fake.reset();
    await send(orch, conv, 'what is 2+2', { force: 'gemini|' });
    assert.match(callsOf('gemini')[0].input, /يفضّل الردود المختصرة/);
    // turning learning off stops both learning and using it
    store.updateSettings({ learn: false });
    fake.reset();
    await send(orch, conv, 'انا اسمي عبدالله', { force: 'gemini|' });
    await orch.learning;
    assert.equal(callsOf('claude').length, 0);
    assert.doesNotMatch(callsOf('gemini')[0].input, /يفضّل/);
  } finally { delete process.env.FAKE_REPLY_claude; }
});

test('tokens: real numbers from Claude/Codex, estimates when a CLI reports none', async () => {
  const { orch, conv, store } = await setup();
  const r1 = await send(orch, conv, 'hello', { force: 'claude|' });
  await send(orch, conv, 'hello', { force: 'codex|' });
  await send(orch, conv, 'hello', { force: 'gemini|' });
  const t = store.tokenReport().today;
  assert.deepEqual([t.claude.input, t.claude.output, t.claude.cached, t.claude.estimated], [120, 45, 3000, 0]);
  assert.deepEqual([t.codex.input, t.codex.cached, t.codex.output], [900, 100, 70]);
  assert.equal(t.gemini.estimated, 1);
  assert.ok(t.gemini.input > 0 && t.gemini.output > 0);
  assert.equal(r1.msg.tokens.output, 45);
});
