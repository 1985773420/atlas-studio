/* ============================================================================
   jobs.js —— 任务生命周期（并发核心）
   提交即返回、多任务并存、一条批量轮询、刷新后可恢复。
   卡片长什么样由注入的 UI 处理器决定（gallery.js 提供），这里只管状态。
   ========================================================================== */

import { api, postJSON } from './api.js';
import { state } from './state.js';

let ui = null;            // { createCard, updateCard, finishCard, failCard, onActive }
let timer = null;
let polling = false;

export function init(handlers) {
  ui = handlers;
}

export function activeCount() {
  return state.active.size;
}

/* 提交一个任务：先摆占位卡，再 POST；失败就地变失败卡（可重试） */
export async function submit(cfg) {
  const engine = cfg.provider === 'cloud' ? 'cloud' : 'local';
  const card = ui.createCard({ engine, prompt: cfg.prompt, cfg });
  try {
    const { job } = await postJSON('/api/create', cfg);
    state.active.set(job.id, { card, cfg, t0: Date.now() });
    apply(job);
    sync();
    start();
    return job;
  } catch (err) {
    ui.failCard(card, err.message, cfg, null);
    return null;
  }
}

/* 刷新页面后恢复还在跑的任务（由 gallery.load 调用） */
export function restore(pending) {
  const list = pending || [];
  list.forEach((job) => {
    const card = ui.createCard({ engine: job.engine, prompt: job.prompt, cfg: null });
    state.active.set(job.id, { card, cfg: null, t0: Date.now() });
    apply(job);
  });
  if (list.length) {
    sync();
    start();
  }
}

function apply(job) {
  const entry = state.active.get(job.id);
  if (!entry) return;
  if (job.status === 'done') {
    finish(job, entry);
    return;
  }
  if (job.status === 'error') {
    fail(job, entry);
    return;
  }
  ui.updateCard(entry.card, job, entry);
}

function finish(job, entry) {
  state.active.delete(job.id);
  ui.finishCard(entry.card, job);     // 占位卡原地换成成品（带像素显影）
  sync();
  stopIfIdle();
}

function fail(job, entry) {
  state.active.delete(job.id);
  ui.failCard(entry.card, job.error || '生成失败', entry.cfg, job.id);
  sync();
  stopIfIdle();
}

function sync() {
  if (ui && ui.onActive) ui.onActive(state.active.size);
}

function start() {
  if (!timer) timer = setInterval(poll, 1200);
}

function stopIfIdle() {
  if (timer && !state.active.size) {
    clearInterval(timer);
    timer = null;
  }
}

/* 所有在跑的任务共用这一条轮询 */
async function poll() {
  if (polling) return;
  if (!state.active.size) {
    stopIfIdle();
    return;
  }
  polling = true;
  try {
    const ids = Array.from(state.active.keys());
    const { jobs } = await api('/api/jobs?ids=' + encodeURIComponent(ids.join(',')));
    const seen = new Set();
    (jobs || []).forEach((job) => {
      seen.add(job.id);
      apply(job);
    });
    ids.forEach((id) => {                       // 服务端不认识 = 丢了
      if (seen.has(id) || !state.active.has(id)) return;
      fail({ id, error: '任务已丢失（服务可能重启过），请重试' }, state.active.get(id));
    });
  } catch (e) {
    /* 网络抖动：下一轮再试 */
  } finally {
    polling = false;
  }
}
