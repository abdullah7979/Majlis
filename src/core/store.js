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
    this.settings = deepMerge(DEFAULT_SETTINGS, readJson(this.settingsFile, {}));
    this.state = deepMerge({ cooldowns: {}, usage: {}, learning: {} }, readJson(this.stateFile, {}));
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
  usageToday() { return this.state.usage[new Date().toISOString().slice(0, 10)] || {}; }
  addFeedback(category, provider, good) {
    const l = this.state.learning;
    l[category] = l[category] || {};
    l[category][provider] = (l[category][provider] || 0) + (good ? 1 : -1);
    this.saveState();
  }
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
