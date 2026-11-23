'use strict';
const { Watcher, initProjectMemory, exportZip } = require('../core/workspace');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, Notification, session, net } = require('electron');
const { installAgy } = require('../core/installers');
const path = require('path');
const fs = require('fs');
const { Store } = require('../core/store');
const { Orchestrator } = require('../core/orchestrator');
const { PROVIDERS } = require('../core/providers');
const { run, openTerminal, augmentedEnv, which } = require('../core/shell');
const { CATEGORIES } = require('../core/defaults');
const { ApiServer } = require('../core/api-server');
const { Scheduler, nextRun } = require('../core/scheduler');
let apiServer = null, scheduler = null;
const toUi = (e) => { if (win && !win.isDestroyed()) win.webContents.send('chat:event', e); };
const notify = (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body: String(body || '').slice(0, 200) }).show(); } catch (_) {} };
async function applyApi() {
  const a = store.getSettings().api || {};
  try {
    if (a.enabled) { const r = await apiServer.start(); return { ok: true, ...r }; }
    await apiServer.stop(); return { ok: true };
  } catch (e) { return { ok: false, error: e.code === 'EADDRINUSE' ? 'port_in_use' : String(e.message || e) }; }
}

const SMOKE = process.argv.includes('--smoke-test');
const VOICE_SELFTEST = (process.argv.find((a) => a.startsWith('--voice-selftest=')) || '').slice('--voice-selftest='.length);
// Lets the speech model use several CPU threads when there is no usable graphics card.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

if (!SMOKE && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, tray = null, store, orch, quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 880, minHeight: 560,
    backgroundColor: '#0b0d12',
    title: 'Majlis',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!SMOKE) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', (e) => {
    if (!quitting && store.getSettings().closeToTray && tray) { e.preventDefault(); win.hide(); }
  });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); if (win.isMinimized()) win.restore(); win.focus(); win.webContents.send('app:focus-input'); }
}

function setupTray() {
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Majlis');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Majlis', click: () => { win.show(); win.focus(); } },
      { label: 'New conversation', click: () => { win.show(); win.webContents.send('app:new-conversation'); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', toggleWindow);
  } catch (_) { tray = null; }
}

function applySystemSettings() {
  const s = store.getSettings();
  globalShortcut.unregisterAll();
  if (s.globalShortcut) { try { globalShortcut.register(s.globalShortcut, toggleWindow); } catch (_) {} }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try { app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin }); } catch (_) {}
  }
}

