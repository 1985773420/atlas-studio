/* ============================================================================
   app.js —— 装配与启动：主题、账号门、引擎状态、模块接线
   ========================================================================== */

import { api } from './api.js';
import { state } from './state.js';
import { toast } from './ui.js';
import * as auth from './auth.js';
import * as router from './router.js';
import * as composer from './composer.js?v=20261118v13';
import * as gallery from './gallery.js';
import * as jobs from './jobs.js';
import * as library from './library.js';
import * as viewer from './viewer.js';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- 主题 */
const THEME_META = { dark: '#090a0d', light: '#f6f5f2' };

function preferredTheme() {
  try {
    const saved = localStorage.getItem('atlas-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (e) { /* 隐私模式 */ }
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
}

function applyTheme(t, animate) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-anim');
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => root.classList.remove('theme-anim'), 420);
  }
  root.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_META[t] || THEME_META.dark);
}

function initTheme() {
  applyTheme(preferredTheme(), false);
  const flip = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('atlas-theme', next); } catch (e) { /* ignore */ }
    applyTheme(next, true);
  };
  // 创作台顶栏一个，登录门里一个 —— 两处都能切
  ['theme-toggle', 'gate-theme'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', flip);
  });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e) => {
      let saved = null;
      try { saved = localStorage.getItem('atlas-theme'); } catch (err) { /* ignore */ }
      if (!saved) applyTheme(e.matches ? 'light' : 'dark', true);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

/* ---------------------------------------------------------------- 引擎状态 */
function setLive(stateName, text) {
  const box = $('live');
  if (!box) return;
  box.dataset.state = stateName;
  $('live-text').textContent = text;
}

async function pollHealth() {
  try {
    const h = await api('/api/health');
    if (h.cloud) setLive('ok', '云端在线');
    else setLive('bad', '云端未配置');
  } catch (e) {
    setLive('bad', '连接失败');
  }
}

/* ---------------------------------------------------------------- 创作台 */
let appReady = false;

async function startApp() {
  auth.paintUser();
  pollHealth();
  setInterval(pollHealth, 20000);

  if (appReady) { await gallery.load(); return; }

  let modes = [];
  try {
    const data = await api('/api/modes');
    modes = data.modes || [];
  } catch (e) {
    setLive('bad', '后端未就绪');
    return;
  }

  composer.init(modes);
  viewer.init({ onReuse: composer.reuseItem });
  gallery.init({
    onRetry: (cfg) => jobs.submit(cfg),
    onReuse: composer.reuseItem,
  });
  jobs.init({
    createCard: gallery.createCard,
    updateCard: gallery.updateCard,
    finishCard: gallery.finishCard,
    failCard: gallery.failCard,
    onActive: composer.setActive,
  });
  library.init({
    onApply: (item) => {
      router.go('create');                 // 从画廊点「用这个生成」先回创作间
      composer.applyPrompt(item.prompt, item.ratio);
    },
  });

  router.init();
  appReady = true;
  await gallery.load();
}

/* ---------------------------------------------------------------- 启动 */
async function boot() {
  initTheme();

  try {
    await auth.loadSession();
  } catch (e) {
    // 后端没起来也要能显示登录门（会给出网络错误提示）
  }

  auth.initAuth(startApp);

  // 任何请求撞到 401（会话过期 / 被封禁）→ 收回登录门
  window.addEventListener('atlas:unauth', () => {
    if (!auth.isAuthed()) return;
    auth.clearUser();
    toast('登录已失效，请重新登录');
    auth.showGate();
  });

  if (!auth.isAuthed()) {
    auth.showGate();
    return;
  }
  await startApp();
}

boot();
