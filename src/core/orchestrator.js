'use strict';
// The brain: classify -> pick a route -> run -> fall back on limits/failures.
// Emits events through `emit(event)` so any UI can render progress live.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, which, augmentedEnv } = require('./shell');
const { PROVIDERS, credentialsPresent } = require('./providers');
const { classifyFailure, looksLikeLimitNotice } = require('./errors');
const { heuristicClassify, buildClassifierPrompt, parseClassifierOutput } = require('./classifier');

const MAX_MSG_CHARS = 8000;
const MAX_CONTEXT_CHARS = 60000;

class Orchestrator {
  /** @param {import('./store').Store} store */
  constructor(store, { providers = PROVIDERS } = {}) {
    this.store = store;
    this.providers = providers;
    this.active = new Map(); // conversationId -> AbortController
  }

  // ------------------------------------------------------------ status
  async providerStatus() {
    const s = this.store.getSettings();
    const usage = this.store.usageToday();
    const env = augmentedEnv();
    const out = {};
    await Promise.all(Object.values(this.providers).map(async (p) => {
      const bin = await which(p.bin, env);
      let version = null;
      if (bin) {
        const r = await run(p.bin, ['--version'], { env, timeoutMs: 15000 });
        version = (r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) || [null])[0];
      }
      out[p.id] = {
        id: p.id, label: p.label, vendor: p.vendor, npmPackage: p.npmPackage, loginCommand: p.loginCommand,
        installed: !!bin, path: bin, version,
        signedIn: bin ? credentialsPresent(p) : false,
        enabled: !!(s.providers[p.id] && s.providers[p.id].enabled),
        cooldownUntil: this.store.cooldownUntil(p.id),
        usageToday: usage[p.id] || 0,
        models: [...p.models, ...((s.customModels || {})[p.id] || []).map((m) => ({ id: m, label: m }))],
      };
    }));
    return out;
  }

  isUsable(id) {
    const s = this.store.getSettings();
    return !!this.providers[id] && !!(s.providers[id] && s.providers[id].enabled) && !this.store.cooldownUntil(id);
  }

  // ------------------------------------------------------------ routing
  async classify(text, { attachments = [], smart = true, signal } = {}) {
    const s = this.store.getSettings();
    if (smart && s.smartRouting && this.isUsable(s.classifier.provider)) {
      const r = await this.runOnce(s.classifier.provider, s.classifier.model, buildClassifierPrompt(text), {
        cwd: os.tmpdir(), autonomy: 'safe', timeoutMs: 45000, signal, emit: () => {},
      });
      if (r.ok) {
        const parsed = parseClassifierOutput(r.text);
        if (parsed) return parsed;
      } else if (r.failure.kind === 'limit') {
        this.coolDown(s.classifier.provider, r.failure.resetAt);
      }
    }
    return heuristicClassify(text, { attachments });
  }

  routeFor(category) {
    const s = this.store.getSettings();
    const route = (s.routes[category] || s.routes.quick || []).filter((r) => this.providers[r.provider]);
    // Keep the configured order unless feedback clearly prefers another provider (>=3 points apart).
    return route.map((r, i) => ({ r, i, sc: this.store.learningScore(category, r.provider) }))
      .sort((a, b) => (Math.abs(b.sc - a.sc) >= 3 ? b.sc - a.sc : a.i - b.i))
      .map((x) => x.r);
  }

  coolDown(provider, resetAt) {
    const s = this.store.getSettings();
    const min = Date.now() + 60e3;
    const until = resetAt && resetAt > min ? resetAt : Date.now() + s.cooldownMinutes * 60e3;
    this.store.setCooldown(provider, until);
    return until;
  }

  // ------------------------------------------------------------ prompt
  buildPrompt(conv, text, attachments) {
    const s = this.store.getSettings();
    const prior = conv.messages.filter((m) => m.text && (m.role === 'user' || m.status === 'done')).slice(-s.historyTurns * 2);
    let ctx = '';
    for (let i = prior.length - 1; i >= 0; i--) {
      const m = prior[i];
      const who = m.role === 'user' ? 'USER' : `ASSISTANT (${m.providerLabel || m.provider || 'AI'})`;
      const piece = `### ${who}\n${m.text.slice(0, MAX_MSG_CHARS)}\n\n`;
      if (ctx.length + piece.length > MAX_CONTEXT_CHARS) break;
      ctx = piece + ctx;
    }
    let prompt = '';
    if (ctx) {
      prompt += 'Below is the earlier part of this conversation. Earlier replies may come from a different AI assistant; ' +
        'continue seamlessly as if you wrote them. Do not mention the handover.\n\n' + ctx + '---\n\n';
    }
    if (attachments.length) {
      prompt += 'The user attached these files (read them from disk):\n' + attachments.map((a) => `- ${a}`).join('\n') + '\n\n';
    }
    prompt += (ctx ? '### NEW USER MESSAGE\n' : '') + text;
    return prompt;
  }

  // ------------------------------------------------------------ execution
  /** Run one provider once (with internal retries for bad flags / bad model). */
  async runOnce(providerId, model, prompt, { cwd, autonomy, timeoutMs, signal, emit }) {
    const p = this.providers[providerId];
    let optional = true, usedModel = model, attempt = 0;
    while (attempt++ < 3) {
      const outFile = p.needsOutputFile ? path.join(os.tmpdir(), `majlis-${process.pid}-${Date.now()}.txt`) : null;
      const args = p.buildArgs({ model: usedModel, autonomy, outputFile: outFile, optional });
      let streamed = '', final = null, finalIsError = false;
      const parser = p.createParser((e) => {
        if (e.type === 'text') { streamed += e.text; emit({ type: 'text', text: e.text }); }
        else if (e.type === 'activity') emit({ type: 'activity', text: e.text });
        else if (e.type === 'final') { final = e.text; finalIsError = e.isError; }
        else if (e.type === 'meta') emit({ type: 'meta', model: e.model });
      });
      let errBuf = '';
      const r = await run(p.bin, args, {
        cwd, input: prompt, timeoutMs, signal,
        onStdout: (d) => parser.feed(d),
        onStderr: (d) => {
          if (!p.stderrToActivity) return;
          errBuf += d;
          let i;
          while ((i = errBuf.indexOf('\n')) >= 0) {
            const line = errBuf.slice(0, i).trim(); errBuf = errBuf.slice(i + 1);
            if (line && line.length < 300) emit({ type: 'activity', text: line });
          }
        },
      });
      parser.end();
      if (outFile) {
        try { const t = fs.readFileSync(outFile, 'utf8'); if (t.trim()) final = t; } catch (_) {}
        try { fs.unlinkSync(outFile); } catch (_) {}
      }
      const text = (final != null && final.trim() ? final : streamed).trim();
      const failed = r.code !== 0 || finalIsError || !text || looksLikeLimitNotice(text);
      if (!failed) return { ok: true, text, model: usedModel };

      const failure = classifyFailure({ ...r, stdout: r.stdout + '\n' + (final || ''), finalText: text });
      if (failure.kind === 'bad_flag' && optional) { optional = false; emit({ type: 'retry', reason: 'bad_flag' }); continue; }
      if (failure.kind === 'bad_model' && usedModel) { usedModel = ''; emit({ type: 'retry', reason: 'bad_model', model }); continue; }
      return { ok: false, failure, text };
    }
    return { ok: false, failure: { kind: 'error', message: 'retries exhausted' }, text: '' };
  }

  cancel(conversationId) {
    const c = this.active.get(conversationId);
    if (c) c.abort();
  }

  /**
   * Handle a user message end-to-end.
   * opts: { conversationId, text, attachments: [absolute paths], force: 'provider|model' | null, smart }
   */
  async send(opts, emit) {
    const { conversationId, text, force, smart = true } = opts;
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error('conversation not found');
    if (this.active.has(conversationId)) throw new Error('busy');
    const controller = new AbortController();
    this.active.set(conversationId, controller);
    const s = this.store.getSettings();
    const attachments = opts.attachments || [];
    const cwd = conv.workspace && fs.existsSync(conv.workspace) ? conv.workspace : this.store.attachmentDir(conversationId);
    fs.mkdirSync(cwd, { recursive: true });

    const prompt = this.buildPrompt(conv, text, attachments);
    const userMsg = { id: this.store.newId(), role: 'user', text, attachments, ts: Date.now() };
    const aiMsg = { id: this.store.newId(), role: 'assistant', text: '', status: 'running', ts: Date.now(), trail: [], activity: [] };
    conv.messages.push(userMsg, aiMsg);
    if (!conv.title) conv.title = text.replace(/\s+/g, ' ').slice(0, 60);
    this.store.saveConversation(conv);
    const send = (e) => emit({ conversationId, messageId: aiMsg.id, ...e });
    send({ type: 'begin', userMessage: userMsg, aiMessage: aiMsg });

    try {
      // 1) plan
      let plan;
      if (force) {
        const [provider, model = ''] = force.split('|');
        plan = { category: 'manual', reason: 'manual', source: 'manual', route: [{ provider, model }] };
      } else {
        send({ type: 'status', key: 'classifying' });
        const c = await this.classify(text, { attachments, smart, signal: controller.signal });
        plan = { ...c, route: this.routeFor(c.category) };
      }
      aiMsg.category = plan.category;
      aiMsg.reason = plan.reason;
      aiMsg.routeSource = plan.source;
      send({ type: 'plan', category: plan.category, reason: plan.reason, source: plan.source, route: plan.route });

      // 2) execute with fallback
      for (const step of plan.route) {
        if (controller.signal.aborted) break;
        const p = this.providers[step.provider];
        if (!this.isUsable(step.provider)) {
          const why = this.store.cooldownUntil(step.provider) ? 'cooldown' : 'disabled';
          aiMsg.trail.push({ provider: step.provider, model: step.model, outcome: why, until: this.store.cooldownUntil(step.provider) });
          send({ type: 'skip', provider: step.provider, model: step.model, why, until: this.store.cooldownUntil(step.provider) });
          continue;
        }
        send({ type: 'start', provider: step.provider, label: p.label, model: step.model });
        aiMsg.text = '';
        const r = await this.runOnce(step.provider, step.model, prompt, {
          cwd, autonomy: s.autonomy, timeoutMs: s.timeoutMinutes * 60e3, signal: controller.signal,
          emit: (e) => {
            if (e.type === 'activity') { aiMsg.activity.push(e.text); if (aiMsg.activity.length > 200) aiMsg.activity.shift(); }
            if (e.type === 'text') aiMsg.text += e.text;
            send(e);
          },
        });
        if (r.ok) {
          this.store.countUsage(step.provider);
          Object.assign(aiMsg, { text: r.text, status: 'done', provider: step.provider, providerLabel: p.label, model: r.model });
          aiMsg.trail.push({ provider: step.provider, model: r.model, outcome: 'ok' });
          this.store.saveConversation(conv);
          send({ type: 'done', text: r.text, provider: step.provider, label: p.label, model: r.model, category: plan.category });
          return aiMsg;
        }
        const f = r.failure;
        if (f.kind === 'cancelled') break;
        let until = null;
        if (f.kind === 'limit') until = this.coolDown(step.provider, f.resetAt);
        aiMsg.trail.push({ provider: step.provider, model: step.model, outcome: f.kind, until, message: f.message });
        send({ type: 'fallback', provider: step.provider, label: p.label, kind: f.kind, until, message: f.message });
      }

      const cancelled = controller.signal.aborted;
      aiMsg.status = cancelled ? 'cancelled' : 'failed';
      this.store.saveConversation(conv);
      send({ type: cancelled ? 'cancelled' : 'failed', trail: aiMsg.trail });
      return aiMsg;
    } catch (e) {
      aiMsg.status = 'failed';
      aiMsg.error = String(e.message || e);
      this.store.saveConversation(conv);
      send({ type: 'failed', error: aiMsg.error, trail: aiMsg.trail });
      return aiMsg;
    } finally {
      this.active.delete(conversationId);
    }
  }

  /** Quick health check for one provider. */
  async test(providerId) {
    const r = await this.runOnce(providerId, '', 'Reply with exactly the word: OK', {
      cwd: os.tmpdir(), autonomy: 'safe', timeoutMs: 120000, emit: () => {},
    });
    if (!r.ok && r.failure.kind === 'limit') this.coolDown(providerId, r.failure.resetAt);
    if (r.ok) this.store.clearCooldown(providerId);
    return r.ok ? { ok: true, text: r.text.slice(0, 200) } : { ok: false, kind: r.failure.kind, message: r.failure.message };
  }
}

module.exports = { Orchestrator };
