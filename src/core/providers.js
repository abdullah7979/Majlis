'use strict';
// Provider adapters, written against the real CLIs:
//   Claude Code 2.1.x · Codex CLI 0.171 · Gemini CLI 0.70
// Each adapter knows how to:
//   - build arguments for a model, an autonomy level and (optionally) a session to resume
//   - parse the CLI's JSON event stream into a few common events
//   - list the models the user's subscription offers
//   - tell whether it is installed / signed in, and how to sign in
//
// Everything runs on the user's own subscription through the vendor's official CLI.

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();

// Events emitted by parsers:
//   { type: 'text', text }              streamed answer text (append)
//   { type: 'activity', text }          a tool call / step the agent took
//   { type: 'final', text, isError }    canonical final answer (replaces streamed text)
//   { type: 'session', id }             session id to resume later
//   { type: 'meta', model }             model actually used
//   { type: 'error', text }             an error reported inside the stream

function lineBuffer(onLine) {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line.trim()) onLine(line); }
    },
    flush() { if (buf.trim()) onLine(buf); buf = ''; },
  };
}
function tryJson(line) { try { return JSON.parse(line); } catch (_) { return null; } }

function describeTool(name, input = {}) {
  const target = input.file_path || input.absolute_path || input.path || input.command || input.pattern || input.url || input.query || input.dir_path || '';
  return target ? `${name}: ${String(Array.isArray(target) ? target.join(' ') : target).slice(0, 140)}` : name;
}

// ---------------------------------------------------------------- Claude Code
const claude = {
  id: 'claude',
  label: 'Claude',
  vendor: 'Anthropic',
  npmPackage: '@anthropic-ai/claude-code',
  bin: 'claude',
  loginCommand: 'claude',
  credentialFiles: [path.join(home, '.claude', '.credentials.json')],
  authEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  // Aliases always point at the newest model of each family.
  staticModels: [
    { id: 'fable', label: 'Claude Fable', note: 'most capable' },
    { id: 'opus', label: 'Claude Opus', note: 'deep work' },
    { id: 'sonnet', label: 'Claude Sonnet', note: 'balanced' },
    { id: 'haiku', label: 'Claude Haiku', note: 'fastest' },
  ],
  buildArgs({ model, autonomy, resumeId, optional = true }) {
    const a = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (optional) a.push('--include-partial-messages');
    if (model) a.push('--model', model);
    if (resumeId) a.push('--resume', resumeId);
    if (autonomy === 'full') a.push('--permission-mode', 'bypassPermissions');
    else if (autonomy === 'edit') a.push('--permission-mode', 'acceptEdits');
    else a.push('--permission-mode', 'plan');
    return a;
  },
  createParser(emit) {
    let sawDelta = false;
    const lb = lineBuffer((line) => {
      const j = tryJson(line);
      if (!j) { emit({ type: 'text', text: line + '\n' }); return; }
      if (j.session_id) emit({ type: 'session', id: j.session_id });
      if (j.type === 'system' && j.subtype === 'init' && j.model) emit({ type: 'meta', model: j.model });
      else if (j.type === 'stream_event' && j.event) {
        const e = j.event;
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') { sawDelta = true; emit({ type: 'text', text: e.delta.text }); }
        if (e.type === 'message_stop') emit({ type: 'text', text: '\n\n' });
      } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
        for (const c of j.message.content) {
          if (c.type === 'text' && !sawDelta) emit({ type: 'text', text: c.text + '\n\n' });
          if (c.type === 'tool_use') emit({ type: 'activity', text: describeTool(c.name, c.input) });
        }
      } else if (j.type === 'result') {
        emit({ type: 'final', text: typeof j.result === 'string' ? j.result : '', isError: !!j.is_error || (j.subtype && j.subtype !== 'success') });
      }
    });
    return { feed: lb.feed, end: lb.flush };
  },
};

