/* ============================================================================
   Atlas 管理台 —— 登录 / 来源记录 / 用户 / 作品 / 设置（原生 ESM，无构建）
   ========================================================================== */

const $ = (s) => (s[0] === '.' || s[0] === '#' ?
  document.querySelector(s) : document.getElementById(s));

const S = {
  sec: 'records',
  users: [],
  rec: { q: '', uid: '', engine: '', status: '', days: 0, page: 1, total: 0 },
  work: { uid: '', page: 1, total: 0, per: 48 },
};

/* ---------------------------------------------------------------- 工具 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  let d = null;
  try { d = await r.json(); } catch (e) { /* 空响应 */ }
  if (r.status === 401 && path.indexOf('/login') < 0) {
    showLogin('登录已过期，请重新登录');
    throw new Error('未登录');
  }
  if (!r.ok) throw new Error((d && d.error) || ('请求失败 ' + r.status));
  return d;
}

function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtFull(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function uaShort(ua) {
  if (!ua) return '—';
  let b = '';
  let m;
  if ((m = /Edg\/(\d+)/.exec(ua))) b = 'Edge ' + m[1];
  else if ((m = /Chrome\/(\d+)/.exec(ua))) b = 'Chrome ' + m[1];
  else if ((m = /Firefox\/(\d+)/.exec(ua))) b = 'Firefox ' + m[1];
  else if (/Safari\//.test(ua)) b = 'Safari';
  else if (/curl|python|urllib|Wget/i.test(ua)) b = '脚本';
  else b = ua.slice(0, 18);
  const os = /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh/.test(ua) ? 'macOS'
          : /Linux/.test(ua) ? 'Linux' : '';
  return b + (os ? ' · ' + os : '');
}
const MODE_LABEL = { generate: '文生图', edit: '图片编辑', sticker: '透明贴纸' };

function thumbUrl(rel) { return '/thumb/320/' + rel.split('/').map(encodeURIComponent).join('/'); }
function imgUrl(rel) { return '/images/' + rel.split('/').map(encodeURIComponent).join('/'); }

/* ---------------------------------------------------------------- 主题 */
const THEME_META = { dark: '#0a0b0e', light: '#f6f5f2' };
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_META[t] || THEME_META.dark);
}
(function initTheme() {
  let t = 'dark';
  try {
    const saved = localStorage.getItem('atlas-theme');
    if (saved === 'light' || saved === 'dark') t = saved;
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) t = 'light';
  } catch (e) { /* 隐私模式 */ }
  applyTheme(t);
})();
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('atlas-theme', next); } catch (e) { /* ignore */ }
  applyTheme(next);
});

/* ---------------------------------------------------------------- 登录 */
function showLogin(msg) {
  $('panel').hidden = true;
  $('login-view').style.display = '';
  $('login-err').textContent = msg || '';
  const u = $('adm-user');
  if (u) {
    try { u.value = localStorage.getItem('atlas-last-admin') || 'liubin'; } catch (e) { /* ignore */ }
    setTimeout(() => ($('pw').value ? u.focus() : $('pw').focus()), 60);
  }
}

async function showPanel() {
  $('login-view').style.display = 'none';
  $('panel').hidden = false;
  await loadOverview();
  activate(S.sec);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-err').textContent = '';
  const uid = ($('adm-user').value || '').trim().toLowerCase();
  try {
    const r = await post('/api/auth/login', { username: uid, password: $('pw').value });
    if (!r.admin) {
      await post('/api/auth/logout', {});
      throw new Error('这个账号不是管理员，无法进入管理台');
    }
    try { localStorage.setItem('atlas-last-admin', uid); } catch (err) { /* ignore */ }
    $('pw').value = '';
    await showPanel();
  } catch (err) {
    $('login-err').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('emergency-toggle').addEventListener('click', () => {
  const row = $('emergency-row');
  row.hidden = !row.hidden;
  if (!row.hidden) $('em-pw').focus();
});

$('em-btn').addEventListener('click', async () => {
  $('login-err').textContent = '';
  try {
    await post('/api/admin/login', { password: $('em-pw').value });
    $('em-pw').value = '';
    await showPanel();
  } catch (err) {
    $('login-err').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  try { await post('/api/admin/logout', {}); } catch (e) { /* ignore */ }
  try { await post('/api/auth/logout', {}); } catch (e) { /* ignore */ }
  location.href = '/';
});

/* ---------------------------------------------------------------- 导航 */
function activate(sec) {
  S.sec = sec;
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.sec === sec);
  });
  ['records', 'users', 'works', 'settings'].forEach((k) => {
    $('sec-' + k).hidden = k !== sec;
  });
  if (sec === 'records') loadRecords();
  if (sec === 'users') loadUsers();
  if (sec === 'works') loadWorks();
  if (sec === 'settings') loadSettings();
}

