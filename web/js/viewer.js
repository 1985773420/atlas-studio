/* ============================================================================
   viewer.js —— 作品查看器：大图 / 提示词说明 / 前后翻页 / 下载与继续创作
   ========================================================================== */

let onReuse = null;
let cards = [];
let idx = 0;

import { postJSON } from './api.js';
import { state } from './state.js';
import * as jobs from './jobs.js';
import { toast, showError } from './ui.js';

const $ = (id) => document.getElementById(id);

export function init(handlers) {
  onReuse = (handlers || {}).onReuse || null;

  $('viewer-close').addEventListener('click', close);
  $('viewer-prev').addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  $('viewer-next').addEventListener('click', (e) => { e.stopPropagation(); step(1); });
  $('viewer').addEventListener('click', (e) => {
    if (e.target.id === 'viewer') close();
  });
  $('viewer-save-prompt').addEventListener('click', savePrompt);
  $('viewer-reuse').addEventListener('click', () => {
    const item = current();
    close();
    if (item && onReuse) onReuse(item);
  });
  window.addEventListener('keydown', (e) => {
    if (!$('viewer').classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
}

export function open(cardEl) {
  // 翻页范围跟着卡片所在的那一片走：画廊里翻画廊，暗房托盘里翻托盘
  const scope = cardEl.closest('.feed, .tray-grid') || document;
  cards = Array.from(scope.querySelectorAll('.card'));
  idx = Math.max(0, cards.indexOf(cardEl));
  show();
  $('viewer').classList.add('open');
  $('viewer').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

export function close() {
  $('viewer').classList.remove('open');
  $('viewer').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  $('viewer-img').removeAttribute('src');
  cards = [];
  idx = 0;
}

function current() {
  const el = cards[idx];
  if (!el) return null;
  return {
    filename: el.dataset.filename || '',
    prompt: el.dataset.prompt || '',
    mode: el.dataset.mode || '',
  };
}

function show() {
  const item = current();
  if (!item) return;
  const src = '/images/' + item.filename;
  const img = $('viewer-img');
  img.src = src;
  img.alt = (item.prompt || '作品').slice(0, 120);
  $('viewer-dl').href = src;
  $('viewer-dl').download = item.filename.split('/').pop() || 'image';
  $('viewer-cap').textContent = item.prompt || '';
  $('viewer-prev').hidden = idx <= 0;
  $('viewer-next').hidden = idx >= cards.length - 1;
}

async function savePrompt() {
  const item = current();
  if (!item || !item.prompt) {
    toast('这张作品没有保存提示词');
    return;
  }
  const btn = $('viewer-save-prompt');
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.classList.add('is-busy');
  try {
    // 用提示词首句做标题，太长就截断
    const firstLine = (item.prompt.split(/[\n.]/)[0] || '我的配方').trim();
    const title = firstLine.slice(0, 24);
    const r = await postJSON('/api/prompts/save', {
      prompt: item.prompt,
      title,
      category: '我的收藏',
      ratio: state.ratio || '',
      engine: state.engine || '',
      resolution: state.tier || '1K',
      autogen: true,
    });
    if (r && r.duplicate) {
      toast('已在提示词库里了：' + (r.title || title));
    } else if (r && r.job) {
      // 收藏后后台建的任务，前端不知道，这里主动登记到暗房托盘
      try {
        jobs.restore([r.job]);
      } catch (e) { /* 登记失败不影响收藏 */ }
      toast('已收藏，正在自动生成一张…');
    } else {
      toast('已收藏到提示词库');
    }
  } catch (e) {
    showError(e && e.message ? e.message : '收藏失败');
  } finally {
    btn.dataset.busy = '0';
    btn.classList.remove('is-busy');
  }
}

function step(delta) {
  const next = idx + delta;
  if (next < 0 || next >= cards.length) return;
  idx = next;
  const img = $('viewer-img');
  img.style.animation = 'none';
  void img.offsetWidth;          // 强制回流，重放入场动画
  img.style.animation = '';
  show();
}
