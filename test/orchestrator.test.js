'use strict';
// End-to-end engine tests against STRICT fake CLIs modelled on the real tools
// (Claude Code 2.1.x, Codex 0.171, Gemini CLI 0.70): any flag the real CLI would
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
  store.updateSettings({ onboarded: true, ...settings });
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
const callsOf = (n) => fake.calls().filter((c) => c.name === n);

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

test('ambiguous request asks the fastest Gemini model to route it', async () => {
  const { orch, conv } = await setup();
  process.env.FAKE_CLASSIFY = 'writing';
  const { msg } = await send(orch, conv, 'ابغى شي يساعدني في موضوع الشغل حق بكرة لو تكرمت');
  assert.equal(msg.routeSource, 'smart');
  assert.equal(msg.category, 'writing');
  const router = fake.calls().find((c) => c.input.includes('You are a router'));
  assert.equal(router.name, 'gemini');
  assert.ok(router.args.includes('gemini-3.1-flash-lite'), router.args.join(' '));
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

test('Gemini runs trusted (--skip-trust + env) so headless mode works in any folder', async () => {
  const { orch, conv } = await setup();
  await send(orch, conv, 'hi', { force: 'gemini|' });
  const c = callsOf('gemini')[0];
  assert.ok(c.args.includes('--skip-trust'));
  assert.ok(c.args.includes('stream-json'));
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
    assert.ok(prov === 'codex' ? a[1] === 'resume' : a.includes('--resume'), a.join(' '));
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
  assert.match(c.input, /GEMINI\[default\]/);
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
  assert.equal(msg.text, 'GEMINI[default]: compare these two');
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
  process.env.FAKE_CLASSIFY = 'writing';
  const { msg, events } = await send(orch, conv, 'write an email to my boss about the report');
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
  for (const n of ['claude', 'codex', 'gemini']) process.env[`FAKE_MODE_${n}`] = 'limit';
  const { msg, types } = await send(orch, conv, 'fix the bug in this python code');
  assert.equal(msg.status, 'failed');
  assert.equal(msg.trail.length, 3);
  assert.ok(msg.trail.every((t) => t.outcome === 'limit'));
  assert.equal(types[types.length - 1], 'failed');
});

test('cancel stops a running request', async () => {
  const { orch, conv } = await setup();
  process.env.FAKE_MODE_gemini = 'slow';
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
  const call = callsOf('gemini')[0];
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
  assert.deepEqual(st.claude.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(st.codex.models.map((m) => m.id), ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.5']);
  assert.deepEqual(st.gemini.models.map((m) => m.id), ['auto', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  assert.equal(orch.resolveModel('gemini', '@flash'), 'gemini-3.5-flash');
  assert.equal(orch.resolveModel('gemini', '@fast'), 'gemini-3.1-flash-lite');
  assert.equal(orch.resolveModel('gemini', '@best'), 'gemini-2.5-pro');
});

test('quick questions use the newest Gemini Flash from the live list', async () => {
  const { orch, conv } = await setup();
  const { msg } = await send(orch, conv, 'كيف حالك');
  assert.equal(msg.provider, 'gemini');
  assert.equal(msg.text, 'GEMINI[gemini-3.5-flash]: كيف حالك');
});

test('settings from v0.2 (retired model names) are migrated', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, routes: { quick: [{ provider: 'gemini', model: 'gemini-2.5-flash' }] }, voice: { model: 'gemini-2.5-flash', autoSend: false } }));
  const store = new Store(dir);
  assert.equal(store.getSettings().routes.quick[0].model, '@flash');
  assert.equal(store.getSettings().voice.model, '@flash');
  assert.equal(store.getSettings().voice.autoSend, false);
  assert.equal(store.getSettings().onboarded, true);
});

test('voice: transcribes a recording through Gemini Flash and cleans the output', async () => {
  const { orch, store } = await setup();
  const dir = path.join(store.dir, 'voice'); fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'rec-1.wav'); fs.writeFileSync(wav, Buffer.alloc(64));
  const r = await orch.transcribe(wav);
  assert.deepEqual(r, { ok: true, text: 'ابني لي صفحة هبوط لمطعمي' });
  const call = callsOf('gemini')[0];
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(dir));
  assert.ok(call.args.includes('gemini-3.5-flash'));
  assert.ok(call.args.includes('plan'));
  process.env.FAKE_TRANSCRIPT = '[silence]';
  assert.deepEqual(await orch.transcribe(wav), { ok: true, text: '' });
});

test('signed-out Gemini is skipped instantly and voice reports auth', async () => {
  const { orch, conv, store } = await setup();
  const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try {
    if (fs.existsSync(path.join(require('os').homedir(), '.gemini', 'oauth_creds.json'))) return;
    const { msg, events } = await send(orch, conv, 'كيف حالك');
    assert.ok(events.some((e) => e.type === 'fallback' && e.provider === 'gemini' && e.kind === 'auth'));
    assert.ok(!callsOf('gemini').length);
    assert.equal(msg.provider, 'claude');
    const wav = path.join(store.dir, 'x.wav'); fs.writeFileSync(wav, Buffer.alloc(8));
    assert.equal((await orch.transcribe(wav)).kind, 'auth');
  } finally { process.env.GEMINI_API_KEY = saved; }
});
