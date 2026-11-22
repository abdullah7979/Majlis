'use strict';
// Before/after snapshots of a project folder, so every change a model makes can be listed and undone.
// Uses a private ("shadow") git repository kept in Majlis's data folder — the project's own .git,
// if any, is never touched. Needs git on the PC; without it this feature quietly turns itself off.

const fs = require('fs');
const path = require('path');
const { run, which, augmentedEnv } = require('./shell');

const EXCLUDES = ['.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', '.next/', '.gradle/', '.idea/', 'target/', '*.log', '.DS_Store', 'Thumbs.db'];
const LIMIT_MS = 60000;

class Snapshots {
  constructor(dir) {
    this.dir = path.join(dir, 'snapshots');
    this.git = undefined;
  }

  async available() {
    if (this.git === undefined) this.git = await which('git');
    return !!this.git;
  }

  repo(conversationId) { return path.join(this.dir, `${conversationId}.git`); }

  async g(conversationId, workspace, args, extra = {}) {
    const env = augmentedEnv({
      GIT_DIR: this.repo(conversationId), GIT_WORK_TREE: workspace,
      GIT_AUTHOR_NAME: 'Majlis', GIT_AUTHOR_EMAIL: 'majlis@localhost', GIT_COMMITTER_NAME: 'Majlis', GIT_COMMITTER_EMAIL: 'majlis@localhost',
    });
    return run(this.git, ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...args], { cwd: workspace, env, timeoutMs: LIMIT_MS, ...extra });
  }

  async ensure(conversationId, workspace) {
    const repo = this.repo(conversationId);
    if (fs.existsSync(path.join(repo, 'HEAD'))) return true;
    fs.mkdirSync(this.dir, { recursive: true });
    const r = await this.g(conversationId, workspace, ['init', '--quiet']);
    if (r.code !== 0) return false;
    fs.mkdirSync(path.join(repo, 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'info', 'exclude'), EXCLUDES.join('\n') + '\n');
    return true;
  }

  async commit(conversationId, workspace, message) {
    let r = await this.g(conversationId, workspace, ['add', '-A']);
    if (r.code !== 0) return null;
    r = await this.g(conversationId, workspace, ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', message]);
    if (r.code !== 0) return null;
    r = await this.g(conversationId, workspace, ['rev-parse', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Record the folder as it is now. Returns a snapshot id or null. */
  async before(conversationId, workspace) {
    try {
      if (!workspace || !(await this.available()) || !(await this.ensure(conversationId, workspace))) return null;
      return await this.commit(conversationId, workspace, 'before');
    } catch (_) { return null; }
  }

  /** Record the result and list what changed since `base`: [{ status: 'A'|'M'|'D', path }] */
  async after(conversationId, workspace, base) {
    try {
      if (!base) return null;
      const head = await this.commit(conversationId, workspace, 'after');
      if (!head) return null;
      const r = await this.g(conversationId, workspace, ['diff', '--name-status', '--no-renames', base, head]);
      if (r.code !== 0) return null;
      const files = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status: status[0], path: p.join('\t') }; });
      return { base, head, files };
    } catch (_) { return null; }
  }

  /** Put the changed files back the way they were at `base` (only those files). */
  async undo(conversationId, workspace, changes) {
    if (!changes || !changes.files || !changes.files.length) return { ok: true, restored: 0 };
    let restored = 0;
    const errors = [];
    for (const f of changes.files) {
      const abs = path.join(workspace, f.path);
      if (!abs.startsWith(path.resolve(workspace))) continue;
      if (f.status === 'A') {
        try { fs.rmSync(abs, { force: true }); restored++; } catch (e) { errors.push(f.path); }
      } else {
        const r = await this.g(conversationId, workspace, ['checkout', changes.base, '--', f.path]);
        if (r.code === 0) restored++; else errors.push(f.path);
      }
    }
    await this.commit(conversationId, workspace, 'undo');
    return { ok: errors.length === 0, restored, errors };
  }
}

module.exports = { Snapshots };
