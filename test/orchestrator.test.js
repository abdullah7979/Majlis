'use strict';
// End-to-end engine tests against fake CLIs. On Windows CI these exercise the
// real .cmd spawning path, argument quoting and UTF-8 (Arabic) stdin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installFakeClis, tempDir } = require('./helpers');
const { Store } = require('../src/core/store');
const { Orchestrator } = require('../src/core/orchestrator');

const fake = installFakeClis();

function setup(settings = {}) {
  fake.reset();
  const store = new Store(tempDir());
  store.updateSettings({ onboarded: true, ...settings });
  const orch = new Orchestrator(store);
  const conv = store.createConversation();
  return { store, orch, conv };
}
async function send(orch, conv, text, extra = {}) {
  const events = [];
  const msg = await orch.send({ conversationId: conv.id, text, ...extra }, (e) => events.push(e));
  return { msg, events, types: events.map((e) => e.type) };
}

test('smart routing sends heavy coding to Claude Opus and streams text', async () => {
  const { orch, conv } = setup();
  process.env.FAKE_CLASSIFY = 'code_heavy';
  const { msg, events } = await send(orch, conv, 'ابني لي تطبيق كامل');
  assert.equal(msg.status, 'done');
  assert.equal(msg.provider, 'claude');
  assert.equal(msg.category, 'code_heavy');
  assert.equal(msg.routeSource, 'smart');
  assert.match(msg.text, /^CLAUDE\[opus\]: ابني لي تطبيق كامل$/); // Arabic survived the round trip
  assert.ok(events.some((e) => e.type === 'text'));
  assert.ok(events.some((e) => e.type === 'activity' && /Read: x\.js/.test(e.text)));
  const call = fake.calls().find((c) => c.name === 'claude');
  assert.ok(call.args.includes('--model') && call.args.includes('opus'));
  assert.ok(call.args.includes('acceptEdits'));
});

test('falls back to the next provider when one hits its limit, and cools it down', async () => {
  const { orch, conv, store } = setup();
  process.env.FAKE_CLASSIFY = 'code_heavy';
  process.env.FAKE_MODE_claude = 'limit';
  const { msg, events } = await send(orch, conv, 'refactor everything');
  assert.equal(msg.status, 'done');
  assert.equal(msg.provider, 'codex');
  assert.equal(msg.text, 'CODEX[default]: refactor everything'); // clean final message from --output-last-message
  const fb = events.find((e) => e.type === 'fallback');
  assert.equal(fb.provider, 'claude');
  assert.equal(fb.kind, 'limit');
  assert.equal(new Date(fb.until).getHours(), 17); // parsed "reset at 5pm"
  assert.ok(store.cooldownUntil('claude'));
  assert.ok(events.some((e) => e.type === 'activity' && e.text === 'exec: ls'));

  // Next message skips the cooled-down provider without calling it.
  fake.reset(); process.env.FAKE_CLASSIFY = 'code_heavy';
  const second = await send(orch, conv, 'and now tests');
  assert.equal(second.msg.provider, 'codex');
  assert.ok(second.events.some((e) => e.type === 'skip' && e.provider === 'claude' && e.why === 'cooldown'));
  assert.ok(!fake.calls().some((c) => c.name === 'claude'));
});

test('conversation context is handed to the next model', async () => {
  const { orch, conv, store } = setup();
  process.env.FAKE_CLASSIFY = 'quick';
  await send(orch, conv, 'my name is Abdullah');
  fake.reset();
  process.env.FAKE_CLASSIFY = 'code';
  await send(orch, conv, 'what is my name?');
  const call = fake.calls().find((c) => c.name === 'claude');
  assert.match(call.input, /my name is Abdullah/);
  assert.match(call.input, /GEMINI\[gemini-2.5-flash\]/);
  assert.match(call.input, /NEW USER MESSAGE\nwhat is my name\?$/);
  assert.equal(store.getConversation(conv.id).messages.length, 4);
});

test('unknown model name retries with the CLI default model', async () => {
  const { orch, conv } = setup();
  process.env.FAKE_CLASSIFY = 'research';
  process.env.FAKE_MODE_gemini = 'badmodel';
  const { msg, events } = await send(orch, conv, 'compare these');
  assert.equal(msg.provider, 'gemini');
  assert.equal(msg.text, 'GEMINI[default]: compare these');
  assert.ok(events.some((e) => e.type === 'retry' && e.reason === 'bad_model'));
});

test('older CLI without optional flags is retried without them', async () => {
  const { orch, conv } = setup({ smartRouting: false });
  process.env.FAKE_MODE_claude = 'badflag';
  const { msg } = await send(orch, conv, 'fix this python bug');
  assert.equal(msg.provider, 'claude');
  assert.equal(msg.status, 'done');
});

