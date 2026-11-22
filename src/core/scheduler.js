'use strict';
// Scheduled tasks ("automations"): a saved request that Majlis runs on its own — every day at a time,
// on chosen weekdays, or every N hours — while the app is running (it can live in the tray).
// Each task keeps its own conversation, so results pile up in one place, and a notification announces them.
//
// Task shape (stored in settings.automations):
//   { id, name, prompt, enabled, mode: 'auto'|'council', schedule: { type: 'daily'|'weekly'|'hours', time: 'HH:MM', days: [0..6], every: N },
//     lastRun, lastStatus, conversationId, workspace }

const crypto = require('crypto');

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '08:00'));
  return m ? { h: Math.min(23, +m[1]), min: Math.min(59, +m[2]) } : { h: 8, min: 0 };
}

/** The most recent moment (<= now) at which the task was supposed to run. null = never yet. */
function lastDue(task, now = Date.now()) {
  const s = task.schedule || { type: 'daily', time: '08:00' };
  if (s.type === 'hours') {
    const every = Math.max(1, Number(s.every) || 1) * 3600e3;
    const anchor = task.createdAt || 0;
    if (now < anchor + every) return null; // first run one interval after the task was created
    return anchor + Math.floor((now - anchor) / every) * every;
  }
  const { h, min } = parseTime(s.time);
  const days = s.type === 'weekly' && Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
  const d = new Date(now);
  for (let back = 0; back < 8; back++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, h, min, 0, 0);
    if (c.getTime() <= now && days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

/** Next time the task will run (for display). */
function nextRun(task, now = Date.now()) {
  const s = task.schedule || {};
  if (s.type === 'hours') {
    const every = Math.max(1, Number(s.every) || 1) * 3600e3;
    const ld = lastDue(task, now);
    return (ld == null ? (task.createdAt || now) : ld) + every;
  }
  // Walk forward an hour at a time; the first scheduled slot after `now` is the next run.
  for (let t = now + 3600e3; t <= now + 8 * 24 * 3600e3; t += 3600e3) {
    const ld = lastDue(task, t);
    if (ld != null && ld > now) return ld;
  }
  return null;
}

/** Should the task run now? Missed runs (PC asleep, app closed) run once when it comes back, if within `grace`. */
function isDue(task, now = Date.now(), grace = 12 * 3600e3) {
  if (!task.enabled || !task.prompt) return false;
  const due = lastDue(task, now);
  if (due == null) return false;
  if (task.lastRun && task.lastRun >= due) return false;
  if (task.createdAt && due < task.createdAt) return false;
  return now - due <= grace;
}

class Scheduler {
  /**
   * @param {object} o
   * @param {import('./store').Store} o.store
   * @param {import('./orchestrator').Orchestrator} o.orch
   * @param {(e: object) => void} [o.onEvent]   chat events (for the UI)
   * @param {(task: object, msg: object) => void} [o.onFinished]  e.g. a desktop notification
   */
  constructor({ store, orch, onEvent = () => {}, onFinished = () => {} }) {
    Object.assign(this, { store, orch, onEvent, onFinished });
    this.timer = null;
    this.running = new Set();
  }

  tasks() { return this.store.getSettings().automations || []; }
  save(tasks) { this.store.settings.automations = tasks; this.store.updateSettings({}); }

  upsert(task) {
    const tasks = this.tasks().slice();
    const now = Date.now();
    const clean = {
      id: task.id || crypto.randomBytes(6).toString('hex'),
      name: String(task.name || '').slice(0, 80) || String(task.prompt || '').slice(0, 40),
      prompt: String(task.prompt || '').slice(0, 20000),
      enabled: task.enabled !== false,
      mode: task.mode === 'council' ? 'council' : 'auto',
      schedule: {
        type: ['daily', 'weekly', 'hours'].includes(task.schedule && task.schedule.type) ? task.schedule.type : 'daily',
        time: (task.schedule && task.schedule.time) || '08:00',
        days: (task.schedule && task.schedule.days) || [0, 1, 2, 3, 4],
        every: (task.schedule && task.schedule.every) || 6,
      },
      workspace: task.workspace || '',
    };
    const i = tasks.findIndex((t) => t.id === clean.id);
    if (i >= 0) tasks[i] = { ...tasks[i], ...clean };
    else tasks.push({ ...clean, createdAt: now, lastRun: null, lastStatus: null, conversationId: null });
    this.save(tasks);
    return tasks.find((t) => t.id === clean.id);
  }
  remove(id) { this.save(this.tasks().filter((t) => t.id !== id)); }

  start(intervalMs = 30000) {
    this.stop();
    this.timer = setInterval(() => this.tick().catch(() => {}), intervalMs);
    setTimeout(() => this.tick().catch(() => {}), 5000);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = Date.now()) {
    for (const t of this.tasks()) if (isDue(t, now) && !this.running.has(t.id)) await this.run(t.id);
  }

  /** Run a task now (also used by the "Run now" button). */
  async run(id) {
    const task = this.tasks().find((t) => t.id === id);
    if (!task || this.running.has(id)) return null;
    this.running.add(id);
    try {
      let conv = task.conversationId ? this.store.getConversation(task.conversationId) : null;
      if (!conv) {
        conv = this.store.createConversation({ title: `⏰ ${task.name}`, workspace: task.workspace || '' });
        conv.source = 'automation';
        conv.automationId = task.id;
        this.store.saveConversation(conv);
      }
      this.update(id, { lastRun: Date.now(), lastStatus: 'running', conversationId: conv.id });
      const opts = { conversationId: conv.id, text: task.prompt };
      const msg = task.mode === 'council' ? await this.orch.council(opts, this.onEvent) : await this.orch.send(opts, this.onEvent);
      this.update(id, { lastStatus: msg.status });
      this.onFinished(task, msg);
      return msg;
    } catch (e) {
      this.update(id, { lastStatus: 'failed' });
      return null;
    } finally {
      this.running.delete(id);
    }
  }

  update(id, patch) {
    const tasks = this.tasks().map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.save(tasks);
  }
}

module.exports = { Scheduler, lastDue, nextRun, isDue, parseTime };
