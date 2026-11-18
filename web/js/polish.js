/* ============================================================================
   polish.js —— v12 交互增强层
   只做“让页面更活”的事：滚动、视差、筛选、光标追光、键盘快捷键。
   不接管任何业务逻辑，所有增强都可降级。
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.classList.add('js');

/* ---------------------------------------------------------------- 顶栏滚动 */
const bar = $('bar');
const progress = $('bar-progress');

function onScroll() {
  const top = window.scrollY || document.documentElement.scrollTop;
  if (bar) bar.classList.toggle('scrolled', top > 18);
  if (progress) {
    const root = document.documentElement;
    const max = root.scrollHeight - root.clientHeight;
    progress.style.width = max > 0 ? ((top / max) * 100).toFixed(2) + '%' : '0%';
  }
}

window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ---------------------------------------------------------------- 滚动进入 */
const revealItems = new WeakSet();
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
  : null;

function observeReveal(el) {
  if (!el || revealItems.has(el)) return;
  revealItems.add(el);
  if (!io) {
    el.classList.add('in');
    return;
  }
  el.classList.add('reveal');
  io.observe(el);
}

document.querySelectorAll('.reveal').forEach(observeReveal);

/* ---------------------------------------------------------------- 提示词计数 */
const promptEl = $('prompt');
const promptCount = $('prompt-count');

function syncPromptCount() {
  if (!promptEl || !promptCount) return;
  promptCount.textContent = String((promptEl.value || '').length);
}

if (promptEl) {
  promptEl.addEventListener('input', syncPromptCount);
  syncPromptCount();
}

/* Inspiration preview and safe prompt replacement. */
const ideas = [...document.querySelectorAll('.idea')];
let previousPrompt = null;
let lastIdea = null;
const restore = $('restore-prompt');
const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
function focusComposer() {
  $('bench').scrollIntoView({ behavior: motion(), block: 'start' });
  promptEl.focus({ preventScroll: true });
}
function setPrompt(text) {
  promptEl.value = text;
  promptEl.dispatchEvent(new Event('input', { bubbles: true }));
  focusComposer();
  promptEl.setSelectionRange(text.length, text.length);
}
function applyIdea(idea) {
  if (promptEl.value !== idea.dataset.idea) {
    previousPrompt = promptEl.value;
    restore.hidden = false;
    setPrompt(idea.dataset.idea);
  } else focusComposer();
  lastIdea = idea;
}
ideas.forEach(idea => idea.addEventListener('click', () => applyIdea(idea)));
restore.addEventListener('click', () => {
  if (previousPrompt === null) return;
  const text = previousPrompt;
  previousPrompt = null;
  restore.hidden = true;
  setPrompt(text);
});
$('surprise').addEventListener('click', () => {
  const choices = ideas.filter(idea => idea !== lastIdea);
  applyIdea(choices[Math.floor(Math.random() * choices.length)]);
});
$('compose-library').addEventListener('click', () => $('open-library').click());
document.querySelector('[data-scroll="bench"]').addEventListener('click', e => {
  e.preventDefault();
  focusComposer();
});
const samples = [
  ['cyberpunk-city', ideas[0].textContent, ideas[0].dataset.idea],
  ['ink-landscape', '水墨山水', '中国水墨山水，山间云雾流动，墨色层叠，远处草亭，留白与宣纸质感'],
  ['cinematic-portrait', '电影感人像', '电影感人像特写，窗边侧光，浅景深，细腻的胶片颗粒，克制的暖色调'],
];
let frame = 0;
function turnFrame(step) {
  frame = (frame + step + samples.length) % samples.length;
  const [file, title] = samples[frame];
  const img = $('exposure-image');
  img.alt = title;
  img.classList.remove('exposed');
  img.src = '/placeholder.svg';
  $('exposure-title').textContent = title;
  $('exposure-frame').textContent = `${String(frame + 1).padStart(2, '0')} / 03`;
}
$('exposure-image').addEventListener('load', e => e.currentTarget.classList.add('exposed'));
$('exposure-prev').addEventListener('click', () => turnFrame(-1));
$('exposure-next').addEventListener('click', () => turnFrame(1));
$('exposure-use').addEventListener('click', () => applyIdea({ dataset: { idea: samples[frame][2] } }));

