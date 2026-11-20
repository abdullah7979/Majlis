#!/usr/bin/env node
'use strict';
// Stand-in for claude / codex / gemini during tests. Behaviour is chosen with
// env vars:  FAKE_MODE_<name> = ok | limit | auth | badmodel | badflag | slow
//            FAKE_CLASSIFY    = category returned when asked to classify
// Every call is appended to FAKE_LOG as JSON (name, args, cwd, stdin).
const fs = require('fs');
const name = process.argv[2];
const args = process.argv.slice(3);
const mode = process.env[`FAKE_MODE_${name}`] || 'ok';

if (args[0] === '--version') { console.log(`${name} 9.9.9`); process.exit(0); }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', main);

function arg(flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }

function main() {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args, cwd: process.cwd(), input }) + '\n');
  const model = arg('--model') || arg('-m') || '';
  const tail = input.trim().split('\n').pop();

  if (input.includes('Transcribe the speech')) {
    const m = input.match(/^@(\S+)/);
    if (!m || !fs.existsSync(m[1])) { console.error('file not found in cwd'); process.exit(1); }
    console.log(process.env.FAKE_TRANSCRIPT || 'Here is the transcript: "ابني لي صفحة هبوط لمطعمي"');
    return;
  }
  if (input.includes('You are a router')) {
    console.log(`{"category":"${process.env.FAKE_CLASSIFY || 'quick'}","reason":"fake"}`);
    return;
  }
  if (mode === 'limit') {
    if (name === 'claude') {
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached. Your limit will reset at 5pm.' }));
      process.exit(1);
    }
    console.error('Error: You have hit your usage limit. Try again in 2 hours.');
    process.exit(1);
  }
  if (mode === 'auth') { console.error('Error: Not logged in. Please run login.'); process.exit(1); }
  if (mode === 'badmodel' && model) { console.error(`Error: model "${model}" not found`); process.exit(1); }
  if (mode === 'badflag' && (args.includes('--include-partial-messages') || args.includes('--color') || args.includes('--approval-mode'))) {
    console.error("error: unknown option '--include-partial-messages'"); process.exit(2);
  }
  if (mode === 'slow') { setTimeout(() => console.log('late'), 60000); return; }

  const answer = `${name.toUpperCase()}[${model || 'default'}]: ${tail}`;
  if (name === 'claude') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: model || 'claude-default' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.js' } }] } }));
    for (const part of [answer.slice(0, 5), answer.slice(5)]) {
      console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } }));
    }
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer }));
  } else if (name === 'codex') {
    console.log('[progress] thinking...');
    console.error('exec: ls');
    const out = arg('--output-last-message');
    if (out) fs.writeFileSync(out, answer, 'utf8');
    else console.log(answer);
  } else {
    console.log(answer);
  }
}
