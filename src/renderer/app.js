'use strict';
/* global window, document, marked, DOMPurify, hljs, I18N, navigator, requestAnimationFrame */
const api = window.majlis;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  lang: 'en', t: I18N.en, settings: null, info: null, providers: {},
  convs: [], conv: null, running: new Set(), pendingFiles: [], renderQueued: new Set(),
};
const PROVIDER_IDS = ['claude', 'codex', 'gemini'];
const INITIAL = { claude: 'C', codex: 'G', gemini: 'Ge' };

// ------------------------------------------------------------------ helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const t = (k) => S.t[k] || I18N.en[k] || k;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toast.tm); toast.tm = setTimeout(() => el.classList.add('hidden'), 2200);
}
const fmtTime = (ms) => new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-SA' : undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const baseName = (p) => String(p).split(/[\\/]/).pop();

function providerLabel(id) { return (S.providers[id] && S.providers[id].label) || id; }
const TOKEN_LABEL = { '@best': 'tok_best', '@flash': 'tok_flash', '@fast': 'tok_fast' };
function modelLabel(provider, model) {
  const p = S.providers[provider];
  const m = p && p.models.find((x) => x.id === model);
  if (m) return m.label;
  if (TOKEN_LABEL[model]) return `${providerLabel(provider)} · ${t(TOKEN_LABEL[model])}`;
  return model ? `${providerLabel(provider)} · ${model}` : providerLabel(provider);
}

function setLanguage(lang) {
  S.lang = lang === 'ar' ? 'ar' : 'en';
  S.t = I18N[S.lang];
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.t.dir;
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  $$('[data-ex]').forEach((el) => { el.textContent = t(el.dataset.ex); });
}

