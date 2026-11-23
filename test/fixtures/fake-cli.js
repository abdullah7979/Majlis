#!/usr/bin/env node
'use strict';
// Strict stand-ins for claude / codex / gemini, modelled on the real CLIs
// (Claude Code 2.1.x, Codex 0.171, Antigravity CLI agy 1.5.14 — verified on Windows):
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
const MODELS = { claude: ['fable', 'opus', 'sonnet', 'haiku'], agy: ['gemini-3.8-flash-medium', 'gemini-3.8-flash-lite', 'gemini-4-pro-high'], codex: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.5'] };

function die(msg, code = 2) { process.stderr.write(msg + '\n'); process.exit(code); }

const SPECS = {
  claude: { bool: ['-p', '--print', '--verbose', '--include-partial-messages'], value: { '--output-format': ['text', 'json', 'stream-json'], '--model': null, '--resume': null, '--permission-mode': ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'], '--effort': ['low', 'medium', 'high', 'xhigh', 'max'] } },
  codex: { bool: ['--skip-git-repo-check', '--json', '--dangerously-bypass-approvals-and-sandbox', '--last', '--ephemeral'], value: { '--output-last-message': null, '-o': null, '-m': null, '--model': null, '-c': null, '--config': null } },
  agy: { bool: ['--dangerously-skip-permissions', '--disable-slash-commands', '-c', '--continue', '--sandbox', '--new-project'], value: { '-p': null, '--print': null, '--prompt': null, '--input-format': ['text', 'stream-json'], '--output-format': ['text', 'json', 'stream-json'], '--model': null, '--mode': null, '--conversation': null, '--effort': ['low', 'medium', 'high', 'xhigh', 'max'], '--print-timeout': null, '--project': null } },
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

if (argv[0] === '--version' || argv[0] === '-v') { console.log(name === 'codex' ? 'codex-cli 0.171.0' : name === 'claude' ? '2.1.330 (Claude Code)' : '1.5.14'); process.exit(0); }
if (name === 'codex' && argv[0] === 'debug' && argv[1] === 'models') {
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list', priority: 1 },
    { slug: 'gpt-6.2-astra', display_name: 'GPT-6.2-Astra', visibility: 'list', priority: 2 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 13 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
  ] }));
  process.exit(0);
}
if (name === 'agy' && argv[0] === 'models') {
  console.log('Fetching available models...');
  if (mode === 'auth') { console.log('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.'); process.exit(1); }
  console.log('Available models:'); for (const m of MODELS.agy) console.log(`  ${m}${m.includes('medium') ? '  (default)' : ''}`);
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
  if (name === 'agy') {
    resume = flags['--conversation'] || null;
    if (flags['--mode'] && !['accept-edits', 'auto', 'plan'].includes(flags['--mode'])) process.stderr.write(`warning: unrecognized --mode value "${flags['--mode']}" (valid: accept-edits, auto, plan)\n`);
    if (flags['--input-format'] === 'stream-json') {
      if (flags['--output-format'] !== 'stream-json') die('error: --input-format stream-json requires --output-format stream-json');
      const lines = input.split('\n').filter((l) => l.trim());
      if (!lines.length) die('error: empty prompt', 1);
      let msg; try { msg = JSON.parse(lines[0]); } catch (_) { die('error: invalid JSON on stdin', 1); }
      if (msg.event !== 'user') die('error: missing event field', 1);
      input = msg.message.content;
    } else if (!flags['-p'] && !flags['--print']) die('fake: interactive mode not supported');
  }

  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args: argv, cwd: process.cwd(), input }) + '\n');

  // Real-CLI requirements (these are what broke v0.2 on a real PC):
  if (name === 'claude' && !flags['-p'] && !flags['--print']) die('fake: interactive mode not supported');
  if (name === 'claude' && flags['--output-format'] === 'stream-json' && !flags['--verbose']) die('Error: When using --print, --output-format=stream-json requires --verbose');

  if (name === 'codex' && !flags['--skip-git-repo-check']) die('Not inside a trusted directory and --skip-git-repo-check was not specified.', 1);

  const model = flags['--model'] || flags['-m'] || '';
  const fullInput = input;
  const tail = fullInput.trim().split('\n').pop();

  if (name === 'agy' && mode === 'auth') {
    // real agy: prints a URL and blocks for 60 s waiting for the browser sign-in
    process.stderr.write('Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x=1\n\nWaiting for authentication (timeout 60s)...\n');
    setTimeout(() => { console.log(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out' } })); process.exit(1); }, 60000);
    return;
  }
  if (mode === 'limit') {
    if (name === 'claude') { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached. Your limit will reset at 5pm.' })); process.exit(1); }
    if (name === 'codex') { console.log(JSON.stringify({ type: 'thread.started', thread_id: uuid() })); console.log(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 2 hours." } })); process.exit(1); }
    console.log(JSON.stringify({ event: 'result', result: { conversation_id: uuid(), status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: You have exhausted your quota. Please retry in 34s.' } })); process.exit(1);
  }
  if (mode === 'auth') die('Error: Not logged in. Please run /login', 1);
  if (mode === 'slow') { setTimeout(() => console.log('late'), 60000); return; }
  if ((mode === 'badmodel' && model) || (model && !MODELS[name].includes(model))) {
    if (name === 'codex') { console.log(JSON.stringify({ type: 'turn.failed', error: { message: `The model \`${model}\` does not exist or you do not have access to it.` } })); process.exit(1); }
    if (name === 'agy') { console.log(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: `unknown model "${model}": model not found` } })); process.exit(1); }
    die(`API Error: model "${model}" not found`, 1);
  }

  let sid = resume, turns = 0;
  if (resume) {
    if (!sessions[resume]) {
      if (name === 'agy') { console.log(JSON.stringify({ event: 'result', result: { conversation_id: resume, status: 'ERROR', response: '', error: `conversation ${resume} not found` } })); process.exit(1); }
      if (name === 'claude') { console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}` })); process.exit(1); }
      die(`Error: thread ${resume} not found`, 1);
    }
    turns = sessions[resume].length;
  } else sid = uuid();
  sessions[sid] = [...(sessions[sid] || []), tail];
  saveSessions();

  // Side effects that real agents have: editing files, generating images.
  if (/EDIT_FILES/.test(fullInput)) {
    fs.writeFileSync(path.join(process.cwd(), 'new.txt'), 'created by agent');
    fs.appendFileSync(path.join(process.cwd(), 'a.txt'), '\nchanged by agent');
  }
  if (/wants a real image/.test(fullInput)) {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400)]);
    if (name === 'codex') {
      const dir = path.join(process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex'), 'generated_images', sid || 'x');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ig_1.png'), png);
    } else fs.writeFileSync(path.join(process.cwd(), 'image_1.png'), png);
  }
  let answer;
  const at = fullInput.match(/^@(\S+)/m);
  if (/Transcribe the speech/.test(fullInput)) {
    if (!at || !fs.existsSync(at[1])) die('file not found in workspace', 1);
    answer = process.env.FAKE_TRANSCRIPT || 'Here is the transcript: "ابني لي صفحة هبوط لمطعمي"';
  } else if (/You correct speech-to-text errors/.test(fullInput) && process.env[`FAKE_REPLY_${name}`]) {
    answer = process.env[`FAKE_REPLY_${name}`];
  } else if (/You maintain a short memory/.test(fullInput) && process.env[`FAKE_REPLY_${name}`]) {
    answer = process.env[`FAKE_REPLY_${name}`];
  } else if (/You are the lead engineer/.test(fullInput)) {
    answer = process.env.FAKE_PLAN || '{"title":"موقع تجريبي","steps":[{"title":"الهيكل","detail":"index.html"},{"title":"التنسيق","detail":"style.css"}],"verify":"node -v"}';
  } else if (/You are building a project step by step/.test(fullInput)) {
    const m = /Now do ONLY step (\d+)/.exec(fullInput);
    if (m && m[1] === '1') fs.writeFileSync(path.join(process.cwd(), 'index.html'), '<!doctype html><title>t</title><h1>hello</h1>');
    else fs.writeFileSync(path.join(process.cwd(), `step${m ? m[1] : 'x'}.css`), 'h1{color:#c60}');
    if (process.env.FAKE_STEP_DELAY) { const t = Date.now(); while (Date.now() - t < +process.env.FAKE_STEP_DELAY); }
    answer = `done step ${m ? m[1] : '?'}`;
  } else if (/Prove that it really works|PROVE it works/.test(fullInput)) {
    answer = 'VERIFIED\nall good';
  } else if (/You are a strict senior reviewer/.test(fullInput)) {
    answer = process.env.FAKE_REVIEW || 'LGTM';
  } else if (/An independent reviewer found these problems/.test(fullInput)) {
    answer = 'fixed';
  } else if (/You are a router/.test(fullInput)) {
    answer = `{"category":"${process.env.FAKE_CLASSIFY || 'quick'}","reason":"fake"}`;
  } else {
    answer = `${name.toUpperCase()}[${model || 'default'}${resume ? `|turn ${turns + 1}` : ''}]: ${tail}`;
  }

  if (name === 'claude') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, model: model || 'claude-sonnet' }));
    console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } }));
    console.log(JSON.stringify({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.js' } }] } }));
    for (const part of [answer.slice(0, 5), answer.slice(5)]) console.log(JSON.stringify({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sid, usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 3000, output_tokens: 45 } }));
  } else if (name === 'codex') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: sid }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls -la' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: answer } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 } }));
    const out = flags['--output-last-message'] || flags['-o'];
    if (out) fs.writeFileSync(out, answer, 'utf8');
  } else {
    console.log(JSON.stringify({ event: 'init', cwd: process.cwd(), tools: ['read_file'], permission_mode: flags['--mode'] || 'auto', model: model || 'gemini-3.8-flash-medium' }));
    console.log(JSON.stringify({ event: 'step_update', conversation_id: sid, step_index: 0, state: 'DONE', step_type: 'user_input' }));
    console.log(JSON.stringify({ event: 'step_update', conversation_id: sid, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { path: 'notes.txt' } }));
    for (const part of [answer.slice(0, 4), answer.slice(4)]) console.log(JSON.stringify({ event: 'step_update', conversation_id: sid, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: part }));
    console.log(JSON.stringify({ event: 'result', result: { conversation_id: sid, status: 'SUCCESS', response: answer, duration_seconds: 0.1, num_turns: 1 } }));
  }
}
