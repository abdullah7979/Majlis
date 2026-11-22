'use strict';

// Task categories and the default route (ordered fallback chain) for each.
// model '' means "the CLI's own default model".
const CATEGORIES = ['code_heavy', 'code', 'image', 'research', 'writing', 'realtime', 'quick'];

// '' = the CLI's own default model; '@fast' / '@flash' / '@best' are resolved from the live model list.
// '' = the CLI's own default (newest) model; '@fast' / '@flash' / '@best' are resolved from the live model list.
// Roles: Claude = heavy coding & precise writing; ChatGPT = coding partner & images; Gemini Pro = research,
// long documents, live info, images (Nano Banana) and quick everyday questions.
const DEFAULT_ROUTES = {
  code_heavy: [{ provider: 'claude', model: 'opus' }, { provider: 'codex', model: '' }, { provider: 'gemini', model: '@best' }],
  code: [{ provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: '' }, { provider: 'gemini', model: '@best' }],
  image: [{ provider: 'gemini', model: '' }, { provider: 'codex', model: '' }],
  research: [{ provider: 'gemini', model: '@best' }, { provider: 'claude', model: 'opus' }, { provider: 'codex', model: '' }],
  writing: [{ provider: 'claude', model: 'sonnet' }, { provider: 'gemini', model: '@best' }, { provider: 'codex', model: '' }],
  realtime: [{ provider: 'gemini', model: '' }, { provider: 'codex', model: '' }, { provider: 'claude', model: 'sonnet' }],
  quick: [{ provider: 'gemini', model: '@flash' }, { provider: 'claude', model: 'haiku' }, { provider: 'codex', model: '' }],
};
// The strongest model of each provider, used by Council mode.
const COUNCIL_MEMBERS = [{ provider: 'claude', model: 'opus' }, { provider: 'codex', model: '' }, { provider: 'gemini', model: '@best' }];

const DEFAULT_SETTINGS = {
  schema: 5,
  language: null, // null = follow system
  onboarded: false,
  smartRouting: true,
  autonomy: 'edit', // safe | edit | full
  balance: true,     // share everyday work between subscriptions so none runs out early
  continuity: true,  // short follow-ups ('yes', 'continue', 'fix it') stay with the model doing the task
  memory: '',        // things the user wants every model to know (shown in Settings → About you)
  snapshots: true,   // record file changes in project folders so they can be undone
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
    engine: 'whisper',         // speech-to-text runs on this PC (Whisper large-v3 turbo); no account needed
    model: 'onnx-community/whisper-large-v3-turbo',
    language: 'auto',          // 'auto' | 'ar' | 'en'
    preload: true,             // download/load the speech model in the background at startup
    autoSend: true,            // send as soon as you stop talking
    speakReplies: true,        // in voice conversation mode, read answers aloud
    voiceName: '',             // preferred system voice ('' = best Arabic/English voice available)
    rate: 1,
  },
};

module.exports = { CATEGORIES, DEFAULT_ROUTES, DEFAULT_SETTINGS, COUNCIL_MEMBERS };
