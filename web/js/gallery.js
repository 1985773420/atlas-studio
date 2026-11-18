/* ============================================================================
   gallery.js —— 作品与任务卡
   成品卡：画廊（#feed）与暗房托盘（#tray-grid）两处都会出现
   任务卡：只出现在创作间的托盘里（点阵光场 + 光圈 + 状态 + 进度 + 计时）
   ========================================================================== */

import { api } from './api.js';
import { mountField, pixelReveal } from './fx.js';
import * as viewer from './viewer.js';
import * as jobs from './jobs.js';
import { toast } from './ui.js';

let handlers = {};
let works = 0;                 // 画廊里的作品总数（含刚生成的）
let latestTs = 0;              // 最新一张的时间（页头显示用）

const $ = (id) => document.getElementById(id);
const feed = () => $('feed');
const hero = () => $('hero');
const tray = () => $('tray');
const trayGrid = () => $('tray-grid');

export function init(h) {
  handlers = h || {};

  const clear = $('tray-clear');
  if (clear) {
    clear.addEventListener('click', () => {
      // 只清「已结束」的卡；还在跑的任务不能被清掉（否则轮询没了落点）
      Array.from(trayGrid().children).forEach((el) => {
        if (el.classList.contains('card') || el.classList.contains('failed')) el.remove();
      });
      syncTray();
    });
  }
  const refresh = $('gal-refresh');
  if (refresh) refresh.addEventListener('click', () => load());
}

/* ---------------------------------------------------------------- 拉取 */
export async function load() {
  try {
    const { items, pending } = await api('/api/gallery');
    renderFeed(items || []);
    if ((pending || []).length) jobs.restore(pending);
    syncTray();
  } catch (e) {
    /* 画廊拉不到不影响创作 */
  }
}

function renderFeed(items) {
  const box = feed();
  box.innerHTML = '';
  let n = 0;
  items.forEach((it) => {
    (it.images || []).forEach((fn) => {
      box.appendChild(cardEl({ filename: fn, mode: it.mode, prompt: it.prompt }));
      n += 1;
    });
  });
  works = n;
  latestTs = (items && items[0] && items[0].created) || latestTs;
  paintCounts();
}

function paintCounts() {
  const sub = $('gal-sub');
  if (sub) {
    sub.textContent = works
      ? ('共 ' + works + ' 张' + (latestTs ? ' · 最新 ' + fmtDay(latestTs) : ''))
      : '还没有作品';
  }
  const nav = $('nav-count');
  if (nav) {
    nav.textContent = works ? String(works) : '';
    nav.hidden = !works;
  }
  const empty = $('gal-empty');
  if (empty) empty.hidden = works > 0;
  const foot = $('bench-foot');
  const bench = $('bench-count');
  if (foot) foot.hidden = !works;
  if (bench) bench.textContent = works;
}