// ------------------------------------------------------------------ markdown
marked.setOptions({ gfm: true, breaks: true });
function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
  el.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noreferrer'; });
  el.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    const lang = ((code.className.match(/language-([\w+#-]+)/) || [])[1]) || '';
    try { hljs.highlightElement(code); } catch (_) {}
    const btn = h('button', { onclick: () => { navigator.clipboard.writeText(code.innerText); btn.textContent = t('copied'); setTimeout(() => (btn.textContent = t('copy')), 1400); } }, t('copy'));
    pre.prepend(h('div', { class: 'code-head' }, h('span', {}, lang || 'code'), btn));
  });
  // Paragraph direction follows its own text (Arabic vs English mixed answers).
  el.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, td, th').forEach((n) => n.setAttribute('dir', 'auto'));
}

// ------------------------------------------------------------------ sidebar
async function refreshConvs() { S.convs = await api.conv.list(); renderSidebar(); }
function renderSidebar() {
  const list = $('#convList'); list.innerHTML = '';
  const q = $('#search').value.trim().toLowerCase();
  const items = S.convs.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
  if (!items.length) { list.append(h('div', { class: 'empty-list' }, t('no_convs'))); return; }
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const groups = [[t('today'), (c) => c.updatedAt >= startToday.getTime()], [t('yesterday'), (c) => c.updatedAt >= startToday.getTime() - 864e5], [t('earlier'), () => true]];
  const used = new Set();
  for (const [label, test] of groups) {
    const g = items.filter((c) => !used.has(c.id) && test(c));
    if (!g.length) continue;
    list.append(h('div', { class: 'conv-group' }, label));
    for (const c of g) {
      used.add(c.id);
      list.append(h('div', { class: 'conv-item' + (S.conv && S.conv.id === c.id ? ' active' : ''), onclick: () => openConversation(c.id), title: c.title },
        S.running.has(c.id) ? h('span', { class: 'run' }) : null,
        h('span', { class: 't' }, c.title || t('new_chat')),
        h('button', { class: 'more', onclick: (e) => { e.stopPropagation(); convMenu(e, c); } }, '⋯')));
    }
  }
}
function convMenu(e, c) {
  closeMenu();
  const m = h('div', { class: 'menu', id: 'menu' },
    h('button', { onclick: () => { closeMenu(); openConversation(c.id).then(() => { $('#convTitle').focus(); $('#convTitle').select(); }); } }, t('rename')),
    h('button', { class: 'danger', onclick: async () => {
      closeMenu();
      if (!window.confirm(t('confirm_delete'))) return;
      await api.conv.remove(c.id);
      if (S.conv && S.conv.id === c.id) S.conv = null;
      await refreshConvs(); if (!S.conv) showWelcome();
    } }, t('delete')));
  document.body.append(m);
  const r = e.target.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`;
  m.style.left = `${Math.min(r.left, window.innerWidth - 170)}px`;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
}
function closeMenu() { const m = $('#menu'); if (m) m.remove(); }

async function refreshProviders() {
  S.providers = await api.providers.status();
  const box = $('#providerDots'); box.innerHTML = '';
  for (const id of PROVIDER_IDS) {
    const p = S.providers[id]; if (!p) continue;
    const st = !p.installed || !p.enabled ? 'off' : p.cooldownUntil || !p.signedIn ? 'cool' : 'ok';
    const tip = !p.signedIn && p.installed && p.enabled ? t('needs_signin') : st === 'cool' ? `${t('resting_until')} ${fmtTime(p.cooldownUntil)}` : st === 'ok' ? `${t('ready')} · ${p.usageToday} ${t('requests_today')}` : p.installed ? t('skipped_disabled') : t('not_installed');
    box.append(h('span', { class: `pdot ${st}`, title: tip, onclick: () => openSettings('providers') }, h('i'), p.label));
  }
  buildModelPicker();
  renderAuthBanner();
}

// ------------------------------------------------------------------ sign-in
const dismissedAuth = new Set();
function renderAuthBanner() {
  const box = $('#authBanner'); if (!box) return;
  const need = PROVIDER_IDS.filter((id) => { const p = S.providers[id]; return p && p.installed && p.enabled && !p.signedIn && !dismissedAuth.has(id); });
  box.innerHTML = '';
  box.classList.toggle('hidden', !need.length || !S.settings || !S.settings.onboarded);
  if (!need.length) return;
  box.append(h('span', {}, '🔑 ', need.map((id) => S.providers[id].label).join(' · '), ` — ${t('needs_signin')}`), h('span', { class: 'grow' }));
  for (const id of need) box.append(h('button', { onclick: () => signIn(id) }, `${t('sign_in_now')}: ${S.providers[id].label}`));
  box.append(h('button', { class: 'x', title: t('dismiss'), onclick: () => { need.forEach((id) => dismissedAuth.add(id)); renderAuthBanner(); } }, '✕'));
}
/** Open the vendor's sign-in, then watch for it to complete (up to 4 minutes). */
async function signIn(id) {
  await api.providers.login(id);
  toast(t(`login_hint_${id}`));
  const until = Date.now() + 240000;
  const poll = async () => {
    S.providers = await api.providers.status();
    if (S.providers[id] && S.providers[id].signedIn) { toast(`${S.providers[id].label} — ${t('signed_in_ok')}`); refreshProviders(); return; }
    if (Date.now() < until) setTimeout(poll, 3000);
  };
  setTimeout(poll, 3000);
}
function buildModelPicker() {
  const sel = $('#modelPick'); const cur = sel.value || 'auto';
  sel.innerHTML = '';
  sel.append(h('option', { value: 'auto' }, `✦ ${t('auto')}`));
  for (const id of PROVIDER_IDS) {
    const p = S.providers[id]; if (!p || !p.installed) continue;
    const g = h('optgroup', { label: p.label });
    g.append(h('option', { value: `${id}|` }, `${p.label} — ${t('default_model')}`));
    for (const m of p.models) g.append(h('option', { value: `${id}|${m.id}` }, m.label));
    sel.append(g);
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'auto';
}

// ------------------------------------------------------------------ conversation view
function showWelcome() {
  S.conv = null;
  $('#welcome').classList.remove('hidden');
  $('#thread').innerHTML = '';
  $('#convTitle').value = '';
  $('#convTitle').placeholder = t('new_chat');
  updateWorkspaceChip();
  updateSendButton();
  renderSidebar();
  $('#input').focus();
}
async function openConversation(id) {
  const c = await api.conv.get(id);
  if (!c) return;
  S.conv = c;
  $('#welcome').classList.toggle('hidden', c.messages.length > 0);
  $('#convTitle').value = c.title || '';
  renderThread();
  updateWorkspaceChip();
  updateSendButton();
  renderSidebar();
  $('#input').focus();
}
async function ensureConversation() {
  if (S.conv) return S.conv;
  S.conv = await api.conv.create({ workspace: S.draftWorkspace || '' });
  S.draftWorkspace = '';
  return S.conv;
}
function renderThread() {
  const th = $('#thread'); th.innerHTML = '';
  for (const m of S.conv.messages) th.append(m.role === 'user' ? userEl(m) : aiEl(m));
  scrollDown(true);
}
function scrollDown(force) {
  const box = $('#messages');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 240) box.scrollTop = box.scrollHeight;
}
function userEl(m) {
  return h('div', { class: 'msg user', 'data-id': m.id },
    h('div', { class: 'bubble', dir: 'auto' }, m.voice ? h('span', { class: 'voice-tag' }, '🎙') : null, m.text,
      m.attachments && m.attachments.length ? h('div', { class: 'files' }, m.attachments.map((a) => h('span', { class: 'file-pill', title: a, onclick: () => api.shell.openPath(a) }, '📄 ' + baseName(a)))) : null));
}
function aiEl(m) {
  const el = h('div', { class: 'msg ai', 'data-id': m.id });
  updateAiEl(el, m);
  return el;
}
function trailEl(m) {
  const steps = (m.trail || []).filter((s) => s.outcome !== 'ok');
  if (!steps.length) return null;
  const box = h('div', { class: 'trail' });
  steps.forEach((s, i) => {
    const kind = s.outcome;
    const why = kind === 'limit' ? `${t('out_limit')}${s.until ? ` ${t('until')} ${fmtTime(s.until)}` : ''}`
      : kind === 'cooldown' ? `${t('skipped_cooldown')}${s.until ? ` ${t('until')} ${fmtTime(s.until)}` : ''}`
      : kind === 'disabled' ? t('skipped_disabled') : kind === 'auth' ? t('signed_out') : kind === 'not_installed' ? t('not_installed')
      : kind === 'timeout' ? t('timeout') : t('failed');
    if (i) box.append(h('span', { class: 'arrow' }, S.lang === 'ar' ? '←' : '→'));
    const cls = kind === 'limit' || kind === 'cooldown' ? kind : kind === 'auth' ? 'auth' : 'fail';
    box.append(h('span', { class: `step ${cls}`, title: s.message || (kind === 'auth' ? t('sign_in_now') : ''), onclick: kind === 'auth' ? () => signIn(s.provider) : null },
      `${modelLabel(s.provider, s.model)} · ${why}${kind === 'auth' ? ` — ${t('sign_in_now')} ↗` : ''}`));
  });
  return box;
}
const fileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
function imagesEl(images) {
  return h('div', { class: 'gallery' }, images.map((p) => h('figure', {},
    h('img', { src: fileUrl(p), alt: '', onclick: () => api.shell.openPath(p), title: t('open_image') }),
    h('figcaption', {}, h('button', { onclick: () => api.shell.openPath(p) }, t('open_image')), h('span', {}, baseName(p))))));
}
function changesEl(m) {
  const c = m.changes;
  const label = { A: t('ch_added'), M: t('ch_modified'), D: t('ch_deleted') };
  const box = h('details', { class: 'changes', open: c.files.length <= 6 },
    h('summary', {}, `📝 ${t('ch_title')} (${c.files.length})`, c.undone ? h('span', { class: 'tag mute' }, t('ch_undone')) : null),
    h('ul', {}, c.files.slice(0, 200).map((f) => h('li', {}, h('span', { class: `chs ${f.status}` }, label[f.status] || f.status), h('code', { dir: 'ltr' }, f.path)))));
  if (!c.undone) {
    box.append(h('button', { class: 'btn undo', onclick: async (e) => {
      if (!window.confirm(t('ch_confirm'))) return;
      e.target.disabled = true;
      const r = await api.chat.undo({ conversationId: S.conv.id, messageId: m.id });
      if (r && r.ok) { c.undone = true; toast(t('ch_done')); } else toast(t('ch_failed'));
      const el = $(`.msg.ai[data-id="${m.id}"]`); if (el) updateAiEl(el, m);
    } }, `↶ ${t('ch_undo')}`));
  }
  return box;
}
function councilEl(m) {
  const st = (x) => (x.ok ? '✓' : x.kind === 'running' ? '…' : '✖');
  return h('details', { class: 'council' },
    h('summary', {}, `🏛 ${t('council_views')} — ${m.council.map((x) => `${x.label} ${st(x)}`).join(' · ')}`),
    m.council.map((x) => {
      const body = h('div', { class: 'body' });
      if (x.ok) renderMarkdown(body, x.text); else body.textContent = x.kind === 'running' ? t('working') + '…' : `✖ ${t(x.kind === 'limit' ? 'out_limit' : x.kind === 'auth' ? 'signed_out' : 'failed')}`;
      return h('div', { class: 'member' }, h('div', { class: 'mhead' }, h('div', { class: `avatar ${x.provider}` }, INITIAL[x.provider]), h('b', {}, modelLabel(x.provider, x.model))), body);
    }));
}
function updateAiEl(el, m) {
  const live = m.status === 'running';
  const prov = m.provider || m.liveProvider;
  const model = m.model != null && m.provider ? m.model : m.liveModel;
  el.innerHTML = '';
  const head = h('div', { class: 'head' },
    h('div', { class: `avatar ${prov || 'pending'}` }, prov ? INITIAL[prov] : '✦'),
    h('span', { class: 'who' }, prov ? modelLabel(prov, model) : 'Majlis'),
    m.category ? h('span', { class: 'tag' }, t(`cat_${m.category}`)) : null,
    m.routeSource && m.category !== 'manual' && m.category !== 'council' ? h('span', { class: 'tag mute', title: m.reason || '' }, t(`src_${m.routeSource}`)) : null);
  el.append(head);
  const tr = trailEl(m); if (tr) el.append(tr);
  if (m.notice) el.append(h('div', { class: 'status-line' }, 'ⓘ ', m.notice));
  if (m.activity && m.activity.length) {
    const d = h('details', { class: 'activity' }, h('summary', {}, `${m.activity.length} ${t('steps')}`), h('ol', {}, m.activity.slice(-80).map((a) => h('li', {}, a))));
    if (m._activityOpen) d.open = true;
    d.addEventListener('toggle', () => { m._activityOpen = d.open; });
    el.append(d);
  }
  if (live && !m.text) {
    el.append(h('div', { class: 'status-line' }, h('span', { class: 'spinner' }), m.statusText || (prov ? `${providerLabel(prov)} ${t('working')}…` : t('classifying'))));
  }
  if (m.text) {
    const body = h('div', { class: 'body' + (live ? ' streaming' : '') });
    renderMarkdown(body, m.text);
    el.append(body);
  }
  if (m.images && m.images.length) el.append(imagesEl(m.images));
  if (m.changes && m.changes.files && m.changes.files.length) el.append(changesEl(m));
  if (m.council && m.council.length) el.append(councilEl(m));
  if (m.status === 'failed') {
    el.append(h('div', { class: 'notice' }, m.error || t('all_failed'), h('button', { onclick: () => openSettings('providers') }, t('open_settings'))));
  }
  if (m.status === 'cancelled' && !m.text) el.append(h('div', { class: 'status-line' }, t('cancelled')));
  if (m.status === 'done') {
    const foot = h('div', { class: 'msg-foot' },
      h('button', { onclick: (e) => { navigator.clipboard.writeText(m.text); e.target.textContent = t('copied'); setTimeout(() => (e.target.textContent = t('copy')), 1400); } }, t('copy')),
      h('span', {}, '·'), h('span', {}, fmtTime(m.ts)));
    if (m.tokens) foot.append(h('span', {}, '·'), h('span', { class: 'tok', title: `${t('tok_in')}: ${fmtTok(m.tokens.input)} · ${t('tok_out')}: ${fmtTok(m.tokens.output)} · ${t('tok_cached')}: ${fmtTok(m.tokens.cached)}` },
      `${m.tokens.estimated ? '≈ ' : ''}${fmtTok(m.tokens.input + m.tokens.output)} ${t('tokens')}`));
    if (m.category === 'prompt') {
      // A written prompt is usually in a code block: save that part (or the whole answer) to the library.
      const block = /```[^\n]*\n([\s\S]*?)```/.exec(m.text || '');
      foot.append(h('span', {}, '·'), h('button', { onclick: () => saveAsPrompt((block ? block[1] : m.text).trim()) }, `📚 ${t('save_as_prompt')}`));
    }
    if (m.category && m.category !== 'manual' && m.category !== 'council') {
      foot.append(h('span', { class: 'grow' }), h('span', {}, m.feedback ? t('thanks') : t('was_good')));
      for (const [sym, good] of [['👍', true], ['👎', false]]) {
        foot.append(h('button', { class: (m.feedback === 1 && good) || (m.feedback === -1 && !good) ? 'on' : '', onclick: async () => {
          m.feedback = good ? 1 : -1;
          await api.chat.feedback({ category: m.category, provider: m.provider, good, conversationId: S.conv.id, messageId: m.id });
          updateAiEl(el, m);
        } }, sym));
      }
    }
    el.append(foot);
  }
}
function queueRender(m) {
  if (S.renderQueued.has(m.id)) return;
  S.renderQueued.add(m.id);
  requestAnimationFrame(() => {
    S.renderQueued.delete(m.id);
    const el = $(`.msg.ai[data-id="${m.id}"]`);
    if (el) { updateAiEl(el, m); scrollDown(); }
  });
}

// ------------------------------------------------------------------ chat events
function onChatEvent(e) {
  if (e.type === 'begin') S.running.add(e.conversationId);
  if (['done', 'failed', 'cancelled'].includes(e.type)) {
    S.running.delete(e.conversationId);
    refreshConvs(); refreshProviders();
  }
  if (!S.conv || S.conv.id !== e.conversationId) { if (e.type === 'begin') refreshConvs(); return; }
  const msgs = S.conv.messages;
  if (e.type === 'begin') {
    msgs.push(e.userMessage, e.aiMessage);
    if (!S.conv.title) { S.conv.title = e.userMessage.text.replace(/\s+/g, ' ').slice(0, 60); $('#convTitle').value = S.conv.title; }
    $('#welcome').classList.add('hidden');
    $('#thread').append(userEl(e.userMessage), aiEl(e.aiMessage));
    scrollDown(true); updateSendButton(); refreshConvs();
    return;
  }
  const m = msgs.find((x) => x.id === e.messageId);
  if (!m) return;
  switch (e.type) {
    case 'status': m.statusText = t(e.key); break;
    case 'plan': Object.assign(m, { category: e.category, reason: e.reason, routeSource: e.source, statusText: null }); break;
    case 'start': Object.assign(m, { liveProvider: e.provider, liveModel: e.model, text: '', statusText: null }); break;
    case 'meta': break;
    case 'text': m.text = (m.text || '') + e.text; break;
    case 'activity': (m.activity = m.activity || []).push(e.text); break;
    case 'retry': if (e.reason === 'bad_model') m.notice = t('retry_model'); break;
    case 'skip': (m.trail = m.trail || []).push({ provider: e.provider, model: e.model, outcome: e.why, until: e.until }); break;
    case 'fallback': (m.trail = m.trail || []).push({ provider: e.provider, model: m.liveModel, outcome: e.kind, until: e.until, message: e.message }); m.text = ''; break;
    case 'done': Object.assign(m, { status: 'done', text: e.text, provider: e.provider, model: e.model, providerLabel: e.label, images: e.images || m.images, changes: e.changes || m.changes, council: e.council || m.council, tokens: e.tokens || m.tokens }); break;
    case 'council-start': (m.council = m.council || []).push({ provider: e.provider, label: e.label, model: e.model, kind: 'running', ok: false }); m.statusText = t('council_thinking'); break;
    case 'council-member': { m.council = m.council || []; const i = m.council.findIndex((x) => x.provider === e.provider); const v = { ...e }; delete v.type; if (i >= 0) m.council[i] = v; else m.council.push(v); break; }
    case 'council-activity': (m.activity = m.activity || []).push(`${providerLabel(e.provider)} · ${e.text}`); break;
    case 'failed': Object.assign(m, { status: 'failed', error: e.error || null }); break;
    case 'cancelled': m.status = 'cancelled'; break;
    default: break;
  }
  queueRender(m);
  if (['done', 'failed', 'cancelled'].includes(e.type)) { updateSendButton(); onVoiceTurnFinished(m, e.type); }
}

// ------------------------------------------------------------------ composer
function updateSendButton() {
  const btn = $('#sendBtn');
  const busy = S.conv && S.running.has(S.conv.id);
  btn.classList.toggle('stop', !!busy);
  btn.textContent = busy ? '■' : '↑';
  btn.title = busy ? t('stop') : t('send');
  btn.disabled = !busy && !$('#input').value.trim();
}
function autoGrow() { const ta = $('#input'); ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`; updateSendButton(); }
function renderAttachments() {
  const box = $('#attachList'); box.innerHTML = '';
  S.pendingFiles.forEach((f, i) => box.append(h('span', { class: 'file-pill', title: f }, '📄 ' + baseName(f),
    h('button', { onclick: () => { S.pendingFiles.splice(i, 1); renderAttachments(); } }, '✕'))));
}
async function sendCurrent({ voice = false } = {}) {
  if (S.conv && S.running.has(S.conv.id)) { api.chat.cancel(S.conv.id); return; }
  const text = $('#input').value.trim();
  if (!text) return;
  const anyReady = PROVIDER_IDS.some((id) => S.providers[id] && S.providers[id].installed && S.providers[id].enabled);
  if (!anyReady) { toast(t('no_provider_ready')); openSettings('providers'); return; }
  const conv = await ensureConversation();
  const files = S.pendingFiles.slice();
  $('#input').value = ''; S.pendingFiles = []; renderAttachments(); autoGrow();
  const force = $('#modelPick').value === 'auto' ? null : $('#modelPick').value;
  S.running.add(conv.id); updateSendButton();
  if (voice) V.awaiting = conv.id;
  if (S.councilOn && !force) await api.chat.council({ conversationId: conv.id, text, files, voice });
  else await api.chat.send({ conversationId: conv.id, text, files, force, voice });
}

// ------------------------------------------------------------------ voice
const V = { state: 'idle', mode: false, rec: null, awaiting: null, empties: 0 };
function voiceSettings() { return (S.settings && S.settings.voice) || {}; }
/** Fast-model repair of recognition mistakes. Never blocks voice: any failure keeps the original text. */
async function repairTranscript(text) {
  if (voiceSettings().smartFix === false) return text;
  try {
    setVoiceUI('transcribing', t('voice_fixing'));
    const r = await api.voice.fix(text, S.conv ? S.conv.id : null);
    return (r && r.ok && r.text) ? r.text : text;
  } catch (_) { return text; }
}
function asrLanguage() { const l = voiceSettings().language || 'auto'; return l === 'auto' ? (S.lang === 'ar' ? 'ar' : 'auto') : l; }
/** Speech model: download/load in the background so the first mic press is instant. */
function initASR() {
  if (!window.ASR) { window.addEventListener('asr-ready', initASR, { once: true }); return; }
  window.ASR.onStatus((st) => {
    if (V.state === 'transcribing' && st.status === 'loading') $('#vbText').textContent = `${t('voice_loading_model')} ${st.progress}%`;
    const el = $('#asrStatus'); if (el) el.textContent = asrStatusText(st);
  });
  if (voiceSettings().preload !== false) setTimeout(() => window.ASR.load(voiceSettings().model).catch(() => {}), 4000);
}
function asrStatusText(st) {
  if (st.status === 'ready') return `${t('asr_ready')} · ${st.device === 'webgpu' ? t('asr_gpu') : t('asr_cpu')}`;
  if (st.status === 'loading') return `${t('voice_loading_model')} ${st.progress}%`;
  if (st.status === 'error') return `✖ ${st.error}`;
  return t('asr_idle');
}
function setVoiceUI(state, text) {
  V.state = state;
  const bar = $('#voiceBar');
  bar.classList.toggle('hidden', state === 'idle' && !V.mode);
  bar.classList.toggle('busy', state === 'transcribing' || state === 'thinking');
  $('#micBtn').classList.toggle('on', state === 'listening');
  $('#voiceModeBtn').classList.toggle('on', V.mode);
  const icons = { listening: '🎙', transcribing: '✍️', thinking: '⏳', speaking: '🔊', idle: '🎧' };
  $('#vbIcon').textContent = icons[state] || '🎧';
  $('#vbText').textContent = text || ({ listening: t('listening'), transcribing: t('transcribing'), thinking: t('thinking_voice'), speaking: t('speaking'), idle: t('voice_mode') })[state];
  $('#vbStop').textContent = V.mode ? t('stop_voice') : state === 'speaking' ? t('stop_speaking') : t('stop_listening');
  if (state !== 'listening') $$('#vbLevel i').forEach((i) => { i.style.height = ''; });
}
function drawLevel(level) {
  $$('#vbLevel i').forEach((bar, i) => {
    const wobble = 0.55 + 0.45 * Math.sin(Date.now() / 120 + i * 1.3);
    bar.style.height = `${4 + Math.round(level * wobble * 22)}px`;
  });
}
async function listen() {
  if (V.state === 'listening') { V.rec && V.rec.stop(); return; }
  Voice.stopSpeaking();
  setVoiceUI('listening');
  V.rec = new Voice.Recorder({ onLevel: drawLevel, noSpeechMs: V.mode ? 15000 : 9000 });
  let res;
  try { res = await V.rec.record(); }
  catch (e) { setVoiceUI('idle'); V.mode = false; setVoiceUI('idle'); toast(t('mic_denied')); return; }
  V.rec = null;
  if (V.state !== 'listening') return; // cancelled meanwhile
  if (!res.pcm) {
    if (V.mode && ++V.empties < 2) return listen();
    V.empties = 0; V.mode = false; setVoiceUI('idle'); return;
  }
  V.empties = 0;
  let r;
  try {
    if (window.ASR.status().status !== 'ready') setVoiceUI('transcribing', t('voice_loading_model'));
    else setVoiceUI('transcribing');
    r = await window.ASR.transcribe(res.pcm, { language: asrLanguage(), model: voiceSettings().model });
  } catch (e) {
    V.mode = false; setVoiceUI('idle'); toast(`${t('voice_failed')} ${e && e.message ? '(' + e.message + ')' : ''}`); return;
  }
  if (!r.text) { if (V.mode) return listen(); setVoiceUI('idle'); return; }
  r.text = await repairTranscript(r.text);
  const input = $('#input');
  input.value = input.value.trim() ? `${input.value.trim()} ${r.text}` : r.text;
  autoGrow();
  const busy = S.conv && S.running.has(S.conv.id);
  if (!busy && (V.mode || voiceSettings().autoSend !== false)) {
    setVoiceUI('thinking');
    await sendCurrent({ voice: true });
  } else {
    setVoiceUI('idle'); input.focus();
  }
}
async function onVoiceTurnFinished(m, type) {
  if (!V.awaiting || !S.conv || V.awaiting !== S.conv.id) return;
  V.awaiting = null;
  if (!V.mode) { setVoiceUI('idle'); return; }
  if (type === 'done' && voiceSettings().speakReplies !== false) {
    setVoiceUI('speaking');
    const r = await Voice.speak(m.text, { voiceName: voiceSettings().voiceName, rate: voiceSettings().rate || 1 });
    if (r.reason === 'no_arabic_voice') toast(t('no_arabic_voice'));
    if (r.stopped && !V.mode) return;
  }
  if (V.mode) listen(); else setVoiceUI('idle');
}
function toggleVoiceMode() {
  if (V.mode) { stopVoice(); return; }
  V.mode = true; V.empties = 0;
  listen();
}
function stopVoice() {
  V.mode = false;
  if (V.rec) { const r = V.rec; V.rec = null; V.state = 'idle'; r.stop(); }
  Voice.stopSpeaking();
  V.awaiting = null;
  setVoiceUI('idle');
}
function onVoiceBarButton() {
  if (V.mode) return stopVoice();
  if (V.state === 'listening' && V.rec) return V.rec.stop();
  if (V.state === 'speaking') { Voice.stopSpeaking(); setVoiceUI('idle'); }
}
function updateWorkspaceChip() {
  const ws = S.conv ? S.conv.workspace : S.draftWorkspace;
  $('#wsLabel').textContent = ws ? baseName(ws) : t('no_workspace');
  $('#wsChip').title = ws || t('choose_folder');
}
async function pickWorkspace() {
  const dir = await api.dialog.pickFolder();
  if (!dir) return;
  if (S.conv) S.conv = await api.conv.update(S.conv.id, { workspace: dir });
  else S.draftWorkspace = dir;
  updateWorkspaceChip();
}

// ------------------------------------------------------------------ settings
function overlay(content) {
  const o = $('#overlay'); o.innerHTML = ''; o.append(content); o.classList.remove('hidden');
  o.onclick = (e) => { if (e.target === o && S.settings.onboarded) closeOverlay(); };
}
function closeOverlay() { $('#overlay').classList.add('hidden'); $('#overlay').innerHTML = ''; }

async function openSettings(tab = 'providers') {
  S.settings = await api.settings.get();
  const pane = h('div', { class: 'pane' });
  const tabs = ['providers', 'routing', 'prompts', 'autos', 'api', 'general', 'about'];
  const nav = h('nav', {}, h('h3', {}, t('settings')),
    tabs.map((k) => h('button', { 'data-tab': k, onclick: () => show(k) }, t(`tab_${k}`))),
    h('button', { class: 'x', onclick: closeOverlay }, '✕'));
  function show(k) {
    $$('button[data-tab]', nav).forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    pane.innerHTML = '';
    ({ providers: paneProviders, routing: paneRouting, prompts: panePrompts, autos: paneAutos, api: paneApi, general: paneGeneral, about: paneAbout })[k](pane);
  }
  overlay(h('div', { class: 'modal' }, nav, pane));
  show(tab);
}
async function saveSettings(patch) {
  S.settings = await api.settings.set(patch);
  if (patch.language !== undefined) setLanguage(patch.language || systemLang());
}

function providerCard(id, { onChange } = {}) {
  const p = S.providers[id];
  const card = h('div', { class: 'card prov-card' });
  const draw = (extra = {}) => {
    card.innerHTML = '';
    const state = !p.installed ? h('span', { class: 'state bad' }, t('not_installed'))
      : p.cooldownUntil ? h('span', { class: 'state warn' }, `${t('resting_until')} ${fmtTime(p.cooldownUntil)}`)
      : p.signedIn ? h('span', { class: 'state ok' }, t('signed_in_guess')) : h('span', { class: 'state warn' }, t('signed_out_guess'));
    const acts = h('div', { class: 'acts' });
    if (!p.installed) acts.append(h('button', { class: 'btn primary', disabled: extra.busy, onclick: install }, extra.busy ? t('installing') : t('install')));
    else {
      acts.append(h('button', { class: 'btn', onclick: login }, t('sign_in')));
      acts.append(h('button', { class: 'btn', disabled: extra.testing, onclick: test }, extra.testing ? t('testing') : t('test')));
      if (p.cooldownUntil) acts.append(h('button', { class: 'btn', onclick: async () => { await api.providers.clearCooldown(id); await reload(); } }, t('wake')));
      const sw = h('label', { class: 'switch', title: t('enabled') }, h('input', { type: 'checkbox', checked: p.enabled, onchange: async (e) => {
        await saveSettings({ providers: { [id]: { enabled: e.target.checked } } }); await reload();
      } }), h('span'));
      acts.append(sw);
    }
    const ms = p.models || [];
    if (p.installed && ms.length) card.append(h('div', { class: 'model-chips' }, ms.map((m) => h('span', { class: 'mchip', title: m.id }, m.label))));
    card.append(
      h('div', { class: `avatar ${id}` }, INITIAL[id]),
      h('div', {}, h('div', { class: 'name' }, `${p.label}`, h('span', { class: 'vendor' }, p.vendor)),
        h('div', { class: 'sub' }, state, p.version ? h('span', {}, `${t('version')} ${p.version}`) : null, p.installed ? h('span', {}, `${p.usageToday} ${t('requests_today')}`) : null)),
      acts);
    if (extra.hint) card.append(h('div', { class: 'hint' }, extra.hint));
    if (extra.progress != null) card.append(h('div', { class: 'pbar' }, h('i', { style: `width:${extra.progress}%` })));
    if (extra.result) card.append(h('div', { class: 'hint', style: `color:${extra.result.ok ? 'var(--ok)' : 'var(--bad)'}` }, extra.result.ok ? t('test_ok') : `${t(extra.result.kind === 'auth' ? 'signed_out' : extra.result.kind === 'limit' ? 'out_limit' : 'failed')} ${extra.result.message || ''}`));
    if (extra.log) card.append(h('pre', { class: 'log' }, extra.log));
    if (!p.installed && p.searched && extra.showDiag) {
      card.append(h('details', { class: 'hint diag' }, h('summary', {}, t('diag_title')),
        h('pre', { class: 'log' }, `${p.npmPackage}\n${t('diag_searched')}:\n` + p.searched.join('\n'))));
    }
  };
  async function reload() { S.providers = await api.providers.status(); Object.assign(p, S.providers[id]); draw(); refreshProviders(); onChange && onChange(); }
  async function install() {
    let log = '';
    const stageText = (pr) => `${t('inst_' + pr.stage)}${pr.percent != null && pr.stage === 'download' ? ` ${pr.percent}%` : ''}${pr.text ? ` · ${pr.text}` : ''}`;
    const off = api.providers.onInstallLog((d) => {
      if (d.id !== id) return;
      if (d.progress) draw({ busy: true, hint: stageText(d.progress), progress: d.progress.stage === 'download' ? d.progress.percent : null });
      else { log += d.text || ''; draw({ busy: true, log: log.slice(-3000) }); }
    });
    draw({ busy: true, hint: t('inst_start') });
    let r;
    try { r = await api.providers.install(id); }
    catch (e) { r = { ok: false, log: String((e && e.message) || e) }; }
    finally { off(); }
    if (!r.ok && r.reason === 'no_node') { draw({ hint: t('ob_node_missing') }); return; }
    await reload();
    if (!r.ok) draw({ hint: `✖ ${t('inst_failed')}`, log: r.log, showDiag: true });
    else if (!p.installed) draw({ hint: t('installed_not_found'), log: r.log, showDiag: true });
    else { draw({ hint: `✓ ${t('inst_ok')} ${t(`login_hint_${id}`)}` }); }
  }
  async function login() { await api.providers.login(id); draw({ hint: t(`login_hint_${id}`) }); setTimeout(reload, 20000); }
  async function test() { draw({ testing: true }); const r = await api.providers.test(id); await reload(); draw({ result: r }); }
  draw({ showDiag: true });
  return card;
}

function paneProviders(pane) {
  pane.append(h('h2', {}, t('tab_providers')), h('p', { class: 'help' }, t('ob_note')),
    h('button', { class: 'btn', style: 'margin:-6px 0 14px', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = t('refreshing');
      await api.providers.refreshModels(); await refreshProviders(); paneProviders((pane.innerHTML = '', pane));
    } }, `⟳ ${t('refresh_models')}`));
  pane.append(usageCard());
  for (const id of PROVIDER_IDS) if (S.providers[id]) pane.append(providerCard(id));
  const cm = S.settings.customModels || {};
  const card = h('div', { class: 'card' }, h('div', { class: 'field', style: 'display:block' },
    h('label', {}, t('custom_models')), h('p', { class: 'help' }, t('custom_models_help'))));
  for (const id of PROVIDER_IDS) {
    card.append(h('div', { class: 'field' }, h('span', {}, providerLabel(id)),
      h('input', { type: 'text', value: (cm[id] || []).join(', '), dir: 'ltr', placeholder: 'model-name, other-model', onchange: async (e) => {
        const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        await saveSettings({ customModels: { [id]: list } }); await refreshProviders();
      } })));
  }
  pane.append(card);
}

/** Today's use of each subscription, with its state (ready / resting until / sign-in needed). */
function usageCard() {
  const ids = PROVIDER_IDS.filter((id) => S.providers[id] && S.providers[id].installed);
  const max = Math.max(5, ...ids.map((id) => S.providers[id].usageToday));
  return h('div', { class: 'card usage' }, h('div', { class: 'uhead' }, h('b', {}, t('usage_title')), h('span', { class: 'help', style: 'margin:0' }, t('usage_help'))),
    ids.map((id) => {
      const p = S.providers[id];
      const state = p.cooldownUntil ? `${t('resting_until')} ${fmtTime(p.cooldownUntil)}` : !p.signedIn ? t('needs_signin') : t('ready');
      const tk = p.tokensToday, wk = p.tokensWeek;
      const tkText = tk ? `${fmtTok(tk.input + tk.output)} ${t('tokens')}` : '—';
      const tkTitle = tk ? `${t('tok_in')}: ${fmtTok(tk.input)} · ${t('tok_out')}: ${fmtTok(tk.output)} · ${t('tok_cached')}: ${fmtTok(tk.cached)}${tk.estimated ? ` · ${t('tok_estimated')}` : ''}${wk ? `\n${t('tok_week')}: ${fmtTok(wk.input + wk.output)}` : ''}` : '';
      return h('div', { class: 'urow' }, h('span', { class: 'uname' }, p.label),
        h('div', { class: 'ubar' }, h('i', { class: id, style: `width:${Math.round((p.usageToday / max) * 100)}%` })),
        h('span', { class: 'ucount' }, `${p.usageToday}`), h('span', { class: 'utok', title: tkTitle }, tkText),
        h('span', { class: `ustate ${p.cooldownUntil ? 'warn' : !p.signedIn ? 'bad' : 'ok'}` }, state));
    }),
    h('p', { class: 'help', style: 'margin:10px 0 0' }, t('tok_note')));
}
function fmtTok(n) { n = n || 0; return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n); }

