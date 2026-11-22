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
      if (j.type === 'rate_limit_event' && j.rate_limit_info) {
        const r = j.rate_limit_info;
        emit({ type: 'limits', window: r.rateLimitType || 'session', status: r.status || null, usedPct: r.utilization != null ? Math.round(r.utilization * (r.utilization <= 1 ? 100 : 1)) : null, resetsAt: r.resetsAt ? (r.resetsAt < 1e12 ? r.resetsAt * 1000 : r.resetsAt) : null });
      }
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
        if (j.usage) emit({ type: 'usage', input: (j.usage.input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0), cached: j.usage.cache_read_input_tokens || 0, output: j.usage.output_tokens || 0 });
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
      } else if (j.type === 'turn.completed' && j.usage) {
        const rl = j.rate_limits || (j.msg && j.msg.rate_limits);
        if (rl) for (const [w, v] of Object.entries(rl)) if (v && typeof v === 'object') emit({ type: 'limits', window: w, status: null, usedPct: v.used_percent != null ? Math.round(v.used_percent) : null, resetsAt: v.resets_in_seconds != null ? Date.now() + v.resets_in_seconds * 1000 : (v.resets_at ? v.resets_at * 1000 : null) });
        const u = j.usage, cached = u.cached_input_tokens || 0;
        emit({ type: 'usage', input: Math.max(0, (u.input_tokens || 0) - cached), cached, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) });
      } else if (j.type === 'turn.failed') emit({ type: 'error', text: (j.error && j.error.message) || 'turn failed' });
      else if (j.type === 'error' && j.message && !/^Reconnecting/i.test(j.message)) emit({ type: 'error', text: j.message });
    });
    return { feed: lb.feed, end: lb.flush };
  },
};

// ---------------------------------------------------------------- Gemini via Antigravity CLI
// Google retired Gemini CLI for personal accounts (Google AI Pro/Ultra/free) on 18 June 2026 and replaced
// it with Antigravity CLI (`agy`). Verified on Windows with agy 1.5.14:
//   agy --input-format stream-json --output-format stream-json [--model slug] [--mode m] [--conversation id]
//   stdin: {"event":"user","message":{"content":"..."}}   (keeps Arabic/newlines out of the command line)
//   stdout: {"event":"init"...} {"event":"step_update",...,"text_delta"} {"event":"result","result":{...}}
// Signed out, it prints "Authentication required" and waits 60 s — we stop it immediately instead.
const AGY_MODE = { safe: 'plan', edit: 'accept-edits', full: 'auto' };
const gemini = {
  id: 'gemini',
  label: 'Gemini',
  vendor: 'Google Antigravity',
  bin: 'agy',
  install: { native: 'agy' }, // see installers.js — Google's install.ps1 steps, done in-process
  loginCommand: 'agy',
  credentialFiles: [], // stored in the system keyring — sign-in is checked with `agy models` instead
  authProbe: true,
  authRequiredRe: /Authentication required|Please sign in|Launch the CLI without arguments to sign in/i,
  staticModels: [],
  listModelsArgs: ['models'],
  parseModels(stdout) {
    if (/Please sign in/i.test(stdout)) return [];
    const seen = new Set(), out = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/\b([a-z][a-z0-9]*(?:[-.][a-z0-9]+)+)\b/i);
      if (!m || /^(https?|www)/i.test(m[1]) || seen.has(m[1])) continue;
      if (!/gemini|claude|gpt|gemma|llama|qwen|deepseek|grok|mistral|neon|flash|pro/i.test(m[1])) continue;
      seen.add(m[1]);
      out.push({ id: m[1], label: prettyGemini(m[1]) });
    }
    return out;
  },
  buildArgs({ model, autonomy, resumeId }) {
    const a = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
    if (model) a.push('--model', model);
    a.push('--mode', AGY_MODE[autonomy] || 'accept-edits');
    if (autonomy === 'full') a.push('--dangerously-skip-permissions');
    if (resumeId) a.push('--conversation', resumeId);
    return a;
  },
  formatInput(prompt) { return JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n'; },
  createParser(emit) {
    let sawText = false;
    const lb = lineBuffer((line) => {
      const j = tryJson(line);
      if (!j || !j.event) return;
      if (j.event === 'init' && j.model) emit({ type: 'meta', model: j.model });
      else if (j.event === 'step_update') {
        if (j.conversation_id) emit({ type: 'session', id: j.conversation_id });
        if (j.step_type === 'agent_response' && j.text_delta) { sawText = true; emit({ type: 'text', text: j.text_delta }); }
        else if (j.step_type === 'tool' && j.state === 'ACTIVE' && j.tool_name) {
          const info = j.tool_info && (j.tool_info.command || j.tool_info.path || j.tool_info.file_path || j.tool_info.query);
          emit({ type: 'activity', text: info ? `${j.tool_name}: ${String(info).slice(0, 140)}` : j.tool_name });
        }
      } else if (j.event === 'result' && j.result) {
        const r = j.result;
        if (r.conversation_id) emit({ type: 'session', id: r.conversation_id });
        const u = r.usage || j.usage || r.usage_metadata;
        if (u) emit({ type: 'usage', input: u.input_tokens || u.prompt_token_count || u.promptTokenCount || 0, cached: u.cached_input_tokens || u.cached_content_token_count || 0, output: u.output_tokens || u.candidates_token_count || u.candidatesTokenCount || 0 });
        if (r.status === 'SUCCESS') emit({ type: 'final', text: r.response || '', isError: false });
        else { if (r.error) emit({ type: 'error', text: r.error }); emit({ type: 'final', text: sawText ? '' : (r.response || ''), isError: true }); }
      }
    });
    return { feed: lb.feed, end: lb.flush };
  },
};

function prettyGemini(id, display) {
  if (id === 'auto') return 'Gemini Auto';
  const s = String(display && display !== id ? display : id);
  return s.replace(/-/g, ' ').replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/^Gpt\b/, 'GPT');
}

const PROVIDERS = { claude, codex, gemini };

function credentialsPresent(p) {
  if ((p.authEnv || []).some((k) => process.env[k])) return true;
  return p.credentialFiles.some((f) => { try { return fs.statSync(f).size > 2; } catch (_) { return false; } });
}

module.exports = { PROVIDERS, credentialsPresent, lineBuffer, prettyGemini };
