'use strict';
// Local JSON storage: settings, runtime state (cooldowns, usage, learning) and
// conversations. Everything lives in the app's data folder; nothing leaves the PC.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_SETTINGS } = require('./defaults');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.convDir = path.join(dir, 'conversations');
    this.attachDir = path.join(dir, 'attachments');
    fs.mkdirSync(this.convDir, { recursive: true });
    fs.mkdirSync(this.attachDir, { recursive: true });
    this.settingsFile = path.join(dir, 'settings.json');
    this.stateFile = path.join(dir, 'state.json');
    const raw = readJson(this.settingsFile, {});
    this.settings = deepMerge(DEFAULT_SETTINGS, raw);
    // v0.3 migration: routes from older versions pointed at retired model names (gemini-2.5-flash...).
    if (Object.keys(raw).length && (!raw.schema || raw.schema < DEFAULT_SETTINGS.schema)) {
      // v0.3: retired model names. v0.4: Gemini CLI -> Antigravity CLI. v0.5: new role-based routes.
      this.settings.routes = DEFAULT_SETTINGS.routes;
      this.settings.voice = { ...DEFAULT_SETTINGS.voice, ...(raw.voice || {}), model: DEFAULT_SETTINGS.voice.model };
      delete this.settings.classifier;
      this.settings.schema = DEFAULT_SETTINGS.schema;
      if (!raw.schema || raw.schema < 4) this._migratedGemini = true;
      try { writeJson(this.settingsFile, this.settings); } catch (_) {}
    }
    this.state = deepMerge({ cooldowns: {}, usage: {}, learning: {}, auth: {}, models: {}, tokens: {}, limits: {} }, readJson(this.stateFile, {}));
    if (this._migratedGemini) { delete this.state.models.gemini; delete this.state.auth.gemini; delete this.state.cooldowns.gemini; }
  }

  // ---- settings
  getSettings() { return this.settings; }
  updateSettings(patch) {
    this.settings = deepMerge(this.settings, patch);
    writeJson(this.settingsFile, this.settings);
    return this.settings;
  }
  resetRoutes() {
    this.settings.routes = DEFAULT_SETTINGS.routes;
    writeJson(this.settingsFile, this.settings);
    return this.settings;
  }

  // ---- state
  saveState() { writeJson(this.stateFile, this.state); }
  cooldownUntil(provider) {
    const t = this.state.cooldowns[provider];
    return t && t > Date.now() ? t : null;
  }
  setCooldown(provider, until) { this.state.cooldowns[provider] = until; this.saveState(); }
  clearCooldown(provider) { delete this.state.cooldowns[provider]; this.saveState(); }
  countUsage(provider) {
    const day = new Date().toISOString().slice(0, 10);
    const u = this.state.usage;
    for (const d of Object.keys(u)) if (d < day) delete u[d];
    u[day] = u[day] || {};
    u[day][provider] = (u[day][provider] || 0) + 1;
    this.saveState();
  }
  /**
   * Tokens each subscription spent, per day (kept 30 days). `estimated` counts runs where the CLI
   * reported no numbers and Majlis estimated them from the text length.
   */
  addTokens(provider, { input = 0, output = 0, cached = 0, estimated = false } = {}, day = new Date().toISOString().slice(0, 10)) {
    const T = this.state.tokens;
    const cutoff = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
    for (const d of Object.keys(T)) if (d < cutoff) delete T[d];
    const e = ((T[day] = T[day] || {})[provider] = T[day][provider] || { input: 0, output: 0, cached: 0, runs: 0, estimated: 0 });
    e.input += input; e.output += output; e.cached += cached; e.runs += 1; if (estimated) e.estimated += 1;
    this.saveState();
  }
  /** Rate-limit windows the CLIs report (Claude: 5-hour/weekly status + reset; Codex: used %). Kept only while still relevant. */
  setLimits(provider, { window, status = null, usedPct = null, resetsAt = null }) {
    const L = (this.state.limits = this.state.limits || {});
    const w = ((L[provider] = L[provider] || {})[window || 'session'] = { status, usedPct, resetsAt, updated: Date.now() });
    this.saveState();
    return w;
  }
  limitsFor(provider, now = Date.now()) {
    const L = (this.state.limits || {})[provider] || {};
    return Object.entries(L).filter(([, v]) => !v.resetsAt || v.resetsAt > now).map(([window, v]) => ({ window, ...v }));
  }
  /** { today: {provider: totals}, week: {provider: totals}, days: [{day, provider: total}] } */
  tokenReport(now = Date.now()) {
    const T = this.state.tokens, today = new Date(now).toISOString().slice(0, 10);
    const weekStart = new Date(now - 6 * 86400e3).toISOString().slice(0, 10);
    const sum = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, runs: a.runs + b.runs, estimated: a.estimated + b.estimated });
    const zero = { input: 0, output: 0, cached: 0, runs: 0, estimated: 0 };
    const week = {}, month = {};
    for (const [d, per] of Object.entries(T)) for (const [p, v] of Object.entries(per)) {
      month[p] = sum(month[p] || zero, v);
      if (d >= weekStart) week[p] = sum(week[p] || zero, v);
    }
    return { today: T[today] || {}, week, month };
  }
  /** Remember the last proof that a provider is (not) signed in. */
  markAuth(provider, ok) { this.state.auth[provider] = { ok, at: Date.now() }; this.saveState(); }
  authKnownGood(provider) { const a = this.state.auth[provider]; return !!(a && a.ok); }
  usageToday() { return this.state.usage[new Date().toISOString().slice(0, 10)] || {}; }
  addFeedback(category, provider, good) {
    const l = this.state.learning;
    l[category] = l[category] || {};
    l[category][provider] = (l[category][provider] || 0) + (good ? 1 : -1);
    this.saveState();
  }
  /** Rolling average of how long a project step takes (ms) — drives the time estimate. */
  recordStep(ms) { const t = (this.state.stepStats = this.state.stepStats || { n: 0, avg: 0 }); t.avg = t.n ? Math.round((t.avg * Math.min(t.n, 20) + ms) / (Math.min(t.n, 20) + 1)) : ms; t.n++; this.saveState(); }
  stepAvgMs() { const t = this.state.stepStats; return t && t.n ? t.avg : 0; }
  /** What feedback has taught Majlis: per task type, how each model scores (👍 − 👎). */
  scoreboard() { return JSON.parse(JSON.stringify(this.state.learning || {})); }
  learningScore(category, provider) { return (this.state.learning[category] || {})[provider] || 0; }

  // ---- conversations
  newId() { return crypto.randomBytes(8).toString('hex'); }
  convFile(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad conversation id');
    return path.join(this.convDir, `${id}.json`);
  }
  createConversation({ title = '', workspace = '' } = {}) {
    const now = Date.now();
    const c = { id: this.newId(), title, workspace: workspace || this.settings.defaultWorkspace || '', createdAt: now, updatedAt: now, messages: [] };
    writeJson(this.convFile(c.id), c);
    return c;
  }
  getConversation(id) { return readJson(this.convFile(id), null); }
  saveConversation(c) { c.updatedAt = Date.now(); writeJson(this.convFile(c.id), c); return c; }
  listConversations() {
    return fs.readdirSync(this.convDir).filter((f) => f.endsWith('.json')).map((f) => {
      const c = readJson(path.join(this.convDir, f), null);
      return c && { id: c.id, title: c.title || (c.messages[0] && c.messages[0].text.slice(0, 60)) || '', updatedAt: c.updatedAt, workspace: c.workspace };
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  deleteConversation(id) {
    try { fs.unlinkSync(this.convFile(id)); } catch (_) {}
    fs.rmSync(path.join(this.attachDir, id), { recursive: true, force: true });
  }
  /** Copy files into the conversation's attachment folder; returns absolute paths. */
  importAttachments(id, files) {
    const dir = path.join(this.attachDir, id);
    fs.mkdirSync(dir, { recursive: true });
    return files.map((src) => {
      let name = path.basename(src), dest = path.join(dir, name), n = 1;
      while (fs.existsSync(dest)) dest = path.join(dir, `${path.parse(name).name}-${n++}${path.extname(name)}`);
      fs.copyFileSync(src, dest);
      return dest;
    });
  }
  attachmentDir(id) { return path.join(this.attachDir, id); }
}

module.exports = { Store, deepMerge };