function modelOptions(provider, selected) {
  const p = S.providers[provider];
  const opts = [h('option', { value: '' }, t('default_model'))];
  for (const tok of Object.keys(TOKEN_LABEL)) if (provider === 'gemini' || tok === '@best') opts.push(h('option', { value: tok }, `✦ ${t(TOKEN_LABEL[tok])}`));
  for (const m of (p ? p.models : [])) opts.push(h('option', { value: m.id }, m.label));
  if (selected && !(p && p.models.some((m) => m.id === selected))) opts.push(h('option', { value: selected }, selected));
  const sel = h('select', {}, opts); sel.value = selected || ''; return sel;
}
function paneRouting(pane) {
  pane.append(h('h2', {}, t('tab_routing')), h('p', { class: 'help' }, t('routing_help')));
  const routes = JSON.parse(JSON.stringify(S.settings.routes));
  const save = () => saveSettings({ routes });
  for (const cat of S.info.categories) {
    const card = h('div', { class: 'card route-card' });
    const draw = () => {
      card.innerHTML = '';
      card.append(h('h4', {}, t(`cat_${cat}`)));
      routes[cat].forEach((step, i) => {
        const provSel = h('select', {}, PROVIDER_IDS.map((id) => h('option', { value: id }, providerLabel(id))));
        provSel.value = step.provider;
        const modSel = modelOptions(step.provider, step.model);
        provSel.onchange = () => { step.provider = provSel.value; step.model = ''; save(); draw(); };
        modSel.onchange = () => { step.model = modSel.value; save(); };
        card.append(h('div', { class: 'route-step' }, h('span', { class: 'n' }, i + 1), provSel, modSel,
          h('button', { class: 'mini', title: '↑', disabled: i === 0, onclick: () => { routes[cat].splice(i - 1, 0, routes[cat].splice(i, 1)[0]); save(); draw(); } }, '↑'),
          h('button', { class: 'mini', title: '↓', disabled: i === routes[cat].length - 1, onclick: () => { routes[cat].splice(i + 1, 0, routes[cat].splice(i, 1)[0]); save(); draw(); } }, '↓'),
          h('button', { class: 'mini', title: '✕', disabled: routes[cat].length === 1, onclick: () => { routes[cat].splice(i, 1); save(); draw(); } }, '✕')));
      });
      card.append(h('button', { class: 'link', onclick: () => { routes[cat].push({ provider: 'gemini', model: '' }); save(); draw(); } }, '＋ ' + t('add_step')));
    };
    draw(); pane.append(card);
  }
  pane.append(h('button', { class: 'btn', onclick: async () => { S.settings = await api.settings.resetRoutes(); pane.innerHTML = ''; paneRouting(pane); } }, t('reset_routes')));
}

