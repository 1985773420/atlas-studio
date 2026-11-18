/* ============================================================================
   router.js —— 两个房间：#/create（创作间）与 #/gallery（画廊）
   哈希路由，静态托管也能用；切换时只显示对应的 .view。
   ========================================================================== */

const VIEWS = ['create', 'gallery'];
let onChange = null;

export function current() {
  const h = (location.hash || '').replace(/^#\/?/, '').toLowerCase();
  return VIEWS.includes(h) ? h : 'create';
}

function apply(name, opts) {
  document.querySelectorAll('.view').forEach((v) => {
    v.hidden = v.id !== 'view-' + name;
  });
  document.querySelectorAll('.nav-item').forEach((a) => {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.body.dataset.view = name;
  if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
  if (onChange) onChange(name);
}

export function go(name) {
  const target = VIEWS.includes(name) ? name : 'create';
  if (current() === target) {
    apply(target);                      // 同视图也重画一次（深链/回退用）
    return;
  }
  location.hash = '#/' + target;        // 触发 hashchange → apply
}

export function init(handler) {
  onChange = handler || null;

  window.addEventListener('hashchange', () => apply(current(), { keepScroll: false }));

  // 任何带 data-go 的元素都能当导航入口（含空状态里的链接）
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-go]');
    if (!a) return;
    e.preventDefault();
    go(a.dataset.go);
  });

  apply(current());
}
