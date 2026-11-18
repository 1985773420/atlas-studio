/* 提示条与错误条的统一样式出口（避免各模块各写一套） */

let toastTimer = null;

export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  // 重放入场动画
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export function showError(msg) {
  const box = document.getElementById('error');
  const text = document.getElementById('error-text');
  if (!box || !text) return;
  text.textContent = msg;
  box.hidden = false;
}

export function clearError() {
  const box = document.getElementById('error');
  if (box) box.hidden = true;
}
