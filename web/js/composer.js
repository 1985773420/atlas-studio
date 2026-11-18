/* ============================================================================
   composer.js —— 底部创作坞
   模式分段器（滑动块）· 引擎胶囊 · 尺寸/比例/数量 · 参考图 · 种子 · 提交
   ========================================================================== */

import { api } from './api.js';
import { state } from './state.js';
import { bindGlow } from './fx.js';
import { toast, showError, clearError } from './ui.js';
import * as jobs from './jobs.js';
import * as router from './router.js';

const $ = (id) => document.getElementById(id);
const els = {};

export function init(modes) {
  Object.assign(els, {
    modes: $('modes'),
    thumb: $('seg-thumb'),
    engPicker: $('engine-picker'),
    engTrigger: $('eng-trigger'),
    engLabel: $('eng-label'),
    engCount: $('eng-count'),
    engMenu: $('eng-menu'),
    sizeGroup: $('size-group'),
    ratioGroup: $('ratio-group'),
    countGroup: $('count-group'),
    prompt: $('prompt'),
    run: $('run'),
    badge: $('run-badge'),
    form: $('composer'),
    refRow: $('ref-row'),
    dropzone: $('dropzone'),
    refInput: $('ref-input'),
    refNote: $('ref-note'),
    dzText: $('dz-text'),
    seedToggle: $('seed-toggle'),
    seedRow: $('seed-row'),
    seed: $('seed'),
  });

  (modes || []).forEach((m) => { state.modes[m.id] = m; });
  bindGlow(els.run);
  initEnginePicker();

  els.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (btn) setMode(btn.dataset.mode);
  });
  els.form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  els.prompt.addEventListener('input', autosize);
  els.prompt.addEventListener('keydown', (e) => {
    if (!e.isComposing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  });
  els.seedToggle.addEventListener('click', () => {
    const open = els.seedRow.hidden;
    els.seedRow.hidden = !open;
    els.seedToggle.setAttribute('aria-expanded', String(open));
  });
  els.dropzone.addEventListener('click', () => els.refInput.click());
  els.refInput.addEventListener('change', () => {
    const file = els.refInput.files && els.refInput.files[0];
    if (file) uploadFile(file);
    els.refInput.value = '';
  });
  window.addEventListener('resize', moveThumb);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveThumb);

  setMode('generate');
}

/* ---------------------------------------------------------------- 模式 */
export function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.seg').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  });
  const meta = state.modes[mode] || {};
  els.prompt.placeholder = meta.placeholder || '描述你想要的画面…';
  els.refRow.hidden = !meta.needs_image;
  renderEngines();
  moveThumb();
  autosize();
}

function moveThumb() {
  const active = document.querySelector('.seg[aria-selected="true"]');
  if (!active || !els.thumb) return;
  els.thumb.style.width = active.offsetWidth + 'px';
  els.thumb.style.transform = 'translateX(' + (active.offsetLeft - 3) + 'px)';
}

/* ---------------------------------------------------------------- 引擎 */
function engineOptions() {
  const meta = state.modes[state.mode] || {};
  return (meta.cloud || []).map((c) => ({
    id: c.id,
    label: c.id,
    note: c.note || '云端 · 消耗额度',
  }));
}

function closeEngMenu() {
  if (!els.engMenu || els.engMenu.hidden) return;
  els.engMenu.hidden = true;
  els.engPicker.classList.remove('open');
  els.engTrigger.setAttribute('aria-expanded', 'false');
}

function openEngMenu() {
  const rect = els.engPicker.getBoundingClientRect();
  const menuSpace = 320;
  const openUp = window.innerHeight - rect.bottom < menuSpace && rect.top > menuSpace;
  els.engMenu.classList.toggle('up', openUp);
  els.engMenu.hidden = false;
  els.engPicker.classList.add('open');
  els.engTrigger.setAttribute('aria-expanded', 'true');
  const cur = els.engMenu.querySelector('.eng-opt[aria-selected="true"]');
  if (cur) cur.focus({ preventScroll: true });
}

function pickEngine(id) {
  state.engine = id;
  closeEngMenu();
  renderEngines();
  renderOptions();
}

function renderEngines() {
  const opts = engineOptions();
  if (!opts.some((o) => o.id === state.engine)) {
    state.engine = opts[0] ? opts[0].id : '';
  }
  const active = opts.find((o) => o.id === state.engine) || opts[0];

  // 触发器：始终只占一行
  els.engLabel.textContent = active ? active.label : '云端未配置';
  els.engCount.textContent = opts.length > 1 ? String(opts.length) : '';
  els.engTrigger.title = active ? active.note : '没有可用的云端模型';
  els.engTrigger.disabled = !active;
  els.engTrigger.classList.add('is-cloud');

  // 菜单项
  els.engMenu.innerHTML = '';
  opts.forEach((op) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'eng-opt';
    b.dataset.engine = op.id;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(op.id === state.engine));
    const mark = document.createElement('span');
    mark.className = 'eng-opt-mark';
    mark.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'eng-opt-name';
    name.textContent = op.label;
    const note = document.createElement('span');
    note.className = 'eng-opt-note';
    note.textContent = op.note;
    b.append(mark, name, note);
    b.addEventListener('click', () => pickEngine(op.id));
    els.engMenu.appendChild(b);
  });

  renderOptions();
}

function initEnginePicker() {
  els.engTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (els.engMenu.hidden) openEngMenu();
    else closeEngMenu();
  });
  document.addEventListener('click', (e) => {
    if (!els.engPicker.contains(e.target)) closeEngMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEngMenu();
  });
  els.engMenu.addEventListener('keydown', (e) => {
    const items = Array.from(els.engMenu.querySelectorAll('.eng-opt'));
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    } else if (!e.isComposing && e.key === 'Enter' || e.key === ' ') {
      if (i >= 0) { e.preventDefault(); pickEngine(items[i].dataset.engine); }
    }
  });
}