/* ---------------------------------------------------------------- 作品卡 / 配方卡增强 */
const MODE_LABEL = { generate: '文生图', edit: '图片编辑', sticker: '透明贴纸' };

function enhanceCard(card) {
  if (!card || card.dataset.enhanced === '1') return;
  card.dataset.enhanced = '1';
  observeReveal(card);

  const mode = card.dataset.mode || '';
  const modeEl = card.querySelector('[data-mode-label]');
  if (modeEl) modeEl.textContent = MODE_LABEL[mode] || mode || '作品';

  const prompt = card.querySelector('[data-prompt-text]');
  if (prompt) prompt.textContent = card.dataset.prompt || '';

  if (!reduced) {
    card.addEventListener('pointermove', (e) => {
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      card.style.setProperty('--gx', (((e.clientX - rect.left) / rect.width) * 100).toFixed(1) + '%');
      card.style.setProperty('--gy', (((e.clientY - rect.top) / rect.height) * 100).toFixed(1) + '%');
    }, { passive: true });
  }
}

function enhanceJob(job) {
  if (!job || job.dataset.enhanced === '1') return;
  job.dataset.enhanced = '1';
  observeReveal(job);
}

function enhanceRecipe(recipe) {
  if (!recipe || recipe.dataset.enhanced === '1') return;
  recipe.dataset.enhanced = '1';
  observeReveal(recipe);
}

function enhanceNode(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.classList.contains('card')) enhanceCard(node);
  if (node.classList.contains('job')) enhanceJob(node);
  if (node.classList.contains('recipe')) enhanceRecipe(node);
  node.querySelectorAll('.card').forEach(enhanceCard);
  node.querySelectorAll('.job').forEach(enhanceJob);
  node.querySelectorAll('.recipe').forEach(enhanceRecipe);
}

['feed', 'tray-grid', 'lib-grid'].forEach((id) => {
  const box = $(id);
  if (!box) return;
  enhanceNode(box);
  new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach(enhanceNode);
    });
    if (id === 'feed') applyFilter();
  }).observe(box, { childList: true, subtree: true });
});

/* ---------------------------------------------------------------- 画廊筛选 */
const feed = $('feed');
const filterButtons = Array.from(document.querySelectorAll('.gal-filter'));
let activeFilter = 'all';

function applyFilter() {
  if (!feed) return;
  feed.querySelectorAll('.card').forEach((card) => {
    card.hidden = activeFilter !== 'all' && card.dataset.mode !== activeFilter;
  });
}

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter || 'all';
    filterButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    applyFilter();
  });
});

/* ---------------------------------------------------------------- 键盘快捷键 */
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const typing = active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT' ||
    active.isContentEditable
  );

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('open-library')?.click();
    return;
  }

  if (e.key === 'Escape') {
    const library = $('library');
    if (library && library.classList.contains('open')) {
      e.preventDefault();
      $('close-library')?.click();
    }
    return;
  }

  if (e.key === '/' && !typing) {
    e.preventDefault();
    const library = $('library');
    if (!library || !library.classList.contains('open')) {
      $('open-library')?.click();
      setTimeout(() => $('lib-search')?.focus(), 320);
    } else {
      $('lib-search')?.focus();
    }
  }
});

/* ---------------------------------------------------------------- 主按钮磁吸 */
if (!reduced) {
  document.querySelectorAll('.btn-primary, .gate-submit').forEach((btn) => {
    btn.addEventListener('pointermove', (e) => {
      const rect = btn.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 8;
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * 6;
      btn.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }, { passive: true });
    btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
  });
}
