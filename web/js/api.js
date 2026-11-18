/* 后端 API 的唯一出口：所有请求都从这里走，方便统一处理错误。 */

export async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* 空响应 */ }
  const signingOut = document.documentElement.dataset.signingOut === '1';
  if (res.status === 401 && !signingOut && !path.startsWith('/api/auth/')) {
    // 会话过期 / 账号被封：交给 app.js 统一弹回登录门
    window.dispatchEvent(new CustomEvent('atlas:unauth'));
  }
  if (!res.ok) throw new Error((data && data.error) || ('请求失败 ' + res.status));
  return data;
}

export function postJSON(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}
