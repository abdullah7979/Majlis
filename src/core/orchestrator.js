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
const { COUNCIL_MEMBERS } = require('./defaults');
const { Snapshots } = require('./snapshots');
const { readProjectMemory, collectFiles } = require('./workspace');

// Short replies that continue the current task rather than start a new one.
const FOLLOW_UP_RE = /^\s*(نعم|ايوه|إيوه|أيوه|ايه|إيه|اي|أي|اوكي|أوكي|تمام|طيب|زين|حلو|ممتاز|كمل|كمّل|استمر|كمله|كملها|كمّلها|زد|زيد|أكثر|اكثر|عدل|عدّل|عدلها|عدّلها|غيره|غيّره|غيرها|سو|سوه|سوّه|سوها|سويها|ابدأ|ابدا|يلا|نفذ|نفّذ|طبق|طبّق|جرب|جرّب|صحح|صلحها|صلّحها|لا|ok|okay|yes|yep|sure|continue|go on|go ahead|do it|more|again|retry|fix it|no)(?=$|[\s.,!؟?،])/i;
const LEARN_CUE_RE = /(أنا|انا|احب|أحب|ابغى|أبغى|ابي|أبي|أفضّل|افضل|لا تسو|لا تكتب|دايم|دائم|دايما|دائما|مشروعي|شغلي|عملي|وظيفتي|اشتغل|أشتغل|اسمي|عندي|بالعربي|باختصار|مختصر|\bI(?: am|'m| prefer| like| want| work)\b|\b(always|never|my (job|project|company|name))\b)/i;
const SECRET_RE = /(sk-|mj-|password|passwd|كلمة (المرور|السر)|api[_ ]?key|token\b|\b\d{12,}\b)/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|bmp)$/i;

const MAX_MSG_CHARS = 8000;
const MAX_CONTEXT_CHARS = 60000;
const CATALOG_TTL = 12 * 3600e3;
const SESSION_ERROR_RE = /(session|thread|conversation).{0,40}(not found|invalid|no such|does not exist|could not be (found|loaded))|INVALID_SESSION_IDENTIFIER|No conversation found/i;

class Orchestrator {
  /** @param {import('./store').Store} store */
  constructor(store, { providers = PROVIDERS } = {}) {
    this.store = store;
    this.snapshots = new Snapshots(store.dir);
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
      const a = state.auth && state.auth[p.id];
      // Re-check sign-in when unknown, or shortly after it was found signed out (the user may have just signed in).
      const authStale = p.authProbe && (!a || (a.ok === false && Date.now() - a.at > 15000));
      if (!force && !authStale && c && Date.now() - c.at < CATALOG_TTL && c.list.length) return;
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
    const tokens = this.store.tokenReport();
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
        tokensToday: tokens.today[p.id] || null,
        tokensWeek: tokens.week[p.id] || null,
        limits: this.store.limitsFor(p.id),
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
  /**
   * Cloud-quality speech recognition through the user's Gemini subscription (it understands Arabic far better than the
   * small on-device model). The recording lives only in the app's private folder and is deleted right after.
   */
  async transcribeCloud(bytes, language = 'auto') {
    if (!this.isReady('gemini')) return { ok: false, reason: 'unavailable' };
    const dir = path.join(this.store.attachDir, '_voice'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rec-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.from(bytes));
    try {
      const lang = language === 'ar' ? 'Arabic' : language === 'en' ? 'English' : 'the language spoken (usually Arabic or English)';
      const r = await this.runOnce('gemini', this.resolveModel('gemini', '@fast'), [
        `Transcribe the speech in this audio file exactly as spoken. Language: ${lang}.`,
        'Write Arabic in correct standard Arabic spelling, keep the speaker\'s own words and dialect, and write English technical terms in Latin letters.',
        'Output ONLY the transcript: no quotes, no explanation, no translation. If you cannot hear any speech, output exactly: [no speech]',
        `Audio file: ${file}`].join('\n'), { cwd: dir, autonomy: 'safe', timeoutMs: 45000, emit: () => {} });
      if (!r.ok) { if (r.failure && r.failure.kind === 'limit') this.coolDown('gemini', r.failure.resetAt); return { ok: false, reason: r.failure ? r.failure.kind : 'failed' }; }
      const text = r.text.replace(/^["“”«»\s]+|["“”«»\s]+$/g, '').trim();
      if (!text || /^\[?no speech\]?$/i.test(text) || /cannot|can't|unable to (access|listen|process)|لا أستطيع/i.test(text) && text.length > 60) return { ok: false, reason: 'no_audio_support', text };
      return { ok: true, text };
    } finally { try { fs.rmSync(file, { force: true }); } catch (_) {} }
  }

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
    const ordered = route.map((r, i) => ({ r, i, sc: this.store.learningScore(category, r.provider) }))
      .sort((a, b) => (Math.abs(b.sc - a.sc) >= 3 ? b.sc - a.sc : a.i - b.i))
      .map((x) => x.r);
    return s.balance === false || category === 'code_heavy' || category === 'image' ? ordered : this.balance(ordered);
  }

  /**
   * Share everyday work: if the first choice has been used much more today than the second
   * (and both are ready), swap them so no single subscription runs out early.
   */
  balance(route) {
    const ready = route.filter((r) => this.isReady(r.provider));
    if (ready.length < 2 || ready[0].provider === ready[1].provider) return route;
    const usage = this.store.usageToday();
    const a = usage[ready[0].provider] || 0, b = usage[ready[1].provider] || 0;
    if (a < b * 2 + 6) return route;
    const out = route.slice();
    const i = out.indexOf(ready[0]), j = out.indexOf(ready[1]);
    [out[i], out[j]] = [out[j], out[i]];
    out.balanced = true;
    return out;
  }

  /** The last finished answer, if this message just continues it ("yes", "continue", "fix it"...). */
  followUpOf(conv, text, heuristic) {
    const s = this.store.getSettings();
    if (s.continuity === false) return null;
    const prev = [...conv.messages].reverse().find((m) => m.role === 'assistant');
    if (!prev || prev.status !== 'done' || !prev.provider) return null;
    if (Date.now() - (prev.ts || 0) > 6 * 3600e3) return null;
    const t = text.trim();
    if (FOLLOW_UP_RE.test(t) && t.length < 160) return prev;
    if (t.length <= 30 && !(heuristic && heuristic.confident)) return prev;
    return null;
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
  buildPrompt(conv, text, attachments, { voice = false, since = null, image = false, promptEng = false } = {}) {
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
    if (s.memory && s.memory.trim()) {
      prompt += `(About the user — they asked every assistant to keep this in mind:\n${s.memory.trim().slice(0, 2000)})\n\n`;
    }
    const learned = (s.learn !== false && Array.isArray(s.learned)) ? s.learned.map((x) => x.text).filter(Boolean) : [];
    if (learned.length) {
      prompt += `(What you know about this user from earlier conversations — use it naturally, do not mention it:\n- ${learned.slice(-40).join('\n- ').slice(0, 3000)})\n\n`;
    }
    const rules = readProjectMemory(conv.workspace);
    if (rules) prompt += `(Project rules from MAJLIS.md — follow them:\n${rules})\n\n`;
    if (this.isSandboxed(conv)) {
      prompt += '(You work in a private sandbox folder that belongs to this chat. To give the user a file, a website, a document or a design, create it as a real file in the CURRENT folder: Majlis shows it to the user right inside the chat. ' +
        'Never read, list, search, open or change anything outside the current folder, never touch the user\'s other files or system settings, and never try to open programs or windows on the user\'s computer. ' +
        'Do NOT write file paths, folder names or file:// links in your answer: just say what you made and that it is shown below, because Majlis displays the files to the user automatically.)\n\n';
    }
    if (promptEng) {
      prompt += '(Act as an expert prompt engineer. Write a ready-to-use prompt the user can paste into an AI model or tool: give it a clear role, ' +
        'the goal and context, step-by-step instructions, constraints, the exact output format, and an example if useful. Put the final prompt in ' +
        'one fenced code block so it is easy to copy, then add at most two lines of tips. Write the prompt in the language the user asks for (default: the user\'s language).)\n\n';
    }
    if (image) {
      prompt += '(The user wants a real image. Use your built-in image generation tool to create it — not a text description — ' +
        'and save the final image file(s) in the current working folder. Then reply with one or two short sentences about what you made.)\n\n';
    }
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
      let streamed = '', final = null, finalIsError = false, sessionId = null, usage = null;
      const errors = [];
      const parser = p.createParser((e) => {
        if (e.type === 'text') { streamed += e.text; emit({ type: 'text', text: e.text }); }
        else if (e.type === 'activity') emit({ type: 'activity', text: e.text });
        else if (e.type === 'final') { final = e.text; finalIsError = e.isError; }
        else if (e.type === 'meta') emit({ type: 'meta', model: e.model });
        else if (e.type === 'session') sessionId = e.id;
        else if (e.type === 'error') errors.push(e.text);
        else if (e.type === 'limits') this.store.setLimits(providerId, e);
        else if (e.type === 'usage') usage = { input: (usage ? usage.input : 0) + e.input, output: (usage ? usage.output : 0) + e.output, cached: (usage ? usage.cached : 0) + e.cached };
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
      // Count what this run cost the subscription. CLIs that report no numbers are estimated from length.
      if (!authRequired && !(r.cancelled && !streamed && !final)) {
        const tk = usage || { input: estimateTokens(typeof input === 'string' ? input : JSON.stringify(input)), output: estimateTokens(final || streamed), cached: 0, estimated: true };
        if (tk.input || tk.output) { this.store.addTokens(providerId, tk); emit({ type: 'tokens', ...tk }); }
      }
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
    const cwd = this.cwdFor(conversationId);
    conv.sessions = conv.sessions || {};

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
      const h = heuristicClassify(text, { attachments });
      const prev = !force ? this.followUpOf({ messages: conv.messages.slice(0, priorCount) }, text, h) : null;
      if (force) {
        const [provider, model = ''] = force.split('|');
        plan = { category: 'manual', reason: 'manual', source: 'manual', route: [{ provider, model }] };
      } else if (prev) {
        // Keep going with the model that is doing this task.
        const category = prev.category && prev.category !== 'manual' ? prev.category : 'quick';
        const rest = this.routeFor(category).filter((r) => r.provider !== prev.provider);
        plan = { category, reason: 'follow-up', source: 'continue', route: [{ provider: prev.provider, model: prev.model || '' }, ...rest] };
      } else {
        send({ type: 'status', key: 'classifying' });
        const c = await this.classify(text, { attachments, smart, signal: controller.signal });
        const route = this.routeFor(c.category);
        plan = { ...c, route, source: route.balanced ? 'balanced' : c.source };
      }
      const image = plan.category === 'image';
      const promptEng = plan.category === 'prompt';
      const freshPrompt = this.buildPrompt(conv, text, attachments, { voice, image, promptEng });
      const baseAutonomy = opts.autonomy || s.autonomy;
      const autonomy = this.sandboxAutonomy(conv, image && baseAutonomy === 'safe' ? 'edit' : baseAutonomy, !!opts.autonomy);
      const started = Date.now();
      const snapBase = s.snapshots !== false && conv.workspace && cwd === conv.workspace && autonomy !== 'safe' && !this.isSandboxed(conv)
        ? await this.snapshots.before(conversationId, cwd) : null;
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
        const prompt = canResume ? this.buildPrompt(conv, text, attachments, { voice, image, promptEng, since: sess.count }) : freshPrompt;
        send({ type: 'start', provider: step.provider, label: p.label, model, resumed: !!canResume });
        aiMsg.text = '';
        const r = await this.runOnce(step.provider, model, prompt, {
          cwd, autonomy, timeoutMs: s.timeoutMinutes * 60e3, signal: controller.signal,
          resumeId: canResume ? sess.id : null, freshPrompt,
          emit: (e) => {
            if (e.type === 'activity') { aiMsg.activity.push(e.text); if (aiMsg.activity.length > 200) aiMsg.activity.shift(); }
            if (e.type === 'text') aiMsg.text += e.text;
            if (e.type === 'tokens') addTokens(aiMsg, e);
            send(e);
          },
        });
        if (r.ok) {
          this.store.countUsage(step.provider);
          if (!this.store.authKnownGood(step.provider)) this.store.markAuth(step.provider, true);
          Object.assign(aiMsg, { text: r.text, status: 'done', provider: step.provider, providerLabel: p.label, model: r.model });
          aiMsg.trail.push({ provider: step.provider, model: r.model, outcome: 'ok' });
          if (r.sessionId) conv.sessions[step.provider] = { id: r.sessionId, model: r.model || '', count: conv.messages.length };
          const images = this.collectImages(conversationId, cwd, started);
          if (images.length) aiMsg.images = images;
          const made = collectFiles(cwd, started);
          if (made.files.length) { aiMsg.files = made.files; aiMsg.entry = made.entry; }
          if (snapBase) {
            const changes = await this.snapshots.after(conversationId, cwd, snapBase);
            if (changes && changes.files.length) aiMsg.changes = changes;
          }
          this.store.saveConversation(conv);
          if (!opts.noLearn) this.learning = this.learnFrom(conv, text, r.text).catch(() => null);
          send({ type: 'done', text: r.text, provider: step.provider, label: p.label, model: r.model, category: plan.category, images: aiMsg.images, files: aiMsg.files, entry: aiMsg.entry, changes: aiMsg.changes, tokens: aiMsg.tokens });
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

  /**
   * Images created during this answer: in the working folder, or where the CLIs keep generated images
   * (Codex: ~/.codex/generated_images). Copied next to the conversation so they stay with it.
   */
  collectImages(conversationId, cwd, since) {
    const found = [];
    const scan = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth > 0) scan(f, depth - 1); continue; }
        if (!IMAGE_EXT.test(e.name)) continue;
        try { const st = fs.statSync(f); if (st.mtimeMs >= since - 1000 && st.size > 100) found.push(f); } catch (_) {}
      }
    };
    scan(cwd, 2);
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    scan(path.join(codexHome, 'generated_images'), 3);
    const keep = this.store.attachmentDir(conversationId);
    return [...new Set(found)].slice(0, 12).map((f) => {
      if (f.startsWith(keep) || f.startsWith(cwd)) return f;
      try { const [copy] = this.store.importAttachments(conversationId, [f]); return copy; } catch (_) { return f; }
    });
  }

  /** Undo the file changes recorded for one answer. */
  async undoChanges(conversationId, messageId) {
    const conv = this.store.getConversation(conversationId);
    const m = conv && conv.messages.find((x) => x.id === messageId);
    if (!m || !m.changes || !conv.workspace) return { ok: false };
    const r = await this.snapshots.undo(conversationId, conv.workspace, m.changes);
    m.changes.undone = r.ok;
    this.store.saveConversation(conv);
    return r;
  }

  /**
   * Council mode: the strongest model of every ready subscription answers the same question at once;
   * then one of them, as chair, writes the single best final answer from all of them.
   */
  async council(opts, emit) {
    const { conversationId, text, voice = false } = opts;
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error('conversation not found');
    if (this.active.has(conversationId)) throw new Error('busy');
    const members = COUNCIL_MEMBERS.filter((m) => this.isReady(m.provider))
      .map((m) => ({ ...m, model: this.resolveModel(m.provider, m.model) }));
    if (members.length < 2) return this.send(opts, emit);

    const controller = new AbortController();
    this.active.set(conversationId, controller);
    const s = this.store.getSettings();
    const attachments = opts.attachments || [];
    const cwd = this.cwdFor(conversationId);
    const prompt = this.buildPrompt(conv, text, attachments, { voice });
    const userMsg = { id: this.store.newId(), role: 'user', text, attachments, voice: !!voice, council: true, ts: Date.now() };
    const aiMsg = { id: this.store.newId(), role: 'assistant', text: '', status: 'running', ts: Date.now(), trail: [], activity: [], council: [], category: opts.compare ? 'compare' : 'council', routeSource: 'council' };
    conv.messages.push(userMsg, aiMsg);
    if (!conv.title) conv.title = text.replace(/\s+/g, ' ').slice(0, 60);
    this.store.saveConversation(conv);
    const send = (e) => emit({ conversationId, messageId: aiMsg.id, ...e });
    send({ type: 'begin', userMessage: userMsg, aiMessage: aiMsg });
    send({ type: 'plan', category: opts.compare ? 'compare' : 'council', source: 'council', route: members });

    try {
      const results = await Promise.all(members.map(async (m) => {
        const p = this.providers[m.provider];
        send({ type: 'council-start', provider: m.provider, label: p.label, model: m.model });
        const r = await this.runOnce(m.provider, m.model, prompt, {
          cwd, autonomy: 'safe', timeoutMs: s.timeoutMinutes * 60e3, signal: controller.signal,
          emit: (e) => { if (e.type === 'activity') send({ type: 'council-activity', provider: m.provider, text: e.text }); if (e.type === 'tokens') addTokens(aiMsg, e); },
        });
        if (r.ok) { this.store.countUsage(m.provider); if (!this.store.authKnownGood(m.provider)) this.store.markAuth(m.provider, true); }
        else if (r.failure.kind === 'limit') this.coolDown(m.provider, r.failure.resetAt);
        const entry = { provider: m.provider, label: p.label, model: r.ok ? r.model : m.model, ok: r.ok, text: r.ok ? r.text : '', kind: r.ok ? 'ok' : r.failure.kind, message: r.ok ? '' : r.failure.message };
        aiMsg.council.push(entry);
        send({ type: 'council-member', ...entry });
        return entry;
      }));
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      const good = results.filter((r) => r.ok);
      if (!good.length) {
        aiMsg.status = 'failed';
        aiMsg.trail = results.map((r) => ({ provider: r.provider, model: r.model, outcome: r.kind, message: r.message }));
        this.store.saveConversation(conv);
        send({ type: 'failed', trail: aiMsg.trail });
        return aiMsg;
      }
      let final = good[0], chair = good[0];
      if (opts.compare) {
        // Side by side, no merging: the user wants to judge the models themselves.
        final = { ...good[0], text: good.map((g) => `### ${modelLabelOf(g)}\n\n${g.text}`).join('\n\n---\n\n') };
      } else if (good.length > 1) {
        chair = good.find((g) => g.provider === 'claude') || good[0];
        send({ type: 'status', key: 'council_merging' });
        const merged = await this.runOnce(chair.provider, chair.model, this.councilPrompt(text, good), {
          cwd, autonomy: 'safe', timeoutMs: s.timeoutMinutes * 60e3, signal: controller.signal,
          emit: (e) => { if (e.type === 'text') { aiMsg.text += e.text; send(e); } if (e.type === 'tokens') addTokens(aiMsg, e); },
        });
        if (merged.ok) final = { ...chair, text: merged.text };
      }
      Object.assign(aiMsg, { text: final.text, status: 'done', provider: chair.provider, providerLabel: chair.label, model: chair.model });
      this.store.saveConversation(conv);
      if (!opts.noLearn) this.learning = this.learnFrom(conv, opts.text, final.text).catch(() => null);
      send({ type: 'done', text: aiMsg.text, provider: chair.provider, label: chair.label, model: chair.model, category: opts.compare ? 'compare' : 'council', council: aiMsg.council, tokens: aiMsg.tokens });
      return aiMsg;
    } catch (e) {
      const cancelled = controller.signal.aborted;
      aiMsg.status = cancelled ? 'cancelled' : 'failed';
      if (!cancelled) aiMsg.error = String(e.message || e);
      this.store.saveConversation(conv);
      send({ type: cancelled ? 'cancelled' : 'failed', error: aiMsg.error, trail: aiMsg.trail });
      return aiMsg;
    } finally {
      this.active.delete(conversationId);
    }
  }

  cwdFor(conversationId) {
    const conv = this.store.getConversation(conversationId);
    const real = conv && conv.workspace && this.store.getSettings().sandbox === false && fs.existsSync(conv.workspace);
    const cwd = real ? conv.workspace : this.store.attachmentDir(conversationId);
    fs.mkdirSync(cwd, { recursive: true });
    return cwd;
  }
  /** Private-folder mode (default): the models never get a folder of the user's PC; results are shown in the chat. */
  isSandboxed(conv) { return this.store.getSettings().sandbox !== false || !conv || !conv.workspace; }
  /** In the sandbox, writing files is safe (they stay in the app's own folder), but full-trust mode is never used. */
  sandboxAutonomy(conv, requested, explicit) {
    if (!this.isSandboxed(conv)) return requested;
    if (requested === 'full') return 'edit';
    return explicit ? requested : 'edit';
  }

  /** Try providers in order until one answers. Returns the successful run or the last failure. */
  async runWithFallback(order, prompt, ro) {
    let last = { ok: false, failure: { kind: 'unavailable' }, text: '' };
    for (const o of order) {
      if (ro.signal && ro.signal.aborted) break;
      if (!this.isReady(o.provider)) continue;
      const model = this.resolveModel(o.provider, o.model || '');
      const r = await this.runOnce(o.provider, model, prompt, ro);
      if (r.ok) { this.store.countUsage(o.provider); return { ...r, provider: o.provider }; }
      last = r;
      if (r.failure.kind === 'limit') this.coolDown(o.provider, r.failure.resetAt);
      if (r.failure.kind === 'auth') this.store.markAuth(o.provider, false);
      if (r.failure.kind === 'cancelled') break;
    }
    return { ...last, provider: null };
  }

  /**
   * Project mode (🏗): for something big (an app, a website). The strongest model plans; the work is done step
   * by step in the project folder; a check-and-fix round proves it runs; a second, different model reviews it;
   * findings are fixed. Every phase is shown live, and the whole run can be undone from the snapshot.
   */
  async project(opts, emit) {
    const { conversationId, text, voice } = opts;
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error('conversation not found');
    if (this.active.has(conversationId)) throw new Error('busy');
    const controller = new AbortController();
    this.active.set(conversationId, controller);
    const s = this.store.getSettings();
    const attachments = opts.attachments || [];
    const cwd = this.cwdFor(conversationId);
    const arabic = /[\u0600-\u06FF]/.test(text);
    const L = arabic
      ? { plan: 'الخطة', verify: 'التحقق', review: 'المراجعة', files: 'الملفات', ok: 'اشتغل وتم التحقق منه', notOk: 'بقيت ملاحظات', lgtm: 'ما لقى المراجع مشاكل', fixed: 'وتم إصلاح ملاحظاته', folder: 'المجلد' }
      : { plan: 'Plan', verify: 'Verification', review: 'Review', files: 'Files', ok: 'runs and was verified', notOk: 'some issues remain', lgtm: 'the reviewer found no problems', fixed: 'and its findings were fixed', folder: 'Folder' };
    const userMsg = { id: this.store.newId(), role: 'user', text, attachments, voice: !!voice, ts: Date.now() };
    const aiMsg = { id: this.store.newId(), role: 'assistant', text: '', status: 'running', ts: Date.now(), trail: [], activity: [], category: 'project', routeSource: 'project', project: { title: '', steps: [], phase: 'plan' } };
    conv.messages.push(userMsg, aiMsg);
    if (!conv.title) conv.title = text.replace(/\s+/g, ' ').slice(0, 60);
    this.store.saveConversation(conv);
    const send = (e) => emit({ conversationId, messageId: aiMsg.id, ...e });
    send({ type: 'begin', userMessage: userMsg, aiMessage: aiMsg });
    send({ type: 'plan', category: 'project', source: 'project', route: [] });
    const baseAuto = opts.autonomy || s.autonomy;
    const buildAuto = this.sandboxAutonomy(conv, baseAuto === 'safe' ? 'edit' : baseAuto, true);
    const planners = [{ provider: 'claude', model: 'opus' }, { provider: 'codex', model: '' }, { provider: 'gemini', model: '@best' }];
    // Planning and review need the strongest model; the building steps use the fast tier so a whole project takes minutes, not an hour.
    const builders = [{ provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: '' }, { provider: 'gemini', model: '@best' }];
    const ro = (autonomy) => ({
      cwd, autonomy, timeoutMs: s.timeoutMinutes * 60e3, signal: controller.signal,
      emit: (e) => { if (e.type === 'activity') send({ type: 'activity', text: e.text }); if (e.type === 'tokens') addTokens(aiMsg, e); },
    });
    const goal = this.buildPrompt(conv, text, attachments, { voice });
    const phase = (name, status) => { aiMsg.project.phase = name; send({ type: 'project-phase', phase: name, status }); };
    const snapBase = s.snapshots !== false && conv.workspace && cwd === conv.workspace && !this.isSandboxed(conv) ? await this.snapshots.before(conversationId, cwd) : null;
    const started = Date.now();
    try {
      // 1 — plan
      phase('plan', 'running');
      const pr = await this.runWithFallback(planners, [
        'You are the lead engineer. Plan how to build what the user asked for, in the current folder (it may already contain files: read them first and build on them).',
        'Return ONLY JSON, no prose: {"title":"short project name","steps":[{"title":"short step name","detail":"concrete work for this step","files":["files this step creates or edits"],"group":1}],"verify":"the shell command(s) that prove it works (tests/build), or empty"}',
        'Use 3 to 8 steps ordered so the project is runnable after every step. Prefer simple, dependency-light technology unless the request says otherwise.',
        '"group" is a number: steps with the SAME group number run at the same time by different engineers, so give them the same group ONLY when they touch completely different files and do not depend on each other (e.g. separate pages, separate modules). Foundation steps (shared config, data files, base layout) come first in their own group. Be generous with parallelism: when the project allows (separate pages, modules, backend vs frontend vs tests), put at least half of the steps in shared groups.',
        'If the folder already contains a project, this is a change request: plan ONLY the changes (1 to 3 steps), reuse what exists, and never rebuild from scratch.',
        '', 'REQUEST:', goal].join('\n'), ro('safe'));
      if (!pr.ok) throw Object.assign(new Error('plan_failed'), { failure: pr.failure });
      let plan; try { plan = JSON.parse(/\{[\s\S]*\}/.exec(pr.text)[0]); } catch (_) { plan = null; }
      const steps = plan && Array.isArray(plan.steps) && plan.steps.length ? plan.steps.slice(0, 8).map((x, i) => ({ title: String(x.title || '').slice(0, 80), detail: String(x.detail || x.title || '').slice(0, 600), files: Array.isArray(x.files) ? x.files.slice(0, 12).map(String) : [], group: Number.isFinite(+x.group) ? +x.group : i + 1 })) : [{ title: arabic ? 'التنفيذ' : 'Build', detail: text, files: [], group: 1 }];
      aiMsg.project = { title: String((plan && plan.title) || text).slice(0, 80), steps: steps.map((x) => ({ title: x.title, status: 'pending', summary: '' })), phase: 'build', verify: '' };
      const groups = [...new Set(steps.map((x) => x.group))].length;
      const avg = this.store.stepAvgMs();
      aiMsg.project.etaMin = avg ? Math.max(1, Math.round((groups * avg) / 60000)) : null;
      send({ type: 'project-plan', title: aiMsg.project.title, steps: aiMsg.project.steps, provider: pr.provider, etaMin: aiMsg.project.etaMin, parallel: steps.length - groups });

      // 2 — build, step by step
      phase('build', 'running');
      let builder = pr.provider;
      const order = () => [{ provider: builder, model: builders.find((b) => b.provider === builder).model }, ...builders.filter((b) => b.provider !== builder)];
      const runStep = async (i, preferred, parallelNote) => {
        aiMsg.project.steps[i].status = 'running'; send({ type: 'project-step', index: i, status: 'running' });
        const t0 = Date.now();
        const ord = [{ provider: preferred, model: builders.find((b) => b.provider === preferred).model }, ...builders.filter((b) => b.provider !== preferred)];
        const r = await this.runWithFallback(ord, [
          'You are building a project step by step. Overall request:', '<<<', text, '>>>',
          'Plan:', ...steps.map((x, k) => `${k + 1}. ${x.title}`),
          `Now do ONLY step ${i + 1} of ${steps.length}: ${steps[i].title} — ${steps[i].detail}`,
          steps[i].files.length ? `Files for this step: ${steps[i].files.join(', ')}` : '',
          parallelNote || '',
          'Never invent photo URLs: a guessed image link can show a completely unrelated picture. Use only inline SVG/CSS illustrations or local files you create, unless the user gave exact image URLs.',
          'Work directly in the current folder: create and edit real, complete files (no placeholders, no TODOs). Keep earlier steps\' work working. Do not ask questions.',
          'When finished, reply with ONE short line saying what you did, written in the same language as the request.',
          'You cannot run node, npx, python or a browser here (commands are not approved), so do not try; write the code carefully instead. Majlis checks syntax and links itself afterwards.',
        ].filter(Boolean).join('\n'), ro(buildAuto));
        if (!r.ok) { aiMsg.project.steps[i].status = 'failed'; send({ type: 'project-step', index: i, status: 'failed', summary: r.failure && r.failure.message || '' }); throw Object.assign(new Error('step_failed'), { failure: r.failure }); }
        aiMsg.project.steps[i] = { ...aiMsg.project.steps[i], status: 'done', summary: r.text.split('\n')[0].slice(0, 200), provider: r.provider };
        send({ type: 'project-step', index: i, status: 'done', summary: aiMsg.project.steps[i].summary, provider: r.provider });
        this.store.recordStep(Date.now() - t0);
        return r.provider;
      };
      // Steps sharing a group number run at the same time, spread over the available models.
      const ready = () => builders.map((b) => b.provider).filter((id) => this.isReady(id));
      const byGroup = [];
      steps.forEach((x, i) => { const last = byGroup[byGroup.length - 1]; if (last && steps[last[0]].group === x.group) last.push(i); else byGroup.push([i]); });
      for (const idxs of byGroup) {
        if (idxs.length === 1) { builder = await runStep(idxs[0], builder); continue; }
        const pool = ready(); const share = pool.length ? pool : [builder];
        send({ type: 'activity', text: `${idxs.length} steps in parallel` });
        const note = 'Other engineers are doing other steps AT THE SAME TIME in other files of this folder: edit ONLY the files of your step, and do not touch anything else.';
        const done = await Promise.all(idxs.map((i, k) => runStep(i, share[k % share.length], note)));
        builder = done[0];
      }

      // 3 — Majlis' own static check first (links, syntax, JSON), then a model pass that fixes what it found
      phase('verify', 'running');
      const { verifyStatic } = require('./workspace');
      let verified = false, verifyNote = '', stat = verifyStatic(cwd);
      send({ type: 'activity', text: `Majlis check: ${stat.checked} files, ${stat.problems.length} problems` });
      for (let round = 0; round < 2 && stat.problems.length; round++) {
        const v = await this.runWithFallback(order(), [
          'Majlis automatically checked the project in this folder and found these concrete problems. Fix every one now by editing the files (you cannot run commands). Reply with one short line.',
          '', ...stat.problems.map((x) => '- ' + x), '', 'Original request:', text].join('\n'), ro(buildAuto));
        if (!v.ok) break;
        builder = v.provider;
        stat = verifyStatic(cwd);
        send({ type: 'project-phase', phase: 'verify', status: stat.problems.length ? 'issues' : 'ok', round });
      }
      verified = stat.problems.length === 0;
      if (opts.allowRun && !this.isSandboxed(conv)) {
        // The user allowed commands in this project: really run its tests/build/start, and fix what fails.
        send({ type: 'activity', text: 'Running the project for real' });
        const v = await this.runWithFallback(order(), [
          'The project in this folder must satisfy this request:', '<<<', text, '>>>',
          'Now PROVE it works by really running it: install dependencies if needed, run the tests/build' + (plan && plan.verify ? ` (suggested: ${String(plan.verify).slice(0, 200)})` : '') + ', and start it briefly to see it boot. Stay inside this folder. If something fails, fix it and run again (at most 3 attempts).',
          'The first line of your reply must be exactly VERIFIED if everything passes, otherwise ISSUES: followed by what is still broken.',
        ].join('\n'), ro('full'));
        if (v.ok) { builder = v.provider; verified = verified && /^\s*VERIFIED/i.test(v.text); aiMsg.project.ran = true; if (!/^\s*VERIFIED/i.test(v.text)) stat.problems.push(v.text.replace(/^\s*ISSUES:?/i, '').trim().slice(0, 200)); }
        stat = { checked: stat.checked, problems: stat.problems };
      }
      verifyNote = verified ? `${stat.checked} ${arabic ? 'ملف: كل الروابط موجودة والأكواد سليمة' : 'files: all links resolve and all code parses'}` : stat.problems.slice(0, 3).join(' · ');
      aiMsg.project.verified = verified;

      // 4 — an independent review by a different model (read-only), then one fix round
      phase('review', 'running');
      const reviewers = builders.filter((b) => b.provider !== builder);
      const rv = await this.runWithFallback(reviewers, [
        'You are a strict senior reviewer. Review the project in this folder against the request. Read the files; do not change anything.',
        'List only REAL problems: bugs, missing requirements, broken links/imports, security issues, things that would not run. At most 8 bullets, most important first, each naming the file. If it is good, reply exactly: LGTM',
        '', 'REQUEST:', text].join('\n'), ro('safe'));
      let reviewNote = L.lgtm, reviewer = rv.provider;
      if (rv.ok && !/^\s*LGTM/i.test(rv.text)) {
        send({ type: 'project-phase', phase: 'fix', status: 'running' });
        const fx = await this.runWithFallback(order(), ['An independent reviewer found these problems in the project in this folder. Fix every real one now, then reply with one short line.', '', rv.text.slice(0, 4000)].join('\n'), ro(buildAuto));
        reviewNote = fx.ok ? `${rv.text.split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 300)} — ${L.fixed}` : rv.text.slice(0, 300);
      } else if (!rv.ok) { reviewNote = '—'; reviewer = null; }
      aiMsg.project.review = { provider: reviewer, note: reviewNote };

      // 5 — summary
      const { listFiles } = require('./workspace');
      const files = listFiles(cwd, { max: 60 });
      const label = (id) => (id && this.providers[id] ? this.providers[id].label : '—');
      const out = [
        `## ${aiMsg.project.title}`, '',
        `**${L.plan}:**`, ...aiMsg.project.steps.map((x, i) => `${i + 1}. ✓ ${x.title}${x.summary ? ` — ${x.summary}` : ''}`), '',
        `**${L.verify}:** ${verified ? '✅ ' + L.ok : '⚠️ ' + L.notOk}${verifyNote ? ` — ${verifyNote}` : ''}`,
        `**${L.review}${reviewer ? ` (${label(reviewer)})` : ''}:** ${reviewNote}`, '',
        `**${L.files}** (${files.length}): ${files.slice(0, 14).map((f) => '`' + f.path + '`').join('، ')}${files.length > 14 ? ' …' : ''}`,
      ].join('\n');
      aiMsg.text = out;
      if (snapBase) { const changes = await this.snapshots.after(conversationId, cwd, snapBase); if (changes && changes.files.length) aiMsg.changes = changes; }
      const images = this.collectImages(conversationId, cwd, started); if (images.length) aiMsg.images = images;
      { const made = collectFiles(cwd, started, { max: 60 }); if (made.files.length) { aiMsg.files = made.files; aiMsg.entry = made.entry; } }
      Object.assign(aiMsg, { status: 'done', provider: builder, providerLabel: label(builder), model: '' });
      this.store.saveConversation(conv);
      send({ type: 'done', text: out, provider: builder, label: label(builder), model: '', category: 'project', images: aiMsg.images, files: aiMsg.files, entry: aiMsg.entry, changes: aiMsg.changes, tokens: aiMsg.tokens, project: aiMsg.project });
      return aiMsg;
    } catch (e) {
      const cancelled = controller.signal.aborted;
      aiMsg.status = cancelled ? 'cancelled' : 'failed';
      if (!cancelled && process.env.MAJLIS_DEBUG) console.error(e.stack); if (!cancelled) aiMsg.error = e.failure && e.failure.message ? e.failure.message : String(e.message || e);
      this.store.saveConversation(conv);
      send({ type: cancelled ? 'cancelled' : 'failed', error: aiMsg.error, trail: aiMsg.trail });
      return aiMsg;
    } finally {
      this.active.delete(conversationId);
    }
  }

  councilPrompt(question, answers) {
    const arabic = /[\u0600-\u06FF]/.test(question);
    return [
      'You chair "Majlis", a council of AI assistants. Several assistants answered the same request independently.',
      'Write the single best final answer for the user: keep the strongest and most correct points from each, fix any mistakes,',
      'and if they genuinely disagree on something important, say so in one short line with your judgement.',
      'Do not list the assistants or describe this process; just give the answer.',
      arabic ? 'Write the answer in Arabic, in the same dialect and tone the user uses (keep code and technical names as they are).' : 'Write in the language of the request.',
      '',
      '### USER REQUEST',
      question,
      '',
      ...answers.map((a, i) => `### ANSWER ${i + 1} (${a.label})\n${a.text.slice(0, 12000)}\n`),
    ].join('\n');
  }

  /**
   * Turn a rough request into a clear, professional prompt (the ✨ button). Uses the fastest ready model.
   * Returns { ok, text }.
   */
  async improvePrompt(text) {
    const helper = this.pickHelper([{ provider: 'claude', model: 'haiku' }, { provider: 'gemini', model: '@flash' }, { provider: 'codex', model: '' }]);
    if (!helper) return { ok: false, kind: 'unavailable' };
    const arabic = /[\u0600-\u06FF]/.test(text);
    const instruction = [
      'Rewrite the user\'s rough request below into a clear, complete, professional prompt for an AI assistant.',
      'Keep the user\'s intent exactly; add the missing structure: goal, context, specific requirements, constraints, and the desired output format.',
      'Do not answer the request. Do not add explanations. Output only the improved prompt text, no quotes, no code fences.',
      arabic ? 'Write it in Arabic (natural, clear Arabic; keep technical terms as they are).' : 'Write it in the same language as the request.',
      '', 'Rough request:', '<<<', text.slice(0, 6000), '>>>',
    ].join('\n');
    const r = await this.runOnce(helper.provider, this.resolveModel(helper.provider, helper.model), instruction, {
      cwd: os.tmpdir(), autonomy: 'safe', timeoutMs: 90000, emit: () => {},
    });
    if (!r.ok) return { ok: false, kind: r.failure.kind };
    return { ok: true, text: r.text.replace(/^```\w*\n?|```$/g, '').replace(/^["“]|["”]$/g, '').trim(), provider: helper.provider };
  }

  /**
   * Speech-to-text repair. Whisper hears Arabic dialect and mixed Arabic/English tech words imperfectly
   * ("فلتر" for Flutter, wrong hamza, split words). A fast model fixes the transcript using what Majlis
   * knows (vocabulary, learned facts, memory, the last messages), without answering or rephrasing it.
   * Falls back to the original text on any doubt, so it can only help.
   */
  async fixTranscript(text, { conversationId = null } = {}) {
    const raw = String(text || '').trim();
    const s = this.store.getSettings();
    const v = s.voice || {};
    if (v.smartFix === false || raw.split(/\s+/).length < 3) return { ok: true, text: raw, fixed: false };
    const helper = this.pickHelper([{ provider: 'claude', model: 'haiku' }, { provider: 'gemini', model: '@flash' }, { provider: 'codex', model: '' }]);
    if (!helper) return { ok: true, text: raw, fixed: false };
    const conv = conversationId ? this.store.getConversation(conversationId) : null;
    const recent = conv ? conv.messages.filter((m) => m.role === 'user').slice(-3).map((m) => String(m.text || '').slice(0, 200)) : [];
    const vocab = String(v.vocabulary || '').split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 80);
    const learned = (s.learn !== false && s.learned || []).map((x) => x.text).slice(-15);
    const instruction = [
      'You correct speech-to-text errors. The text below was produced by a speech recognizer from an Arabic speaker (Saudi/Gulf dialect, often mixing English technical words).',
      'Fix only recognition mistakes: wrong or misheard words, broken Arabic spelling (hamza, ta marbuta, alef maqsura), words wrongly split or merged, and English/technical terms that were written in Arabic letters or garbled (write them in Latin letters, e.g. Flutter, Kotlin, API, GitHub, Claude).',
      'Keep the speaker\'s words, dialect and meaning. Do NOT translate, summarize, answer, or add anything. Add basic punctuation only. If it is already correct, return it unchanged.',
      vocab.length ? `Words/names the speaker uses: ${vocab.join('، ')}` : '',
      s.memory ? `About the speaker: ${String(s.memory).slice(0, 600)}` : '',
      learned.length ? `Also known: ${learned.join(' | ')}` : '',
      recent.length ? `Their previous messages (context only): ${recent.join(' / ')}` : '',
      'Output ONLY the corrected text on one line.', '', 'Text:', '<<<', raw.slice(0, 3000), '>>>',
    ].filter((x) => x !== '').join('\n');
    const r = await this.runOnce(helper.provider, this.resolveModel(helper.provider, helper.model), instruction, {
      cwd: os.tmpdir(), autonomy: 'safe', timeoutMs: 45000, emit: () => {},
    });
    if (!r.ok) return { ok: true, text: raw, fixed: false };
    const out = acceptFix(raw, r.text);
    return { ok: true, text: out, fixed: out !== raw, provider: helper.provider };
  }

  /**
   * Like the memory in the official apps: after a reply, a fast model notes durable facts and preferences
   * the user revealed (how they like answers, their work, their projects, tools). Shared by every model
   * through buildPrompt. Cheap: runs only when the message looks personal, or every 8th message.
   */
  async learnFrom(conv, userText, replyText) {
    const s = this.store.getSettings();
    if (s.learn === false || !userText || userText.length < 8) return null;
    const userTurns = conv.messages.filter((m) => m.role === 'user').length;
    const personal = LEARN_CUE_RE.test(userText);
    if (!personal && userTurns % 8 !== 0) return null;
    const helper = this.pickHelper([{ provider: 'claude', model: 'haiku' }, { provider: 'gemini', model: '@flash' }, { provider: 'codex', model: '' }]);
    if (!helper) return null;
    const known = (s.learned || []).map((x) => `${x.id}: ${x.text}`).join('\n') || '(nothing yet)';
    const instruction = [
      'You maintain a short memory about ONE user of an AI assistant, so every future answer fits them better.',
      'From the latest exchange, extract only DURABLE facts the user stated or clearly showed about themselves: preferred language/dialect and tone, answer length and format they like or dislike, their job and skills, their ongoing projects, tools, platforms and accounts they use, standing instructions ("always…", "never…").',
      'Do NOT store: one-off task details, things the assistant said, guesses, secrets/passwords/keys, health, religion, politics, finances, or anything sensitive.',
      'Each fact: one short line, written in the user\'s language, third person (e.g. "يفضّل الردود المختصرة بالعربي").',
      'If a new fact replaces an old one, remove the old id. If nothing durable, return empty lists.',
      'Return ONLY JSON: {"add":["..."],"remove":["id"]}',
      '', 'Already known:', known, '', 'Latest user message:', userText.slice(0, 3000), '', 'Assistant reply (context only):', String(replyText || '').slice(0, 1200),
    ].join('\n');
    const r = await this.runOnce(helper.provider, this.resolveModel(helper.provider, helper.model), instruction, { cwd: os.tmpdir(), autonomy: 'safe', timeoutMs: 60000, emit: () => {} });
    if (!r.ok) return null;
    const m = /\{[\s\S]*\}/.exec(r.text); if (!m) return null;
    let j; try { j = JSON.parse(m[0]); } catch (_) { return null; }
    const remove = new Set((j.remove || []).map(String));
    let list = (this.store.getSettings().learned || []).filter((x) => !remove.has(x.id));
    const have = new Set(list.map((x) => x.text.trim()));
    for (const t of (j.add || []).map((x) => String(x).trim()).filter((x) => x && x.length < 300 && !have.has(x)).slice(0, 5)) {
      if (SECRET_RE.test(t)) continue;
      list.push({ id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: t, ts: Date.now() });
    }
    list = list.slice(-60);
    this.store.updateSettings({ learned: list });
    return list;
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

function modelLabelOf(g) { return `${g.label}${g.model ? ` · ${g.model}` : ''}`; }
function addTokens(msg, e) {
  const t0 = msg.tokens || { input: 0, output: 0, cached: 0 };
  msg.tokens = { input: t0.input + e.input, output: t0.output + e.output, cached: t0.cached + e.cached, estimated: !!(t0.estimated || e.estimated) };
}

/** Accept a model's correction only if it still looks like the same sentence. */
function acceptFix(original, candidate) {
  let c = String(candidate || '').replace(/^```\w*\n?|```$/g, '').replace(/^<<<|>>>$/g, '').replace(/^["“«]|["”»]$/g, '').replace(/\s+/g, ' ').trim();
  if (!c || c.length > original.length * 1.6 + 12 || c.length < original.length * 0.5) return original;
  if (/^(sorry|i can't|i cannot|عذرا|عذراً|آسف|لا أستطيع)/i.test(c)) return original;
  return c;
}

/** Rough token count when a CLI reports none (~4 chars/token for Latin text, ~2.5 for Arabic). */
function estimateTokens(text) {
  const t = String(text || '');
  const arabic = (t.match(/[\u0600-\u06FF]/g) || []).length;
  return Math.ceil(arabic / 2.5 + (t.length - arabic) / 4);
}

module.exports = { Orchestrator, estimateTokens, acceptFix };
