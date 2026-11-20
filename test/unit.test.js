'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicClassify, parseClassifierOutput } = require('../src/core/classifier');
const { classifyFailure, parseResetTime, looksLikeLimitNotice } = require('../src/core/errors');
const { quoteWin } = require('../src/core/shell');
const { deepMerge } = require('../src/core/store');

test('heuristic classifier — Arabic and English', () => {
  const c = (t) => heuristicClassify(t).category;
  assert.equal(c('صمم لي شعار لمطعم شاورما'), 'image');
  assert.equal(c('design a logo for my bakery'), 'image');
  assert.equal(c('ابني لي تطبيق كامل من الصفر بـ Flutter'), 'code_heavy');
  assert.equal(c('refactor the entire codebase to TypeScript'), 'code_heavy');
  assert.equal(c('fix this python error: KeyError'), 'code');
  assert.equal(c('عندي خطأ برمجي في الكود'), 'code');
  assert.equal(c('لخص لي هذا التقرير'), 'research');
  assert.equal(c('اكتب لي مقال عن السفر'), 'writing');
  assert.equal(c('وش أخبار السوق اليوم'), 'realtime');
  assert.equal(c('كيف حالك'), 'quick');
  assert.equal(c('أتصور إن الجو حلو'), 'quick'); // "تصور" must not trigger image
});

test('classifier output parsing', () => {
  assert.deepEqual(parseClassifierOutput('blah\n{"category":"code","reason":"bug fix"}\n').category, 'code');
  assert.equal(parseClassifierOutput('```json\n{"category": "image", "reason": "logo"}\n```').category, 'image');
  assert.equal(parseClassifierOutput('{"category":"banana"}'), null);
  assert.equal(parseClassifierOutput('no json here'), null);
});

test('failure classification', () => {
  assert.equal(classifyFailure({ code: 1, stderr: 'Error: You have hit your usage limit' }).kind, 'limit');
  assert.equal(classifyFailure({ code: 1, stderr: '429 Too Many Requests' }).kind, 'limit');
  assert.equal(classifyFailure({ code: 1, stderr: '[API Error: RESOURCE_EXHAUSTED quota]' }).kind, 'limit');
  assert.equal(classifyFailure({ code: 1, stderr: 'Invalid API key · Please run /login' }).kind, 'auth');
  assert.equal(classifyFailure({ code: 1, stderr: "'claude' is not recognized as an internal or external command" }).kind, 'not_installed');
  assert.equal(classifyFailure({ code: 1, stderr: 'Error: model "foo" not found' }).kind, 'bad_model');
  assert.equal(classifyFailure({ code: 2, stderr: "error: unknown option '--color'" }).kind, 'bad_flag');
  assert.equal(classifyFailure({ code: 1, cancelled: true }).kind, 'cancelled');
  assert.equal(classifyFailure({ code: 1, stderr: 'segfault' }).kind, 'error');
  assert.ok(looksLikeLimitNotice('Claude AI usage limit reached|1735689600'));
  assert.ok(!looksLikeLimitNotice('Here is a long answer about rate limiting in APIs. '.repeat(20)));
});

test('reset time parsing', () => {
  const now = new Date('2026-11-20T10:00:00').getTime();
  assert.equal(parseResetTime('Claude AI usage limit reached|1735689600', now), 1735689600000);
  assert.equal(parseResetTime('Try again in 2 hours 30 minutes', now), now + 2.5 * 3600e3);
  assert.equal(parseResetTime('Please retry in 34s', now), now + 34e3);
  const five = new Date(parseResetTime('Your limit will reset at 5pm', now));
  assert.equal(five.getHours(), 17);
  assert.equal(parseResetTime('nothing useful', now), null);
});

test('windows argument quoting', () => {
  assert.equal(quoteWin('opus'), 'opus');
  assert.equal(quoteWin(''), '""');
  assert.equal(quoteWin('C:\\Users\\Abdullah Ali\\x.txt'), '"C:\\Users\\Abdullah Ali\\x.txt"');
  assert.equal(quoteWin('a&b'), '"a&b"');
});

test('settings deep merge keeps arrays replaced, objects merged', () => {
  const m = deepMerge({ a: 1, o: { x: 1, y: 2 }, arr: [1, 2] }, { o: { y: 3 }, arr: [9] });
  assert.deepEqual(m, { a: 1, o: { x: 1, y: 3 }, arr: [9] });
});

test('finds CLIs in npm\'s global folder even when it is not on PATH (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'appdata '));
  fs.mkdirSync(path.join(appdata, 'npm'));
  fs.writeFileSync(path.join(appdata, 'npm', 'zzmajlistool.cmd'), '@echo zz 1.2.3\r\n');
  const saved = process.env.APPDATA;
  process.env.APPDATA = appdata;
  try {
    const { which, run } = require('../src/core/shell');
    const found = await which('zzmajlistool');
    assert.ok(found && found.toLowerCase().endsWith('zzmajlistool.cmd'), String(found));
    const r = await run(found, ['--version']); // full path with a space in it
    assert.match(r.stdout, /zz 1\.2\.3/);
  } finally { process.env.APPDATA = saved; }
});

test('which() returns null for missing tools and full path for present ones', async () => {
  const { which } = require('../src/core/shell');
  assert.equal(await which('definitely-not-a-real-tool-xyz'), null);
  assert.ok(await which('node'));
});
