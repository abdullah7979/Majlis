'use strict';
// Windows-only diagnostic: install Antigravity CLI exactly the way Majlis does (same command,
// same spawn code) into a folder whose path has Arabic letters and a space, like many real users.
const fs = require('fs');
const path = require('path');
const { run, which, augmentedEnv } = require('../../src/core/shell');
const { PROVIDERS } = require('../../src/core/providers');

(async () => {
  const root = path.join(process.env.RUNNER_TEMP || require('os').tmpdir(), 'عبدالله اللقماني', 'AppData', 'Local');
  fs.mkdirSync(root, { recursive: true });
  const env = augmentedEnv({ LOCALAPPDATA: root });
  const p = PROVIDERS.gemini;
  console.log('install command:', p.install.command, p.install.args.join(' '));
  const r = await run(p.install.command, p.install.args, { env, timeoutMs: 10 * 60e3, onStdout: (d) => process.stdout.write(d), onStderr: (d) => process.stdout.write('[err] ' + d) });
  console.log('\nexit code:', r.code);
  const exe = path.join(root, 'agy', 'bin', 'agy.exe');
  console.log('agy.exe exists at expected path:', fs.existsSync(exe), exe);
  const found = await which('agy', augmentedEnv({ LOCALAPPDATA: root }));
  console.log('which(agy):', found);
  if (found) { const v = await run(found, ['--version'], { env }); console.log('version:', v.stdout.trim(), v.stderr.trim()); }
  // list where things went
  const walk = (d, depth = 0) => { if (depth > 3) return; for (const n of fs.readdirSync(d)) { const f = path.join(d, n); console.log(' '.repeat(depth * 2) + n); if (fs.statSync(f).isDirectory()) walk(f, depth + 1); } };
  walk(root);
  process.exit(found ? 0 : 1);
})();
