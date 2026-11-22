'use strict';
// The Antigravity installer against a local server that behaves like Google's update server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { installAgy, agyPlatform } = require('../src/core/installers');

function serve(binary, { badHash = false, missing = false } = {}) {
  const sha512 = crypto.createHash('sha512').update(badHash ? 'x' : binary).digest('hex');
  const server = http.createServer((req, res) => {
    if (missing) { res.statusCode = 404; return res.end(); }
    if (req.url === `/manifests/${agyPlatform()}.json`) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ version: '1.5.14', url: `http://127.0.0.1:${server.address().port}/bin/agy`, sha512 }));
    }
    if (req.url === '/bin/agy') { res.setHeader('content-length', binary.length); return res.end(binary); }
    res.statusCode = 404; res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const bin = Buffer.from(process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');

test('installs agy: manifest -> download with progress -> SHA-512 -> placed', async () => {
  const server = await serve(bin);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy عربي '));
  const target = path.join(dir, 'agy', 'bin', process.platform === 'win32' ? 'agy.cmd' : 'agy');
  const stages = [];
  const r = await installAgy({ fetch, base: `http://127.0.0.1:${server.address().port}`, target, onProgress: (p) => stages.push(p.stage) });
  server.close();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, '1.5.14');
  assert.ok(fs.readFileSync(target).equals(bin));
  for (const s of ['manifest', 'download', 'verify', 'place', 'setup', 'done']) assert.ok(stages.includes(s), s);
});

test('refuses a download whose checksum does not match', async () => {
  const server = await serve(bin, { badHash: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  const target = path.join(dir, 'agy');
  const r = await installAgy({ fetch, base: `http://127.0.0.1:${server.address().port}`, target });
  server.close();
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'verify');
  assert.ok(!fs.existsSync(target));
});

test('clear error when Google\'s server cannot be reached', async () => {
  const r = await installAgy({ fetch, base: 'http://127.0.0.1:9', target: path.join(os.tmpdir(), 'agy-none') });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'manifest');
  assert.match(r.error, /internet|VPN|firewall/);
});
