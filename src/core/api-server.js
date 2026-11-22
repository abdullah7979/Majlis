'use strict';
// Local OpenAI-compatible API, so other tools on this PC (n8n, Make/Zapier agents, scripts, IDE plugins)
// can hand work to Majlis. Majlis picks the strongest model across the user's subscriptions, exactly as
// in the app. Bound to 127.0.0.1 by default and protected by a secret key.
//
//   GET  /v1/models                     -> majlis-auto, majlis-council, and every provider:model
//   POST /v1/chat/completions           -> OpenAI chat format, optional "stream": true (SSE)
//   GET  /health                        -> { ok, version }
//
// Extra request fields (optional): "conversation_id" to continue a Majlis conversation,
// "majlis": { "autonomy": "safe" | "edit" }.

const http = require('http');
const crypto = require('crypto');

function newKey() { return 'mj-' + crypto.randomBytes(24).toString('base64url'); }

class ApiServer {
  /**
   * @param {object} o
   * @param {import('./orchestrator').Orchestrator} o.orch
   * @param {import('./store').Store} o.store
   * @param {(e: object) => void} [o.onEvent]  mirror chat events to the UI
   * @param {string} [o.version]
   */
  constructor({ orch, store, onEvent = () => {}, version = '0' }) {
    Object.assign(this, { orch, store, onEvent, version });
    this.server = null;
    this.port = null;
    this.requests = 0;
  }

  settings() { return this.store.getSettings().api || {}; }

  /** Make sure a key exists; returns it. */
  ensureKey() {
    const a = this.settings();
    if (a.key) return a.key;
    const key = newKey();
    this.store.updateSettings({ api: { key } });
    return key;
  }
  regenerateKey() { const key = newKey(); this.store.updateSettings({ api: { key } }); return key; }

