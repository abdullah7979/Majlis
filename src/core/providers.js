'use strict';
// Provider adapters. Each one knows how to:
//   - build CLI arguments for a model + autonomy level
//   - parse the CLI's streaming output into a small set of events
//   - tell whether it is installed / signed in, and how to install / sign in
//
// Every provider runs on the user's existing subscription through the vendor's
// official CLI. No API keys, no browser scraping.

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();

// Events emitted by parsers:
//   { type: 'text', text }        streamed answer text (append)
//   { type: 'activity', text }    tool use / progress line
//   { type: 'final', text, isError }  canonical final answer (replaces streamed text)
//   { type: 'meta', model }       model actually used, if the CLI reports it

/** Line-buffered JSONL parser helper. */
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

function describeTool(name, input = {}) {
  const target = input.file_path || input.path || input.command || input.pattern || input.url || input.query || '';
  return target ? `${name}: ${String(target).slice(0, 120)}` : name;
}

// ---------------------------------------------------------------- Claude Code
const claude = {
  id: 'claude',
  label: 'Claude',
  vendor: 'Anthropic',
  npmPackage: '@anthropic-ai/claude-code',
  bin: 'claude',
  loginCommand: 'claude',
  loginHint: 'login_hint_claude',
  credentialFiles: [path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude.json')],
  models: [
    { id: 'opus', label: 'Claude Opus' },
    { id: 'sonnet', label: 'Claude Sonnet' },
    { id: 'haiku', label: 'Claude Haiku' },
  ],
  buildArgs({ model, autonomy, optional = true }) {
    const a = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (optional) a.push('--include-partial-messages');
    if (model) a.push('--model', model);
    if (autonomy === 'full') a.push('--dangerously-skip-permissions');
    else if (autonomy === 'edit') a.push('--permission-mode', 'acceptEdits');
    else a.push('--permission-mode', 'default');
    return a;
  },
  createParser(emit) {
    let sawDelta = false;
    const lb = lineBuffer((line) => {
      let j;
      try { j = JSON.parse(line); } catch (_) { emit({ type: 'text', text: line + '\n' }); return; }
      if (j.type === 'system' && j.model) emit({ type: 'meta', model: j.model });
      else if (j.type === 'stream_event' && j.event) {
        const e = j.event;
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') { sawDelta = true; emit({ type: 'text', text: e.delta.text }); }
        if (e.type === 'message_stop') emit({ type: 'text', text: '\n' });
      } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
        for (const c of j.message.content) {
          if (c.type === 'text' && !sawDelta) emit({ type: 'text', text: c.text + '\n' });
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
const codex = {
  id: 'codex',
  label: 'ChatGPT',
  vendor: 'OpenAI Codex',
  npmPackage: '@openai/codex',
  bin: 'codex',
  loginCommand: 'codex login',
  loginHint: 'login_hint_codex',
  credentialFiles: [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')],
  models: [],
  buildArgs({ model, autonomy, outputFile, optional = true }) {
    const a = ['exec', '--skip-git-repo-check'];
    if (optional) a.push('--color', 'never');
    if (outputFile) a.push('--output-last-message', outputFile);
    if (model) a.push('-m', model);
    if (autonomy === 'full') a.push('--dangerously-bypass-approvals-and-sandbox');
    else if (autonomy === 'edit') a.push('--full-auto');
    else a.push('--sandbox', 'read-only');
    a.push('-');
    return a;
  },
  needsOutputFile: true,
  createParser(emit) {
    // Human-readable mode: answer + progress on stdout. We stream it and later
    // replace it with the clean final message read from --output-last-message.
    return { feed: (c) => emit({ type: 'text', text: c }), end() {} };
  },
  stderrToActivity: true,
};

// ---------------------------------------------------------------- Gemini CLI
const gemini = {
  id: 'gemini',
  label: 'Gemini',
  vendor: 'Google',
  npmPackage: '@google/gemini-cli',
  bin: 'gemini',
  loginCommand: 'gemini',
  loginHint: 'login_hint_gemini',
  credentialFiles: [path.join(home, '.gemini', 'oauth_creds.json'), path.join(home, '.gemini', 'google_accounts.json')],
  models: [
    { id: 'gemini-2.5-pro', label: 'Gemini Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini Flash' },
  ],
  buildArgs({ model, autonomy, optional = true }) {
    const a = [];
    if (model) a.push('-m', model);
    if (autonomy === 'full') a.push('--yolo');
    else if (autonomy === 'edit' && optional) a.push('--approval-mode', 'auto_edit');
    return a;
  },
  createParser(emit) {
    return { feed: (c) => emit({ type: 'text', text: c }), end() {} };
  },
  stderrToActivity: false,
};

const PROVIDERS = { claude, codex, gemini };

function credentialsPresent(p) {
  return p.credentialFiles.some((f) => { try { return fs.statSync(f).size > 2; } catch (_) { return false; } });
}

module.exports = { PROVIDERS, credentialsPresent, lineBuffer };
