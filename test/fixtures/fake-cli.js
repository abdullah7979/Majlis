#!/usr/bin/env node
'use strict';
// Strict stand-ins for claude / codex / gemini, modelled on the real CLIs
// (Claude Code 2.1.x, Codex 0.171, Gemini CLI 0.70):
//   - unknown flags and invalid choices are rejected exactly like the real tools do
//   - output uses the real JSON event formats
//   - sessions are remembered so --resume / exec resume can be tested
// Behaviour per tool via env: FAKE_MODE_<name> = ok | limit | auth | badmodel | slow
//                             FAKE_CLASSIFY = category returned when asked to route
//                             FAKE_TRANSCRIPT = text returned for audio transcription
// Every call is appended to FAKE_LOG as JSON (name, args, cwd, input).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const name = process.argv[2];
const argv = process.argv.slice(3);
const mode = process.env[`FAKE_MODE_${name}`] || 'ok';
const MODELS = { claude: ['fable', 'opus', 'sonnet', 'haiku'], gemini: ['auto', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'], codex: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.5'] };

function die(msg, code = 2) { process.stderr.write(msg + '\n'); process.exit(code); }

const SPECS = {
  claude: { bool: ['-p', '--print', '--verbose', '--include-partial-messages'], value: { '--output-format': ['text', 'json', 'stream-json'], '--model': null, '--resume': null, '--permission-mode': ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'], '--effort': ['low', 'medium', 'high', 'xhigh', 'max'] } },
  codex: { bool: ['--skip-git-repo-check', '--json', '--dangerously-bypass-approvals-and-sandbox', '--last', '--ephemeral'], value: { '--output-last-message': null, '-o': null, '-m': null, '--model': null, '-c': null, '--config': null } },
  gemini: { bool: ['--skip-trust', '-y', '--yolo'], value: { '-p': null, '--prompt': null, '-o': ['text', 'json', 'stream-json'], '--output-format': ['text', 'json', 'stream-json'], '-m': null, '--model': null, '--approval-mode': ['default', 'auto_edit', 'yolo', 'plan'], '--resume': null, '-r': null } },
};
function parse(spec, args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-') { pos.push(a); continue; }
    if (a.startsWith('-')) {
      if (spec.bool.includes(a)) { flags[a] = true; continue; }
      if (a in spec.value) {
        const v = args[++i];
        if (v === undefined) die(`error: option '${a}' argument missing`);
        const choices = spec.value[a];
        if (choices && !choices.includes(v)) die(`error: option '${a} <value>' argument '${v}' is invalid. Allowed choices are ${choices.join(', ')}.`);
        flags[a] = v; continue;
      }
      if (name === 'codex') die(`error: unexpected argument '${a}' found\n\n  tip: to pass '${a}' as a value, use '-- ${a}'\n\nUsage: codex exec [OPTIONS] [PROMPT]`);
      die(name === 'claude' ? `error: unknown option '${a}'` : `Unknown arguments: ${a.replace(/^-+/, '')}`);
    }
    pos.push(a);
  }
  return { flags, pos };
}

const sessDir = process.env.FAKE_LOG ? path.dirname(process.env.FAKE_LOG) : require('os').tmpdir();
const sessFile = path.join(sessDir, `sessions-${name}.json`);
const sessions = (() => { try { return JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch (_) { return {}; } })();
const saveSessions = () => fs.writeFileSync(sessFile, JSON.stringify(sessions));
const uuid = () => crypto.randomUUID();

if (argv[0] === '--version' || argv[0] === '-v') { console.log(name === 'codex' ? 'codex-cli 0.171.0' : name === 'claude' ? '2.1.330 (Claude Code)' : '0.70.0'); process.exit(0); }
if (name === 'codex' && argv[0] === 'debug' && argv[1] === 'models') {
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list', priority: 1 },
    { slug: 'gpt-6.2-astra', display_name: 'GPT-6.2-Astra', visibility: 'list', priority: 2 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 13 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
  ] }));
  process.exit(0);
}
if (name === 'gemini' && argv[0] === 'models') {
  console.log(JSON.stringify(MODELS.gemini.map((id) => ({ id, modelId: id, displayName: id === 'auto' ? 'Auto' : id }))));
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', main);

function main() {
  let args = argv, resume = null, codexResume = false;
  if (name === 'codex') {
    if (args[0] !== 'exec') die('this fake only supports codex exec');
    args = args.slice(1);
    if (args[0] === 'resume') { args = args.slice(1); codexResume = true; }
  }
  const { flags, pos } = parse(SPECS[name], args);
  if (codexResume) { resume = pos.find((x) => x !== '-') || null; if (!resume) die('error: resume needs a session id'); }
  if (name === 'claude') resume = flags['--resume'] || null;
  if (name === 'gemini') resume = flags['--resume'] || flags['-r'] || null;

  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args: argv, cwd: process.cwd(), input }) + '\n');

  // Real-CLI requirements (these are what broke v0.2 on a real PC):
  if (name === 'claude' && !flags['-p'] && !flags['--print']) die('fake: interactive mode not supported');
  if (name === 'claude' && flags['--output-format'] === 'stream-json' && !flags['--verbose']) die('Error: When using --print, --output-format=stream-json requires --verbose');
  if (name === 'gemini' && !('-p' in flags || '--prompt' in flags)) die('fake: gemini needs -p for headless mode');
  if (name === 'gemini' && !flags['--skip-trust'] && process.env.GEMINI_CLI_TRUST_WORKSPACE !== 'true') {
    die('Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, set the `GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory in interactive mode.', 55);
  }
  if (name === 'codex' && !flags['--skip-git-repo-check']) die('Not inside a trusted directory and --skip-git-repo-check was not specified.', 1);

  const model = flags['--model'] || flags['-m'] || '';
  const fullInput = input + (name === 'gemini' && flags['-p'] ? flags['-p'] : '');
  const tail = fullInput.trim().split('\n').pop();

  if (mode === 'limit') {
    if (name === 'claude') { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached. Your limit will reset at 5pm.' })); process.exit(1); }
    if (name === 'codex') { console.log(JSON.stringify({ type: 'thread.started', thread_id: uuid() })); console.log(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 2 hours." } })); process.exit(1); }
    console.log(JSON.stringify({ type: 'result', status: 'error', error: { type: 'QuotaError', message: 'RESOURCE_EXHAUSTED: quota exceeded' } })); process.exit(1);
  }
  if (mode === 'auth') die('Error: Not logged in. Please run /login', 1);
  if (mode === 'slow') { setTimeout(() => console.log('late'), 60000); return; }
  if ((mode === 'badmodel' && model) || (model && !MODELS[name].includes(model))) {
    if (name === 'codex') { console.log(JSON.stringify({ type: 'turn.failed', error: { message: `The model \`${model}\` does not exist or you do not have access to it.` } })); process.exit(1); }
    die(`API Error: model "${model}" not found`, 1);
  }

  let sid = resume, turns = 0;
  if (resume) {
    if (!sessions[resume]) {
      if (name === 'gemini') die(`Invalid session identifier "${resume}". Use --list-sessions to see available sessions.`, 1);
      if (name === 'claude') { console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}` })); process.exit(1); }
      die(`Error: thread ${resume} not found`, 1);
    }
    turns = sessions[resume].length;
  } else sid = uuid();
  sessions[sid] = [...(sessions[sid] || []), tail];
  saveSessions();

  let answer;
  const at = fullInput.match(/^@(\S+)/m);
  if (/Transcribe the speech/.test(fullInput)) {
    if (!at || !fs.existsSync(at[1])) die('file not found in workspace', 1);
    answer = process.env.FAKE_TRANSCRIPT || 'Here is the transcript: "ابني لي صفحة هبوط لمطعمي"';
  } else if (/You are a router/.test(fullInput)) {
    answer = `{"category":"${process.env.FAKE_CLASSIFY || 'quick'}","reason":"fake"}`;
  } else {
    answer = `${name.toUpperCase()}[${model || 'default'}${resume ? `|turn ${turns + 1}` : ''}]: ${tail}`;
  }

  if (name === 'claude') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, model: model || 'claude-sonnet' }));
    console.log(JSON.stringify({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.js' } }] } }));
    for (const part of [answer.slice(0, 5), answer.slice(5)]) console.log(JSON.stringify({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sid }));
  } else if (name === 'codex') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: sid }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls -la' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: answer } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }));
    const out = flags['--output-last-message'] || flags['-o'];
    if (out) fs.writeFileSync(out, answer, 'utf8');
  } else {
    console.log(JSON.stringify({ type: 'init', session_id: sid, model: model || 'auto' }));
    console.log(JSON.stringify({ type: 'message', role: 'user', content: fullInput.slice(0, 20) }));
    console.log(JSON.stringify({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: 'notes.txt' } }));
    for (const part of [answer.slice(0, 4), answer.slice(4)]) console.log(JSON.stringify({ type: 'message', role: 'assistant', content: part, delta: true }));
    console.log(JSON.stringify({ type: 'result', status: 'success', stats: {} }));
  }
}