/* ---------------------------------------------------------------- 尺寸 / 比例 / 数量 */
function renderOptions() {
  const meta = state.modes[state.mode] || {};
  els.sizeGroup.innerHTML = '';
  els.ratioGroup.innerHTML = '';
  els.countGroup.innerHTML = '';

  const res = meta.cloud_res || {};
  const tiers = res.tiers || [];
  const ratios = res.ratios || [];
  const counts = meta.cloud_counts || [1];

  if (!tiers.includes(state.tier)) state.tier = tiers[0] || '1K';
  if (!ratios.includes(state.ratio)) state.ratio = ratios[0] || '1:1';
  if (!counts.includes(state.count)) state.count = counts[0] || 1;

  tiers.forEach((t) => {
    els.sizeGroup.appendChild(chip(t, state.tier === t, () => { state.tier = t; renderOptions(); },
      t === '4K'));
  });
  ratios.forEach((r) => {
    els.ratioGroup.appendChild(chip(r, state.ratio === r, () => { state.ratio = r; renderOptions(); }));
  });
  if (counts.length > 1) {
    counts.forEach((n) => {
      els.countGroup.appendChild(chip('×' + n, state.count === n, () => { state.count = n; renderOptions(); }));
    });
  }
}

function chip(label, active, onClick, hint) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (hint ? ' hint' : '');
  b.textContent = label;
  b.setAttribute('aria-pressed', String(active));
  b.addEventListener('click', onClick);
  return b;
}

/* ---------------------------------------------------------------- 参考图 */
async function uploadFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) {
    showError('只能上传图片文件');
    return;
  }
  if (file.size > 40 * 1024 * 1024) {
    showError('图片太大（上限 40MB）');
    return;
  }
  const fd = new FormData();
  fd.append('image', file, file.name || 'upload.jpg');
  els.refNote.textContent = '上传中…';
  try {
    const res = await api('/api/upload', { method: 'POST', body: fd });
    state.ref = { filename: res.filename, preview: res.preview };
    paintRef();
    els.refNote.textContent = '已就绪';
  } catch (e) {
    state.ref = null;
    paintRef();
    els.refNote.textContent = '';
    showError('参考图上传失败：' + e.message);
  }
}

function paintRef() {
  const old = els.dropzone.querySelector('img');
  if (old) old.remove();
  if (state.ref) {
    const img = document.createElement('img');
    img.src = state.ref.preview;
    img.alt = '';
    els.dropzone.prepend(img);
    els.dropzone.classList.add('ready');
    els.dzText.textContent = '已选参考图';
  } else {
    els.dropzone.classList.remove('ready');
    els.dzText.textContent = '上传参考图';
  }
}

/* 把作品「继续创作」：从画廊跳回创作间 → 下载原图 → 当参考图 → 切编辑模式 */
export async function reuseItem(item) {
  if (!item || !item.filename) return;
  router.go('create');
  try {
    const resp = await fetch('/images/' + item.filename);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const name = String(item.filename).split('/').pop() || 'reference.png';
    await uploadFile(new File([blob], name, { type: blob.type || 'image/png' }));
    setMode('edit');
    els.prompt.focus();
    toast('已作为参考图，写一句想要的效果');
  } catch (e) {
    showError('无法把这张图转为参考图：' + e.message);
  }
}

/* ---------------------------------------------------------------- 提交 */
export function setActive(n) {
  els.badge.textContent = n;
  els.badge.hidden = !n;
  els.form.classList.toggle('running', n > 0);
  // 就算人在画廊，也能从导航上看到创作间还在跑
  const dot = $('nav-run');
  if (dot) dot.hidden = !n;
}

function autosize() {
  const t = els.prompt;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 190) + 'px';
}

async function run() {
  clearError();
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    showError('先写点什么，再点生成');
    els.prompt.focus();
    return;
  }
  const meta = state.modes[state.mode] || {};
  if (meta.needs_image && !state.ref) {
    showError('这个模式需要先上传一张参考图');
    return;
  }

  const cfg = buildCfg(prompt);
  els.run.disabled = true;
  els.run.classList.add('busy');
  try {
    await jobs.submit(cfg);       // 只等 POST，不等出图
  } finally {
    els.run.disabled = false;
    els.run.classList.remove('busy');
  }
}

function buildCfg(prompt) {
  const cfg = { mode: state.mode, prompt };
  if (state.ref) cfg.ref_filename = state.ref.filename;
  const seed = (els.seed && els.seed.value || '').trim();
  if (seed) cfg.seed = seed;

  cfg.provider = 'cloud';
  cfg.cloud_model = state.engine;
  cfg.resolution = state.tier;
  cfg.ratio = state.ratio;
  cfg.count = state.count;
  return cfg;
}

/* 提示词库「用这个生成」：载入提示词 + 按配方切比例 */
export function applyPrompt(text, ratio) {
  els.prompt.value = text || '';
  autosize();
  els.prompt.dispatchEvent(new Event('input', { bubbles: true }));
  if (ratio) {
    const res = (state.modes[state.mode] || {}).cloud_res || {};
    if ((res.ratios || []).includes(ratio)) {
      state.ratio = ratio;
      renderOptions();
    }
  }
  els.prompt.focus();
  try { els.prompt.setSelectionRange(els.prompt.value.length, els.prompt.value.length); } catch (e) { /* ignore */ }
}
