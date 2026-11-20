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
function modelLabel(provider, model) {
  const p = S.providers[provider];
  const m = p && p.models.find((x) => x.id === model);
  if (m) return m.label;
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
    const st = !p.installed || !p.enabled ? 'off' : p.cooldownUntil ? 'cool' : 'ok';
    const tip = st === 'cool' ? `${t('resting_until')} ${fmtTime(p.cooldownUntil)}` : st === 'ok' ? `${t('ready')} · ${p.usageToday} ${t('requests_today')}` : p.installed ? t('skipped_disabled') : t('not_installed');
    box.append(h('span', { class: `pdot ${st}`, title: tip, onclick: () => openSettings('providers') }, h('i'), p.label));
  }
  buildModelPicker();
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
    h('div', { class: 'bubble', dir: 'auto' }, m.text,
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
    box.append(h('span', { class: `step ${kind === 'limit' || kind === 'cooldown' ? kind : 'fail'}`, title: s.message || '' }, `${modelLabel(s.provider, s.model)} · ${why}`));
  });
  return box;
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
    m.routeSource && m.category !== 'manual' ? h('span', { class: 'tag mute', title: m.reason || '' }, t(m.routeSource)) : null);
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
  if (m.status === 'failed') {
    el.append(h('div', { class: 'notice' }, m.error || t('all_failed'), h('button', { onclick: () => openSettings('providers') }, t('open_settings'))));
  }
  if (m.status === 'cancelled' && !m.text) el.append(h('div', { class: 'status-line' }, t('cancelled')));
  if (m.status === 'done') {
    const foot = h('div', { class: 'msg-foot' },
      h('button', { onclick: (e) => { navigator.clipboard.writeText(m.text); e.target.textContent = t('copied'); setTimeout(() => (e.target.textContent = t('copy')), 1400); } }, t('copy')),
      h('span', {}, '·'), h('span', {}, fmtTime(m.ts)));
    if (m.category && m.category !== 'manual') {
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
    case 'done': Object.assign(m, { status: 'done', text: e.text, provider: e.provider, model: e.model, providerLabel: e.label }); break;
    case 'failed': Object.assign(m, { status: 'failed', error: e.error || null }); break;
    case 'cancelled': m.status = 'cancelled'; break;
    default: break;
  }
  queueRender(m);
  if (['done', 'failed', 'cancelled'].includes(e.type)) updateSendButton();
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
async function sendCurrent() {
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
  await api.chat.send({ conversationId: conv.id, text, files, force });
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
  const tabs = ['providers', 'routing', 'general', 'about'];
  const nav = h('nav', {}, h('h3', {}, t('settings')),
    tabs.map((k) => h('button', { 'data-tab': k, onclick: () => show(k) }, t(`tab_${k}`))),
    h('button', { class: 'x', onclick: closeOverlay }, '✕'));
  function show(k) {
    $$('button[data-tab]', nav).forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    pane.innerHTML = '';
    ({ providers: paneProviders, routing: paneRouting, general: paneGeneral, about: paneAbout })[k](pane);
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
    card.append(
      h('div', { class: `avatar ${id}` }, INITIAL[id]),
      h('div', {}, h('div', { class: 'name' }, `${p.label}`, h('span', { class: 'vendor' }, p.vendor)),
        h('div', { class: 'sub' }, state, p.version ? h('span', {}, `${t('version')} ${p.version}`) : null, p.installed ? h('span', {}, `${p.usageToday} ${t('requests_today')}`) : null)),
      acts);
    if (extra.hint) card.append(h('div', { class: 'hint' }, extra.hint));
    if (extra.result) card.append(h('div', { class: 'hint', style: `color:${extra.result.ok ? 'var(--ok)' : 'var(--bad)'}` }, extra.result.ok ? t('test_ok') : `${t(extra.result.kind === 'auth' ? 'signed_out' : extra.result.kind === 'limit' ? 'out_limit' : 'failed')} ${extra.result.message || ''}`));
    if (extra.log) card.append(h('pre', { class: 'log' }, extra.log));
  };
  async function reload() { S.providers = await api.providers.status(); Object.assign(p, S.providers[id]); draw(); refreshProviders(); onChange && onChange(); }
  async function install() {
    let log = '';
    const off = api.providers.onInstallLog((d) => { if (d.id === id) { log += d.text; draw({ busy: true, log: log.slice(-3000) }); } });
    draw({ busy: true });
    const r = await api.providers.install(id);
    off();
    if (!r.ok && r.reason === 'no_node') { draw({ hint: t('ob_node_missing') }); return; }
    await reload();
    if (!r.ok) draw({ log: r.log });
    else draw({ hint: t(`login_hint_${id}`) });
  }
  async function login() { await api.providers.login(id); draw({ hint: t(`login_hint_${id}`) }); setTimeout(reload, 20000); }
  async function test() { draw({ testing: true }); const r = await api.providers.test(id); await reload(); draw({ result: r }); }
  draw();
  return card;
}

function paneProviders(pane) {
  pane.append(h('h2', {}, t('tab_providers')), h('p', { class: 'help' }, t('ob_note')));
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

function modelOptions(provider, selected) {
  const p = S.providers[provider];
  const opts = [h('option', { value: '' }, t('default_model'))];
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
  const clsSel = h('select', { onchange: (e) => { const [provider, model] = e.target.value.split('|'); saveSettings({ classifier: { provider, model } }); } });
  for (const id of PROVIDER_IDS) {
    const p = S.providers[id]; if (!p) continue;
    clsSel.append(h('option', { value: `${id}|` }, `${p.label} — ${t('default_model')}`));
    for (const m of p.models) clsSel.append(h('option', { value: `${id}|${m.id}` }, m.label));
  }
  clsSel.value = `${s.classifier.provider}|${s.classifier.model}`;
  const autonomy = h('div', { class: 'radio-list' }, ['safe', 'edit', 'full'].map((k) => h('label', {},
    h('input', { type: 'radio', name: 'autonomy', value: k, checked: s.autonomy === k, onchange: () => saveSettings({ autonomy: k }) }), t(`autonomy_${k}`))));
  const num = (key, min, max) => h('input', { type: 'number', min, max, value: s[key], onchange: (e) => saveSettings({ [key]: Math.max(min, Math.min(max, Number(e.target.value) || min)) }) });
  const wsBtn = h('button', { class: 'btn', onclick: async () => { const d = await api.dialog.pickFolder(); if (d) { await saveSettings({ defaultWorkspace: d }); openSettings('general'); } } }, s.defaultWorkspace ? baseName(s.defaultWorkspace) : t('choose_folder'));
  pane.append(h('h2', {}, t('tab_general')), h('div', { class: 'card' },
    field(t('language'), lang),
    field(t('smart_routing'), toggle(s.smartRouting, (v) => saveSettings({ smartRouting: v })), t('smart_routing_help')),
    field(t('classifier'), clsSel),
    h('div', { class: 'field', style: 'display:block' }, h('label', {}, t('autonomy')), h('div', { style: 'margin-top:10px' }, autonomy)),
    field(t('default_workspace'), wsBtn),
    field(t('history_turns'), num('historyTurns', 1, 50)),
    field(t('cooldown'), num('cooldownMinutes', 5, 1440)),
    field(t('timeout'), num('timeoutMinutes', 1, 240)),
    field(t('close_to_tray'), toggle(s.closeToTray, (v) => saveSettings({ closeToTray: v }))),
    field(t('launch_login'), toggle(s.launchAtLogin, (v) => saveSettings({ launchAtLogin: v }))),
    field(t('shortcut'), h('input', { type: 'text', value: s.globalShortcut, dir: 'ltr', onchange: (e) => saveSettings({ globalShortcut: e.target.value.trim() }) }))));
}
function paneAbout(pane) {
  pane.append(h('h2', {}, 'Majlis'), h('p', { class: 'help' }, t('welcome_sub')),
    h('div', { class: 'card' },
      field(t('version'), h('span', {}, S.info.version)),
      field(t('data_folder'), h('button', { class: 'btn', onclick: () => api.shell.openPath(S.info.dataDir) }, t('open'))),
      field('GitHub', h('button', { class: 'btn', onclick: () => api.shell.openExternal('https://github.com/abdullah7979/majlis') }, 'abdullah7979/majlis'))),
    h('p', { class: 'help' }, t('ob_note')));
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
  input.oninput = autoGrow;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); } };
  $('#sendBtn').onclick = sendCurrent;
  $('#attachBtn').onclick = async () => { const f = await api.dialog.pickFiles(); S.pendingFiles.push(...f); renderAttachments(); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); showWelcome(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
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

  await Promise.all([refreshConvs(), refreshProviders()]);
  showWelcome();
  setInterval(refreshProviders, 60000);
  if (!S.settings.onboarded) await showOnboarding();
  api.smokeOk();
}

window.addEventListener('error', (e) => console.error('UI error:', e.message));
boot().catch((e) => console.error('boot error:', e && e.stack ? e.stack : e));