document.querySelectorAll('#nav button').forEach((b) => {
  b.addEventListener('click', () => activate(b.dataset.sec));
});

/* ---------------------------------------------------------------- 统计条 */
let warnedPw = false;
async function loadOverview() {
  try {
    const { overview: o } = await api('/api/admin/overview');
    const items = [
      ['账号', o.users, ''],
      ['任务', o.jobs_total, ''],
      ['图片', o.images_total, ''],
      ['近 24h', o.jobs_24h, 'hot'],
      ['云端任务', o.cloud_jobs, ''],
      ['本地任务', o.local_jobs, ''],
      ['失败', o.error_jobs, o.error_jobs ? 'hot' : ''],
      ['图库占用', fmtBytes(o.gallery_bytes), ''],
    ];
    $('stats').innerHTML = items.map(([k, v, cls]) =>
      `<div class="ad-stat ${cls}"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
    if (o.initial_pw && !warnedPw) {
      warnedPw = true;
      toast('提示：管理员仍在使用初始密码，请到「设置」修改');
    }
  } catch (e) { /* 未登录时忽略 */ }
}

/* ---------------------------------------------------------------- 来源记录 */
const STATUS_LABEL = { done: '成功', error: '失败', running: '生成中', queued: '排队' };

function recQuery() {
  return new URLSearchParams({
    q: S.rec.q, uid: S.rec.uid, engine: S.rec.engine, status: S.rec.status,
    days: S.rec.days, page: S.rec.page, per: 30,
  }).toString();
}

function syncExportLink() {
  const p = new URLSearchParams({
    q: S.rec.q, uid: S.rec.uid, engine: S.rec.engine, status: S.rec.status, days: S.rec.days,
  }).toString();
  $('rec-export').href = '/api/admin/export.csv?' + p;
}

let openDetail = null;

async function loadRecords() {
  const body = $('rec-body');
  body.innerHTML = '<tr><td colspan="10" class="ad-empty">加载中…</td></tr>';
  try {
    const { data } = await api('/api/admin/jobs?' + recQuery());
    S.rec.total = data.total;
    $('rec-sub').textContent = '共 ' + data.total + ' 条 · 第 ' + data.page
      + ' / ' + Math.max(1, Math.ceil(data.total / data.per)) + ' 页';
    openDetail = null;
    renderRecords(data.items);
    renderPager('rec-pager', data.page, Math.ceil(data.total / data.per) || 1, (p) => {
      S.rec.page = p;
      loadRecords();
    });
    syncExportLink();
  } catch (e) {
    if (e.message !== '未登录') body.innerHTML = '<tr><td colspan="10" class="ad-empty">' + esc(e.message) + '</td></tr>';
  }
}

function renderRecords(items) {
  const body = $('rec-body');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="10" class="ad-empty">没有符合条件的记录</td></tr>';
    return;
  }
  body.innerHTML = '';
  items.forEach((it) => {
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.dataset.id = it.id;
    const uname = it.owner || '公共';
    const enginePill = it.engine === 'cloud'
      ? '<span class="ad-pill cloud">云端</span>' : '<span class="ad-pill">本地</span>';
    const st = STATUS_LABEL[it.status] || it.status;
    const stCls = it.status === 'done' ? 'ok' : (it.status === 'error' ? 'bad' : '');
    const imgs = it.images || [];
    const thumbs = imgs.slice(0, 1).map((fn) =>
      `<img class="ad-thumb" loading="lazy" src="${thumbUrl(fn)}" data-full="${esc(imgUrl(fn))}" alt="">`).join('')
      + (imgs.length ? `<span class="ad-thumb-more">${imgs.length} 张</span>` : '<span class="ad-dim">—</span>');
    tr.innerHTML = `
      <td class="ad-mono">${esc(fmtTime(it.created))}</td>
      <td class="ad-mono">${esc(uname)}</td>
      <td class="ad-mono">${esc(it.ip || '—')}</td>
      <td class="ad-dim">${esc(uaShort(it.ua))}</td>
      <td>${esc(MODE_LABEL[it.mode] || it.mode || '')}</td>
      <td>${enginePill}</td>
      <td><span class="ad-pill ${stCls}">${esc(st)}</span></td>
      <td class="ad-mono">${it.elapsed ? it.elapsed + 's' : '—'}</td>
      <td><div class="ad-prompt" title="${esc(it.prompt || '')}">${esc(it.prompt || '')}</div></td>
      <td><div class="ad-thumbs">${thumbs}</div></td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.ad-thumb')) return;
      toggleDetail(tr, it);
    });
    body.appendChild(tr);
  });
}

