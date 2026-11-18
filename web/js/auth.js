/* ============================================================================
   auth.js —— 账号：登录门、用户菜单、修改密码
   站点是"进来才能创作"的：没登录时整页是登录门，登录后才装配创作台。
   ========================================================================== */

import { api, postJSON } from './api.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);

export const auth = {
  user: null,
  admin: false,
  registration: { open: true, invite_required: false },
  site: 'Atlas Studio',
};

/* ---------------------------------------------------------------- 会话 */
export async function loadSession() {
  const s = await api('/api/auth/session');
  auth.user = s.user;
  auth.admin = !!s.admin;
  auth.registration = s.registration || auth.registration;
  auth.site = s.site || auth.site;
  return s;
}

export function isAuthed() {
  return !!(auth.user && auth.user.uid);
}

export function clearUser() {
  auth.user = null;
  auth.admin = false;
}

/* ---------------------------------------------------------------- 登录门 */
let gateMode = 'login';
let onAuthed = null;

function gateError(msg) {
  const box = $('g-err');
  if (!box) return;
  box.textContent = msg || '';
  box.hidden = !msg;
}

function setTab(tab) {
  gateMode = tab === 'register' ? 'register' : 'login';
  const reg = gateMode === 'register';
  const tabs = document.querySelector('.gate-tabs');
  if (tabs) {
    tabs.dataset.tab = gateMode;
    tabs.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === gateMode));
    });
  }
  $('g-pass2-row').hidden = !reg;
  $('g-invite-row').hidden = !(reg && auth.registration.invite_required);
  $('g-submit-text').textContent = reg ? '注册并进入' : '登录';
  $('g-title').textContent = reg ? '开一个账号' : '进入暗房';
  $('g-sub').textContent = reg
    ? '用户名就是登录名，只允许小写字母、数字、下划线和连字符。'
    : '登录后开始创作。作品按账号存放，别人看不到你的东西。';
  $('g-note').textContent = reg && !auth.registration.open
    ? '当前未开放自助注册，请联系管理员开通账号。'
    : '';
  $('g-pass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  gateError('');
}

function gateBusy(on) {
  const b = $('g-submit');
  if (!b) return;
  b.disabled = on;
  b.classList.toggle('busy', on);
  $('g-submit-text').textContent = on
    ? (gateMode === 'register' ? '正在创建…' : '正在登录…')
    : (gateMode === 'register' ? '注册并进入' : '登录');
}

export function showGate() {
  const gate = $('gate');
  if (!gate) return;
  document.body.classList.add('gated');
  gate.hidden = false;

  // 不开放注册时把「注册」页签藏掉，避免点了才被拒
  const regBtn = document.querySelector('.gate-tabs button[data-tab="register"]');
  if (regBtn) regBtn.hidden = !auth.registration.open;
  setTab('login');

  // 有历史的用户名先填上，少打一次字
  try {
    const last = localStorage.getItem('atlas-last-user');
    if (last && !$('g-user').value) {
      $('g-user').value = last;
      $('g-pass').focus();
    } else {
      $('g-user').focus();
    }
  } catch (e) { /* 隐私模式 */ }
}

function closeGate() {
  const gate = $('gate');
  if (gate) gate.hidden = true;
  document.body.classList.remove('gated');
}

function bindGate() {
  const tabs = document.querySelector('.gate-tabs');
  if (tabs) {
    tabs.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
    });
  }

  const form = $('gate-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('g-submit').disabled) return;
    gateError('');

    const username = ($('g-user').value || '').trim().toLowerCase();
    const password = $('g-pass').value || '';
    if (!username) { gateError('请填用户名'); $('g-user').focus(); return; }
    if (!password) { gateError('请填密码'); $('g-pass').focus(); return; }

    const body = { username, password };
    if (gateMode === 'register') {
      if (password.length < 6) { gateError('密码至少 6 位'); return; }
      if (password !== $('g-pass2').value) { gateError('两次密码不一致'); return; }
      if (auth.registration.invite_required) body.invite = ($('g-invite').value || '').trim();
    }

    gateBusy(true);
    try {
      const url = gateMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const r = await postJSON(url, body);
      auth.user = r.user;
      auth.admin = r.admin !== undefined ? !!r.admin : (r.user && r.user.role === 'admin');
      try { localStorage.setItem('atlas-last-user', username); } catch (err) { /* ignore */ }
      closeGate();
      if (onAuthed) await onAuthed();
    } catch (err) {
      gateError(err.message || '登录失败');
      $('g-pass').select();
    } finally {
      gateBusy(false);
    }
  });
}

/* ---------------------------------------------------------------- 用户菜单 */
export function paintUser() {
  const u = auth.user;
  const box = $('user-box');
  if (!u || !box) return;
  const name = u.name || u.uid;
  $('user-av').textContent = name.slice(0, 1);
  $('user-name').textContent = name;
  $('um-name').textContent = name;
  $('um-meta').textContent = [
    u.role === 'admin' ? '管理员' : '普通用户',
    u.works != null ? u.works + ' 张作品' : '',
  ].filter(Boolean).join(' · ');
  if ($('admin-link')) $('admin-link').hidden = !auth.admin;
}

function closeMenu() {
  const m = $('user-menu');
  const c = $('user-chip');
  if (m) m.hidden = true;
  if (c) c.setAttribute('aria-expanded', 'false');
}

function bindUser() {
  const chip = $('user-chip');
  const menu = $('user-menu');
  if (!chip || !menu) return;

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); closePw(); }
  });

  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    closeMenu();
    if (act === 'password') openPw();
    if (act === 'logout') {
      // 退出瞬间还有轮询在飞，标记一下让 401 不再弹"登录已失效"
      document.documentElement.dataset.signingOut = '1';
      try { await postJSON('/api/auth/logout', {}); } catch (err) { /* ignore */ }
      location.href = '/';
    }
  });
}

/* ---------------------------------------------------------------- 修改密码 */
function openPw() {
  const m = $('pw-modal');
  if (!m) return;
  ['pw-cur', 'pw-new', 'pw-new2'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
  const err = $('pw-err');
  if (err) { err.hidden = true; err.textContent = ''; }
  m.hidden = false;
  $('pw-cur').focus();
}

function closePw() {
  const m = $('pw-modal');
  if (m) m.hidden = true;
}

function bindPw() {
  const form = $('pw-form');
  if (!form) return;
  $('pw-cancel').addEventListener('click', closePw);
  form.addEventListener('click', (e) => { if (e.target === form) closePw(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('pw-err');
    const cur = $('pw-cur').value || '';
    const nw = $('pw-new').value || '';
    if (($('pw-new2').value || '') !== nw) { err.textContent = '两次新密码不一致'; err.hidden = false; return; }
    if (nw.length < 6) { err.textContent = '新密码至少 6 位'; err.hidden = false; return; }
    try {
      await postJSON('/api/auth/password', { current: cur, new: nw });
      closePw();
      toast('密码已更新');
    } catch (ex) {
      err.textContent = ex.message || '修改失败';
      err.hidden = false;
    }
  });
}

/* ---------------------------------------------------------------- 入口 */
export function initAuth(handler) {
  onAuthed = handler;
  bindGate();
  bindUser();
  bindPw();
}
