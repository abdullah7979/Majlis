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
  chat: { send: invoke('chat:send'), cancel: invoke('chat:cancel'), feedback: invoke('chat:feedback'), onEvent: on('chat:event') },
  providers: {
    status: invoke('providers:status'), test: invoke('providers:test'), login: invoke('providers:login'),
    install: invoke('providers:install'), clearCooldown: invoke('providers:clear-cooldown'), onInstallLog: on('providers:install-log'),
  },
  system: { checkNode: invoke('system:check-node') },
  dialog: { pickFolder: invoke('dialog:pick-folder'), pickFiles: invoke('dialog:pick-files') },
  shell: { openExternal: invoke('shell:open-external'), openPath: invoke('shell:open-path') },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return file.path || ''; } },
});