function field(label, control, help) {
  return h('div', { class: 'field' }, h('div', {}, h('label', {}, label), help ? h('p', { class: 'help' }, help) : null), control);
}
function toggle(checked, onchange) { return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span')); }
function paneGeneral(pane) {
  const s = S.settings;
  const lang = h('select', { onchange: (e) => saveSettings({ language: e.target.value || null }).then(() => openSettings('general')) },
    h('option', { value: '' }, 'System'), h('option', { value: 'en' }, 'English'), h('option', { value: 'ar' }, 'العربية'));
  lang.value = s.language || '';
  const autonomy = h('div', { class: 'radio-list' }, ['safe', 'edit', 'full'].map((k) => h('label', {},
    h('input', { type: 'radio', name: 'autonomy', value: k, checked: s.autonomy === k, onchange: () => saveSettings({ autonomy: k }) }), t(`autonomy_${k}`))));
  const num = (key, min, max) => h('input', { type: 'number', min, max, value: s[key], onchange: (e) => saveSettings({ [key]: Math.max(min, Math.min(max, Number(e.target.value) || min)) }) });
  const wsBtn = h('button', { class: 'btn', onclick: async () => { const d = await api.dialog.pickFolder(); if (d) { await saveSettings({ defaultWorkspace: d }); openSettings('general'); } } }, s.defaultWorkspace ? baseName(s.defaultWorkspace) : t('choose_folder'));
  const mem = h('textarea', { class: 'memory', dir: 'auto', rows: 5, placeholder: t('memory_ph') });
  mem.value = s.memory || '';
  mem.onchange = () => saveSettings({ memory: mem.value });
  pane.append(h('h2', {}, t('memory_title')), h('p', { class: 'help' }, t('memory_help')), h('div', { class: 'card' }, mem));
  const learnedBox = h('div', { class: 'learned' });
  const drawLearned = () => {
    learnedBox.innerHTML = '';
    const list = S.settings.learned || [];
    if (!list.length) learnedBox.append(h('p', { class: 'help', style: 'margin:0' }, t('learned_none')));
    for (const x of list) learnedBox.append(h('div', { class: 'lrow' }, h('span', { dir: 'auto' }, x.text),
      h('button', { class: 'link', title: t('delete'), onclick: async () => { await saveSettings({ learned: (S.settings.learned || []).filter((y) => y.id !== x.id) }); drawLearned(); } }, '✕')));
    if (list.length) learnedBox.append(h('button', { class: 'btn danger', style: 'margin-top:10px', onclick: async () => { if (confirm(t('learned_clear_q'))) { await saveSettings({ learned: [] }); drawLearned(); } } }, t('learned_clear')));
  };
  drawLearned();
  pane.append(h('h2', { style: 'margin-top:22px' }, t('learned_title')), h('p', { class: 'help' }, t('learned_help')),
    h('div', { class: 'card' }, field(t('learn_on'), toggle(s.learn !== false, (v) => saveSettings({ learn: v }))), learnedBox));
  pane.append(h('h2', { style: 'margin-top:22px' }, t('tab_general')), h('div', { class: 'card' },
    field(t('language'), lang),
    field(t('smart_routing'), toggle(s.smartRouting, (v) => saveSettings({ smartRouting: v })), t('smart_routing_help')),
    h('div', { class: 'field', style: 'display:block' }, h('label', {}, t('autonomy')), h('div', { style: 'margin-top:10px' }, autonomy)),
    field(t('default_workspace'), wsBtn),
    field(t('history_turns'), num('historyTurns', 1, 50)),
    field(t('cooldown'), num('cooldownMinutes', 5, 1440)),
    field(t('timeout'), num('timeoutMinutes', 1, 240)),
    field(t('continuity'), toggle(s.continuity !== false, (v) => saveSettings({ continuity: v })), t('continuity_help')),
    field(t('balance'), toggle(s.balance !== false, (v) => saveSettings({ balance: v })), t('balance_help')),
    field(t('snapshots'), toggle(s.snapshots !== false, (v) => saveSettings({ snapshots: v })), t('snapshots_help')),
    field(t('close_to_tray'), toggle(s.closeToTray, (v) => saveSettings({ closeToTray: v }))),
    field(t('launch_login'), toggle(s.launchAtLogin, (v) => saveSettings({ launchAtLogin: v }))),
    field(t('shortcut'), h('input', { type: 'text', value: s.globalShortcut, dir: 'ltr', onchange: (e) => saveSettings({ globalShortcut: e.target.value.trim() }) }))));
  const v = s.voice || {};
  const voiceSel = h('select', { onchange: (e) => saveSettings({ voice: { voiceName: e.target.value } }) }, h('option', { value: '' }, t('voice_auto')));
  Voice.voicesReady().then((list) => {
    list.filter((x) => /^(ar|en)/i.test(x.lang)).sort((a, b) => (a.lang < b.lang ? -1 : 1))
      .forEach((x) => voiceSel.append(h('option', { value: x.name }, `${x.name} (${x.lang})`)));
    voiceSel.value = v.voiceName || '';
  });
  pane.append(h('h2', { style: 'margin-top:22px' }, t('voice_settings')), h('div', { class: 'card' },
    field(t('auto_send'), toggle(v.autoSend !== false, (x) => saveSettings({ voice: { autoSend: x } }))),
    field(t('speak_replies'), toggle(v.speakReplies !== false, (x) => saveSettings({ voice: { speakReplies: x } }))),
    field(t('voice_pick'), h('div', { style: 'display:flex;gap:8px' }, voiceSel,
      h('button', { class: 'btn', onclick: async () => {
        const r = await Voice.speak(t('voice_test_text'), { voiceName: voiceSel.value });
        if (r.reason === 'no_arabic_voice') toast(t('no_arabic_voice'));
      } }, t('test_voice')))),
    micTestField()));
}
/** Record one sentence and show what was understood — a one-click end-to-end voice check. */
function micTestField() {
  const out = h('div', { class: 'out', dir: 'auto' }, t('mic_test_hint'));
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    btn.disabled = true; out.textContent = t('mic_test_listening');
    try {
      const rec = new Voice.Recorder({ noSpeechMs: 8000 });
      const res = await rec.record();
      if (!res.pcm) { out.textContent = '—'; return; }
      out.textContent = t('mic_test_working');
      const r = await window.ASR.transcribe(res.pcm, { language: asrLanguage(), model: voiceSettings().model });
      const raw = r.text;
      out.textContent = `${raw || '—'}   (${(r.ms / 1000).toFixed(1)}s · ${r.device === 'webgpu' ? t('asr_gpu') : t('asr_cpu')})`;
      if (raw && voiceSettings().smartFix !== false) {
        out.textContent += `\n${t('voice_fixing')}`;
        const f = await api.voice.fix(raw, null);
        out.textContent = `${t('heard_raw')}: ${raw}\n${t('after_fix')}: ${f && f.text ? f.text : raw}   (${(r.ms / 1000).toFixed(1)}s · ${r.device === 'webgpu' ? t('asr_gpu') : t('asr_cpu')})`;
      }
    } catch (e) { out.textContent = e && e.name === 'NotAllowedError' ? t('mic_denied') : `✖ ${(e && e.message) || e}`; }
    finally { btn.disabled = false; }
  } }, `🎙 ${t('mic_test')}`);
  const lang = h('select', { onchange: (e) => saveSettings({ voice: { language: e.target.value } }) },
    h('option', { value: 'auto' }, t('lang_auto')), h('option', { value: 'ar' }, 'العربية'), h('option', { value: 'en' }, 'English'));
  lang.value = voiceSettings().language || 'auto';
  const st = window.ASR ? window.ASR.status() : { status: 'idle' };
  const model = h('select', { onchange: async (e) => { await saveSettings({ voice: { model: e.target.value } }); if (window.ASR) window.ASR.load(e.target.value).catch(() => {}); } },
    h('option', { value: 'onnx-community/whisper-large-v3-turbo' }, t('model_fast')), h('option', { value: 'onnx-community/whisper-large-v3-ONNX' }, t('model_accurate')));
  model.value = voiceSettings().model || 'onnx-community/whisper-large-v3-turbo';
  const vocab = h('textarea', { class: 'memory', rows: 2, dir: 'auto', placeholder: t('vocab_ph') }); vocab.value = voiceSettings().vocabulary || '';
  vocab.onchange = () => saveSettings({ voice: { vocabulary: vocab.value } });
  return h('div', {},
    field(t('speech_lang'), lang),
    field(t('speech_model'), model, t('speech_model_help')),
    field(t('smart_fix'), toggle(voiceSettings().smartFix !== false, (v) => saveSettings({ voice: { smartFix: v } })), t('smart_fix_help')),
    h('div', { class: 'field', style: 'display:block' }, h('label', {}, t('vocab')), h('p', { class: 'help', style: 'margin:4px 0' }, t('vocab_help')), vocab),
    field(t('speech_engine'), h('span', { id: 'asrStatus', class: 'help', style: 'margin:0' }, asrStatusText(st))),
    h('div', { class: 'field', style: 'display:block' }, h('label', {}, t('mic_test')), h('div', { class: 'mic-test', style: 'margin-top:8px' }, btn, out)));
}