function toggleDetail(tr, it) {
  if (openDetail && openDetail.dataset.for === it.id) {
    openDetail.remove();
    openDetail = null;
    return;
  }
  if (openDetail) openDetail.remove();
  const dtr = document.createElement('tr');
  dtr.className = 'detail';
  dtr.dataset.for = it.id;
  const imgs = (it.images || []).map((fn) =>
    `<img loading="lazy" src="${thumbUrl(fn)}" data-full="${esc(imgUrl(fn))}" alt="">`).join('');
  dtr.innerHTML = `<td colspan="10">
    <div class="ad-detail">
      <div>
        <h4>提示词</h4>
        <div class="full">${esc(it.prompt || '—')}</div>
      </div>
      <div>
        <h4>来源</h4>
        <dl class="kv">
          <dt>用户</dt><dd>${esc(it.owner || '（公共）')}</dd>
          <dt>IP</dt><dd>${esc(it.ip || '—')}</dd>
          <dt>浏览器</dt><dd>${esc(it.ua || '—')}</dd>
          <dt>任务 ID</dt><dd>${esc(it.id)}</dd>
          <dt>种子</dt><dd>${esc(it.seed == null ? '—' : it.seed)}</dd>
          ${it.error ? `<dt>错误</dt><dd>${esc(it.error)}</dd>` : ''}
        </dl>
      </div>
      ${imgs ? `<div class="imgs">${imgs}</div>` : ''}
      <div class="ad-btn-row">
        <button type="button" class="ad-btn danger" data-del>删除这条记录（含图片）</button>
      </div>
    </div>
  </td>`;
  dtr.querySelector('[data-del]').addEventListener('click', async () => {
    if (!confirm('删除这条任务记录及其全部图片？')) return;
    await post('/api/admin/delete_job', { id: it.id });
    toast('已删除');
    loadRecords();
    loadOverview();
  });
  tr.after(dtr);
  openDetail = dtr;
}

