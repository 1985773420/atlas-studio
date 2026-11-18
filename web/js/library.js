/* ============================================================================
   library.js —— 提示词库面板：搜索 / 分类 / 卡片 / 一键载入 / 复制
   ========================================================================== */

import { api } from './api.js';
import { state } from './state.js';
import { bindGlow } from './fx.js';
import { toast } from './ui.js';

let onApply = null;
const $ = (id) => document.getElementById(id);

export function init(handlers) {
  onApply = (handlers || {}).onApply || null;

  $('open-library').addEventListener('click', open);
  $('close-library').addEventListener('click', close);
  $('library').addEventListener('click', (e) => {
    if (e.target.id === 'library') close();
  });
  $('lib-search').addEventListener('input', () => {
    state.lib.q = $('lib-search').value || '';
    render();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('library').classList.contains('open')) close();
  });

  load();
}

export function open() {
  $('library').classList.add('open');
  $('library').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  setTimeout(() => { const s = $('lib-search'); if (s) s.focus(); }, 90);
}

export function close() {
  $('library').classList.remove('open');
  $('library').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  const active = document.activeElement;
  if (active && $('library').contains(active) && active.blur) active.blur();
  const trigger = $('open-library');
  if (trigger) trigger.focus({ preventScroll: true });
}

async function load() {
  try {
    const d = await api('/api/prompts');
    state.lib.items = d.items || [];
    state.lib.cats = d.categories || ['全部'];
    const count = $('lib-count');
    if (count) count.textContent = state.lib.items.length;
    renderCats();
    render();
  } catch (e) {
    $('lib-grid').innerHTML = '<p class="lib-empty">提示词库读取失败</p>';
  }
}

function renderCats() {
  const box = $('lib-cats');
  box.innerHTML = '';
  const counts = {};
  state.lib.items.forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });
  state.lib.cats.forEach((c) => {
    const n = c === '全部' ? state.lib.items.length : (counts[c] || 0);
    if (!n) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cat';
    b.textContent = c;
    b.setAttribute('aria-pressed', String(state.lib.cat === c));
    b.addEventListener('click', () => {
      state.lib.cat = c;
      renderCats();
      render();
    });
    box.appendChild(b);
  });
}

function filtered() {
  const q = (state.lib.q || '').trim().toLowerCase();
  return state.lib.items.filter((it) => {
    if (state.lib.cat !== '全部' && it.category !== state.lib.cat) return false;
    if (!q) return true;
    return (it.title + ' ' + (it.zh || '') + ' ' + it.prompt + ' ' + it.category).toLowerCase().includes(q);
  });
}

function render() {
  const grid = $('lib-grid');
  const items = filtered();
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = '<p class="lib-empty">没有匹配的配方，换个关键词试试</p>';
    return;
  }
  items.forEach((it, i) => {
    const node = $('tpl-recipe').content.firstElementChild.cloneNode(true);
    const media = node.querySelector('.recipe-media');
    const img = media.querySelector('img');
    if (it.preview) {
      img.src = it.preview;
      img.alt = it.title;
    } else {
      // 没有预览图：把缩略图换成序号。
      // 注意不能用 media.textContent，否则会把同层的 .recipe-ratio 一起清掉。
      if (img) img.remove();
      media.classList.add('blank');
      const num = document.createElement('span');
      num.className = 'recipe-num';
      num.textContent = String(i + 1).padStart(2, '0');
      media.insertBefore(num, media.firstChild);
    }

    const setText = (sel, val) => {
      const el = node.querySelector(sel);
      if (el) el.textContent = val || '';
    };
    setText('[data-ratio]', it.ratio);
    setText('[data-cat]', it.category);
    setText('[data-title]', it.title);
    setText('[data-zh]', it.zh);
    setText('[data-prompt]', it.prompt);

    const useBtn = node.querySelector('[data-use]');
    bindGlow(useBtn);
    useBtn.addEventListener('click', () => {
      close();
      if (onApply) onApply(it);
    });

    const copyBtn = node.querySelector('[data-copy]');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(it.prompt || '');
        toast('提示词已复制');
      } catch (e) {
        toast('复制失败，请手动选中提示词');
      }
    });

    grid.appendChild(node);
  });
}