function paneAbout(pane) {
  pane.append(h('h2', {}, 'Majlis'), h('p', { class: 'help' }, t('welcome_sub')),
    h('div', { class: 'card' },
      field(t('version'), h('span', {}, S.info.version)),
      field(t('data_folder'), h('button', { class: 'btn', onclick: () => api.shell.openPath(S.info.dataDir) }, t('open'))),
      field('GitHub', h('button', { class: 'btn', onclick: () => api.shell.openExternal('https://github.com/abdullah7979/majlis') }, 'abdullah7979/majlis'))),
    h('p', { class: 'help' }, t('ob_note')));
}

// ------------------------------------------------------------------ prompts (✨ improve + "/" library)
async function improveCurrent() {
  const input = $('#input'); const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const btn = $('#improveBtn'); if (btn.disabled) return;
  btn.disabled = true; btn.classList.add('busy'); toast(t('improving'));
  try {
    const r = await api.chat.improve(text);
    if (!r || !r.ok || !r.text) { toast(t('improve_failed')); return; }
    input.focus(); input.select();
    // insertText keeps Ctrl+Z working, so the original request is one undo away.
    if (!document.execCommand('insertText', false, r.text)) input.value = r.text;
    autoGrow(); toast(t('improved'));
  } finally { btn.disabled = false; btn.classList.remove('busy'); }
}