/* ---------------------------------------------------------------- 分页 */
function renderPager(el, page, pages, go) {
  const box = $(el);
  box.innerHTML = '';
  if (pages <= 1) return;
  const mk = (label, target, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.disabled = disabled;
    if (!disabled) b.addEventListener('click', () => { go(target); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    return b;
  };
  box.append(
    mk('上一页', page - 1, page <= 1),
    Object.assign(document.createElement('span'), { className: 'num', textContent: page + ' / ' + pages }),
    mk('下一页', page + 1, page >= pages),
  );
}

/* ---------------------------------------------------------------- 用户 */
/* ---------------------------------------------------------------- 账号 */
const isPublicRow = (u) => !u.uid;

async function loadUsers() {
  const body = $('usr-body');
  body.innerHTML = '<tr><td colspan="8" class="ad-empty">加载中…</td></tr>';
  try {
    const q = ($('usr-q').value || '').trim();
    const { data } = await api('/api/admin/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    S.users = data.items;
    renderUserOptions();
    if ($('usr-sub')) {
      $('usr-sub').textContent = `${data.registered} 个账号 · ${data.guests} 个历史身份 · `
        + `${data.public_works ? data.public_works + ' 条公共老作品' : '无公共老作品'}`;
    }
    if (!data.items.length) {
      body.innerHTML = '<tr><td colspan="8" class="ad-empty">还没有账号</td></tr>';
      return;
    }
    body.innerHTML = '';
    data.items.forEach((u) => {
      const tr = document.createElement('tr');
      tr.className = 'row';
      const isPublic = isPublicRow(u);
      const online = isPublicRow(u) ? '<span class="ad-dim">—</span>'
        : (u.status === 'blocked' ? '<span class="ad-tag bad">已封禁</span>'
          : (u.registered ? '<span class="ad-tag ok">正常</span>' : '<span class="ad-tag">未注册</span>'));
      const roleCell = isPublic || !u.registered
        ? `<span class="ad-dim">${isPublic ? '—' : '历史身份'}</span>`
        : `<select class="ad-mini" data-role>
             <option value="user"${u.role === 'user' ? ' selected' : ''}>普通</option>
             <option value="admin"${u.role === 'admin' ? ' selected' : ''}>管理员</option>
           </select>`;
      tr.innerHTML = `
        <td class="ad-mono">${esc(isPublic ? '（公共老作品）' : u.uid)}
          ${!isPublic && u.name && u.name !== u.uid ? `<span class="ad-dim"> · ${esc(u.name)}</span>` : ''}</td>
        <td>${roleCell}</td>
        <td>${online}</td>
        <td class="ad-mono">${u.images}</td>
        <td class="ad-mono">${esc(fmtTime(u.created || u.first_seen))}</td>
        <td class="ad-mono">${esc(fmtTime(u.last_login))}</td>
        <td class="ad-mono">${esc(u.ip || '—')}</td>
        <td class="ad-btn-row">
          <button type="button" class="ad-btn" data-rec>记录</button>
          ${isPublic ? '' : (u.registered
            ? `<button type="button" class="ad-btn" data-pw>改密</button>
               <button type="button" class="ad-btn" data-status>${u.status === 'blocked' ? '解封' : '封禁'}</button>
               <button type="button" class="ad-btn danger" data-del>删除</button>`
            : `<button type="button" class="ad-btn" data-adopt>转为账号</button>
               <button type="button" class="ad-btn danger" data-del>删除</button>`)}
        </td>`;

      tr.querySelector('[data-rec]').addEventListener('click', (e) => {
        e.stopPropagation();
        S.rec.uid = u.uid || '__legacy__';
        S.rec.page = 1;
        $('f-uid').value = S.rec.uid;
        activate('records');
      });

      const pwBtn = tr.querySelector('[data-pw]');
      if (pwBtn) pwBtn.addEventListener('click', () => openAccModal('reset', u));

      const adoptBtn = tr.querySelector('[data-adopt]');
      if (adoptBtn) adoptBtn.addEventListener('click', () => openAccModal('adopt', u));

      const stBtn = tr.querySelector('[data-status]');
      if (stBtn) {
        stBtn.addEventListener('click', async () => {
          const next = u.status === 'blocked' ? 'active' : 'blocked';
          if (next === 'blocked' && !confirm(`封禁 ${u.uid}？他当前的登录会立即失效。`)) return;
          try {
            await post('/api/admin/accounts/update', { uid: u.uid, status: next });
            toast(next === 'blocked' ? '已封禁，会话立即失效' : '已解封');
            loadUsers();
            loadOverview();
          } catch (err) { toast(err.message); }
        });
      }

      const roleSel = tr.querySelector('[data-role]');
      if (roleSel) {
        roleSel.addEventListener('change', async () => {
          try {
            await post('/api/admin/accounts/update', { uid: u.uid, role: roleSel.value });
            toast(roleSel.value === 'admin' ? '已设为管理员' : '已设为普通用户');
            loadUsers();
          } catch (err) { toast(err.message); roleSel.value = u.role; }
        });
      }

      const delBtn = tr.querySelector('[data-del]');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          const warn = u.images
            ? `删除账号 ${u.uid}，连同名下 ${u.images} 张作品一起删除，不可恢复。\n\n想保留作品请先到「设置 → 作品归属」并入其他账号。\n\n确定删除？`
            : `删除账号 ${u.uid}？`;
          if (!confirm(warn)) return;
          try {
            const r = await post('/api/admin/accounts/delete', { uid: u.uid });
            toast('已删除账号，清理作品 ' + r.deleted_works + ' 条');
            loadUsers();
            loadOverview();
          } catch (err) { toast(err.message); }
        });
      }
      body.appendChild(tr);
    });
  } catch (e) {
    if (e.message !== '未登录') body.innerHTML = '<tr><td colspan="8" class="ad-empty">' + esc(e.message) + '</td></tr>';
  }
}

