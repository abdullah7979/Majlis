'use strict';
// What the model wrote into the project folder: file list, the page worth previewing, live change polling,
// and the optional project rules file (MAJLIS.md) that every model reads.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.idea', '.gradle', 'target', '.cache']);

function listFiles(dir, { max = 400, depth = 5 } = {}) {
  const out = [];
  (function walk(d, rel, lvl) {
    if (lvl > depth || out.length >= max) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r, lvl + 1);
      else { try { const st = fs.statSync(p); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); } catch (_) {} }
    }
  })(dir, '', 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The page to show in the live preview: index.html at the top, else the shallowest index.html, else the newest .html. */
function findEntry(files) {
  const html = files.filter((f) => /\.html?$/i.test(f.path));
  if (!html.length) return null;
  const top = html.find((f) => /^index\.html?$/i.test(f.path));
  if (top) return top.path;
  const idx = html.filter((f) => /(^|\/)index\.html?$/i.test(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
  return (idx || html.slice().sort((a, b) => b.mtime - a.mtime)[0]).path;
}

function snapshot(dir) {
  const files = listFiles(dir);
  return { files, entry: findEntry(files), sig: files.map((f) => `${f.path}:${f.size}:${Math.round(f.mtime)}`).join('|') };
}

/** Polls a folder and calls onChange(snapshot) when anything changed. Polling is robust on every OS and cheap for project sizes. */
class Watcher {
  constructor(onChange, intervalMs = 1000) { this.onChange = onChange; this.intervalMs = intervalMs; this.dir = null; this.sig = null; this.timer = null; }
  watch(dir) {
    if (this.dir === dir && this.timer) return snapshot(dir);
    this.stop(); this.dir = dir;
    const snap = snapshot(dir); this.sig = snap.sig;
    this.timer = setInterval(() => {
      const s = snapshot(this.dir);
      if (s.sig !== this.sig) { this.sig = s.sig; try { this.onChange(this.dir, s); } catch (_) {} }
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return snap;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.dir = null; }
}

/**
 * Majlis' own check, no model and no shell needed: every local file an HTML page links to exists,
 * every .js parses, every .json is valid. Returns a list of concrete problems (empty = clean).
 */
function verifyStatic(dir) {
  const vm = require('vm');
  const files = listFiles(dir, { max: 800 });
  const problems = [];
  const exists = (rel) => { try { return fs.existsSync(path.join(dir, rel)); } catch (_) { return false; } };
  for (const f of files) {
    const full = path.join(dir, f.path);
    let txt = '';
    if (/\.(html?|js|mjs|json|css)$/i.test(f.path) && f.size < 2e6) { try { txt = fs.readFileSync(full, 'utf8'); } catch (_) { continue; } } else continue;
    if (/\.html?$/i.test(f.path)) {
      for (const m of txt.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)(?:[?#][^"']*)?["']/gi)) {
        const u = m[1].trim();
        if (!u || /^(https?:|\/\/|data:|mailto:|tel:|javascript:|blob:|sms:|whatsapp:)/i.test(u)) continue;
        const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), u.replace(/^\//, '')));
        if (!exists(rel) && !(u.endsWith('/') && exists(rel + '/index.html'))) problems.push(`${f.path}: links to missing file "${u}"`);
      }
    } else if (/\.json$/i.test(f.path)) {
      try { JSON.parse(txt); } catch (e) { problems.push(`${f.path}: invalid JSON (${e.message.slice(0, 60)})`); }
    } else if (/\.m?js$/i.test(f.path)) {
      const isModule = /\.mjs$/i.test(f.path) || /^\s*(import|export)\s/m.test(txt);
      try { new vm.Script(isModule ? txt.replace(/^\s*import\s[^;]*;?/gm, '').replace(/^\s*export\s+(default\s+)?/gm, '') : txt, { filename: f.path }); }
      catch (e) { problems.push(`${f.path}: JavaScript syntax error (${String(e.message).slice(0, 80)})`); }
    }
  }
  return { checked: files.length, problems: problems.slice(0, 20) };
}

/** Packs the project folder into a .zip next to it (what you upload to any free host, or send to someone). */
function exportZip(dir, outDir, title) {
  const { spawnSync } = require('child_process');
  const name = String(title || path.basename(dir)).slice(0, 40).replace(/[^\w\u0600-\u06FF-]+/g, '_') || 'project';
  const out = path.join(outDir || path.dirname(dir), `${name}-${new Date().toISOString().slice(0, 10)}.zip`);
  try { fs.rmSync(out, { force: true }); } catch (_) {}
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${out.replace(/'/g, "''")}' -Force`], { encoding: 'utf8', windowsHide: true })
    : spawnSync('zip', ['-qr', out, '.'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error((r.stderr || r.error && r.error.message || 'zip failed').toString().slice(0, 200));
  return out;
}

/** Everything a model produced during one answer (non-image files; images have their own gallery). */
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
function collectFiles(dir, since, { max = 40 } = {}) {
  const out = [];
  for (const f of listFiles(dir, { max: 600, depth: 4 })) {
    if (f.mtime < since - 1000 || f.path === MEMORY_FILE) continue;
    if (/^attachments?\//i.test(f.path)) continue;
    out.push({ rel: f.path, abs: path.join(dir, f.path), size: f.size, kind: /\.html?$/i.test(f.path) ? 'html' : IMG_RE.test(f.path) ? 'image' : isTextName(f.path) ? 'text' : 'binary' });
    if (out.length >= max) break;
  }
  return { files: out, entry: findEntry(out.map((x) => ({ path: x.rel, mtime: 0 }))) };
}
const TEXT_RE = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|svg|csv|tsv|py|java|c|h|cpp|cs|go|rs|rb|php|sh|bat|ps1|sql|yml|yaml|toml|ini|env|log|vue|svelte|kt|swift|r|lua)$/i;
function isTextName(n) { return TEXT_RE.test(n) || /(^|\/)(readme|license|dockerfile|makefile)$/i.test(n); }

/** Read a file inside the project folder only (no path tricks). Text up to `max` bytes. */
function readFileSafe(dir, rel, max = 400000) {
  const root = path.resolve(dir);
  const full = path.resolve(root, String(rel || ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('outside the project folder');
  const st = fs.statSync(full);
  if (!st.isFile()) throw new Error('not a file');
  if (!isTextName(full)) return { binary: true, size: st.size, abs: full };
  const buf = fs.readFileSync(full);
  return { text: buf.slice(0, max).toString('utf8'), truncated: buf.length > max, size: st.size, abs: full };
}

const MEMORY_FILE = 'MAJLIS.md';
function readProjectMemory(dir) {
  if (!dir) return '';
  try { return fs.readFileSync(path.join(dir, MEMORY_FILE), 'utf8').slice(0, 4000).trim(); } catch (_) { return ''; }
}
const TEMPLATE = `# قواعد المشروع (يقرأها كل النماذج: Claude وChatGPT وGemini)

## وش هذا المشروع
-

## التقنيات المعتمدة
-

## قواعد الكتابة
- اكتب الكود نظيف ومعلّق بالقدر الكافي.
- لا تغيّر ملفات خارج اللي طُلب منك.

## كيف أشغّل وأختبر
-
`;
function initProjectMemory(dir) {
  const f = path.join(dir, MEMORY_FILE);
  if (!fs.existsSync(f)) fs.writeFileSync(f, TEMPLATE, 'utf8');
  return f;
}

module.exports = { collectFiles, readFileSafe, isTextName, exportZip, verifyStatic, listFiles, findEntry, snapshot, Watcher, readProjectMemory, initProjectMemory, MEMORY_FILE };