const PM = { open: false, items: [], index: 0, fromSlash: false };
function promptList() { return (S.settings.prompts || []).filter((p) => p && p.text); }
function openPromptMenu({ fromSlash = false } = {}) {
  PM.open = true; PM.fromSlash = fromSlash; PM.index = 0; renderPromptMenu();
}
function closePromptMenu() { PM.open = false; $('#promptMenu').classList.add('hidden'); }
function renderPromptMenu() {
  const menu = $('#promptMenu'); const input = $('#input');
  const q = PM.fromSlash ? input.value.slice(1).trim().toLowerCase() : '';
  PM.items = promptList().filter((p) => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
  if (PM.index >= PM.items.length) PM.index = 0;
  menu.innerHTML = '';
  menu.append(h('div', { class: 'pm-head' }, h('span', {}, `📚 ${t('prompts')}`), h('button', { class: 'link', onclick: () => { closePromptMenu(); openSettings('prompts'); } }, '⚙')));
  if (!PM.items.length) menu.append(h('div', { class: 'pm-empty' }, t('no_match')));
  PM.items.forEach((p, i) => menu.append(h('button', { class: `pm-item${i === PM.index ? ' on' : ''}`, onmousedown: (e) => { e.preventDefault(); applyPrompt(p); } },
    h('b', {}, p.name), h('span', { dir: 'auto' }, p.text.replace(/\s+/g, ' ').slice(0, 90)))));
  menu.classList.remove('hidden');
}
function applyPrompt(p) {
  const input = $('#input');
  const existing = PM.fromSlash ? '' : input.value.trim();
  let text = p.text;
  if (text.includes('{text}')) text = text.replace('{text}', existing);
  else if (existing) text = text.replace(/\s*$/, '\n\n') + existing;
  input.value = text;
  closePromptMenu(); autoGrow(); input.focus();
  const at = p.text.includes('{text}') && !existing ? p.text.indexOf('{text}') : text.length;
  input.setSelectionRange(at, at);
}
function promptMenuKey(e) {
  if (!PM.open) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = PM.items.length || 1; PM.index = (PM.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderPromptMenu(); return true; }
  if ((e.key === 'Enter' || e.key === 'Tab') && PM.items.length) { e.preventDefault(); applyPrompt(PM.items[PM.index]); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closePromptMenu(); return true; }
  return false;
}
async function saveAsPrompt(text) {
  const prompts = (S.settings.prompts || []).slice();
  prompts.push({ id: 'p' + Date.now().toString(36), name: text.replace(/\s+/g, ' ').slice(0, 28), text });
  await saveSettings({ prompts }); toast(t('saved'));
}

function panePrompts(pane) {
  const list = h('div', {});
  const save = (prompts) => saveSettings({ prompts });
  const draw = () => {
    list.innerHTML = '';
    const prompts = (S.settings.prompts || []).slice();
    prompts.forEach((p, i) => {
      const name = h('input', { type: 'text', value: p.name, dir: 'auto', placeholder: t('prompt_name') });
      const text = h('textarea', { class: 'memory', rows: 3, dir: 'auto', placeholder: t('prompt_text') }); text.value = p.text;
      const commit = () => { prompts[i] = { ...p, name: name.value.trim() || t('prompts'), text: text.value }; save(prompts); };
      name.onchange = commit; text.onchange = commit;
      list.append(h('div', { class: 'card prompt-card' }, h('div', { class: 'row' }, name,
        h('button', { class: 'btn danger', onclick: async () => { prompts.splice(i, 1); await save(prompts); draw(); } }, t('delete'))), text));
    });
  };
  pane.append(h('h2', {}, t('tab_prompts')), h('p', { class: 'help' }, t('prompts_help')), list,
    h('button', { class: 'btn primary', onclick: async () => {
      const prompts = (S.settings.prompts || []).concat([{ id: 'p' + Date.now().toString(36), name: '', text: '' }]);
      S.settings.prompts = prompts; draw(); const last = $$('.prompt-card input', list).pop(); if (last) last.focus();
    } }, t('add_prompt')));
  draw();
}

// ------------------------------------------------------------------ Connect (API)
async function paneApi(pane) {
  const st = await api.api.status();
  const a = st.settings || {};
  const base = () => `http://${a.allowLan ? '<IP>' : '127.0.0.1'}:${st.port || a.port || 4891}/v1`;
  const copyBtn = (get) => h('button', { class: 'btn', onclick: async () => { await navigator.clipboard.writeText(get()); toast(t('copied')); } }, t('copy'));
  let key = st.key;
  const keyBox = h('code', { class: 'secret', dir: 'ltr' }, key.slice(0, 7) + '••••••••••••' + key.slice(-4));
  const status = h('span', { class: `state ${st.running ? 'ok' : 'warn'}` }, st.running ? `${t('api_running')} · ${st.requests} ${t('api_requests')}` : t('api_stopped'));
  const apply = async (patch) => {
    await saveSettings({ api: patch });
    const r = await api.api.apply();
    if (!r.ok) toast(r.error === 'port_in_use' ? t('api_port_in_use') : `✖ ${r.error}`);
    pane.innerHTML = ''; paneApi(pane);
  };
  const autonomy = h('select', { onchange: (e) => saveSettings({ api: { autonomy: e.target.value } }) },
    ['safe', 'edit', 'full'].map((k) => h('option', { value: k }, t(`autonomy_${k}`))));
  autonomy.value = a.autonomy || 'safe';
  const curl = () => `curl ${base()}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d "{\\"model\\":\\"majlis-auto\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"لخص لي هذا النص\\"}]}"`;
  const py = () => `from openai import OpenAI\nclient = OpenAI(base_url="${base()}", api_key="${key}")\nr = client.chat.completions.create(\n    model="majlis-auto",   # or majlis-council, claude:opus, codex:gpt-6-luna ...\n    messages=[{"role": "user", "content": "اكتب لي رد على هذا الإيميل"}],\n)\nprint(r.choices[0].message.content)`;
  const n8n = () => `n8n → OpenAI Chat Model (or "OpenAI" node)\n  Credentials → API Key: ${key}\n               Base URL: ${base()}\n  Model: majlis-auto`;
  const ex = (title, get) => h('details', { class: 'example' }, h('summary', {}, title), h('pre', { class: 'log', dir: 'ltr' }, get()), copyBtn(get));
  pane.append(h('h2', {}, t('api_title')), h('p', { class: 'help' }, t('api_help')),
    h('div', { class: 'card' },
      field(t('api_enable'), h('div', { style: 'display:flex;gap:10px;align-items:center' }, status, toggle(!!a.enabled, (v) => apply({ enabled: v })))),
      field(t('api_address'), h('div', { style: 'display:flex;gap:8px;align-items:center' }, h('code', { dir: 'ltr' }, base()), copyBtn(base))),
      field(t('api_key'), h('div', { style: 'display:flex;gap:8px;align-items:center' }, keyBox, copyBtn(() => key),
        h('button', { class: 'btn', onclick: async () => { if (!confirm(t('regen_confirm'))) return; key = await api.api.regenerateKey(); pane.innerHTML = ''; paneApi(pane); } }, t('regen')))),
      field(t('api_port'), h('input', { type: 'number', min: 1024, max: 65535, value: a.port || 4891, onchange: (e) => apply({ port: Math.max(1024, Math.min(65535, Number(e.target.value) || 4891)) }) })),
      field(t('api_lan'), toggle(!!a.allowLan, (v) => apply({ allowLan: v })), t('api_lan_help')),
      field(t('api_autonomy'), autonomy),
      field(t('api_models'), h('code', { dir: 'ltr' }, 'majlis-auto · majlis-council · claude:opus'), t('api_models_help')),
      field(t('api_test'), (() => { const out = h('span', { class: 'help', style: 'margin:0' }); const b = h('button', { class: 'btn', onclick: async () => {
        b.disabled = true; out.textContent = '…';
        const r = await api.api.selftest(); b.disabled = false;
        out.textContent = r.ok ? `✓ ${t('api_test_ok')} (${r.models} ${t('api_models_count')}, ${r.ms}ms)` : `✖ ${r.error}`;
        out.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
      } }, t('api_test_btn')); return h('div', { style: 'display:flex;gap:10px;align-items:center' }, b, out); })())),
    h('h2', { style: 'margin-top:22px' }, t('api_examples')),
    h('div', { class: 'card' }, ex('Python (openai)', py), ex('curl', curl), ex('n8n / Make / Zapier', n8n)));
}

// ------------------------------------------------------------------ Automations
async function paneAutos(pane) {
  let tasks = await api.auto.list();
  const dayNames = t('days').split(',');
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString(S.lang === 'ar' ? 'ar-SA-u-nu-latn' : undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '—');
  const list = h('div', {});
  const editor = (task, onDone) => {
    const tk = JSON.parse(JSON.stringify(task));
    tk.schedule = tk.schedule || { type: 'daily', time: '08:00', days: [0, 1, 2, 3, 4], every: 6 };
    const name = h('input', { type: 'text', dir: 'auto', value: tk.name || '', placeholder: t('auto_ex1') });
    const prompt = h('textarea', { class: 'memory', rows: 4, dir: 'auto', placeholder: t('auto_ex1_p') }); prompt.value = tk.prompt || '';
    const type = h('select', {}, ['daily', 'weekly', 'hours'].map((k) => h('option', { value: k }, t(`auto_${k}`)))); type.value = tk.schedule.type;
    const time = h('input', { type: 'time', value: tk.schedule.time || '08:00' });
    const every = h('input', { type: 'number', min: 1, max: 168, value: tk.schedule.every || 6, style: 'width:70px' });
    const days = h('div', { class: 'days' }, dayNames.map((d, i) => h('label', {}, h('input', { type: 'checkbox', checked: (tk.schedule.days || []).includes(i), 'data-day': i }), d)));
    const mode = h('select', {}, h('option', { value: 'auto' }, t('auto_mode_auto')), h('option', { value: 'council' }, t('auto_mode_council'))); mode.value = tk.mode || 'auto';
    const when = h('div', { class: 'when' });
    const drawWhen = () => {
      when.innerHTML = '';
      if (type.value === 'hours') when.append(h('span', {}, t('auto_every')), every, h('span', {}, t('auto_hours_unit')));
      else { if (type.value === 'weekly') when.append(days); when.append(h('span', {}, t('auto_at')), time); }
    };
    type.onchange = drawWhen; drawWhen();
    const box = h('div', { class: 'card auto-edit' },
      field(t('auto_name'), name), h('div', { class: 'field', style: 'display:block' }, h('label', {}, t('auto_prompt')), prompt),
      field(t('auto_when'), h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, type, when)),
      field(t('auto_mode'), mode),
      h('div', { class: 'row', style: 'justify-content:flex-end;gap:8px' },
        h('button', { class: 'btn', onclick: onDone }, '✕'),
        h('button', { class: 'btn primary', onclick: async () => {
          if (!prompt.value.trim()) { prompt.focus(); return; }
          tasks = await api.auto.save({ ...tk, name: name.value.trim(), prompt: prompt.value.trim(), mode: mode.value,
            schedule: { type: type.value, time: time.value || '08:00', every: Number(every.value) || 6, days: $$('input[data-day]', days).filter((c) => c.checked).map((c) => +c.dataset.day) } });
          onDone();
        } }, t('save'))));
    return box;
  };
  const draw = () => {
    list.innerHTML = '';
    if (!tasks.length) list.append(h('p', { class: 'help' }, t('auto_none')));
    for (const tk of tasks) {
      const s = tk.schedule || {};
      const whenText = s.type === 'hours' ? `${t('auto_every')} ${s.every} ${t('auto_hours_unit')}`
        : `${s.type === 'weekly' ? (s.days || []).map((d) => dayNames[d]).join('، ') : t('auto_daily')} · ${s.time}`;
      const last = tk.lastRun ? `${fmt(tk.lastRun)} ${tk.lastStatus === 'done' ? '✓' : tk.lastStatus === 'running' ? '…' : tk.lastStatus ? '✖' : ''}` : '—';
      const card = h('div', { class: 'card auto-card' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, `⏰ ${tk.name}`, tk.mode === 'council' ? h('span', { class: 'vendor' }, '🏛') : null),
          h('div', { class: 'sub' }, h('span', {}, whenText), h('span', {}, `${t('auto_next')}: ${fmt(tk.nextRun)}`), h('span', {}, `${t('auto_last')}: ${last}`))),
          toggle(tk.enabled, async (v) => { tasks = await api.auto.save({ ...tk, enabled: v }); draw(); })),
        h('div', { class: 'sub prompt-preview', dir: 'auto' }, tk.prompt.slice(0, 160)),
        h('div', { class: 'row', style: 'gap:8px;justify-content:flex-end' },
          tk.conversationId ? h('button', { class: 'btn', onclick: () => { closeOverlay(); openConversation(tk.conversationId); } }, t('auto_open')) : null,
          h('button', { class: 'btn', onclick: () => { card.replaceWith(editor(tk, draw)); } }, '✎'),
          h('button', { class: 'btn danger', onclick: async () => { tasks = await api.auto.remove(tk.id); draw(); } }, t('delete')),
          h('button', { class: 'btn primary', disabled: tk.running, onclick: async (e) => { e.target.disabled = true; e.target.textContent = t('auto_running'); await api.auto.run(tk.id); setTimeout(async () => { tasks = await api.auto.list(); draw(); refreshConvs(); }, 1500); } }, tk.running ? t('auto_running') : t('auto_run_now'))));
      list.append(card);
    }
  };
  const addBtn = h('button', { class: 'btn primary', onclick: () => { addBtn.before(editor({ name: '', prompt: '', enabled: true, mode: 'auto' }, () => { pane.innerHTML = ''; paneAutos(pane); })); } }, t('auto_new'));
  pane.append(h('h2', {}, t('autos_title')), h('p', { class: 'help' }, t('autos_help')), list, addBtn);
  if (!S.settings.closeToTray) pane.append(h('p', { class: 'help', style: 'margin-top:14px' }, t('auto_tray_note')));
  draw();
  const off = api.auto.onChanged(async () => { if (!pane.isConnected) return off(); tasks = await api.auto.list(); draw(); });
}

