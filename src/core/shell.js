'use strict';
// Cross-platform process helpers. On Windows, npm-installed CLIs are .cmd shims,
// which Node can only launch through cmd.exe — so we use shell:true there and
// quote arguments ourselves. On macOS/Linux we spawn directly (no shell).

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

/** PATH augmented with the usual places npm puts global binaries. */
function augmentedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const dirs = (env[key] || '').split(path.delimiter).filter(Boolean);
  const add = [];
  if (isWin) {
    if (env.APPDATA) add.push(path.join(env.APPDATA, 'npm'));
    if (env.ProgramFiles) add.push(path.join(env.ProgramFiles, 'nodejs'));
    if (env.LOCALAPPDATA) add.push(path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
  } else {
    const home = os.homedir();
    add.push('/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin'),
      path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'));
  }
  for (const d of add) if (!dirs.includes(d)) dirs.push(d);
  env[key] = dirs.join(path.delimiter);
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  env.CI = env.CI || '';
  return env;
}

/** Quote one argument for cmd.exe (Windows) — only used with shell:true. */
function quoteWin(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/**
 * Run a command, streaming output. Resolves (never rejects) with
 * { code, stdout, stderr, error, cancelled, timedOut }.
 */
function run(command, args, opts = {}) {
  const { cwd, input, env, onStdout, onStderr, timeoutMs, signal } = opts;
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, cancelled = false, timedOut = false, child;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, error, cancelled, timedOut });
    };
    try {
      if (isWin) {
        const line = [quoteWin(command), ...args.map(quoteWin)].join(' ');
        child = spawn(line, [], { cwd, env: env || augmentedEnv(), shell: true, windowsHide: true });
      } else {
        child = spawn(command, args, { cwd, env: env || augmentedEnv(), detached: true });
      }
    } catch (e) {
      return finish(-1, e);
    }
    const onAbort = () => { cancelled = true; killTree(child); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; onStdout && onStdout(d); });
    child.stderr.on('data', (d) => { stderr += d; onStderr && onStderr(d); });
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code == null ? -1 : code));
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch (_) {
    try { child.kill(); } catch (__) {}
  }
}

/** Locate an executable on PATH. Resolves to the full path or null. */
function which(name, env = augmentedEnv()) {
  return new Promise((resolve) => {
    const tool = isWin ? 'where' : 'which';
    execFile(tool, [name], { env, windowsHide: true }, (err, out) => {
      if (err || !out) return resolve(null);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pick = isWin ? (lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) || lines[0]) : lines[0];
      resolve(pick && fs.existsSync(pick) ? pick : null);
    });
  });
}

/** Open a visible terminal window running `commandLine` (for interactive logins). */
function openTerminal(commandLine, cwd) {
  const env = augmentedEnv();
  if (isWin) {
    spawn('cmd.exe', ['/c', 'start', '"Majlis"', 'cmd.exe', '/k', commandLine],
      { cwd, env, detached: true, windowsHide: false, windowsVerbatimArguments: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(commandLine)}`;
    spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', 'bash', '-lc', `${commandLine}; exec bash`], { cwd, env, detached: true, stdio: 'ignore' }).unref();
  }
}

module.exports = { run, which, openTerminal, augmentedEnv, quoteWin, isWin, killTree };
