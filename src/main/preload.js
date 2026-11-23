'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => {
  const l = (_e, d) => fn(d);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
};

contextBridge.exposeInMainWorld('majlis', {
  info: invoke('app:info'),
  smokeOk: invoke('app:smoke-ok'),
  installUpdate: invoke('app:install-update'),
  onUpdate: on('app:update'),
  onFocusInput: on('app:focus-input'),
  onNewConversation: on('app:new-conversation'),

  settings: { get: invoke('settings:get'), set: invoke('settings:set'), resetRoutes: invoke('settings:reset-routes') },
  conv: { list: invoke('conv:list'), get: invoke('conv:get'), create: invoke('conv:create'), remove: invoke('conv:delete'), update: invoke('conv:update') },
  chat: { send: invoke('chat:send'), council: invoke('chat:council'), compare: invoke('chat:compare'), project: invoke('chat:project'), undo: invoke('chat:undo'), improve: invoke('chat:improve'), cancel: invoke('chat:cancel'), feedback: invoke('chat:feedback'), onEvent: on('chat:event') },
  providers: {
    status: invoke('providers:status'), test: invoke('providers:test'), refreshModels: invoke('providers:refresh-models'), login: invoke('providers:login'),
    install: invoke('providers:install'), clearCooldown: invoke('providers:clear-cooldown'), onInstallLog: on('providers:install-log'),
  },
  voice: { fix: invoke('voice:fix'), cloud: invoke('voice:cloud') },
  api: { log: invoke('api:log'), status: invoke('api:status'), apply: invoke('api:apply'), regenerateKey: invoke('api:regenerate-key'), selftest: invoke('api:selftest') },
  auto: { list: invoke('auto:list'), save: invoke('auto:save'), remove: invoke('auto:remove'), run: invoke('auto:run'), onChanged: on('auto:changed') },
  system: { checkNode: invoke('system:check-node') },
  selftestResult: invoke('app:selftest-result'),
  ws: { exportZip: invoke('ws:export-zip'), publish: invoke('ws:publish'), open: invoke('ws:open'), close: invoke('ws:close'), initMemory: invoke('ws:init-memory'), openPath: invoke('ws:open-external'), onChanged: on('ws:changed') },
  file: { read: invoke('file:read'), saveAs: invoke('file:save-as') },
  conv2: { exportMd: invoke('conv:export-md') },
  stats: { scoreboard: invoke('stats:scoreboard') },
  dialog: { pickFolder: invoke('dialog:pick-folder'), pickFiles: invoke('dialog:pick-files') },
  shell: { openExternal: invoke('shell:open-external'), openPath: invoke('shell:open-path') },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return file.path || ''; } },
});
