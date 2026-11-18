/* ============================================================================
   fx.js —— 原生 Canvas / CSS 变量实现的视觉效果层（零依赖、零构建）
   ① mountField    ：任务卡里的点阵光场 + 扫描带（显影中的底片）
   ② pixelReveal   ：作品落位时的像素显影（由粗到细，最后换上原图）
   ③ bindGlow      ：按钮的光标跟随柔光
   ④ bindParallax  ：空状态镜头水印的指针视差
   全部遵守 prefers-reduced-motion，且离开视口/切后台就停帧。
   ========================================================================== */

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/* #rrggbb + alpha -> #rrggbbaa（Canvas 认 8 位十六进制） */
function withAlpha(hex, a) {
  const h = (hex || '').trim();
  if (h.charAt(0) === '#' && h.length === 7) {
    const v = Math.max(0, Math.min(1, a));
    return h + Math.round(v * 255).toString(16).padStart(2, '0');
  }
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- ① 点阵光场 */
export function mountField(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { stop() {} };

  const dotColor = cssVar('--field-dot', '#ffffff');
  const glowColor = cssVar('--field-glow', '#ff7a67');
  const scanColor = cssVar('--field-scan', '#ff5c46');

  let w = 0;
  let h = 0;
  let dots = [];
  let raf = 0;
  let last = 0;
  let onScreen = true;
  let t0 = performance.now();

  function layout() {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.round(box.width);
    h = Math.round(box.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const gap = w < 360 ? 20 : 24;
    dots = [];
    for (let y = gap / 2; y < h; y += gap) {
      for (let x = gap / 2; x < w; x += gap) {
        dots.push({ x, y, p: x * 0.055 + y * 0.085 });
      }
    }
    return true;
  }

  function paint(now) {
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, w, h);

    // 光场中心缓慢游走（椭圆轨迹）
    const cx = w * (0.5 + 0.3 * Math.sin(t * 0.31));
    const cy = h * (0.46 + 0.24 * Math.cos(t * 0.23));
    const reach = Math.max(w, h) * 0.62;

    for (let i = 0; i < dots.length; i += 1) {
      const d = dots[i];
      const dist = Math.hypot(d.x - cx, d.y - cy);
      const near = Math.max(0, 1 - dist / reach);
      const wob = 0.5 + 0.5 * Math.sin(d.p * 1.7 + t * 1.5);
      const alpha = 0.06 + near * near * 0.62 * (0.5 + 0.5 * wob);
      ctx.fillStyle = near > 0.42 ? withAlpha(glowColor, alpha) : withAlpha(dotColor, alpha * 0.7);
      ctx.beginPath();
      ctx.arc(d.x, d.y, 0.9 + near * 1.4, 0, 6.2832);
      ctx.fill();
    }

    // 扫描带：自上而下（底片过药水的显影感）
    const sy = ((t * 34) % (h + 160)) - 80;
    const scan = ctx.createLinearGradient(0, sy - 46, 0, sy + 46);
    scan.addColorStop(0, withAlpha(scanColor, 0));
    scan.addColorStop(0.5, withAlpha(scanColor, 0.14));
    scan.addColorStop(1, withAlpha(scanColor, 0));
    ctx.fillStyle = scan;
    ctx.fillRect(0, sy - 46, w, 92);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!onScreen || document.hidden) return;
    if (now - last < 32) return;      // 约 30fps，省电
    last = now;
    paint(now);
  }

  const ok = layout();
  if (reduced()) {
    if (ok) paint(t0 + 900);          // 静止一帧
    return { stop() {} };
  }
  raf = requestAnimationFrame(loop);

  const ro = ('ResizeObserver' in window) ? new ResizeObserver(() => { layout(); }) : null;
  if (ro) ro.observe(canvas);
  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => { onScreen = entries[0].isIntersecting; }, { threshold: 0 })
    : null;
  if (io) io.observe(canvas);

  return {
    stop() {
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
    },
  };
}

/* ---------------------------------------------------------------- ② 像素显影 */
export async function pixelReveal(canvas, img, opts) {
  if (reduced()) return;
  const steps = (opts && opts.steps) || [64, 36, 20, 11, 6, 3, 0];
  const frameMs = (opts && opts.frame) || 96;

  const w = Math.round(img.clientWidth || 0);
  const h = Math.round(img.clientHeight || 0);
  if (!w || !h) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const off = document.createElement('canvas');
  const octx = off.getContext('2d');

  for (let i = 0; i < steps.length; i += 1) {
    const block = steps[i];
    if (!block) return;                       // 0 = 该露原图了
    const bw = Math.max(1, Math.round(w / block));
    const bh = Math.max(1, Math.round(h / block));
    off.width = bw;
    off.height = bh;
    octx.clearRect(0, 0, bw, bh);
    octx.drawImage(img, 0, 0, bw, bh);

    ctx.imageSmoothingEnabled = false;        // 方块感：显影从颗粒开始
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0, bw, bh, 0, 0, w, h);

    const flash = 0.26 - i * 0.05;            // 起手过曝，逐帧定影
    if (flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + flash.toFixed(3) + ')';
      ctx.fillRect(0, 0, w, h);
    }
    await sleep(frameMs);
  }
}

/* ---------------------------------------------------------------- ③ 光标柔光 */
export function bindGlow(el) {
  if (!el || el.dataset.glowBound) return;
  el.dataset.glowBound = '1';
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 100).toFixed(1) + '%');
    el.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
  });
}

/* ---------------------------------------------------------------- ④ 指针视差 */
export function bindParallax(el, range) {
  const max = range || 10;
  if (!el || reduced()) return;
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const nx = (e.clientX / window.innerWidth - 0.5) * 2;
    const ny = (e.clientY / window.innerHeight - 0.5) * 2;
    el.style.setProperty('--iris-x', (nx * max).toFixed(1) + 'px');
    el.style.setProperty('--iris-y', (ny * max).toFixed(1) + 'px');
  }, { passive: true });
}
