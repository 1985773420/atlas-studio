/* 全局状态：唯一可变的真相源。模块之间只通过它共享数据。 */

export const state = {
  modes: {},              // id -> { label, cloud, cloud_res, cloud_counts, needs_image, placeholder }
  mode: 'generate',
  engine: '',             // 云端模型 id；空表示用当前模式的第一个模型
  tier: '1K',             // 云端分辨率档位
  ratio: '1:1',           // 云端画面比例
  count: 1,               // 云端批量
  ref: null,              // { filename, preview } 参考图
  active: new Map(),      // jobId -> { card, cfg, t0 } 还在跑的任务
  lib: { items: [], cats: [], cat: '全部', q: '' },
};
