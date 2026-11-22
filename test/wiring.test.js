'use strict';
// Every IPC channel the UI can call must have a handler in the main process.
// (v0.4 shipped with the Install button's handler accidentally deleted — the button hung forever.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

test('every invoke() channel in preload has an ipcMain handler', () => {
  const preload = read('main/preload.js');
  const main = read('main/main.js');
  const invoked = [...preload.matchAll(/invoke\('([^']+)'\)/g)].map((m) => m[1]);
  const handled = new Set([...main.matchAll(/(?:\bh|ipcMain\.handle)\('([^']+)'/g)].map((m) => m[1]));
  assert.ok(invoked.length > 20);
  const missing = invoked.filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], `no handler for: ${missing.join(', ')}`);
});

test('every api.* call in the UI exists in preload', () => {
  const app = read('renderer/app.js');
  const preload = read('main/preload.js');
  const calls = new Set([...app.matchAll(/\bapi\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?\(/g)].map((m) => (m[2] ? `${m[1]}.${m[2]}` : m[1])));
  const missing = [...calls].filter((c) => {
    const [a, b] = c.split('.');
    if (!b) return !new RegExp(`\\b${a}:`).test(preload);
    const block = preload.match(new RegExp(`\\b${a}: \\{([^}]*)\\}`));
    return !block || !new RegExp(`\\b${b}:`).test(block[1]);
  });
  assert.deepEqual(missing, [], `UI calls missing from preload: ${missing.join(', ')}`);
});