test('signed-out provider is skipped (auth) without cooldown', async () => {
  const { orch, conv, store } = setup({ smartRouting: false });
  process.env.FAKE_MODE_claude = 'auth';
  const { msg, events } = await send(orch, conv, 'write an email to my boss');
  assert.equal(msg.provider, 'gemini');
  assert.equal(events.find((e) => e.type === 'fallback').kind, 'auth');
  assert.equal(store.cooldownUntil('claude'), null);
});

test('heuristic routing when smart routing is off; classifier is not called', async () => {
  const { orch, conv } = setup({ smartRouting: false });
  const { msg } = await send(orch, conv, 'صمم لي شعار');
  assert.equal(msg.category, 'image');
  assert.equal(msg.provider, 'codex');
  assert.ok(!fake.calls().some((c) => c.input.includes('You are a router')));
});

test('forced provider/model bypasses routing', async () => {
  const { orch, conv } = setup();
  const { msg } = await send(orch, conv, 'hello', { force: 'claude|haiku' });
  assert.equal(msg.category, 'manual');
  assert.equal(msg.text, 'CLAUDE[haiku]: hello');
});

test('all providers exhausted -> failed with full trail', async () => {
  const { orch, conv } = setup({ smartRouting: false });
  for (const n of ['claude', 'codex', 'gemini']) process.env[`FAKE_MODE_${n}`] = 'limit';
  const { msg, types } = await send(orch, conv, 'fix bug in code');
  assert.equal(msg.status, 'failed');
  assert.equal(msg.trail.length, 3);
  assert.ok(msg.trail.every((t) => t.outcome === 'limit'));
  assert.equal(types[types.length - 1], 'failed');
});

test('cancel stops a running request', async () => {
  const { orch, conv } = setup({ smartRouting: false });
  process.env.FAKE_MODE_gemini = 'slow';
  const p = send(orch, conv, 'hi there');
  await new Promise((r) => setTimeout(r, 1500));
  orch.cancel(conv.id);
  const { msg } = await p;
  assert.equal(msg.status, 'cancelled');
});

test('workspace folder is used as the working directory; attachments listed in prompt', async () => {
  const ws = tempDir();
  const { orch, conv, store } = setup({ smartRouting: false });
  conv.workspace = ws; store.saveConversation(conv);
  const src = path.join(ws, 'notes.txt'); fs.writeFileSync(src, 'x');
  const [att] = store.importAttachments(conv.id, [src]);
  await send(orch, conv, 'لخص الملف', { attachments: [att] });
  const call = fake.calls().find((c) => c.name === 'gemini');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(ws));
  assert.ok(call.input.includes(att));
});

test('feedback re-orders a route only after a clear preference', () => {
  const { orch, store } = setup();
  assert.equal(orch.routeFor('code')[0].provider, 'claude');
  store.addFeedback('code', 'codex', true); store.addFeedback('code', 'codex', true);
  assert.equal(orch.routeFor('code')[0].provider, 'claude');
  store.addFeedback('code', 'codex', true);
  assert.equal(orch.routeFor('code')[0].provider, 'codex');
});

test('provider status detects installed fake CLIs and versions', async () => {
  const { orch } = setup();
  const st = await orch.providerStatus();
  for (const id of ['claude', 'codex', 'gemini']) {
    assert.equal(st[id].installed, true, id);
    assert.equal(st[id].version, '9.9.9');
  }
});

test('voice: transcribes a recording through Gemini and cleans the output', async () => {
  const { orch, store } = setup();
  const dir = path.join(store.dir, 'voice'); fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'rec-1.wav'); fs.writeFileSync(wav, Buffer.alloc(64));
  const r = await orch.transcribe(wav);
  assert.deepEqual(r, { ok: true, text: 'ابني لي صفحة هبوط لمطعمي' });
  const call = fake.calls().find((c) => c.name === 'gemini');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(dir));
  process.env.FAKE_TRANSCRIPT = '[silence]';
  assert.deepEqual(await orch.transcribe(wav), { ok: true, text: '' });
});

test('signed-out Gemini is skipped instantly and voice reports auth', async () => {
  const { orch, conv, store } = setup({ smartRouting: false });
  const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  const os = require('os'); const savedHome = process.env.HOME; const savedUP = process.env.USERPROFILE;
  try {
    const { msg, events } = await send(orch, conv, 'hi');  // quick -> gemini first
    assert.ok(events.some((e) => e.type === 'fallback' && e.provider === 'gemini' && e.kind === 'auth'));
    if (!fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'))) {
      assert.ok(!fake.calls().some((c) => c.name === 'gemini'));
      const wav = path.join(store.dir, 'x.wav'); fs.writeFileSync(wav, Buffer.alloc(8));
      assert.equal((await orch.transcribe(wav)).kind, 'auth');
    }
    assert.equal(msg.provider, 'claude');
  } finally { process.env.GEMINI_API_KEY = saved; process.env.HOME = savedHome; process.env.USERPROFILE = savedUP; }
});