function setupUpdater() {
  if (!app.isPackaged || SMOKE) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => win && win.webContents.send('app:update', { state: 'ready', version: info.version }));
    autoUpdater.on('update-available', (info) => win && win.webContents.send('app:update', { state: 'downloading', version: info.version }));
    autoUpdater.on('error', () => {});
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600e3);
    ipcMain.handle('app:install-update', () => { quitting = true; autoUpdater.quitAndInstall(true, true); }); // silent install, relaunch
  } catch (_) {}
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));

  h('app:info', () => ({ version: app.getVersion(), platform: process.platform, locale: app.getLocale(), dataDir: store.dir, categories: CATEGORIES, packaged: app.isPackaged,
    voiceSelftest: VOICE_SELFTEST ? { file: VOICE_SELFTEST, model: process.env.MAJLIS_ASR_MODEL || '', language: process.env.MAJLIS_ASR_LANG || 'auto' } : null }));
  h('app:selftest-result', (r) => {
    console.log('VOICE_SELFTEST ' + JSON.stringify(r));
    if (process.env.MAJLIS_SELFTEST_OUT) { try { fs.writeFileSync(process.env.MAJLIS_SELFTEST_OUT, JSON.stringify(r, null, 2), 'utf8'); } catch (_) {} }
    quitting = true; setTimeout(() => app.exit(r && r.ok ? 0 : 1), 200); return true;
  });
  h('settings:get', () => store.getSettings());
  h('settings:set', (patch) => { const s = store.updateSettings(patch); applySystemSettings(); return s; });
  h('settings:reset-routes', () => store.resetRoutes());

  h('conv:list', () => store.listConversations());
  h('conv:get', (id) => store.getConversation(id));
  h('conv:create', (opts) => store.createConversation(opts || {}));
  h('conv:delete', (id) => { orch.cancel(id); store.deleteConversation(id); return true; });
  h('conv:update', (id, patch) => {
    const c = store.getConversation(id); if (!c) return null;
    if (typeof patch.title === 'string') c.title = patch.title.slice(0, 120);
    if (typeof patch.workspace === 'string') c.workspace = patch.workspace;
    return store.saveConversation(c);
  });

  const startChat = (mode) => async ({ conversationId, text, files = [], force, smart, voice, allowRun }) => {
    const attachments = files.length ? store.importAttachments(conversationId, files.filter((f) => fs.existsSync(f))) : [];
    const emit = (e) => {
      if (win && !win.isDestroyed()) win.webContents.send('chat:event', e);
      if ((e.type === 'done' || e.type === 'failed') && win && !win.isFocused() && Notification.isSupported()) {
        new Notification({ title: 'Majlis', body: e.type === 'done' ? `${e.label} ✓` : '✖' }).show();
      }
    };
    const job = mode === 'council' ? orch.council({ conversationId, text, attachments, voice }, emit)
      : mode === 'compare' ? orch.council({ conversationId, text, attachments, voice, compare: true }, emit)
      : mode === 'project' ? orch.project({ conversationId, text, attachments, voice, allowRun: !!allowRun }, emit)
      : orch.send({ conversationId, text, attachments, force, smart, voice }, emit);
    job.catch((err) => win && win.webContents.send('chat:event', { conversationId, type: 'failed', error: String(err.message || err) }));
    return true;
  };
  h('chat:send', startChat('send'));
  h('chat:council', startChat('council'));
  h('chat:compare', startChat('compare'));
  h('chat:project', startChat('project'));
  h('voice:fix', (text, conversationId) => orch.fixTranscript(String(text || ''), { conversationId }));
  h('chat:improve', (text) => orch.improvePrompt(String(text || '')));

  // Local API (connect other systems)
  h('api:status', () => ({ ...apiServer.status(), key: apiServer.ensureKey(), settings: store.getSettings().api }));
  h('api:apply', () => applyApi());
  h('api:regenerate-key', () => apiServer.regenerateKey());
  // Calls the running API exactly like an outside system would (key + /v1/models), without spending any model quota.
  h('api:selftest', async () => {
    const st = apiServer.status();
    if (!st.running) return { ok: false, error: 'API is off' };
    const t0 = Date.now();
    try {
      const r = await net.fetch(`http://127.0.0.1:${st.port}/v1/models`, { headers: { Authorization: `Bearer ${apiServer.ensureKey()}` } });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      return { ok: true, models: j.data.length, ms: Date.now() - t0 };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // Automations (scheduled tasks)
  const autoList = () => scheduler.tasks().map((t) => ({ ...t, nextRun: t.enabled ? nextRun(t) : null, running: scheduler.running.has(t.id) }));
  h('auto:list', () => autoList());
  h('auto:save', (task) => { scheduler.upsert(task || {}); return autoList(); });
  h('auto:remove', (id) => { scheduler.remove(id); return autoList(); });
  h('auto:run', (id) => { scheduler.run(id); return true; });

  h('chat:undo', ({ conversationId, messageId }) => orch.undoChanges(conversationId, messageId));
  h('chat:cancel', (id) => { orch.cancel(id); return true; });
  h('chat:feedback', ({ category, provider, good, conversationId, messageId }) => {
    if (CATEGORIES.includes(category)) store.addFeedback(category, provider, good);
    const c = store.getConversation(conversationId);
    const m = c && c.messages.find((x) => x.id === messageId);
    if (m) { m.feedback = good ? 1 : -1; store.saveConversation(c); }
    return true;
  });

  h('providers:status', () => orch.providerStatus());
  h('providers:test', (id) => orch.test(id));
  h('providers:refresh-models', () => orch.refreshCatalog(true).then(() => true));
  h('providers:clear-cooldown', (id) => { store.clearCooldown(id); return true; });
  h('providers:login', (id) => {
    const p = PROVIDERS[id]; if (!p) return false;
    try { if (p.prepareLogin) p.prepareLogin(); } catch (_) {}
    openTerminal(p.loginCommand);
    return true;
  });

  h('providers:install', async (id) => {
    const p = PROVIDERS[id]; if (!p) return { ok: false, log: 'unknown provider' };
    const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('providers:install-log', { id, ...msg }); };
    if (p.install && p.install.native === 'agy') {
      const r = await installAgy({ fetch: (u, o) => net.fetch(u, o), onProgress: (pr) => send({ progress: pr }) });
      if (r.ok) await orch.refreshCatalog(true).catch(() => {});
      return { ok: r.ok, log: r.ok ? '' : r.error, stage: r.stage };
    }
    const npm = await which('npm', augmentedEnv());
    if (!npm) return { ok: false, reason: 'no_node' };
    const r = await run(npm, ['install', '-g', p.npmPackage], {
      timeoutMs: 10 * 60e3, onStdout: (d) => send({ text: d }), onStderr: (d) => send({ text: d }),
    });
    return { ok: r.code === 0, log: (r.stderr || r.stdout).slice(-1500) };
  });

  h('system:check-node', async () => {
    const env = augmentedEnv();
    const node = await which('node', env);
    if (!node) return { installed: false };
    const r = await run('node', ['--version'], { env, timeoutMs: 10000 });
    return { installed: true, version: r.stdout.trim() };
  });

  const wsWatcher = new Watcher((dir, snap) => { if (win && !win.isDestroyed()) win.webContents.send('ws:changed', { dir, files: snap.files, entry: snap.entry }); });
  h('api:log', () => apiServer.getLog());
  h('ws:open', (conversationId) => {
    const dir = orch.cwdFor(conversationId);
    const snap = wsWatcher.watch(dir);
    const { readProjectMemory } = require('../core/workspace');
    return { dir, files: snap.files, entry: snap.entry, hasRules: !!readProjectMemory(dir) };
  });
  h('ws:export-zip', (conversationId) => { const z = exportZip(orch.cwdFor(conversationId), app.getPath('downloads')); shell.showItemInFolder(z); return z; });
  h('ws:publish', (conversationId) => { const dir = orch.cwdFor(conversationId); shell.openExternal('https://app.netlify.com/drop'); shell.openPath(dir); return true; });
  h('conv:export-md', async (conversationId) => {
    const c = store.getConversation(conversationId); if (!c) return null;
    const md = [`# ${c.title || 'Majlis'}`, '', ...c.messages.map((m) => `## ${m.role === 'user' ? '🧑' : `🤖 ${m.providerLabel || 'Majlis'}${m.model ? ' · ' + m.model : ''}`}\n\n${m.text || ''}\n`)].join('\n');
    const f = path.join(app.getPath('downloads'), `${(c.title || 'majlis').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 50) || 'majlis'}.md`);
    fs.writeFileSync(f, md, 'utf8'); shell.showItemInFolder(f); return f;
  });
  h('stats:scoreboard', () => store.scoreboard());
  h('ws:close', () => { wsWatcher.stop(); return true; });
  h('ws:init-memory', (conversationId) => { const f = initProjectMemory(orch.cwdFor(conversationId)); shell.openPath(f); return f; });
  h('ws:open-external', (p) => { if (p && fs.existsSync(p)) shell.openPath(p); return true; });
  h('dialog:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('dialog:pick-files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  h('shell:open-external', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
  h('shell:open-path', (p) => { if (p && fs.existsSync(p)) shell.openPath(p); return true; });
  h('app:smoke-ok', () => {
    const cap = process.argv.find((a) => a.startsWith('--capture='));
    if (cap) { // dev: screenshot after optional JS, used for README / CI artifacts
      const js = process.env.MAJLIS_CAPTURE_JS || '';
      setTimeout(async () => {
        if (js) await win.webContents.executeJavaScript(js).catch((e) => console.error(e));
        setTimeout(async () => { fs.writeFileSync(cap.slice(10), (await win.webContents.capturePage()).toPNG()); app.exit(0); }, 1500);
      }, 800);
      return true;
    }
    if (SMOKE) { console.log('SMOKE_OK'); quitting = true; setTimeout(() => app.exit(0), 200); } return true; });
}

// ------------------------------------------------------------------ boot
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.abdullah7979.majlis');
  const dataDir = process.env.MAJLIS_DATA_DIR
    || (SMOKE ? fs.mkdtempSync(path.join(app.getPath('temp'), 'majlis-smoke-')) : path.join(app.getPath('userData'), 'data'));
  store = new Store(dataDir);
  // Microphone for voice input; nothing else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write');
  orch = new Orchestrator(store);
  apiServer = new ApiServer({ orch, store, version: app.getVersion(), onEvent: toUi });
  scheduler = new Scheduler({ store, orch, onEvent: toUi, onFinished: (task, msg) => {
    notify(`⏰ ${task.name}`, msg.status === 'done' ? (msg.text || '✓') : `✖ ${msg.error || ''}`);
    if (win && !win.isDestroyed()) win.webContents.send('auto:changed');
  } });
  registerIpc();
  createWindow();
  if (!SMOKE) { setupTray(); applySystemSettings(); setupUpdater(); applyApi(); scheduler.start(); }
  if (VOICE_SELFTEST) setTimeout(() => { console.error('VOICE_SELFTEST_TIMEOUT'); app.exit(1); }, 15 * 60e3);
  if (SMOKE) {
    setTimeout(() => { console.error('SMOKE_TIMEOUT'); app.exit(1); }, 45000);
    win.webContents.on('console-message', (...a) => { const msg = a[0] && a[0].message ? a[0].message : a[2]; if (/error/i.test(String(msg))) console.error('RENDERER:', msg); });
    win.webContents.on('preload-error', (_e, p, err) => { console.error('PRELOAD_ERROR', err); app.exit(1); });
    win.webContents.on('render-process-gone', () => { console.error('RENDERER_GONE'); app.exit(1); });
  }
});