function fmtDay(ts) {
  const d = new Date((ts || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* 刚生成的图：托盘里放一份（带显影），画廊里也放一份（不带显影） */
function addWork(item) {
  const node = cardEl(item);
  feed().prepend(node);
  works += 1;
  latestTs = Date.now() / 1000;
  paintCounts();
}

/* ---------------------------------------------------------------- 托盘 / 主视觉 */
export function syncTray() {
  const t = tray();
  const hasCards = trayGrid().children.length > 0;
  if (t) t.hidden = !hasCards;
  const h = hero();
  if (h) h.classList.toggle('hide', hasCards);
}

/* ---------------------------------------------------------------- 成品卡 */
function cardEl(item, opts) {
  const node = document.getElementById('tpl-card').content.firstElementChild.cloneNode(true);
  const img = node.querySelector('img');
  img.src = '/images/' + item.filename;
  img.alt = (item.prompt || '作品').slice(0, 120);

  // 只有「刚生成」的卡片才需要显影画布；历史作品直接去掉，避免空 canvas 堆积
  const canvas = node.querySelector('.reveal-canvas');
  if (!(opts && opts.reveal)) canvas.remove();

  node.dataset.filename = item.filename;
  node.dataset.prompt = item.prompt || '';
  node.dataset.mode = item.mode || '';

  img.addEventListener('click', () => viewer.open(node));
  node.querySelector('[data-act="download"]').addEventListener('click', (e) => {
    e.stopPropagation();
    download(item);
  });
  node.querySelector('[data-act="reuse"]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (handlers.onReuse) handlers.onReuse(item);
  });
  return node;
}

function download(item) {
  const a = document.createElement('a');
  a.href = '/images/' + item.filename;
  a.download = String(item.filename).split('/').pop();
  a.click();
}

/* ---------------------------------------------------------------- 任务卡 */
export function createCard({ engine, prompt }) {
  const node = document.getElementById('tpl-job').content.firstElementChild.cloneNode(true);
  node.querySelector('[data-meta]').textContent = metaLine(engine, prompt);
  node.__field = mountField(node.querySelector('.job-field'));
  trayGrid().prepend(node);
  syncTray();
  return node;
}

function metaLine(engine, prompt) {
  const tag = engine === 'cloud' ? '云端' : '本地';
  const brief = (prompt || '').replace(/\s+/g, ' ').trim();
  if (!brief) return tag;
  return tag + ' · ' + (brief.length > 78 ? brief.slice(0, 78) + '…' : brief);
}

export function updateCard(card, job, entry) {
  const status = card.querySelector('[data-status]');
  const bar = card.querySelector('[data-bar]');
  const fill = card.querySelector('[data-fill]');
  const time = card.querySelector('[data-time]');

  if (job.status === 'queued') {
    status.textContent = job.ahead > 0 ? ('排队中 · 前面还有 ' + job.ahead + ' 个') : '已入队，马上开始…';
  } else if (job.status === 'running') {
    status.textContent = job.message || '生成中…';
  }

  // 进度：云端批量会给出 "1/2" 这样的分数，能算就显示确定进度
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(job.message || '');
  if (frac && Number(frac[2]) > 0) {
    bar.classList.remove('indet');
    fill.style.width = Math.min(100, (Number(frac[1]) / Number(frac[2])) * 100) + '%';
  } else if (!bar.classList.contains('indet')) {
    bar.classList.add('indet');
  }

  if (entry && entry.t0) {
    const secs = Math.floor((Date.now() - entry.t0) / 1000);
    if (secs >= 3) {
      time.hidden = false;
      time.textContent = secs + 's';
    }
  }
}

export function finishCard(card, job) {
  const images = job.images || [];
  const prompt = job.effective_prompt || job.prompt || '';
  let prev = card;
  images.forEach((fn) => {
    const item = { filename: fn, mode: job.mode, prompt };
    const node = cardEl(item, { reveal: true });
    prev.after(node);
    prev = node;
    develop(node);                       // 像素显影（异步，不阻塞）
    addWork(item);                       // 画廊同步一份
  });
  if (card.__field) {
    card.__field.stop();
    card.__field = null;
  }
  card.remove();
  syncTray();
  if (images.length) toast('已出图 · ' + images.length + ' 张');
}

export function failCard(card, text, cfg, jobId) {
  if (card.__field) {
    card.__field.stop();
    card.__field = null;
  }
  card.classList.add('failed');
  card.querySelector('[data-status]').textContent = text;
  card.querySelector('[data-bar]').hidden = true;
  if (cfg && !card.querySelector('.job-retry')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'job-retry';
    btn.textContent = '重试';
    btn.addEventListener('click', () => {
      card.remove();
      if (handlers.onRetry) handlers.onRetry(cfg);
      syncTray();
    });
    card.querySelector('.job-core').appendChild(btn);
  }
  syncTray();
}

/* ---------------------------------------------------------------- 像素显影 */
async function develop(node) {
  const img = node.querySelector('img');
  const canvas = node.querySelector('.reveal-canvas');
  node.classList.add('is-developing');
  try {
    if (img.decode) await img.decode();
    else await new Promise((r) => { img.onload = r; img.onerror = r; });
    await pixelReveal(canvas, img);
  } catch (e) {
    /* 显影失败就直接露原图 */
  }
  node.classList.remove('is-developing');
  if (canvas) canvas.remove();
}