function renderUserOptions() {
  const fill = (sel, keepAll) => {
    const cur = sel.value;
    sel.innerHTML = (keepAll ? '<option value="">全部</option>' : '')
      + '<option value="__legacy__">公共老作品</option>'
      + S.users.filter((u) => u.uid).map((u) => `<option value="${esc(u.uid)}">${esc(u.uid)}</option>`).join('');
    if (cur) sel.value = cur;
  };
  fill($('f-uid'), true);
  fill($('w-uid'), true);
}

/* ---------------------------------------------------------------- 作品 */
async function loadWorks() {
  const grid = $('work-grid');
  grid.innerHTML = '<div class="ad-empty" style="grid-column:1/-1">加载中…</div>';
  try {
    const p = new URLSearchParams({ uid: S.work.uid, page: S.work.page, per: S.work.per }).toString();
    const { data } = await api('/api/admin/works?' + p);
    S.work.total = data.total;
    const pages = Math.max(1, Math.ceil(data.total / data.per));
    $('work-sub').textContent = '共 ' + data.total + ' 张 · 第 ' + data.page + ' / ' + pages + ' 页';
    grid.innerHTML = '';
    if (!data.items.length) {
      grid.innerHTML = '<div class="ad-empty" style="grid-column:1/-1">没有作品</div>';
    }
    data.items.forEach((w) => {
      const el = document.createElement('div');
      el.className = 'ad-work';
      el.innerHTML = `
        <img loading="lazy" src="${thumbUrl(w.filename)}" data-full="${esc(imgUrl(w.filename))}" alt="${esc(w.prompt || '')}">
        <div class="ad-work-acts">
          <button type="button" data-act="dl" title="下载原图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/></svg></button>
          <button type="button" data-act="del" title="删除这张"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg></button>
        </div>
        <div class="ad-work-cap"><b>${esc(w.owner || '公共')}</b><span>${esc(fmtTime(w.created))}</span></div>`;
      el.querySelector('[data-act="dl"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const a = document.createElement('a');
        a.href = imgUrl(w.filename);
        a.download = w.filename.split('/').pop();
        a.click();
      });
      el.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('删除这张图片？')) return;
        await post('/api/admin/delete_image', { job: w.job, filename: w.filename });
        toast('已删除');
        loadWorks();
        loadOverview();
      });
      grid.appendChild(el);
    });
    renderPager('work-pager', data.page, pages, (p) => { S.work.page = p; loadWorks(); });
  } catch (e) {
    if (e.message !== '未登录') grid.innerHTML = '<div class="ad-empty" style="grid-column:1/-1">' + esc(e.message) + '</div>';
  }
}