// ------------------------------------------------------------------ onboarding
async function showOnboarding() {
  const node = await api.system.checkNode();
  const box = h('div', { class: 'onboard' });
  const nodeCard = h('div', { class: 'card prov-card' },
    h('div', { class: 'avatar', style: 'background:#6cc24a' }, 'JS'),
    h('div', {}, h('div', { class: 'name' }, t('ob_node')), h('div', { class: 'sub' },
      node.installed ? h('span', { class: 'state ok' }, `${t('ob_node_ok')} ${node.version}`) : h('span', { class: 'state bad' }, t('ob_node_missing')))),
    h('div', { class: 'acts' }, node.installed ? null : h('button', { class: 'btn primary', onclick: () => api.shell.openExternal('https://nodejs.org/en/download') }, t('get_node')),
      node.installed ? null : h('button', { class: 'btn', onclick: () => showOnboarding() }, t('recheck'))));
  box.append(
    h('div', { class: 'top' }, h('img', { src: '../../build/icon.png' }), h('h2', {}, t('ob_title')), h('p', { class: 'help' }, t('ob_sub'))),
    nodeCard,
    ...PROVIDER_IDS.filter((id) => S.providers[id]).map((id) => providerCard(id)),
    h('p', { class: 'note' }, t('ob_note')),
    h('div', { class: 'end' },
      h('button', { class: 'link', onclick: finish }, t('ob_skip')),
      h('button', { class: 'btn primary', onclick: finish }, t('ob_done'))));
  overlay(box);
  async function finish() { await saveSettings({ onboarded: true }); closeOverlay(); refreshProviders(); $('#input').focus(); }
}

