# Atlas Studio

中文图像创作台：原生 HTML/CSS/JavaScript 前端、Python HTTP API、SQLite、多用户账户、异步云端图像任务、提示词库及管理后台。

本目录是用于公开代码的独立整理版，不是线上数据备份。原创代码和文档采用 Apache-2.0 许可证；第三方组件遵循各自条款。

## 内容与运行条件

- `backend/server.py`：后端入口，同时提供前端静态文件；Python 3.11+。
- `web/`：当前前端，无 npm、打包步骤或外部 CDN 依赖。
- `backend/prompts.json`：重新编写的安全示例，不含原提示词库或用户自定义记录。
- `data/`：首次启动自动创建，存放 SQLite、管理员配置、可编辑提示词库、上传、作品和缓存，禁止提交。
- `Pillow`：图像处理依赖，安装见 `requirements.txt`。不需要 GPU、ComfyUI、Redis 或 PostgreSQL。本地引擎为停用的历史代码，不能据此认为相关按钮支持本地图像生成。

原有截图、生成预览、用户上传、作品、数据库、管理员配置、备份、旧版前端和私人测试脚本均未复制。首页使用新建的中性占位图；提示词预览初始为空，属于预期行为。

## 本机启动

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，为 ATLAS_ADMIN_PW 设置至少 12 位的全新强密码
chmod 600 .env
PYTHON=.venv/bin/python ./start.sh
```

访问 `http://127.0.0.1:8190/`，后台为 `/admin`。`start.sh` 会切换到项目根目录、读取可信 `.env` 并设置限制性文件权限；直接运行 `python3 -I backend/server.py` 时不会自动读取 `.env`，必须先自行导出环境变量。相对 `ATLAS_DATA_DIR` 按进程工作目录解析。

首次启动必须设置管理员密码，不存在通用默认密码；密码只以加盐哈希保存，日志不输出密码。已有 `data/admin.json` 时不会因修改环境变量而重置密码，损坏配置会报错而不是悄悄覆盖。首次创建后可移除 `.env` 中的初始化密码，正常重启无需再次提供。请在后台维护密码；丢失全部管理员凭据时，在停服且备份数据后删除自己的 `data/admin.json` 再初始化，会使旧签名会话失效。

默认关闭公开注册。管理员先在 `/admin` 登录，创建普通账户，或在设置中按需开放注册/设置邀请码。管理员后台登录与普通前台账户是不同入口。

## 云端图像 API

不配置云端凭据即可启动、登录、管理账户和提示词，**不会因此具备生图能力**。

| 配置项 | 用途 |
| --- | --- |
| `ATLAS_ADMIN_PW` | 首次初始化所需，全新且至少 12 位 |
| `ATLAS_DATA_DIR` | 数据目录，默认项目内 `data/` |
| `BIND` / `PORT` | 默认 `127.0.0.1` / `8190` |
| `ATLAS_CLOUD_WORKERS` | 云任务线程数，建议从 4 开始；未设置时源码默认 24 |
| `AGENT3_BASE` | 图像服务 HTTPS API 根路径，例如 `https://images.example.com/v1`；无实际服务默认值 |
| `AGENT3_KEY` | 自有服务密钥，默认空 |
| `RELAY_BASE` / `RELAY_TOKEN` | 可选的自有下载中转，默认关闭 |

接口使用 `POST /images/generations` 和 multipart `POST /images/edits`。这只是请求形状兼容，不保证任意供应商可用。现有模型列表、分辨率、返回格式及上游命名约定仍来自原实现，请先根据供应商文档检查 `MODES`、`cloud_generate`、`cloud_edit`。公开版移除了原先专用的多组密钥池与模型后缀，改为一个无后缀标准凭据；若供应商需要后缀，应使用自己的模型配置修改代码。不要把密钥写进前端或源文件。

历史代码对外部 HTTP 请求使用自建 urllib opener，存在不继承环境代理的路径；不能假定设置 `HTTP_PROXY` 就能控制所有出口。上游下载 URL 和可选中转均属于信任边界，请限制服务网络出口，避免连接内网元数据或不可信中转。健康检查的 `cloud` 仅表示配置了 key，不代表上游连通或额度可用。

本次整理未调用任何外部服务、未运行付费生成、未验证供应商连通或计费。

## Docker Compose 部署

```sh
cp .env.example .env
# 编辑 .env 设置初始化密码及可选云端参数
chmod 600 .env
docker compose up -d --build
docker compose logs --tail=50
```

构建会下载基础镜像和 Python 依赖，需要网络；本次未执行构建。容器以非 root 用户运行，数据保存在 `atlas-data` 命名卷，宿主端口只绑定回环地址。不要执行 `docker compose down -v`，除非明确要删除全部数据。容器配置覆盖 `.env` 内的数据目录、监听地址和端口。

公网部署必须使用可信 HTTPS 反向代理，并限制后台及注册入口。Python `http.server` 不是成熟的互联网网关，不应直接开放到公网；建议仅供受控的小规模部署，外层添加认证、请求体大小限制、超时、限流、防火墙和访问日志策略。原实现的会话 cookie 尚未全面启用 `Secure`，TLS 代理应添加 Secure 属性（例如 nginx `proxy_cookie_flags ~ secure httponly samesite=lax;`），并核对浏览器实际响应。API 及上传安全未做完整专项审计，本整理不构成无漏洞保证。

单进程运行，不要在同一数据目录启动多个实例。队列在内存中，重启可能中断未完成任务；数据库保存的历史记录不是可靠的分布式任务队列。

## 备份、升级与隐私

停服后备份完整 `data/` 或 Compose 命名卷，包含 `admin.json`、SQLite、提示词库及图像目录；管理员签名密钥丢失会使会话失效。备份应加密并限制访问。初始化仅在数据目录不存在提示词库时复制示例；后续修改源 `backend/prompts.json` 不会覆盖运行中的提示词库。

不要把 `.env`、`data/`、数据库、日志、上传、截图或备份加入 Git。`.gitignore` 只是防误提交措施，不能清除 Git 历史中的秘密。推送前仍应人工检查全部待发布文件与历史；若原先硬编码凭据曾被分享，请在供应商侧轮换（本次未代为操作）。

## 离线验证

```sh
python3 -I tests/offline_smoke.py
```

测试在本目录内创建临时隔离数据，启动真实后端，仅访问 `127.0.0.1`；清空上游配置，拒绝非回环网络，并在结束时终止子进程、清理数据。覆盖首次启动拒绝空密码、安全初始化、管理员登录、未授权接口、静态资源、提示词、默认禁用注册及重启持久化。测试不生成真实图像、不请求供应商。Python/JavaScript 语法检查可以分别使用 `python3 -m py_compile backend/server.py` 和支持 ES module 的 Node 语法检查。


## 开源许可证

Copyright 2026 1985773420。原创代码和文档采用 [Apache License 2.0](LICENSE)，允许商用、修改和分发，并含明确的专利授权及终止条款；使用和分发须遵守许可、保留相关声明并标明修改。软件按原样提供，不提供担保。第三方依赖及资源不因本项目许可而改变其原有条款，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