/* ---------------------------------------------------------------- 设置 */
async function loadSettings() {
  try {
    const [{ overview: o }, { settings: st }, sess] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/settings'),
      fetch('/api/auth/session').then((r) => r.json()).catch(() => ({})),
    ]);
    const box = $('sys-info');
    box.innerHTML = `
      <dt>引擎模式</dt><dd>纯云端（本地 GPU 已下线）</dd>
      <dt>云端并发工位</dt><dd>${o.cloud_workers}</dd>
      <dt>图库占用</dt><dd>${fmtBytes(o.gallery_bytes)}</dd>
      <dt>任务 / 图片</dt><dd>${o.jobs_total} / ${o.images_total}</dd>
      <dt>近 7 天图片</dt><dd>${o.images_7d}</dd>`;

    $('set-open').checked = st.open_register === '1';
    $('set-invite').value = st.invite_code || '';
    $('set-site').value = st.site_name || '';

    const me = sess && sess.user;
    $('me-note').textContent = me
      ? `当前登录：${me.uid}（${me.role === 'admin' ? '管理员' : '普通用户'}，${me.works || 0} 张作品）。`
      : '当前是用旧版全局口令进来的，改密码只会更新那个口令；建议改用账号登录。';

    $('legacy-note').textContent =
      '隔离前的老作品现在只有管理员能看到。要长期保留，把它们的归属划到某个账号下。';

    const banner = document.querySelector('.ad-banner');
    if (o.initial_pw && !banner) {
      const b = document.createElement('div');
      b.className = 'ad-banner';
      b.textContent = '⚠ 旧版全局口令仍是初始值（atlas-admin），请尽快在 admin.json 对应的口令处更换，'
        + '它是账号系统出问题时的应急入口。';
      document.querySelector('.ad-cards').prepend(b);
    }
  } catch (e) { /* ignore */ }
}

$('set-save').addEventListener('click', async () => {
  try {
    await post('/api/admin/settings', {
      open_register: $('set-open').checked,
      invite_code: $('set-invite').value.trim(),
      site_name: $('set-site').value.trim(),
    });
    toast('设置已保存');
    loadSettings();
  } catch (err) { toast(err.message); }
});

/* ---------------------------------------------------------------- 账号弹窗 */
let accMode = 'create';
let accTarget = null;

function openAccModal(mode, u) {
  accMode = mode;
  accTarget = u || null;
  const modal = $('acc-modal');
  const err = $('acc-err');
  err.hidden = true;
  err.textContent = '';
  $('acc-pw').value = '';
  if (mode === 'create') {
    $('acc-title').textContent = '新建账号';
    $('acc-sub').textContent = '用户名会成为作品目录名，建好后不能改。';
    $('acc-uid').value = '';
    $('acc-uid').disabled = false;
    $('acc-pw-label').textContent = '初始密码';
    $('acc-ok').textContent = '创建';
    $('acc-role-row').hidden = false;
    $('acc-role').value = 'user';
  } else if (mode === 'reset') {
    $('acc-title').textContent = '重置密码 · ' + u.uid;
    $('acc-sub').textContent = '重置后他所有设备上的登录都会失效，需要用新密码重新登录。';
    $('acc-uid').value = u.uid;
    $('acc-uid').disabled = true;
    $('acc-pw-label').textContent = '新密码';
    $('acc-ok').textContent = '重置';
    $('acc-role-row').hidden = true;
  } else {                        // adopt：历史身份转正式账号
    $('acc-title').textContent = '转为账号 · ' + u.uid;
    $('acc-sub').textContent = '沿用这个身份名，名下 ' + u.images + ' 张作品会自动归到新账号。';
    $('acc-uid').value = u.uid;
    $('acc-uid').disabled = true;
    $('acc-pw-label').textContent = '初始密码';
    $('acc-ok').textContent = '开通';
    $('acc-role-row').hidden = false;
    $('acc-role').value = 'user';
  }
  modal.hidden = false;
  setTimeout(() => $('acc-pw').focus(), 60);
}

function closeAccModal() {
  $('acc-modal').hidden = true;
  accTarget = null;
}

$('acc-cancel').addEventListener('click', closeAccModal);
$('acc-modal').addEventListener('click', (e) => { if (e.target.id === 'acc-modal') closeAccModal(); });

$('acc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('acc-err');
  const uid = ($('acc-uid').value || '').trim().toLowerCase();
  const pw = $('acc-pw').value || '';
  try {
    if (accMode === 'reset') {
      await post('/api/admin/accounts/update', { uid, password: pw });
      toast('密码已重置');
    } else {
      await post('/api/admin/accounts/create', {
        uid, password: pw, role: $('acc-role').value,
      });
      toast(accMode === 'adopt' ? '已开通账号，作品仍在原处' : '账号已创建');
    }
    closeAccModal();
    loadUsers();
    loadOverview();
  } catch (ex) {
    err.textContent = ex.message || '操作失败';
    err.hidden = false;
  }
});