// ------------------------------------------------------------------ voice self-test (CI / diagnostics)
async function runVoiceSelftest({ file, model, language }) {
  try {
    while (!window.ASR) await new Promise((r) => setTimeout(r, 200));
    const url = 'file:///' + file.replace(/\\/g, '/').replace(/^\/+/, '');
    const blob = await (await fetch(url)).blob();
    const pcm = await Voice.toPcm16k(blob);
    const t0 = Date.now();
    await window.ASR.load(model || voiceSettings().model);
    const loadMs = Date.now() - t0;
    const r = await window.ASR.transcribe(pcm, { language: language || 'auto', model: model || voiceSettings().model });
    await api.selftestResult({ ok: !!r.text, text: r.text, ms: r.ms, loadMs, device: r.device, model: window.ASR.status().model, fallback: window.ASR.status().fallback || null, seconds: +(pcm.length / 16000).toFixed(1) });
  } catch (e) {
    await api.selftestResult({ ok: false, error: String((e && e.stack) || e) });
  }
}

// ------------------------------------------------------------------ boot
function systemLang() { return /^ar/i.test(S.info.locale || navigator.language) ? 'ar' : 'en'; }
async function boot() {
  S.info = await api.info();
  S.settings = await api.settings.get();
  setLanguage(S.settings.language || systemLang());
  api.chat.onEvent(onChatEvent);
  api.onFocusInput(() => $('#input').focus());
  api.onNewConversation(() => showWelcome());
  api.onUpdate((u) => {
    const bar = $('#updateBar'); bar.classList.remove('hidden'); bar.innerHTML = '';
    if (u.state === 'ready') bar.append(h('span', {}, `${t('update_ready')} (${u.version})`), h('button', { onclick: () => api.installUpdate() }, t('restart')));
    else bar.append(h('span', {}, `${t('downloading_update')} ${u.version}…`));
  });

  $('#newChat').onclick = showWelcome;
  $('#openSettings').onclick = () => openSettings('providers');
  $('#search').oninput = renderSidebar;
  $('#wsChip').onclick = pickWorkspace;
  $('#convTitle').onchange = async (e) => { if (S.conv) { S.conv = { ...S.conv, ...(await api.conv.update(S.conv.id, { title: e.target.value })) }; refreshConvs(); } };
  $('#convTitle').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  $$('[data-ex]').forEach((b) => { b.onclick = () => { $('#input').value = t(b.dataset.ex); autoGrow(); $('#input').focus(); }; });
  const input = $('#input');
  input.oninput = () => {
    autoGrow();
    if (/^\/[^\n]{0,40}$/.test(input.value)) openPromptMenu({ fromSlash: true });
    else if (PM.open && PM.fromSlash) closePromptMenu();
  };
  input.onblur = () => setTimeout(closePromptMenu, 150);
  input.onkeydown = (e) => {
    if (promptMenuKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); }
  };
  $('#improveBtn').onclick = improveCurrent;
  $('#promptsBtn').onclick = () => (PM.open ? closePromptMenu() : openPromptMenu());
  $('#openAutos').onclick = () => openSettings('autos');
  $('#sendBtn').onclick = sendCurrent;
  $('#attachBtn').onclick = async () => { const f = await api.dialog.pickFiles(); S.pendingFiles.push(...f); renderAttachments(); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyN') { e.preventDefault(); showWelcome(); }
    if ((e.ctrlKey || e.metaKey) && e.code === 'Comma') { e.preventDefault(); openSettings(); }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyM') { e.preventDefault(); listen(); }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyI') { e.preventDefault(); improveCurrent(); }
    if (e.key === 'Escape' && (V.mode || V.state !== 'idle')) stopVoice();
    if (e.key === 'Escape' && !$('#overlay').classList.contains('hidden') && S.settings.onboarded) closeOverlay();
  });
  // drag & drop files anywhere on the chat
  const chat = $('#chat'); let depth = 0;
  chat.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; $('#dropHint').classList.remove('hidden'); });
  chat.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#dropHint').classList.add('hidden'); } });
  chat.addEventListener('dragover', (e) => e.preventDefault());
  chat.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; $('#dropHint').classList.add('hidden');
    for (const f of e.dataTransfer.files) { const p = api.pathForFile(f); if (p) S.pendingFiles.push(p); }
    renderAttachments();
  });

  // Mic: click = talk until you stop; press and hold = talk while holding.
  let holdTimer = null, holding = false;
  $('#micBtn').onpointerdown = () => { holding = false; holdTimer = setTimeout(() => { holding = true; if (V.state !== 'listening') listen(); }, 350); };
  $('#micBtn').onpointerup = () => { clearTimeout(holdTimer); if (holding) { if (V.rec) V.rec.stop(); } else listen(); holding = false; };
  $('#micBtn').onpointerleave = () => { clearTimeout(holdTimer); if (holding && V.rec) V.rec.stop(); holding = false; };
  $('#councilBtn').onclick = () => { S.councilOn = !S.councilOn; $('#councilBtn').classList.toggle('on', S.councilOn); toast(t(S.councilOn ? 'council_on' : 'council_off')); };
  $('#voiceModeBtn').onclick = toggleVoiceMode;
  $('#vbStop').onclick = onVoiceBarButton;
  await Promise.all([refreshConvs(), refreshProviders()]);
  initASR();
  if (S.info.voiceSelftest) { runVoiceSelftest(S.info.voiceSelftest); return; }
  showWelcome();
  setInterval(refreshProviders, 60000);
  if (!S.settings.onboarded) await showOnboarding();
  api.smokeOk();
}

window.addEventListener('error', (e) => console.error('UI error:', e.message));
boot().catch((e) => console.error('boot error:', e && e.stack ? e.stack : e));
