'use strict';
// Native installer for Google Antigravity CLI (agy) — the same steps as Google's install.ps1
// (manifest -> download -> SHA-512 check -> place in %LOCALAPPDATA%\agy\bin -> `agy install`),
// done in-process so it can't hang on PowerShell and can report real progress and errors.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./shell');

const AGY_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

function agyPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return `windows_${arch}`;
  if (process.platform === 'darwin') return `darwin_${arch}`;
  return `linux_${arch}`;
}

function agyTargetPath(env = process.env) {
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe');
  return path.join(os.homedir(), '.local', 'bin', 'agy');
}

/**
 * @param {object} o
 * @param {(url: string) => Promise<Response>} o.fetch   fetch implementation (Electron net.fetch in the app)
 * @param {(msg: {stage: string, percent?: number, text?: string}) => void} o.onProgress
 */
async function installAgy({ fetch, onProgress = () => {}, base = AGY_BASE, env = process.env, signal, target = agyTargetPath(env) } = {}) {
  const say = (stage, extra = {}) => onProgress({ stage, ...extra });

  say('manifest');
  let manifest;
  try {
    const res = await fetch(`${base}/manifests/${agyPlatform()}.json`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    return { ok: false, stage: 'manifest', error: `Could not reach Google's download server (${e.message}). Check the internet connection, VPN or firewall.` };
  }
  if (!manifest || !manifest.url || !manifest.sha512) return { ok: false, stage: 'manifest', error: 'Unexpected manifest from Google.' };

  say('download', { percent: 0, text: manifest.version });
  const staging = path.join(path.dirname(target), '..', '..', 'antigravity', 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const tmp = path.join(staging, `agy-${Date.now()}.download`);
  const hash = crypto.createHash('sha512');
  try {
    const res = await fetch(manifest.url, { signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(tmp);
    let loaded = 0, last = -1;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      loaded += buf.length;
      const pct = total ? Math.floor((loaded / total) * 100) : 0;
      if (pct !== last) { last = pct; say('download', { percent: pct, text: `${(loaded / 1048576).toFixed(1)} MB` }); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, stage: 'download', error: `Download failed (${e.message}).` };
  }

  say('verify');
  if (hash.digest('hex').toLowerCase() !== String(manifest.sha512).toLowerCase()) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, stage: 'verify', error: 'The downloaded file failed its security check (SHA-512). Try again.' };
  }

  say('place');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(tmp, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    fs.unlinkSync(tmp);
  } catch (e) {
    return { ok: false, stage: 'place', error: `Could not write ${target} (${e.message}). Close any running agy and try again.` };
  }

  // Google's own setup step (PATH etc.). Non-fatal, and never allowed to hang.
  say('setup');
  await run(target, ['install'], { timeoutMs: 60000, env });
  say('done', { text: manifest.version });
  return { ok: true, path: target, version: manifest.version };
}

module.exports = { installAgy, agyTargetPath, agyPlatform, AGY_BASE };