  async start() {
    await this.stop();
    const a = this.settings();
    this.ensureKey();
    const host = a.allowLan ? '0.0.0.0' : '127.0.0.1';
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.json(res, 500, { error: { message: String(e.message || e), type: 'server_error' } })));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(a.port || 4891, host, () => { this.server.off('error', reject); resolve(); });
    });
    this.port = this.server.address().port;
    return { ok: true, port: this.port, host };
  }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null; this.port = null;
    await new Promise((r) => s.close(() => r()));
  }

  status() { return { running: !!this.server, port: this.port, requests: this.requests }; }

  // ---------------------------------------------------------------- HTTP helpers
  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  }
  readBody(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  authorized(req) {
    const key = this.settings().key;
    const h = req.headers.authorization || '';
    const given = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers['x-api-key'] || '');
    if (!key || !given) return false;
    const a = Buffer.from(key), b = Buffer.from(String(given));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------------------------------------------------------------- models
  modelList() {
    const out = [
      { id: 'majlis-auto', owned_by: 'majlis', description: 'Majlis picks the best model for each request' },
      { id: 'majlis-council', owned_by: 'majlis', description: 'Claude, ChatGPT and Gemini answer together; one merged best answer' },
    ];
    for (const id of Object.keys(this.orch.providers)) {
      out.push({ id: `${id}:default`, owned_by: id });
      for (const m of this.orch.models(id)) out.push({ id: `${id}:${m.id}`, owned_by: id, description: m.label });
    }
    return out;
  }

  /** 'majlis-auto' | 'majlis-council' | 'claude:opus' | 'claude/opus' | 'gpt-6-luna' | 'opus' -> plan */
  resolve(model) {
    const m = String(model || 'majlis-auto').trim();
    if (!m || /^(majlis(-auto)?|auto|default)$/i.test(m)) return { mode: 'auto' };
    if (/^majlis-council$|^council$/i.test(m)) return { mode: 'council' };
    const parts = m.split(/[:/]/);
    if (parts.length === 2 && this.orch.providers[parts[0]]) return { mode: 'force', force: `${parts[0]}|${parts[1] === 'default' ? '' : parts[1]}` };
    if (this.orch.providers[m]) return { mode: 'force', force: `${m}|` };
    for (const id of Object.keys(this.orch.providers)) {
      if (this.orch.models(id).some((x) => x.id === m)) return { mode: 'force', force: `${id}|${m}` };
    }
    return null;
  }

  // ---------------------------------------------------------------- routes
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      return res.end();
    }
    if (url.pathname === '/health') return this.json(res, 200, { ok: true, name: 'majlis', version: this.version });
    if (!this.authorized(req)) return this.json(res, 401, { error: { message: 'Invalid or missing API key. Use: Authorization: Bearer <key from Majlis → Settings → Connect (API)>', type: 'invalid_request_error', code: 'invalid_api_key' } });

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return this.json(res, 200, { object: 'list', data: this.modelList().map((m) => ({ object: 'model', created: 0, ...m })) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return this.chat(req, res);
    return this.json(res, 404, { error: { message: `Unknown endpoint ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
  }

  async chat(req, res) {
    let body;
    try { body = JSON.parse(await this.readBody(req)); } catch (e) { return this.json(res, 400, { error: { message: 'Body must be JSON', type: 'invalid_request_error' } }); }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : '');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = lastUser ? textOf(lastUser.content).trim() : '';
    if (!text) return this.json(res, 400, { error: { message: 'messages must contain a user message', type: 'invalid_request_error' } });
    const plan = this.resolve(body.model);
    if (!plan) return this.json(res, 404, { error: { message: `Unknown model "${body.model}". GET /v1/models lists what you can use.`, type: 'invalid_request_error', code: 'model_not_found' } });
    this.requests++;

    // A conversation per request (or continue one). Earlier messages become context.
    let conv = body.conversation_id && /^[a-f0-9]{16}$/.test(body.conversation_id) ? this.store.getConversation(body.conversation_id) : null;
    if (!conv) {
      conv = this.store.createConversation({ title: '' });
      conv.source = 'api';
      const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n').trim();
      const history = messages.slice(0, messages.lastIndexOf(lastUser)).filter((m) => m.role === 'user' || m.role === 'assistant');
      if (system) conv.messages.push({ id: this.store.newId(), role: 'user', text: `(Instructions for this conversation)\n${system}`, ts: Date.now() });
      for (const m of history) {
        conv.messages.push(m.role === 'user'
          ? { id: this.store.newId(), role: 'user', text: textOf(m.content), ts: Date.now() }
          : { id: this.store.newId(), role: 'assistant', text: textOf(m.content), status: 'done', provider: 'external', providerLabel: 'assistant', ts: Date.now() });
      }
      conv.title = `API · ${text.replace(/\s+/g, ' ').slice(0, 50)}`;
      this.store.saveConversation(conv);
    }

    const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    const stream = !!body.stream;
    let usedModel = body.model || 'majlis-auto';
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    }
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: usedModel, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    let sentRole = false, streamed = '';
    const emit = (e) => {
      this.onEvent(e);
      if (!stream) return;
      if (e.type === 'start') usedModel = `${e.provider}:${e.model || 'default'}`;
      if (e.type === 'start' && streamed) { streamed = ''; } // a fallback restarted the answer
      if (e.type === 'text' && e.text) {
        if (!sentRole) { chunk({ role: 'assistant', content: '' }); sentRole = true; }
        streamed += e.text; chunk({ content: e.text });
      }
    };
    const autonomy = (body.majlis && body.majlis.autonomy) || this.settings().autonomy || 'safe';
    const opts = { conversationId: conv.id, text, autonomy };
    let msg;
    try {
      msg = plan.mode === 'council' ? await this.orch.council(opts, emit) : await this.orch.send({ ...opts, force: plan.force || null }, emit);
    } catch (e) {
      msg = { status: 'failed', error: String(e.message || e), trail: [] };
    }
    const ok = msg.status === 'done';
    const modelName = ok ? `${msg.provider}:${msg.model || 'default'}` : usedModel;
    const majlis = { conversation_id: conv.id, provider: msg.provider || null, model: msg.model || null, category: msg.category || null, route: msg.routeSource || null, images: msg.images || [], trail: msg.trail || [] };

    if (stream) {
      if (!ok) chunk({ content: streamed ? '' : `[Majlis] ${msg.error || 'every model on this route is unavailable right now'}` }, 'stop');
      else {
        if (!sentRole) { chunk({ role: 'assistant', content: '' }); sentRole = true; }
        if (!streamed) chunk({ content: msg.text }); // providers that only return a final answer
        chunk({}, 'stop');
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [], majlis })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (!ok) return this.json(res, 503, { error: { message: msg.error || 'Every model on this route is unavailable right now (limits, sign-in or errors).', type: 'server_error', code: 'all_models_unavailable', majlis } });
    return this.json(res, 200, {
      id, object: 'chat.completion', created, model: modelName,
      choices: [{ index: 0, message: { role: 'assistant', content: msg.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      majlis,
    });
  }
}

module.exports = { ApiServer, newKey };