// ---------------------------------------------------------------- Codex (ChatGPT)
// codex exec [resume] --skip-git-repo-check --json -o <file> [-m model] -c sandbox_mode="..." [<id>] -
const SANDBOX = { safe: 'read-only', edit: 'workspace-write' };
const codex = {
  id: 'codex',
  label: 'ChatGPT',
  vendor: 'OpenAI Codex',
  npmPackage: '@openai/codex',
  bin: 'codex',
  loginCommand: 'codex login',
  credentialFiles: [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')],
  authEnv: ['OPENAI_API_KEY'],
  staticModels: [],
  needsOutputFile: true,
  listModelsArgs: ['debug', 'models'],
  parseModels(stdout) {
    const start = stdout.search(/[[{]/);
    const j = start >= 0 ? tryJson(stdout.slice(start)) : null;
    const list = Array.isArray(j) ? j : j && Array.isArray(j.models) ? j.models : [];
    return list.filter((m) => m && m.slug && m.visibility !== 'hide')
      .sort((a, b) => (a.priority || 99) - (b.priority || 99))
      .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  },
  buildArgs({ model, autonomy, outputFile, resumeId }) {
    const a = ['exec'];
    if (resumeId) a.push('resume');
    a.push('--skip-git-repo-check', '--json');
    if (outputFile) a.push('--output-last-message', outputFile);
    if (model) a.push('-m', model);
    if (autonomy === 'full') a.push('--dangerously-bypass-approvals-and-sandbox');
    else a.push('-c', `sandbox_mode=${SANDBOX[autonomy] || 'workspace-write'}`); // raw TOML string, no quotes needed
    if (resumeId) a.push(resumeId);
    a.push('-');
    return a;
  },
  createParser(emit) {
    const lb = lineBuffer((line) => {
      const j = tryJson(line);
      if (!j) return; // human-readable noise
      if (j.type === 'thread.started' && j.thread_id) emit({ type: 'session', id: j.thread_id });
      else if (j.type === 'item.started' || j.type === 'item.completed') {
        const it = j.item || {};
        if (it.type === 'agent_message' && j.type === 'item.completed' && it.text) emit({ type: 'text', text: it.text + '\n\n' });
        else if (it.type === 'command_execution' && j.type === 'item.started') emit({ type: 'activity', text: `run: ${String(it.command || '').slice(0, 160)}` });
        else if (it.type === 'file_change' && j.type === 'item.completed') emit({ type: 'activity', text: `edit: ${(it.changes || []).map((c) => c.path).join(', ').slice(0, 160)}` });
        else if (it.type === 'web_search' && j.type === 'item.started') emit({ type: 'activity', text: `search: ${it.query || ''}` });
        else if (it.type === 'error' && it.message && !/Falling back|Reconnecting/i.test(it.message)) emit({ type: 'error', text: it.message });
      } else if (j.type === 'turn.failed') emit({ type: 'error', text: (j.error && j.error.message) || 'turn failed' });
      else if (j.type === 'error' && j.message && !/^Reconnecting/i.test(j.message)) emit({ type: 'error', text: j.message });
    });
    return { feed: lb.feed, end: lb.flush };
  },
};

// ---------------------------------------------------------------- Gemini CLI
// gemini -p " " --skip-trust -o stream-json [-m model] --approval-mode X [--resume <uuid>]   (prompt on stdin)
const APPROVAL = { safe: 'plan', edit: 'auto_edit', full: 'yolo' };
const gemini = {
  id: 'gemini',
  label: 'Gemini',
  vendor: 'Google',
  npmPackage: '@google/gemini-cli',
  bin: 'gemini',
  loginCommand: 'gemini',
  credentialFiles: [path.join(home, '.gemini', 'oauth_creds.json')],
  authEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  // A headless run without stored Google credentials can't succeed, so a missing file means "not signed in".
  strictCredentials: true,
  // Headless runs refuse untrusted folders unless told otherwise; never open a browser from a background run.
  runEnv: { GEMINI_CLI_TRUST_WORKSPACE: 'true', NO_BROWSER: 'true' },
  staticModels: [{ id: 'auto', label: 'Gemini Auto' }],
  listModelsArgs: ['models', '-o', 'json'],
  parseModels(stdout) {
    const start = stdout.indexOf('[');
    const j = start >= 0 ? tryJson(stdout.slice(start)) : null;
    return (Array.isArray(j) ? j : []).filter((m) => m && (m.id || m.modelId))
      .map((m) => ({ id: m.id || m.modelId, label: prettyGemini(m.id || m.modelId, m.displayName) }));
  },
  buildArgs({ model, autonomy, resumeId }) {
    const a = ['-p', ' ', '--skip-trust', '-o', 'stream-json'];
    if (model) a.push('-m', model);
    a.push('--approval-mode', APPROVAL[autonomy] || 'auto_edit');
    if (resumeId) a.push('--resume', resumeId);
    return a;
  },
  createParser(emit) {
    const lb = lineBuffer((line) => {
      const j = tryJson(line);
      if (!j) return;
      if (j.type === 'init') { if (j.session_id) emit({ type: 'session', id: j.session_id }); if (j.model) emit({ type: 'meta', model: j.model }); }
      else if (j.type === 'message' && j.role === 'assistant' && j.content) emit({ type: 'text', text: j.content });
      else if (j.type === 'tool_use') emit({ type: 'activity', text: describeTool(j.tool_name, j.parameters) });
      else if (j.type === 'error') emit({ type: 'error', text: j.message || (j.error && j.error.message) || 'error' });
      else if (j.type === 'result' && j.status && j.status !== 'success') emit({ type: 'error', text: (j.error && j.error.message) || `status ${j.status}` });
    });
    return { feed: lb.feed, end: lb.flush };
  },
  /** Make interactive `gemini` go straight to "Login with Google". */
  prepareLogin() {
    const file = path.join(home, '.gemini', 'settings.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* new file */ }
    const already = (cfg.security && cfg.security.auth && cfg.security.auth.selectedType) || cfg.selectedAuthType;
    if (already) return;
    cfg.security = cfg.security || {};
    cfg.security.auth = { ...(cfg.security.auth || {}), selectedType: 'oauth-personal' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  },
};

function prettyGemini(id, display) {
  if (id === 'auto') return 'Gemini Auto';
  const s = String(display && display !== id ? display : id).replace(/^gemini-/i, 'Gemini ');
  return s.replace(/-/g, ' ').replace(/\b(pro|flash|lite|ultra)\b/gi, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

const PROVIDERS = { claude, codex, gemini };

function credentialsPresent(p) {
  if ((p.authEnv || []).some((k) => process.env[k])) return true;
  return p.credentialFiles.some((f) => { try { return fs.statSync(f).size > 2; } catch (_) { return false; } });
}

module.exports = { PROVIDERS, credentialsPresent, lineBuffer, prettyGemini };
