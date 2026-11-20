'use strict';
// Classify a failed CLI run so the orchestrator knows what to do next:
//   limit       -> provider is out of quota: cool it down, move to the next one
//   auth        -> not signed in: skip, tell the user to sign in
//   not_installed
//   bad_model   -> retry same provider with its default model
//   bad_flag    -> retry same provider without optional flags (older CLI version)
//   timeout / cancelled / error

const LIMIT_PATTERNS = [
  /usage limit/i, /rate[ _-]?limit/i, /limit (has been )?(reached|exceeded)/i, /\bquota\b/i,
  /RESOURCE_EXHAUSTED/, /\b429\b/, /too many requests/i, /hit your (usage )?limit/i,
  /out of (credits|messages|tokens)/i, /(5|five)[- ]hour limit/i, /weekly limit/i,
  /reached your .{0,30}limit/i, /exceeded your current quota/i, /(at|over) capacity/i, /overloaded/i,
];
const AUTH_PATTERNS = [
  /not (logged|signed) in/i, /please (log|sign) ?in/i, /\/login\b/, /unauthori[sz]ed/i, /\b401\b/,
  /invalid (api key|x-api-key|credentials|token)/i, /authenticat(e|ion) (required|failed)/i,
  /run `?(codex|claude|gemini) login/i, /OAuth token (has )?expired/i, /credentials? (not found|missing)/i,
];
const NOT_INSTALLED_PATTERNS = [/is not recognized as an internal or external command/i, /command not found/i, /\bENOENT\b/, /No such file or directory/i];
const BAD_MODEL_PATTERNS = [
  /model.{0,60}(not found|not_found|invalid|unknown|does not exist|not supported|unsupported|not available|unavailable)/i,
  /(unknown|invalid|unsupported) model/i, /no such model/i,
];
const BAD_FLAG_PATTERNS = [/unknown (option|argument|flag)/i, /unexpected argument/i, /unrecognized (option|argument|arguments)/i, /error: Found argument/i, /Unknown arguments?:/i];

const any = (pats, text) => pats.some((p) => p.test(text));

function classifyFailure({ code, stdout = '', stderr = '', error, cancelled, timedOut, finalText = '' }) {
  if (cancelled) return { kind: 'cancelled' };
  if (timedOut) return { kind: 'timeout' };
  const text = `${stderr}\n${stdout}\n${error ? String(error.message || error) : ''}`;
  if (error && error.code === 'ENOENT') return { kind: 'not_installed' };
  if (any(NOT_INSTALLED_PATTERNS, text) && code !== 0 && !finalText) return { kind: 'not_installed' };
  if (any(BAD_FLAG_PATTERNS, text)) return { kind: 'bad_flag' };
  if (any(BAD_MODEL_PATTERNS, text)) return { kind: 'bad_model' };
  if (any(LIMIT_PATTERNS, text)) return { kind: 'limit', resetAt: parseResetTime(text) };
  if (any(AUTH_PATTERNS, text)) return { kind: 'auth' };
  return { kind: 'error', message: lastLines(stderr || stdout || String(error || ''), 6) };
}

/** Text that came back successfully can still be a limit notice (some CLIs exit 0). */
function looksLikeLimitNotice(text) {
  const t = (text || '').trim();
  return t.length > 0 && t.length < 500 && any(LIMIT_PATTERNS, t);
}

/** Best-effort parse of when a quota resets. Returns epoch ms or null. */
function parseResetTime(text, now = Date.now()) {
  // Claude legacy: "Claude AI usage limit reached|1735689600"
  let m = text.match(/limit reached\|(\d{10,13})/i);
  if (m) { const n = Number(m[1]); return n < 1e12 ? n * 1000 : n; }
  // "retry in 34.5s", "retryDelay": "34s", "try again in 2 hours 15 minutes", "in 45m"
  m = text.match(/(?:retry|try again)[^\d]{0,20}((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*(?:and\s*)?)+)/i)
    || text.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?s)/i);
  if (m) {
    let ms = 0;
    const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
    let p;
    while ((p = re.exec(m[1]))) {
      const v = parseFloat(p[1]); const u = p[2].toLowerCase();
      ms += u.startsWith('h') ? v * 3600e3 : u.startsWith('m') ? v * 60e3 : v * 1e3;
    }
    if (ms > 0) return now + ms;
  }
  // "resets at 5pm", "resets 5:30 PM", "available again at 17:00"
  m = text.match(/(?:resets?|again)\s*(?:at|on)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let h = Number(m[1]); const min = Number(m[2] || 0); const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h < 24 && min < 60) {
      const d = new Date(now); d.setHours(h, min, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
  }
  return null;
}

function lastLines(s, n) {
  return String(s).trim().split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n').slice(0, 800);
}

module.exports = { classifyFailure, parseResetTime, looksLikeLimitNotice };