$('usr-create').addEventListener('click', () => openAccModal('create'));
let usrTimer = null;
$('usr-q').addEventListener('input', () => {
  clearTimeout(usrTimer);
  usrTimer = setTimeout(loadUsers, 300);
});

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = $('pw-cur').value;
  const nw = $('pw-new').value;
  const nw2 = $('pw-new2').value;
  if (nw !== nw2) { toast('两次输入的新密码不一致'); return; }
  if (nw.length < 6) { toast('新密码至少 6 位'); return; }
  try {
    await post('/api/admin/password', { current: cur, new: nw });
    $('pw-form').reset();
    toast('密码已更新');
    loadSettings();
  } catch (err) {
    toast(err.message);
  }
});

$('claim-do').addEventListener('click', async () => {
  const uid = ($('claim-uid').value || '').trim().toLowerCase();
  if (!uid) { toast('先填目标账号'); return; }
  try {
    const r = await post('/api/admin/claim_legacy', { uid });
    toast('已把 ' + r.changed + ' 条老作品划给 ' + uid);
    loadOverview();
    loadUsers();
    loadSettings();
  } catch (err) { toast(err.message); }
});

$('claim-release').addEventListener('click', async () => {
  const uid = ($('claim-uid').value || '').trim().toLowerCase();
  if (!uid) { toast('先填要收回的账号'); return; }
  if (!confirm('把 ' + uid + ' 名下的作品全部收回为「公共」（仅管理员可见）？')) return;
  try {
    const r = await post('/api/admin/claim_legacy', { uid, release: true });
    toast('已收回 ' + r.changed + ' 条');
    loadOverview();
    loadUsers();
    loadSettings();
  } catch (err) { toast(err.message); }
});

$('tr-do').addEventListener('click', async () => {
  const from = ($('tr-from').value || '').trim().toLowerCase();
  const to = ($('tr-to').value || '').trim().toLowerCase();
  if (!from || !to) { toast('填好「从」和「到」'); return; }
  if (from === to) { toast('两边是同一个账号'); return; }
  if (!confirm(`把 ${from} 名下的作品全部并入 ${to}？文件会一起移动。`)) return;
  try {
    const r = await post('/api/admin/transfer_works', { from, to });
    toast('已并入 ' + r.moved + ' 条作品');
    $('tr-from').value = '';
    $('tr-to').value = '';
    loadUsers();
    loadOverview();
    loadWorks();
  } catch (err) { toast(err.message); }
});

/* ---------------------------------------------------------------- 筛选与事件 */
const bindFilter = (id, key) => {
  $(id).addEventListener('change', () => {
    S.rec[key] = $(id).value;
    S.rec.page = 1;
    loadRecords();
  });
};
bindFilter('f-uid', 'uid');
bindFilter('f-engine', 'engine');
bindFilter('f-status', 'status');
bindFilter('f-days', 'days');
$('f-days').addEventListener('change', () => { S.rec.days = parseInt($('f-days').value, 10) || 0; });

let qTimer = null;
$('f-q').addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    S.rec.q = $('f-q').value.trim();
    S.rec.page = 1;
    loadRecords();
  }, 350);
});

$('rec-refresh').addEventListener('click', () => { loadRecords(); loadOverview(); });
$('usr-refresh').addEventListener('click', () => { loadUsers(); loadOverview(); });
$('work-refresh').addEventListener('click', () => { loadWorks(); loadOverview(); });
$('w-uid').addEventListener('change', () => {
  S.work.uid = $('w-uid').value;
  S.work.page = 1;
  loadWorks();
});

/* 灯箱（点缩略图看原图） */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-full]');
  if (t) {
    $('lb-img').src = t.dataset.full;
    $('lightbox').hidden = false;
    return;
  }
  if (e.target.id === 'lightbox' || e.target.id === 'lb-img') {
    $('lightbox').hidden = true;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('lightbox').hidden = true;
});

/* ---------------------------------------------------------------- 启动 */
(async function boot() {
  try {
    const s = await api('/api/admin/session');
    if (s.authed) showPanel();
    else showLogin('');
  } catch (e) {
    showLogin('');
  }
})();
