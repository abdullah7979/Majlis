'use strict';
// The brain: classify -> pick a route -> run (resuming the model's own session when possible)
// -> fall back on limits/failures. Emits events through `emit(event)` so the UI renders live.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, which, searchedDirs, augmentedEnv } = require('./shell');
const { PROVIDERS, credentialsPresent } = require('./providers');
const { classifyFailure, looksLikeLimitNotice } = require('./errors');
const { heuristicClassify, buildClassifierPrompt, parseClassifierOutput } = require('./classifier');

const MAX_MSG_CHARS = 8000;
const MAX_CONTEXT_CHARS = 60000;
const CATALOG_TTL = 12 * 3600e3;
const SESSION_ERROR_RE = /(session|thread|conversation).{0,40}(not found|invalid|no such|does not exist|could not be (found|loaded))|INVALID_SESSION_IDENTIFIER|No conversation found/i;

class Orchestrator {
  /** @param {import('./store').Store} store */
  constructor(store, { providers = PROVIDERS } = {}) {
    this.store = store;
    this.providers = providers;
    this.active = new Map(); // conversationId -> AbortController
    this.catalogLoading = null;
  }

  // ------------------------------------------------------------ models
  /** All models per provider: built-in aliases + the live list from the CLI + user-added names. */
  models(id) {
    const p = this.providers[id];
    if (!p) return [];
    const s = this.store.getSettings();
    const cached = (this.store.state.models || {})[id];
    const seen = new Set();
    const out = [];
    for (const m of [...p.staticModels, ...((cached && cached.list) || []), ...((s.customModels || {})[id] || []).map((x) => ({ id: x, label: x }))]) {
      if (m && m.id && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    return out;
  }

  /** Refresh live model lists (codex debug models, gemini models -o json). Cheap, cached for 12h. */
  refreshCatalog(force = false) {
    if (this.catalogLoading) return this.catalogLoading;
    const state = this.store.state;
    state.models = state.models || {};
    this.catalogLoading = Promise.all(Object.values(this.providers).map(async (p) => {
      if (!p.listModelsArgs) return;
      const c = state.models[p.id];
      const authUnknown = p.authProbe && !(state.auth && state.auth[p.id]);
      if (!force && !authUnknown && c && Date.now() - c.at < CATALOG_TTL && c.list.length) return;
      const bin = await which(p.bin);
      if (!bin) return;
      const r = await run(bin, p.listModelsArgs, { timeoutMs: 30000, env: augmentedEnv(p.runEnv || {}) });
      const all = `${r.stdout || ''}\n${r.stderr || ''}`;
      if (p.authProbe) {
        if (p.authRequiredRe.test(all)) { this.store.markAuth(p.id, false); return; }
        if (r.code === 0) this.store.markAuth(p.id, true);
      }
      try {
        const list = p.parseModels(r.stdout || '');
        if (list.length) state.models[p.id] = { at: Date.now(), list };
      } catch (_) { /* keep previous list */ }
    })).then(() => { this.store.saveState(); }).finally(() => { this.catalogLoading = null; });
    return this.catalogLoading;
  }

  /** Resolve '@fast' / '@flash' style tokens to a concrete model for that provider. */
  resolveModel(provider, model) {
    if (!model || model[0] !== '@') return model || '';
    const list = this.models(provider).map((m) => m.id);
    const want = model.slice(1);
    if (provider === 'claude') return { fast: 'haiku', flash: 'haiku', best: 'opus', top: 'fable' }[want] || '';
    if (provider === 'gemini') {
      if (want === 'fast') return list.find((x) => /flash-lite/.test(x)) || list.find((x) => /flash/.test(x)) || '';
      if (want === 'flash') return list.find((x) => /flash/.test(x) && !/lite/.test(x)) || list.find((x) => /flash/.test(x)) || '';
      if (want === 'best') return list.find((x) => /pro/.test(x)) || '';
      return '';
    }
    return '';
  }

  // ------------------------------------------------------------ status
  async providerStatus() {
    const s = this.store.getSettings();
    const usage = this.store.usageToday();
    const env = augmentedEnv();
    this.refreshCatalog().catch(() => {});
    const out = {};
    await Promise.all(Object.values(this.providers).map(async (p) => {
      const bin = await which(p.bin, env);
      let version = null;
      if (bin) {
        const r = await run(bin, ['--version'], { env, timeoutMs: 15000 });
        version = (r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) || [null])[0];
      }
      out[p.id] = {
        id: p.id, label: p.label, vendor: p.vendor, npmPackage: p.npmPackage, loginCommand: p.loginCommand,
        installed: !!bin, path: bin, version,
        signedIn: bin ? (p.authProbe ? this.store.authKnownGood(p.id) : credentialsPresent(p) || this.store.authKnownGood(p.id)) : false,
        searched: bin ? null : searchedDirs(env),
        enabled: !!(s.providers[p.id] && s.providers[p.id].enabled),
        cooldownUntil: this.store.cooldownUntil(p.id),
        usageToday: usage[p.id] || 0,
        models: this.models(p.id),
      };
    }));
    return out;
  }

  isUsable(id) {
    const s = this.store.getSettings();
    return !!this.providers[id] && !!(s.providers[id] && s.providers[id].enabled) && !this.store.cooldownUntil(id);
  }
  /** Known to be signed out (only for CLIs whose sign-in we can't see on disk). */
  knownSignedOut(id) {
    const p = this.providers[id];
    const a = (this.store.state.auth || {})[id];
    return !!(p && p.authProbe && a && a.ok === false);
  }
  isReady(id) { return this.isUsable(id) && !this.knownSignedOut(id); }

  // ------------------------------------------------------------ routing
  pickHelper(candidates) { return candidates.find((c) => this.isReady(c.provider)) || null; }

  /**
   * Keyword routing is instant and handles clear requests; a fast model is asked only when the
   * request is ambiguous, so routing never adds more than a few seconds.
   */
  async classify(text, { attachments = [], smart = true, signal } = {}) {
    const s = this.store.getSettings();
    const h = heuristicClassify(text, { attachments });
    if (h.confident || !smart || !s.smartRouting || text.trim().length < 25) return h;
    const helper = this.pickHelper([{ provider: 'claude', model: 'haiku' }, { provider: 'gemini', model: '@fast' }]);
    if (!helper) return h;
    const r = await this.runOnce(helper.provider, this.resolveModel(helper.provider, helper.model), buildClassifierPrompt(text), {
      cwd: os.tmpdir(), autonomy: 'safe', timeoutMs: 20000, signal, emit: () => {},
    });
    if (r.ok) { const parsed = parseClassifierOutput(r.text); if (parsed) return parsed; }
    else if (r.failure.kind === 'limit') this.coolDown(helper.provider, r.failure.resetAt);
    return h;
  }

  routeFor(category) {
    const s = this.store.getSettings();
    const route = (s.routes[category] || s.routes.quick || []).filter((r) => this.providers[r.provider]);
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
  /**
   * Build the prompt. With `since` (index into conv.messages) only the turns after that point are
   * included — used when resuming the provider's own session, which already remembers the rest.
   */
  buildPrompt(conv, text, attachments, { voice = false, since = null } = {}) {
    const s = this.store.getSettings();
    const done = (m) => m.text && (m.role === 'user' || m.status === 'done');
    let prior = since == null ? conv.messages.filter(done).slice(-s.historyTurns * 2) : conv.messages.slice(since).filter(done);
    let ctx = '';
    for (let i = prior.length - 1; i >= 0; i--) {
      const m = prior[i];
      const who = m.role === 'user' ? 'USER' : `ASSISTANT (${m.providerLabel || m.provider || 'AI'})`;
      const piece = `### ${who}\n${m.text.slice(0, MAX_MSG_CHARS)}\n\n`;
      if (ctx.length + piece.length > MAX_CONTEXT_CHARS) break;
      ctx = piece + ctx;
    }
    // Reply language follows the user (an Arabic question got an English answer from Claude Haiku on a real PC).
    const arabic = /[\u0600-\u06FF]/.test(text);
    let prompt = arabic
      ? '(Reply in Arabic, in the same dialect and tone the user uses, unless they ask for another language. Keep code, commands and technical names as they are.)\n\n'
      : '';
    if (ctx) {
      prompt += since == null
        ? 'Below is the earlier part of this conversation. Earlier replies may come from a different AI assistant; continue seamlessly as if you wrote them. Do not mention the handover.\n\n'
        : 'Since your last reply, the conversation continued with another assistant (continue seamlessly, do not mention it):\n\n';
      prompt += ctx + '---\n\n';
    }
    if (attachments.length) prompt += 'The user attached these files (read them from disk):\n' + attachments.map((a) => `- ${a}`).join('\n') + '\n\n';
    if (voice) {
      prompt += '(The user is talking to you by voice — this message is a speech transcript and your answer will be read aloud. ' +
        'Reply the way you would in a natural spoken conversation, in the same language and dialect the user used. ' +
        'Keep it short unless the task needs more, but still do the complete task, including any files or code.)\n\n';
    }
    prompt += (ctx ? '### NEW USER MESSAGE\n' : '') + text;
    return prompt;
  }

  // ------------------------------------------------------------ execution
  /**
   * Run one provider once, with internal retries for older CLI flags, renamed models and expired sessions.
   * Returns { ok, text, model, sessionId } or { ok:false, failure }.
   */
  async runOnce(providerId, model, prompt, { cwd, autonomy, timeoutMs, signal, emit, resumeId = null, freshPrompt = null }) {
    const p = this.providers[providerId];
    const fmt = (x) => (p.formatInput ? p.formatInput(x) : x);
    let optional = true, usedModel = model, resume = resumeId, input = fmt(prompt), attempt = 0;
    const bin = (await which(p.bin)) || p.bin; // full path avoids PATH differences between shells
    while (attempt++ < 4) {
      const outFile = p.needsOutputFile ? path.join(os.tmpdir(), `majlis-${process.pid}-${Date.now()}-${attempt}.txt`) : null;
      const args = p.buildArgs({ model: usedModel, autonomy, outputFile: outFile, optional, resumeId: resume });
      let streamed = '', final = null, finalIsError = false, sessionId = null;
      const errors = [];
      const parser = p.createParser((e) => {
        if (e.type === 'text') { streamed += e.text; emit({ type: 'text', text: e.text }); }
        else if (e.type === 'activity') emit({ type: 'activity', text: e.text });
        else if (e.type === 'final') { final = e.text; finalIsError = e.isError; }
        else if (e.type === 'meta') emit({ type: 'meta', model: e.model });
        else if (e.type === 'session') sessionId = e.id;
        else if (e.type === 'error') errors.push(e.text);
      });
      // Some CLIs wait for an interactive sign-in when signed out; stop them at once instead.
      const local = new AbortController();
      const onOuter = () => local.abort();
      if (signal) { if (signal.aborted) local.abort(); else signal.addEventListener('abort', onOuter); }
      let authRequired = false;
      const watch = (d) => { if (p.authRequiredRe && !authRequired && p.authRequiredRe.test(d)) { authRequired = true; local.abort(); } };
      const r = await run(bin, args, {
        cwd, input, timeoutMs, signal: local.signal, env: p.runEnv ? augmentedEnv(p.runEnv) : undefined,
        onStdout: (d) => { watch(d); parser.feed(d); },
        onStderr: watch,
      });
      if (signal) signal.removeEventListener('abort', onOuter);
      parser.end();
      if (authRequired) {
        if (p.authProbe) this.store.markAuth(p.id, false);
        return { ok: false, failure: { kind: 'auth' }, text: '' };
      }
      if (r.cancelled && signal && !signal.aborted) r.cancelled = false;
      if (outFile) {
        try { const t = fs.readFileSync(outFile, 'utf8'); if (t.trim()) final = t; } catch (_) {}
        try { fs.unlinkSync(outFile); } catch (_) {}
      }
      const text = (final != null && final.trim() ? final : streamed).trim();
      const failed = r.code !== 0 || finalIsError || !text || looksLikeLimitNotice(text);
      if (!failed) return { ok: true, text, model: usedModel, sessionId };

      const errText = errors.join('\n');
      const failure = classifyFailure({ ...r, stdout: `${errText}\n${r.stdout}\n${final || ''}`, finalText: text });
      if (!failure.message && errText) failure.message = errText.slice(-800);
      if (resume && (SESSION_ERROR_RE.test(`${errText}\n${r.stderr}\n${r.stdout}`) || failure.kind === 'error')) {
        resume = null; input = fmt(freshPrompt || prompt); emit({ type: 'retry', reason: 'session' }); continue;
      }
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
   * opts: { conversationId, text, attachments, force: 'provider|model' | null, smart, voice }
   */
  async send(opts, emit) {
    const { conversationId, text, force, smart = true, voice = false } = opts;
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error('conversation not found');
    if (this.active.has(conversationId)) throw new Error('busy');
    const controller = new AbortController();
    this.active.set(conversationId, controller);
    const s = this.store.getSettings();
    const attachments = opts.attachments || [];
    const cwd = conv.workspace && fs.existsSync(conv.workspace) ? conv.workspace : this.store.attachmentDir(conversationId);
    fs.mkdirSync(cwd, { recursive: true });
    conv.sessions = conv.sessions || {};

    const freshPrompt = this.buildPrompt(conv, text, attachments, { voice });
    const userMsg = { id: this.store.newId(), role: 'user', text, attachments, voice: !!voice, ts: Date.now() };
    const aiMsg = { id: this.store.newId(), role: 'assistant', text: '', status: 'running', ts: Date.now(), trail: [], activity: [] };
    const priorCount = conv.messages.length;
    conv.messages.push(userMsg, aiMsg);
    if (!conv.title) conv.title = text.replace(/\s+/g, ' ').slice(0, 60);
    this.store.saveConversation(conv);
    const send = (e) => emit({ conversationId, messageId: aiMsg.id, ...e });
    send({ type: 'begin', userMessage: userMsg, aiMessage: aiMsg });

    try {
      let plan;
      if (force) {
        const [provider, model = ''] = force.split('|');
        plan = { category: 'manual', reason: 'manual', source: 'manual', route: [{ provider, model }] };
      } else {
        send({ type: 'status', key: 'classifying' });
        const c = await this.classify(text, { attachments, smart, signal: controller.signal });
        plan = { ...c, route: this.routeFor(c.category) };
      }
      Object.assign(aiMsg, { category: plan.category, reason: plan.reason, routeSource: plan.source });
      send({ type: 'plan', category: plan.category, reason: plan.reason, source: plan.source, route: plan.route });

      for (const step of plan.route) {
        if (controller.signal.aborted) break;
        const p = this.providers[step.provider];
        const model = this.resolveModel(step.provider, step.model);
        if (!this.isUsable(step.provider)) {
          const why = this.store.cooldownUntil(step.provider) ? 'cooldown' : 'disabled';
          aiMsg.trail.push({ provider: step.provider, model, outcome: why, until: this.store.cooldownUntil(step.provider) });
          send({ type: 'skip', provider: step.provider, model, why, until: this.store.cooldownUntil(step.provider) });
          continue;
        }
        if (this.knownSignedOut(step.provider)) {
          aiMsg.trail.push({ provider: step.provider, model, outcome: 'auth' });
          send({ type: 'fallback', provider: step.provider, label: p.label, kind: 'auth' });
          continue;
        }
        // Resume this provider's own session when it was used earlier in this conversation (same model):
        // faster, and it remembers its own tool use. Turns from other models are passed along.
        const sess = conv.sessions[step.provider];
        const canResume = sess && sess.id && (sess.model || '') === (model || '') && sess.count <= priorCount;
        const prompt = canResume ? this.buildPrompt(conv, text, attachments, { voice, since: sess.count }) : freshPrompt;
        send({ type: 'start', provider: step.provider, label: p.label, model, resumed: !!canResume });
        aiMsg.text = '';
        const r = await this.runOnce(step.provider, model, prompt, {
          cwd, autonomy: s.autonomy, timeoutMs: s.timeoutMinutes * 60e3, signal: controller.signal,
          resumeId: canResume ? sess.id : null, freshPrompt,
          emit: (e) => {
            if (e.type === 'activity') { aiMsg.activity.push(e.text); if (aiMsg.activity.length > 200) aiMsg.activity.shift(); }
            if (e.type === 'text') aiMsg.text += e.text;
            send(e);
          },
        });
        if (r.ok) {
          this.store.countUsage(step.provider);
          if (!this.store.authKnownGood(step.provider)) this.store.markAuth(step.provider, true);
          Object.assign(aiMsg, { text: r.text, status: 'done', provider: step.provider, providerLabel: p.label, model: r.model });
          aiMsg.trail.push({ provider: step.provider, model: r.model, outcome: 'ok' });
          if (r.sessionId) conv.sessions[step.provider] = { id: r.sessionId, model: r.model || '', count: conv.messages.length };
          this.store.saveConversation(conv);
          send({ type: 'done', text: r.text, provider: step.provider, label: p.label, model: r.model, category: plan.category });
          return aiMsg;
        }
        const f = r.failure;
        if (f.kind === 'cancelled') break;
        let until = null;
        if (f.kind === 'limit') until = this.coolDown(step.provider, f.resetAt);
        if (f.kind === 'auth') this.store.markAuth(step.provider, false);
        aiMsg.trail.push({ provider: step.provider, model, outcome: f.kind, until, message: f.message });
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
    if (r.ok) { this.store.clearCooldown(providerId); this.store.markAuth(providerId, true); }
    if (!r.ok && r.failure.kind === 'auth') this.store.markAuth(providerId, false);
    return r.ok ? { ok: true, text: r.text.slice(0, 200) } : { ok: false, kind: r.failure.kind, message: r.failure.message };
  }
}

module.exports = { Orchestrator };
