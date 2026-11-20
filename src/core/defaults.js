'use strict';

// Task categories and the default route (ordered fallback chain) for each.
// model '' means "the CLI's own default model".
const CATEGORIES = ['code_heavy', 'code', 'image', 'research', 'writing', 'realtime', 'quick'];

const DEFAULT_ROUTES = {
  code_heavy: [{ provider: 'claude', model: 'opus' }, { provider: 'codex', model: '' }, { provider: 'gemini', model: 'gemini-2.5-pro' }],
  code: [{ provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: '' }, { provider: 'gemini', model: 'gemini-2.5-pro' }],
  image: [{ provider: 'codex', model: '' }, { provider: 'gemini', model: 'gemini-2.5-pro' }, { provider: 'claude', model: 'sonnet' }],
  research: [{ provider: 'gemini', model: 'gemini-2.5-pro' }, { provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: '' }],
  writing: [{ provider: 'claude', model: 'sonnet' }, { provider: 'gemini', model: 'gemini-2.5-pro' }, { provider: 'codex', model: '' }],
  realtime: [{ provider: 'gemini', model: 'gemini-2.5-pro' }, { provider: 'codex', model: '' }, { provider: 'claude', model: 'sonnet' }],
  quick: [{ provider: 'gemini', model: 'gemini-2.5-flash' }, { provider: 'claude', model: 'haiku' }, { provider: 'codex', model: '' }],
};

const DEFAULT_SETTINGS = {
  language: null, // null = follow system
  onboarded: false,
  smartRouting: true,
  classifier: { provider: 'gemini', model: 'gemini-2.5-flash' },
  autonomy: 'edit', // safe | edit | full
  historyTurns: 10,
  cooldownMinutes: 60,
  timeoutMinutes: 30,
  closeToTray: true,
  globalShortcut: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  defaultWorkspace: '',
  providers: { claude: { enabled: true }, codex: { enabled: true }, gemini: { enabled: true } },
  customModels: { claude: [], codex: [], gemini: [] },
  routes: DEFAULT_ROUTES,
  voice: {
    model: 'gemini-2.5-flash', // transcription model (falls back to Gemini's default if renamed)
    autoSend: true,            // send as soon as you stop talking
    speakReplies: true,        // in voice conversation mode, read answers aloud
    voiceName: '',             // preferred system voice ('' = best Arabic/English voice available)
    rate: 1,
  },
};

module.exports = { CATEGORIES, DEFAULT_ROUTES, DEFAULT_SETTINGS };
