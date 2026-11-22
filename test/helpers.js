'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli.js');

/** Create a temp bin dir with fake claude/codex/gemini and put it first on PATH. */
function installFakeClis() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'majlis-bin-'));
  for (const name of ['claude', 'codex', 'agy']) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\nnode "${FAKE}" ${name} %*\r\n`);
    } else {
      const f = path.join(bin, name);
      fs.writeFileSync(f, `#!/bin/sh\nexec node "${FAKE}" ${name} "$@"\n`);
      fs.chmodSync(f, 0o755);
    }
  }
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  process.env[key] = bin + path.delimiter + process.env[key];
  const log = path.join(bin, 'calls.jsonl');
  process.env.CODEX_HOME = path.join(bin, 'codex-home'); // keep generated images away from the real home folder
  process.env.FAKE_LOG = log;
  return {
    bin,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    reset: () => { try { fs.unlinkSync(log); } catch (_) {} for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_MODE_') || k === 'FAKE_CLASSIFY') delete process.env[k]; },
  };
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'majlis-data-')); }

module.exports = { installFakeClis, tempDir };
