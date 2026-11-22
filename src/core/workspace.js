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

module.exports = { listFiles, findEntry, snapshot, Watcher, readProjectMemory, initProjectMemory, MEMORY_FILE };
