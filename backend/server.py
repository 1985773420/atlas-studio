#!/usr/bin/env python3
"""Atlas Studio 后端：纯云端图像创作台 API（本地 ComfyUI/GPU 已于 2026-11-18 下线）。

设计要点
- 全部生成任务走云端（配置的图像 API），不再访问本地 GPU。
- 云端多工线程池：上游支持大并发，提交即返回 job id，前台从不等待。
- 多用户隔离（防窜台）：浏览器持有一个 uid cookie（?u=xxx 可显式指定），
  任务/作品/上传都按 uid 归档，别人的东西既不出现在列表里也取不到文件。
- 上传的参考图只存本地 uploads/<uid>/，云端编辑时直接读取该文件。
- 成果落 gallery/<uid>/，元数据落 SQLite，刷新页面不丢历史。
"""
import base64
import hashlib
import hmac
import io
import json
import os
import queue
import random
import re
import sqlite3
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket as _socket

# 本地 ComfyUI 已于 2026-11-18 下线；空值仅让遗留函数可导入，运行路径不再访问。
COMFY = ''  # 本公开版本不启用旧本地引擎
PORT = int(os.environ.get('PORT', '8190'))
BIND = os.environ.get('BIND', '127.0.0.1')

CODE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(CODE_DIR)
BASE = os.path.abspath(os.environ.get('ATLAS_DATA_DIR', os.path.join(ROOT, 'data')))
WEB = os.path.join(ROOT, 'web')
UPLOADS = os.path.join(BASE, 'uploads')
GALLERY = os.path.join(BASE, 'gallery')
PREVIEWS = os.path.join(BASE, 'previews')
THUMBS = os.path.join(BASE, 'thumbs')       # 管理台缩略图缓存（磁盘）
PROMPTS_FILE = os.path.join(BASE, 'prompts.json')
DB_PATH = os.path.join(BASE, 'studio.db')
for d in (UPLOADS, GALLERY, PREVIEWS, THUMBS):
    os.makedirs(d, exist_ok=True)
if not os.path.exists(PROMPTS_FILE):
    import shutil
    shutil.copyfile(os.path.join(CODE_DIR, 'prompts.json'), PROMPTS_FILE)

# 云端并发工位数：上游支持大并发，默认开 24 条（可用 ATLAS_CLOUD_WORKERS 调）
CLOUD_WORKERS = max(1, int(os.environ.get('ATLAS_CLOUD_WORKERS', '24')))
# 身份标识：小写字母/数字开头，3~24 位
UID_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{2,23}$')


# ---------------------------------------------------------------- 管理员
# 密码存 backend/admin.json（600 权限，PBKDF2 加盐，不落明文）；会话是无状态签名
# cookie（HMAC），不占会话表。首次启动自动创建一个，初始密码见 ADMIN_INITIAL_PW。
ADMIN_FILE = os.path.join(BASE, 'admin.json')
ADMIN_INITIAL_PW = os.environ.get('ATLAS_ADMIN_PW', '')
ADMIN_TTL = 7 * 24 * 3600
# 登录限流：key -> [失败时间戳]。按「IP|用户名」计数（一个 IP 后常有多个人），
# 再加一道 IP 总量闸门防止有人遍历用户名。登录成功即清零该用户名的计数。
_LOGIN_FAILS = {}
LOGIN_WINDOW = 300
LOGIN_MAX_PER_USER = 8
LOGIN_MAX_PER_IP = 30


def _fails(key, now):
    arr = [t for t in _LOGIN_FAILS.get(key, []) if now - t < LOGIN_WINDOW]
    _LOGIN_FAILS[key] = arr
    return arr


def _hash_pw(pw, salt=None):
    salt = salt or os.urandom(16)
    return salt.hex(), hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, 120000).hex()


def _save_admin(d):
    tmp = ADMIN_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ADMIN_FILE)


def _load_admin():
    if os.path.exists(ADMIN_FILE):
        with open(ADMIN_FILE, encoding='utf-8') as f:
            d = json.load(f)
        if not all(d.get(k) for k in ('salt', 'hash', 'secret')):
            raise RuntimeError('管理员配置损坏，请从自己的备份恢复；不会自动覆盖。')
        return d
    if len(ADMIN_INITIAL_PW) < 12:
        raise RuntimeError('首次启动必须设置至少 12 位的 ATLAS_ADMIN_PW。')
    salt, h = _hash_pw(ADMIN_INITIAL_PW)
    d = {'salt': salt, 'hash': h, 'secret': os.urandom(32).hex(),
         'updated': time.time(), 'initial': True}
    _save_admin(d)
    print('[admin] 已创建独立管理员配置；密码不会写入日志。')
    return d


ADMIN = _load_admin()


def check_pw(pw):
    if not pw:
        return False
    _, h = _hash_pw(pw, bytes.fromhex(ADMIN['salt']))
    return hmac.compare_digest(h, ADMIN['hash'])


def _admin_sig(exp):
    return hmac.new(bytes.fromhex(ADMIN['secret']),
                    ('admin:%d' % exp).encode(), hashlib.sha256).hexdigest()


def admin_token():
    exp = int(time.time()) + ADMIN_TTL
    return '%d.%s' % (exp, _admin_sig(exp))


def admin_token_ok(tok):
    try:
        exp_s, sig = tok.split('.', 1)
        exp = int(exp_s)
    except Exception:
        return False
    if exp < time.time():
        return False
    return hmac.compare_digest(sig, _admin_sig(exp))


def login_blocked(ip, uid=''):
    now = time.time()
    if len(_fails('ip:' + ip, now)) >= LOGIN_MAX_PER_IP:
        return True
    if uid and len(_fails('u:%s|%s' % (ip, uid), now)) >= LOGIN_MAX_PER_USER:
        return True
    return False


def login_fail(ip, uid=''):
    now = time.time()
    _LOGIN_FAILS.setdefault('ip:' + ip, []).append(now)
    if uid:
        _LOGIN_FAILS.setdefault('u:%s|%s' % (ip, uid), []).append(now)


def login_reset(ip, uid=''):
    """登录成功：清掉这个用户名的失败计数（IP 总量闸门保留，防遍历）。"""
    _LOGIN_FAILS.pop('u:%s|%s' % (ip, uid), None)


# ---------------------------------------------------------------- 账号体系
# 用户 = users 表里的一行，uid 就是登录名（沿用旧表，历史作品一行都不用搬）。
# 会话是无状态的签名 cookie：uid.exp.pw_ver.sig —— pw_ver 一变（改密 / 封禁 /
# 重置）所有旧会话立刻失效，不需要服务端会话表。
SESS_COOKIE = 'atlas_sess'
SESS_TTL = 30 * 24 * 3600
PW_MIN = 6
USER_COLS = ('uid', 'pw_salt', 'pw_hash', 'role', 'status', 'pw_ver', 'name',
             'created', 'last_login', 'ip', 'ua', 'first_seen', 'last_seen')

SETTINGS_DEFAULT = {
    'open_register': '0',       # 1 = 允许自助注册
    'invite_code': '',          # 非空则注册必须带邀请码
    'site_name': 'Atlas Studio',
}


def _sess_sig(uid, exp, pwv):
    return hmac.new(bytes.fromhex(ADMIN['secret']),
                    ('sess:%s:%d:%d' % (uid, exp, pwv)).encode(),
                    hashlib.sha256).hexdigest()


def make_session(uid, pwv):
    exp = int(time.time()) + SESS_TTL
    return '%s.%d.%d.%s' % (uid, exp, pwv, _sess_sig(uid, exp, pwv))


def parse_session(tok):
    """校验会话 cookie，返回 (uid, pw_ver)；不合法返回 None。"""
    parts = (tok or '').split('.')
    if len(parts) != 4:
        return None
    uid, exp_s, pwv_s, sig = parts
    if not UID_RE.match(uid):
        return None
    try:
        exp, pwv = int(exp_s), int(pwv_s)
    except ValueError:
        return None
    if exp < time.time():
        return None
    if not hmac.compare_digest(sig, _sess_sig(uid, exp, pwv)):
        return None
    return uid, pwv


def user_get(uid):
    if not uid:
        return None
    try:
        conn = db()
        conn.row_factory = sqlite3.Row
        r = conn.execute('SELECT %s FROM users WHERE uid=?' % ','.join(USER_COLS),
                         (uid,)).fetchone()
        conn.close()
    except Exception:
        traceback.print_exc()
        return None
    if not r:
        return None
    u = dict(r)
    u['pw_ver'] = u.get('pw_ver') or 0
    u['role'] = u.get('role') or 'guest'     # guest = 升级前遗留的浏览器身份
    u['status'] = u.get('status') or 'active'
    u['name'] = u.get('name') or u['uid']
    return u


def user_auth(uid, pw):
    """校验用户名密码；封禁 / 未注册（无密码）/ 密码错都返回 None。"""
    u = user_get(uid)
    if not u or not u.get('pw_hash') or not u.get('pw_salt'):
        return None
    if u['status'] != 'active':
        return None
    try:
        _, h = _hash_pw(pw or '', bytes.fromhex(u['pw_salt']))
    except Exception:
        return None
    return u if hmac.compare_digest(h, u['pw_hash']) else None


def user_set_password(uid, pw):
    salt, h = _hash_pw(pw)
    conn = db()
    conn.execute('UPDATE users SET pw_salt=?, pw_hash=?, pw_ver=COALESCE(pw_ver,0)+1, '
                 'first_seen=COALESCE(first_seen,?) WHERE uid=?', (salt, h, time.time(), uid))
    conn.commit()
    conn.close()


def user_create(uid, pw, role='user', name='', ip='', ua=''):
    """建账号；如果 uid 已存在但是未注册的访客行，就地升级（作品继续挂在名下）。"""
    now = time.time()
    salt, h = _hash_pw(pw)
    conn = db()
    cur = conn.execute('UPDATE users SET pw_salt=?, pw_hash=?, role=?, status="active", '
                       'name=COALESCE(NULLIF(name, ""), ?), created=COALESCE(created, ?), '
                       'ip=COALESCE(NULLIF(ip, ""), ?), ua=COALESCE(NULLIF(ua, ""), ?), '
                       'first_seen=COALESCE(first_seen, ?), last_seen=? WHERE uid=?',
                       (salt, h, role, name or uid, now, ip, ua, now, now, uid))
    if cur.rowcount == 0:
        conn.execute('INSERT INTO users(uid, pw_salt, pw_hash, role, status, pw_ver, name, '
                     'created, ip, ua, first_seen, last_seen) '
                     'VALUES(?,?,?,?,?,0,?,?,?,?,?,?)',
                     (uid, salt, h, role, 'active', name or uid, now, ip, ua, now, now))
    conn.commit()
    conn.close()
    return user_get(uid)


def touch_login(uid, ip, ua):
    try:
        conn = db()
        conn.execute('UPDATE users SET last_login=?, last_seen=?, ip=?, ua=? WHERE uid=?',
                     (time.time(), time.time(), ip, ua, uid))
        conn.commit()
        conn.close()
    except Exception:
        traceback.print_exc()


def public_user(u, works=None):
    if not u:
        return None
    d = {'uid': u['uid'], 'name': u.get('name') or u['uid'], 'role': u['role'],
         'created': u.get('created'), 'last_login': u.get('last_login')}
    if works is not None:
        d['works'] = works
    return d


def settings_all():
    out = dict(SETTINGS_DEFAULT)
    try:
        conn = db()
        for k, v in conn.execute('SELECT k, v FROM settings').fetchall():
            out[k] = v
        conn.close()
    except Exception:
        pass
    return out


def settings_set(k, v):
    conn = db()
    conn.execute('INSERT OR REPLACE INTO settings(k, v) VALUES(?, ?)', (k, str(v)))
    conn.commit()
    conn.close()


def touch_user(uid, ip, ua):
    """记录/更新浏览器身份（后台「用户」页的数据来源）。"""
    if not uid:
        return
    try:
        conn = db()
        cur = conn.execute('UPDATE users SET last_seen=?, ip=?, ua=? WHERE uid=?',
                           (time.time(), ip, ua, uid))
        if cur.rowcount == 0:
            try:
                conn.execute('INSERT INTO users(uid, ip, ua, first_seen, last_seen) '
                             'VALUES(?,?,?,?,?)', (uid, ip, ua, time.time(), time.time()))
            except sqlite3.IntegrityError:
                pass          # 并发下另一个线程刚插过
        conn.commit()
        conn.close()
    except Exception:
        traceback.print_exc()


def owner_relpath(base, owner, fn):
    """成果文件按用户分目录存放，返回相对路径（含 uid 前缀）；老数据保持无前缀。"""
    if not owner:
        return fn
    os.makedirs(os.path.join(base, owner), exist_ok=True)
    return owner + '/' + fn


def owner_abspath(base, owner, rel):
    """解析文件路径：优先本人目录，其次老的无前缀公共文件。"""
    rel = (rel or '').lstrip('/')
    if os.sep in rel or '/' in rel:
        return os.path.join(base, *[p for p in rel.split('/') if p and p != '..'])
    if owner:
        p = os.path.join(base, owner, rel)
        if os.path.exists(p):
            return p
    return os.path.join(base, rel)


def load_prompts():
    """提示词库（本地 JSON，改文件即生效，不用重启）。"""
    try:
        with open(PROMPTS_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print('[prompts] 读取失败: %s' % e)
        return {'categories': ['全部'], 'items': []}


def save_prompts(d):
    # 原子写回：先写临时文件再替换，避免写一半崩掉
    tmp = PROMPTS_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PROMPTS_FILE)


def _preview_dims(ratio):
    """预览图尺寸：按配方声明的比例出图，均为 64 的倍数。"""
    table = {
        '1:1': (1024, 1024), '16:9': (1152, 640), '9:16': (640, 1152),
        '4:3': (1024, 768), '3:4': (768, 1024), '3:2': (1152, 768),
        '2:3': (768, 1152), '4:5': (1024, 1280), '21:9': (1344, 576),
    }
    return table.get(ratio or '1:1', (1024, 1024))


def preview_path(pid):
    return os.path.join(PREVIEWS, pid + '.jpg')


def has_preview(pid):
    fp = preview_path(pid)
    return os.path.exists(fp) and os.path.getsize(fp) > 2000


def comfy_online():
    return False
    try:
        http_json(COMFY + '/system_stats', timeout=6)
        return True
    except Exception:
        return False


def generate_preview(pid, budget=300):
    """用本地 ComfyUI 生成一张预览图并存为 previews/<id>.jpg。"""
    lib = load_prompts()
    item = None
    for it in lib.get('items') or []:
        if it.get('id') == pid:
            item = it
            break
    if not item:
        raise RuntimeError('配方不存在：%s' % pid)
    prompt_text = (item.get('prompt') or '').strip()
    if not prompt_text:
        raise RuntimeError('配方没有提示词')

    w, h = _preview_dims(item.get('ratio'))
    api_prompt, _meta = build_prompt('generate', {
        'prompt': prompt_text, 'width': w, 'height': h,
        'seed': __import__('random').randint(1, 10 ** 9),
    })
    r = http_json(COMFY + '/prompt',
                  {'prompt': api_prompt, 'client_id': 'atlas-preview'}, timeout=60)
    if r.get('node_errors'):
        raise RuntimeError('ComfyUI 参数错误：%s' % json.dumps(r['node_errors'])[:200])
    job_id = r.get('prompt_id')
    if not job_id:
        raise RuntimeError('ComfyUI 未返回任务 id')

    t0 = time.time()
    while time.time() - t0 < budget:
        time.sleep(2)
        try:
            hist = http_json(COMFY + '/history/' + job_id, timeout=20)
        except Exception:
            continue
        item_h = hist.get(job_id)
        if not item_h:
            continue
        st = item_h.get('status') or {}
        if st.get('status_str') == 'error':
            raise RuntimeError('出图失败：%s' % json.dumps(st.get('messages', []))[:200])
        if st.get('completed'):
            imgs = [im for out in (item_h.get('outputs') or {}).values()
                    for im in (out.get('images') or [])]
            if not imgs:
                raise RuntimeError('工作流完成但没有图片')
            im = imgs[0]
            qs = urllib.parse.urlencode({'filename': im['filename'],
                                         'subfolder': im.get('subfolder', ''),
                                         'type': 'output'})
            with urllib.request.urlopen(COMFY + '/view?' + qs, timeout=120) as resp:
                raw = resp.read()
            dst = preview_path(pid)
            try:
                from PIL import Image
                pic = Image.open(io.BytesIO(raw)).convert('RGB')
                pic.save(dst, 'JPEG', quality=88, optimize=True)
            except Exception:
                with open(dst, 'wb') as f:
                    f.write(raw)
            return dst
    raise RuntimeError('生成超时（%d 秒）' % budget)


def slugify(text, fallback='recipe'):
    import hashlib
    h = hashlib.md5(text.encode('utf-8')).hexdigest()[:8]
    return '%s-%s' % (fallback, h)

# ---------------------------------------------------------------- 工作流定义
# wf   : Windows 上 ComfyUI 工作流文件名
# 提示词/尺寸/seed 用「角色」定位，而不是硬编码 node id，
# 这样用户在工作流里挪动/重排节点也不会打崩网站。
MODES = {
    'generate': {
        'label': '文生图',
        'wf': 'Qwen生图-Turbo快速版.json',
        'size': [1024, 1024],
        'sizes': [[1024, 1024], [1360, 768], [768, 1360], [1536, 640], [640, 1536], [2048, 1024], [1024, 2048]],
        'cloud': [
            {'id': 'gpt-image-2.5-flare', 'note': '最快'},
            {'id': 'gpt-image-2', 'note': ''},
            {'id': 'gpt-image-2.5', 'note': ''},
            {'id': 'nano-banana-2.1', 'note': '新'},
            {'id': 'nano-banana-2', 'note': '新'},
            {'id': 'gemini-3.1-flash-image', 'note': '新'},
        ],
        'cloud_res': {'tiers': ['1K', '2K', '4K'],
                      'ratios': ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5']},
        'cloud_counts': [1, 2, 4],
        'needs_image': False,
        'placeholder': '描述你想要的画面。英文效果最佳，例如：\nA lone lighthouse on a cliff at dusk, crashing waves, warm lantern glow, cinematic photography',
    },
    'edit': {
        'label': '图片编辑',
        'wf': 'Qwen图片编辑.json',
        'size': [1024, 1024],
        'sizes': [],
        'cloud': [
            {'id': 'gpt-image-2.5-flare', 'note': ''},
            {'id': 'nano-banana-2.1', 'note': '新'},
            {'id': 'nano-banana-2', 'note': '新'},
            {'id': 'gemini-3.1-flash-image', 'note': '新'},
        ],
        'cloud_res': {},
        'cloud_counts': [1, 2],
        'needs_image': True,
        'placeholder': '描述想要的效果，中文可以直接写。例如：\n将这张照片转换为精美的日式动漫风格插画，赛璐璐平涂上色，干净清晰的线稿',
    },
    'sticker': {
        'label': '透明贴纸',
        'wf': 'Qwen生图-透明贴纸.json',
        'size': [1024, 1024],
        'sizes': [[1024, 1024], [2048, 2048]],
        'cloud': [
            {'id': 'gpt-image-2.5-flare', 'note': ''},
        ],
        'cloud_res': {'tiers': ['1K', '2K', '4K'], 'ratios': ['1:1']},
        'cloud_counts': [1, 2, 4],
        'needs_image': False,
        'prefix': 'This is an RGBA image with transparency. ',
        'placeholder': '只写主体，透明底前缀会自动补上。例如：\nA cute cartoon cat sticker, big head, waving paw, thick outline',
    },
}

NODE_UI_TYPES = {  # 不需要参与 API 提交的前端节点
    'MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode',
}

# ---------------------------------------------------------------- 工作流转 API
_wf_cache = {}


def http_json(url, payload=None, timeout=30, method=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return json.loads(body) if body else {}


# ---------------------------------------------------------------- 本地引擎已下线
# 2026-11-18 起只保留云端引擎；本地 ComfyUI 的 SSH 唤醒逻辑已移除。


# ---------------------------------------------------------------- 云端引擎（配置的图像 API）
# 文生图/贴纸走 /v1/images/generations，编辑走 /v1/images/edits（multipart）。
AGENT3_BASE = os.environ.get('AGENT3_BASE', '')
AGENT3_KEY = os.environ.get('AGENT3_KEY', '')
RELAY_BASE = os.environ.get('RELAY_BASE', '')
RELAY_TOKEN = os.environ.get('RELAY_TOKEN', '')
CLOUD_DIRECT_RACE = 3   # 直连兜底的并发竞速连接数

CLOUD_PROVIDERS = [
    {'name': 'std', 'suffix': '', 'key': AGENT3_KEY},
]

# ---------------------------------------------------------------- 预览图生成队列
PREVIEW_STATE = {'running': False, 'done': 0, 'failed': 0,
                 'total': 0, 'current': '', 'results': {}}
_PREVIEW_LOCK = threading.Lock()


def preview_status():
    with _PREVIEW_LOCK:
        st = dict(PREVIEW_STATE)
        st['results'] = dict(PREVIEW_STATE['results'])
    st['comfy'] = comfy_online()
    return st


def queue_preview_job(ids):
    """把需要生成预览图的配方 id 丢进后台线程。已在跑就直接拒绝。"""
    with _PREVIEW_LOCK:
        if PREVIEW_STATE['running']:
            return False
        PREVIEW_STATE.update({'running': True, 'done': 0, 'failed': 0,
                              'total': len(ids), 'current': '', 'results': {}})

    def worker():
        ok, bad = 0, 0
        for pid in ids:
            with _PREVIEW_LOCK:
                PREVIEW_STATE['current'] = pid
            try:
                generate_preview(pid)
                ok += 1
                with _PREVIEW_LOCK:
                    PREVIEW_STATE['results'][pid] = 'ok'
            except Exception as e:
                bad += 1
                msg = str(e)[:200]
                print('[preview] %s 失败：%s' % (pid, msg), flush=True)
                with _PREVIEW_LOCK:
                    PREVIEW_STATE['results'][pid] = msg
            with _PREVIEW_LOCK:
                PREVIEW_STATE['done'] = ok
                PREVIEW_STATE['failed'] = bad
        with _PREVIEW_LOCK:
            PREVIEW_STATE['running'] = False
            PREVIEW_STATE['current'] = ''
        print('[preview] 完成 ok=%d failed=%d' % (ok, bad), flush=True)

    threading.Thread(target=worker, daemon=True).start()
    return True


_NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _open_direct(req, timeout):
    """强制不走环境代理的请求（NAS 全局代理会把 relay/CDN 弄坏）。"""
    return _NOPROXY.open(req, timeout=timeout)


def cloud_error_info(e):
    """把云端 HTTPError 拆成 (可读文本, 上游错误码)。"""
    body = ''
    try:
        body = e.read().decode('utf-8', 'replace')
    except Exception:
        pass
    code, msg = '', body
    try:
        j = json.loads(body)
        err = j.get('error') if isinstance(j, dict) else None
        if isinstance(err, dict):
            code = str(err.get('code') or '')
            msg = err.get('message') or body
        elif isinstance(j, dict):
            code = str(j.get('code') or '')
            msg = j.get('message') or body
    except Exception:
        pass
    return '云端返回 HTTP %s：%s' % (getattr(e, 'code', '?'), str(msg)[:280]), code


def cloud_error_text(e):
    return cloud_error_info(e)[0]


def cloud_generate(key, model, prompt, ratio=None, resolution=None,
                   width=None, height=None, sticker=False, n=1, timeout=420):
    if not AGENT3_BASE.startswith('https://') or not key:
        raise RuntimeError('请配置 HTTPS AGENT3_BASE 和 API key；当前未启用云端。')
    payload = {'model': model, 'prompt': prompt, 'n': max(1, min(int(n or 1), 8)),
               'output_format': 'jpeg'}
    if ratio:
        # 比例 + 分辨率档位（1K/2K/4K），文档推荐写法
        payload['size'] = ratio
        if resolution:
            payload['resolution'] = resolution
    elif width and height:
        payload['size'] = '%dx%d' % (int(width), int(height))
    if sticker:
        payload['background'] = 'transparent'
        payload['output_format'] = 'png'
    req = urllib.request.Request(AGENT3_BASE + '/images/generations',
                                 data=json.dumps(payload).encode(),
                                 headers={'Authorization': 'Bearer ' + key,
                                          'Content-Type': 'application/json'})
    t0 = time.time()
    with _open_direct(req, timeout) as r:
        d = json.loads(r.read())
    return d, time.time() - t0


def cloud_edit(key, model, image_path, prompt, n=1, timeout=420):
    if not AGENT3_BASE.startswith('https://') or not key:
        raise RuntimeError('请配置 HTTPS AGENT3_BASE 和 API key；当前未启用云端。')
    with open(image_path, 'rb') as f:
        img = f.read()
    ext = os.path.splitext(image_path)[1].lower().lstrip('.')
    mime = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
            'webp': 'image/webp'}.get(ext, 'image/png')
    boundary = '----atlas' + uuid.uuid4().hex

    def field(name, value):
        return ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
                % (boundary, name, value)).encode()

    parts = [
        ('--%s\r\nContent-Disposition: form-data; name="image"; filename="%s"\r\n'
         'Content-Type: %s\r\n\r\n' % (boundary, os.path.basename(image_path), mime)).encode(),
        img, b'\r\n',
        field('model', model),
        field('prompt', prompt),
        field('n', str(max(1, min(int(n or 1), 8)))),
        field('output_format', 'jpeg'),
        ('--%s--\r\n' % boundary).encode(),
    ]
    req = urllib.request.Request(AGENT3_BASE + '/images/edits', data=b''.join(parts),
                                 headers={'Authorization': 'Bearer ' + key,
                                          'Content-Type': 'multipart/form-data; boundary=' + boundary})
    t0 = time.time()
    with _open_direct(req, timeout) as r:
        d = json.loads(r.read())
    return d, time.time() - t0


def download_cloud_image(url, timeout=180):
    """直连与 relay 并行竞速，谁先拿到整图用谁。
    CDN 分组的图直连 ~0.5s；普通分组直连抖动大（3~18s），靠 relay（~2s）赢。"""
    box = queue.Queue()
    t0 = time.time()

    def run(tag, fn):
        try:
            data = fn()
            if data and len(data) > 800:
                box.put((data, tag, time.time() - t0))
        except Exception:
            pass

    def direct():
        with _open_direct(url, timeout) as r:
            return r.read()

    def relay():
        req = urllib.request.Request(
            RELAY_BASE + '/fetch?url=' + urllib.parse.quote(url, safe=''),
            headers={'X-Relay-Token': RELAY_TOKEN})
        with _open_direct(req, timeout) as r:
            return r.read()

    threading.Thread(target=run, args=('direct', direct), daemon=True).start()
    if RELAY_BASE and RELAY_TOKEN:
        threading.Thread(target=run, args=('relay', relay), daemon=True).start()
    try:
        return box.get(timeout=timeout + 10)
    except queue.Empty:
        raise RuntimeError('结果图下载失败（直连与 relay 都没成功）')


def fetch_workflow(name):
    """从 ComfyUI userdata 读 UI 格式工作流（带缓存 + 版本更新自动失效）。"""
    key = name
    cached = _wf_cache.get(key)
    if cached and time.time() - cached['at'] < 300:
        return cached['wf']
    url = COMFY + '/api/userdata/workflows%2F' + urllib.parse.quote(name)
    wf = http_json(url, timeout=20)
    _wf_cache[key] = {'wf': wf, 'at': time.time()}
    return wf


def ui_to_api(wf):
    """UI 格式 → API(prompt) 格式。返回 (api_prompt, warnings)。"""
    nodes = {n['id']: n for n in wf.get('nodes', []) if n.get('type') not in NODE_UI_TYPES}
    # 链接索引：[link_id] = (源节点, 源槽)
    link_src = {}
    for l in wf.get('links', []):
        if isinstance(l, list) and len(l) >= 5:
            lid, s_node, s_slot = l[0], l[1], l[2]
            link_src[lid] = (s_node, s_slot)
    api, warnings = {}, []
    for nid, n in nodes.items():
        if n.get('mode', 0) in (2, 4):   # 2=静音 4=绕过
            continue
        ctype = n['type']
        inputs = {}
        # 1) 连线输入
        for slot in n.get('inputs', []) or []:
            lid = slot.get('link')
            if lid is None or lid not in link_src:
                continue
            s_node, s_slot = link_src[lid]
            if s_node not in nodes:
                warnings.append(f'节点{nid}.{slot["name"]} 的来源不是可执行节点')
                continue
            inputs[slot['name']] = [str(s_node), s_slot]
        # 2) widget 值：按 object_info 里的顺序对位 widgets_values
        vals = n.get('widgets_values')
        names = n.get('widgets_values_named') or {}
        if isinstance(names, dict) and names:
            for k, v in names.items():
                if k not in inputs:
                    inputs[k] = v
        elif isinstance(vals, list):
            for i, v in enumerate(vals):
                nm = _widget_name(ctype, i)
                if nm and nm not in inputs:
                    inputs[nm] = v
        api[str(nid)] = {'class_type': ctype, 'inputs': inputs}
    return api, warnings


_widget_order = {}


def _widget_name(class_type, idx):
    """从 ComfyUI /object_info 取该节点的 widget 顺序，拿到第 idx 个 widget 的名字。"""
    if class_type not in _widget_order:
        try:
            info = http_json(COMFY + '/object_info/' + urllib.parse.quote(class_type), timeout=20)
            spec = info.get(class_type, {})
            req = spec.get('input', {}).get('required', {})
            opt = spec.get('input', {}).get('optional', {})
            order = []
            for sec in (req, opt):
                for nm, sd in sec.items():
                    if isinstance(sd, list) and sd and sd[0] in ('INT', 'FLOAT', 'STRING', 'BOOLEAN'):
                        order.append(nm)
                    elif isinstance(sd, list) and sd and isinstance(sd[0], list):
                        order.append(nm)   # COMBO
            # 有 widget 在前端顺序里通常排在连线输入之后，这里按声明顺序近似即可
            _widget_order[class_type] = order
        except Exception:
            _widget_order[class_type] = []
    order = _widget_order[class_type]
    return order[idx] if idx < len(order) else None


def find_nodes(api, class_type):
    return [nid for nid, n in api.items() if n['class_type'] == class_type]


def build_prompt(mode, cfg):
    """把用户参数写进 API 格式的 prompt。定位靠 class_type，不依赖 node id。"""
    m = MODES[mode]
    wf = fetch_workflow(m['wf'])
    api, warnings = ui_to_api(wf)

    prompt_text = (cfg.get('prompt') or '').strip()
    if mode == 'sticker':
        prompt_text = m['prefix'] + (prompt_text or '')
        # 工作流里原本就要求带 RGBA 前缀，避免重复
        prompt_text = re.sub(r'(This is an RGBA image with transparency\.\s*){2,}',
                             r'\1', prompt_text)
    if not prompt_text:
        raise ValueError('提示词不能为空')

    seed = cfg.get('seed')
    try:
        seed = int(seed) if seed not in (None, '', 'random') else random.randint(0, 2**48)
    except (TypeError, ValueError):
        seed = random.randint(0, 2**48)

    # 提示词：写入 TextEncodeQwenImage21（若被 Primitive 连线覆盖则一起改）
    te_ids = find_nodes(api, 'TextEncodeQwenImage21')
    if not te_ids:
        raise RuntimeError('工作流里找不到 TextEncodeQwenImage21 节点')
    for nid in te_ids:
        api[nid]['inputs']['prompt'] = prompt_text

    # seed
    for nid in find_nodes(api, 'RandomNoise'):
        api[nid]['inputs']['noise_seed'] = seed
    for nid in find_nodes(api, 'KSampler'):
        api[nid]['inputs']['seed'] = seed

    # 尺寸
    width, height = cfg.get('width'), cfg.get('height')
    if width and height:
        width, height = int(width), int(height)
        for nid in find_nodes(api, 'EmptyLatentImage'):
            api[nid]['inputs'].update(width=width, height=height)
        for nid in te_ids:
            api[nid]['inputs']['resolution'] = max(width, height)

    # 参考图
    ref_name = cfg.get('ref_filename')
    if m['needs_image']:
        if not ref_name:
            raise ValueError('该模式必须先上传一张参考图')
        li = find_nodes(api, 'LoadImage')
        if li:
            li_id = str(li[0])
            api[li_id]['inputs']['image'] = ref_name
        else:
            li_id = '9991'
            api[li_id] = {'class_type': 'LoadImage', 'inputs': {'image': ref_name}}
        for nid in te_ids:
            api[nid]['inputs']['images.image_1'] = [li_id, 0]

    # 输出前缀
    for nid in find_nodes(api, 'SaveImage'):
        api[nid]['inputs']['filename_prefix'] = 'atlas_%s' % mode

    return api, {'seed': seed, 'prompt': prompt_text, 'warnings': warnings}


# ---------------------------------------------------------------- 任务调度
# 云端唯一泳道：多工线程池，上游支持大并发，N 个任务同时跑。
class JobQueue:
    def __init__(self, cloud_workers=CLOUD_WORKERS):
        self.jobs = {}          # job_id -> job dict（只活在内存；落库在完成时）
        self.lock = threading.Lock()
        self.cloud_workers = max(1, cloud_workers)
        self.queues = {'cloud': queue.Queue()}
        for _ in range(self.cloud_workers):
            threading.Thread(target=self._run, args=('cloud',), daemon=True).start()

    @staticmethod
    def lane_of(job):
        return 'cloud'

    def submit(self, job):
        with self.lock:
            self.jobs[job['id']] = job
        self.queues[self.lane_of(job)].put(job['id'])
        return job

    def get(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)

    def pending(self, uid):
        """该用户还在排队/生成中的任务（刷新页面后能接着显示进度）。"""
        with self.lock:
            js = [j for j in self.jobs.values()
                  if j.get('owner') == uid and j.get('status') in ('queued', 'running')]
        return sorted(js, key=lambda j: j['created'])

    def ahead(self, job):
        """云端泳道里排在它前面的任务数（给「前面还有 N 个」用）。"""
        if job.get('status') != 'queued':
            return 0
        with self.lock:
            busy = sum(1 for j in self.jobs.values() if j.get('status') == 'running')
            free = max(0, self.cloud_workers - busy)
            n = max(0, sum(1 for j in self.jobs.values()
                           if j['created'] < job['created']
                           and j.get('status') == 'queued') - free)
        return n

    def recent(self, n=30):
        with self.lock:
            js = sorted(self.jobs.values(), key=lambda j: j['created'], reverse=True)
        return js[:n]

    def _run(self, lane):
        while True:
            job_id = self.queues[lane].get()
            job = self.get(job_id)
            if not job:
                continue
            try:
                self._execute(job)
            except Exception as e:
                job['status'] = 'error'
                job['error'] = str(e)[:500]
                job['message'] = '生成失败'
                print('[job %s] FAILED: %s' % (job_id, e))
                traceback.print_exc()
            finally:
                job['finished'] = time.time()
                persist_job(job)

    def _execute(self, job):
        job['status'] = 'running'
        # 2026-11-18 起本地 GPU 已下线，所有任务走云端。
        job['cfg']['provider'] = 'cloud'
        return self._execute_cloud(job)


    def _execute_cloud(self, job):
        """云端引擎：key 池（cdn 优先）+ 直连/relay 竞速取图，不占 GPU 资源。"""
        cfg = job['cfg']
        mode = job['mode']
        logical = cfg.get('cloud_model') or 'gpt-image-2.5-flare'
        prompt = (cfg.get('prompt') or '').strip()
        if mode == 'sticker' and 'transparent' not in prompt.lower():
            # 透明底语义要文字+参数双线索才稳定（实测无该提示时参数被上游忽略）
            prompt = prompt.rstrip('.,;，。') + ', transparent background'
        job['effective_prompt'] = prompt
        ratio = cfg.get('ratio')
        tier = cfg.get('resolution')
        count = max(1, min(int(cfg.get('count') or 1), 8))
        t0 = time.time()
        job['message'] = '正在提交到云端（%s%s）' % (logical, ' ×%d' % count if count > 1 else '')

        def try_provider(prov):
            """单 key 尝试（含 1 次瞬态重试）。返回 (d, api_s, err_text, terminal)。"""
            model_id = logical + prov['suffix']
            for attempt in (1, 2):
                try:
                    if mode == 'edit':
                        ref = os.path.basename(cfg.get('ref_filename') or '')
                        path = owner_abspath(UPLOADS, job.get('owner'), ref)
                        if not ref or not os.path.exists(path):
                            raise RuntimeError('参考图不存在，请重新上传后再试')
                        # 批量已改成"并行 N 个单张请求"，每次只要 1 张
                        d, api_s = cloud_edit(prov['key'], model_id, path, prompt, n=1)
                    else:
                        d, api_s = cloud_generate(prov['key'], model_id, prompt, ratio=ratio,
                                                  resolution=tier, width=cfg.get('width'),
                                                  height=cfg.get('height'),
                                                  sticker=(mode == 'sticker'), n=1)
                except urllib.error.HTTPError as e:
                    txt, ecode = cloud_error_info(e)
                    # upstream_text_reply（上游回文字）与 upstream_total_timeout（上游超时）都可重试一次
                    transient = ecode in ('upstream_text_reply', 'upstream_total_timeout') or e.code >= 500
                    terminal = e.code in (400, 404, 413) and not transient
                    if terminal:
                        return None, 0.0, txt, True      # 参数类错误，换 key 也没用
                    if attempt == 1 and transient:
                        time.sleep(2)
                        continue
                    return None, 0.0, txt, False
                except urllib.error.URLError as e:
                    if attempt == 1:
                        time.sleep(2)
                        continue
                    return None, 0.0, '连接失败：%s' % e, False
                err = d.get('error') if isinstance(d, dict) else None
                if err:
                    code = (err or {}).get('code', '')
                    txt = json.dumps(err, ensure_ascii=False)[:300]
                    if attempt == 1 and code == 'upstream_text_reply':
                        print('[cloud] 上游瞬态错误 upstream_text_reply，1 次重试')
                        time.sleep(2)
                        continue
                    return None, 0.0, txt, False
                return d, api_s, None, False
            return None, 0.0, '未知错误', False

        def attempt_once():
            """单次调用（一张）：provider 池逐个尝试，返回 (d, api_s, provider_name)。"""
            last = None
            for prov in CLOUD_PROVIDERS:
                if not prov['key']:
                    continue
                only = prov.get('only')
                if only and logical not in only:
                    continue
                skip = prov.get('skip')
                if skip and logical in skip:
                    continue
                dd, sec, txt, terminal = try_provider(prov)
                if dd is not None:
                    return dd, sec, prov['name']
                last = txt
                print('[cloud] provider=%s 失败：%s' % (prov['name'], str(txt)[:140]))
                if terminal:
                    break
            raise RuntimeError(last or '云端调用失败')

        def extract(d):
            return [it for it in (d.get('data') or []) if it.get('url') or it.get('b64_json')]

        # 批量：并行 N 个单张请求（实测比 n=N 的单请求稳，n=N 会整批超时）
        if count > 1:
            results, errors, lock = [], [], threading.Lock()
            prog = {'done': 0}

            def worker(_i):
                try:
                    dd, sec, prov = attempt_once()
                    its = extract(dd)
                    with lock:
                        results.extend([(it, sec, prov) for it in its])
                        prog['done'] += 1
                        job['message'] = '云端生成中 %d/%d' % (prog['done'], count)
                except Exception as e:
                    with lock:
                        errors.append(str(e)[:200])
                        prog['done'] += 1
                        job['message'] = '云端生成中 %d/%d（%d 张失败）' % (
                            prog['done'], count, len(errors))

            threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(count)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if not results:
                raise RuntimeError(errors[0] if errors else '云端调用失败')
            items = [r[0] for r in results]
            api_s = max(r[1] for r in results)
            used = results[0][2]
            if errors:
                print('[cloud] 批量部分失败 %d/%d：%s' % (len(errors), count, errors[0][:120]))
        else:
            d, api_s, used = attempt_once()
            items = extract(d)
            if not items:
                raise RuntimeError('云端响应里没有图片：' + json.dumps(d, ensure_ascii=False)[:200])

        job['message'] = ('云端已出图 %d 张，正在取回' % len(items)) if len(items) > 1 else '云端已出图，正在取回'
        ext = '.png' if mode == 'sticker' else '.jpg'
        stamp = time.strftime('%Y%m%d_%H%M%S')
        saved, channels, dl_total = [], [], 0.0
        for idx, item in enumerate(items):
            if item.get('url'):
                data, channel, dl_s = download_cloud_image(item['url'])
                dl_total += dl_s
            else:
                data, channel, dl_s = base64.b64decode(item['b64_json']), 'b64', 0.0
            fn = '%s_%s%s%s' % (stamp, job['id'][:6], '_%d' % (idx + 1) if len(items) > 1 else '', ext)
            rel = owner_relpath(GALLERY, job.get('owner'), fn)
            with open(os.path.join(GALLERY, rel), 'wb') as f:
                f.write(data)
            saved.append(rel)
            channels.append(channel)
        job['images'] = saved
        job['elapsed'] = round(time.time() - t0, 1)
        job['status'] = 'done'
        job['message'] = '完成'
        dims = (' %s@%s' % (ratio, tier)) if ratio else ''
        print('[cloud] %s/%s%s x%d via %s ok: api %.1fs + dl(%s) %.1fs = %.1fs'
              % (mode, logical, dims, len(saved), used, api_s, '+'.join(sorted(set(channels))),
                 dl_total, time.time() - t0))


def download_image(im, job):
    qs = urllib.parse.urlencode({'filename': im['filename'],
                                 'subfolder': im.get('subfolder', ''),
                                 'type': im.get('type', 'output')})
    url = COMFY + '/view?' + qs
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    ext = os.path.splitext(im['filename'])[1] or '.png'
    fn = '%s_%s%s' % (time.strftime('%Y%m%d_%H%M%S'), job['id'][:6], ext)
    rel = owner_relpath(GALLERY, job.get('owner'), fn)
    with open(os.path.join(GALLERY, rel), 'wb') as f:
        f.write(data)
    return rel


def upload_ref(uid, data, ext):
    """只存到本人目录，返回 (本地文件名, 相对路径)；云端编辑直接读这个文件。"""
    h = hashlib.md5(data).hexdigest()[:10]
    local = 'ref_%s%s' % (h, ext)
    rel = owner_relpath(UPLOADS, uid, local)
    with open(os.path.join(UPLOADS, rel), 'wb') as f:
        f.write(data)
    return local, rel


# ---------------------------------------------------------------- 持久化
def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.execute("""CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY, mode TEXT, status TEXT, cfg TEXT, prompt TEXT,
        images TEXT, seed INTEGER, elapsed REAL, error TEXT, created REAL, finished REAL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS users(
        uid TEXT PRIMARY KEY, ip TEXT, ua TEXT, first_seen REAL, last_seen REAL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)""")
    # 迁移：老 users 表补账号字段（密码 / 角色 / 状态 / 版本号 / 显示名 / 时间）
    ucols = [r[1] for r in conn.execute('PRAGMA table_info(users)').fetchall()]
    for col, typ in (('pw_salt', 'TEXT'), ('pw_hash', 'TEXT'), ('role', 'TEXT'),
                     ('status', 'TEXT'), ('pw_ver', 'INTEGER'), ('name', 'TEXT'),
                     ('created', 'REAL'), ('last_login', 'REAL')):
        if col not in ucols:
            try:
                conn.execute('ALTER TABLE users ADD COLUMN %s %s' % (col, typ))
                conn.commit()
            except sqlite3.OperationalError:
                pass          # 另一个线程已加过
    # 迁移：老库补 owner（多用户隔离）/ ip / ua / engine（来源记录）列
    cols = [r[1] for r in conn.execute('PRAGMA table_info(jobs)').fetchall()]
    added = []
    for col in ('owner', 'ip', 'ua', 'engine'):
        if col not in cols:
            try:
                conn.execute('ALTER TABLE jobs ADD COLUMN %s TEXT' % col)
                conn.commit()
                added.append(col)
            except sqlite3.OperationalError:
                pass          # 另一个线程已加过
    if 'engine' in added:
        # 一次性回填：老数据从 cfg 里认出引擎
        try:
            for jid, cfg in conn.execute('SELECT id, cfg FROM jobs').fetchall():
                try:
                    prov = (json.loads(cfg or '{}') or {}).get('provider')
                except Exception:
                    prov = None
                conn.execute('UPDATE jobs SET engine=? WHERE id=? AND engine IS NULL',
                             ('cloud' if prov == 'cloud' else 'local', jid))
            conn.commit()
        except Exception:
            pass
    return conn


def persist_job(job):
    try:
        conn = db()
        conn.execute('INSERT OR REPLACE INTO jobs '
                     '(id,mode,status,cfg,prompt,images,seed,elapsed,error,created,finished,'
                     'owner,ip,ua,engine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
            job['id'], job['mode'], job.get('status', ''),
            json.dumps(job.get('cfg', {}), ensure_ascii=False),
            job.get('effective_prompt', job.get('cfg', {}).get('prompt', '')),
            json.dumps(job.get('images', [])),
            job.get('seed'), job.get('elapsed'), job.get('error'),
            job['created'], job.get('finished'),
            job.get('owner'), job.get('ip'), job.get('ua'),
            job.get('engine') or JobQueue.lane_of(job)))
        conn.commit()
        conn.close()
    except Exception:
        traceback.print_exc()


def load_gallery(uid, limit=60, with_public=False):
    """本人的作品；with_public=True 时把隔离前的老作品（无归属）也算进来（仅管理员）。"""
    try:
        conn = db()
        if with_public:
            rows = conn.execute(
                'SELECT id,mode,status,prompt,images,seed,elapsed,created,cfg FROM jobs '
                'WHERE status="done" AND (owner IS NULL OR owner="" OR owner=?) '
                'ORDER BY created DESC LIMIT ?', (uid, limit)).fetchall()
        else:
            rows = conn.execute(
                'SELECT id,mode,status,prompt,images,seed,elapsed,created,cfg FROM jobs '
                'WHERE status="done" AND owner=? '
                'ORDER BY created DESC LIMIT ?', (uid, limit)).fetchall()
        conn.close()
        out = []
        for r in rows:
            try:
                provider = (json.loads(r[8] or '{}') or {}).get('provider') or 'local'
            except Exception:
                provider = 'local'
            out.append({'id': r[0], 'mode': r[1], 'status': r[2], 'prompt': r[3],
                        'images': json.loads(r[4] or '[]'), 'seed': r[5],
                        'elapsed': r[6], 'created': r[7], 'provider': provider})
        return out
    except Exception:
        return []


# ---------------------------------------------------------------- 管理后台数据
def _jobs_where(q='', uid=None, engine='', status='', days=0):
    where, args = [], []
    if q:
        where.append('prompt LIKE ?')
        args.append('%' + q + '%')
    if uid:
        if uid == '__legacy__':
            where.append('(owner IS NULL OR owner="")')
        else:
            where.append('owner=?')
            args.append(uid)
    if engine in ('local', 'cloud'):
        where.append('COALESCE(engine,"local")=?')
        args.append(engine)
    if status:
        where.append('status=?')
        args.append(status)
    if days:
        where.append('created > ?')
        args.append(time.time() - days * 86400)
    return ((' WHERE ' + ' AND '.join(where)) if where else ''), args


def admin_overview():
    conn = db()
    now = time.time()
    day, week = now - 86400, now - 7 * 86400
    users = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
    jobs_total = conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]
    jobs_24h = conn.execute('SELECT COUNT(*) FROM jobs WHERE created>?', (day,)).fetchone()[0]
    jobs_7d = conn.execute('SELECT COUNT(*) FROM jobs WHERE created>?', (week,)).fetchone()[0]
    rows = conn.execute('SELECT images, engine, created, status FROM jobs').fetchall()
    conn.close()
    images_total = images_7d = cloud = local = errors = 0
    for imgs, engine, created, status in rows:
        n = len(json.loads(imgs or '[]'))
        images_total += n
        if created and created > week:
            images_7d += n
        cloud += engine == 'cloud'
        local += engine != 'cloud'
        errors += status != 'done'
    size = 0
    for root, _dirs, files in os.walk(GALLERY):
        for f in files:
            try:
                size += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return {'users': users, 'jobs_total': jobs_total, 'jobs_24h': jobs_24h, 'jobs_7d': jobs_7d,
            'images_total': images_total, 'images_7d': images_7d, 'cloud_jobs': cloud,
            'local_jobs': local, 'error_jobs': errors, 'gallery_bytes': size,
            'cloud_workers': CLOUD_WORKERS, 'initial_pw': bool(ADMIN.get('initial'))}


def admin_jobs(q='', uid='', engine='', status='', days=0, page=1, per=30):
    w, args = _jobs_where(q, uid, engine, status, days)
    conn = db()
    total = conn.execute('SELECT COUNT(*) FROM jobs' + w, args).fetchone()[0]
    per = max(10, min(100, int(per or 30)))
    page = max(1, int(page or 1))
    rows = conn.execute(
        'SELECT id,mode,status,prompt,images,seed,elapsed,error,created,finished,owner,ip,ua,engine '
        'FROM jobs' + w + ' ORDER BY created DESC LIMIT ? OFFSET ?',
        args + [per, (page - 1) * per]).fetchall()
    conn.close()
    items = [{'id': r[0], 'mode': r[1], 'status': r[2], 'prompt': r[3],
              'images': json.loads(r[4] or '[]'), 'seed': r[5], 'elapsed': r[6],
              'error': r[7], 'created': r[8], 'finished': r[9], 'owner': r[10] or '',
              'ip': r[11] or '', 'ua': r[12] or '', 'engine': r[13] or 'local'}
             for r in rows]
    return {'total': total, 'page': page, 'per': per, 'items': items}


def admin_users(q=''):
    """账号列表：users 表里的账号 + 只在作品里出现过的历史身份（ghost）。
    q 同时匹配 uid / 显示名 / IP。"""
    conn = db()
    conn.row_factory = sqlite3.Row
    rows = conn.execute('SELECT %s FROM users' % ','.join(USER_COLS)).fetchall()
    us = {}
    for r in rows:
        u = dict(r)
        us[u['uid']] = {
            'uid': u['uid'], 'name': u.get('name') or u['uid'],
            'role': u.get('role') or 'guest', 'status': u.get('status') or 'active',
            'registered': bool(u.get('pw_hash')),
            'created': u.get('created'), 'last_login': u.get('last_login'),
            'first_seen': u.get('first_seen'), 'last_seen': u.get('last_seen'),
            'ip': u.get('ip') or '', 'ua': u.get('ua') or '',
            'jobs': 0, 'done': 0, 'images': 0,
        }
    for owner, imgs, status in conn.execute('SELECT owner, images, status FROM jobs').fetchall():
        key = owner or ''
        u = us.setdefault(key, {
            'uid': '', 'name': '（公共作品）', 'role': 'ghost', 'status': 'active',
            'registered': False, 'created': None, 'last_login': None,
            'first_seen': None, 'last_seen': None, 'ip': '', 'ua': '',
            'jobs': 0, 'done': 0, 'images': 0})
        u['jobs'] += 1
        if status == 'done':
            u['done'] += 1
            u['images'] += len(json.loads(imgs or '[]'))
    conn.close()
    items = sorted(us.values(), key=lambda x: -(x['last_seen'] or x['created'] or 0))
    if q:
        ql = q.lower()
        items = [x for x in items
                 if ql in x['uid'].lower() or ql in (x['name'] or '').lower()
                 or ql in (x['ip'] or '')]
    return {'items': items,
            'registered': sum(1 for x in items if x['registered']),
            'guests': sum(1 for x in items if not x['registered'] and x['uid']),
            'public_works': sum(1 for x in items if not x['uid'])}


def admin_count_admins():
    conn = db()
    n = conn.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND status='active' "
                     "AND pw_hash IS NOT NULL").fetchone()[0]
    conn.close()
    return n


def admin_account_delete(uid):
    """删账号：作品（文件 + 记录）一并删除，避免变成无主公共作品泄露给所有人。
    想保留作品先用 transfer_works 并入别的账号。返回 (ok, msg, 删除作品数)。"""
    if not uid:
        return False, '缺少账号', 0
    conn = db()
    n = 0
    rows = conn.execute('SELECT id, images FROM jobs WHERE owner=?', (uid,)).fetchall()
    for jid, imgs in rows:
        for rel in json.loads(imgs or '[]'):
            p = owner_abspath(GALLERY, uid, rel)
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass
        conn.execute('DELETE FROM jobs WHERE id=?', (jid,))
        n += 1
    conn.execute('DELETE FROM users WHERE uid=?', (uid,))
    conn.commit()
    conn.close()
    for d in (GALLERY, UPLOADS):
        p = os.path.join(d, uid)
        if os.path.isdir(p):
            for f in os.listdir(p):
                try:
                    os.remove(os.path.join(p, f))
                except OSError:
                    pass
            try:
                os.rmdir(p)
            except OSError:
                pass
    return True, '已删除', n


def transfer_works(frm, to):
    """把 A 的作品（含文件）整体并入 B —— 迁移历史访客身份时用。"""
    frm, to = (frm or '').strip(), (to or '').strip()
    if not frm or not to or frm == to:
        return 0
    if not UID_RE.match(to):
        return -1
    conn = db()
    rows = conn.execute('SELECT id, images FROM jobs WHERE owner=?', (frm,)).fetchall()
    moved = []
    os.makedirs(os.path.join(GALLERY, to), exist_ok=True)
    for jid, imgs in rows:
        new = []
        for rel in json.loads(imgs or '[]'):
            src = owner_abspath(GALLERY, frm, rel)
            base = os.path.basename(rel)
            dst_rel = to + '/' + base
            dst = os.path.join(GALLERY, to, base)
            try:
                if os.path.exists(src) and not os.path.exists(dst):
                    os.replace(src, dst)
            except OSError:
                pass
            new.append(dst_rel if os.path.exists(dst) else rel)
        conn.execute('UPDATE jobs SET owner=?, images=? WHERE id=?',
                     (to, json.dumps(new), jid))
        moved.append(jid)
    # 上传的参考图也一并带走
    src_dir = os.path.join(UPLOADS, frm)
    if os.path.isdir(src_dir):
        os.makedirs(os.path.join(UPLOADS, to), exist_ok=True)
        for f in os.listdir(src_dir):
            try:
                os.replace(os.path.join(src_dir, f), os.path.join(UPLOADS, to, f))
            except OSError:
                pass
        try:
            os.rmdir(src_dir)
        except OSError:
            pass
    conn.commit()
    conn.close()
    return len(moved)



def admin_works(uid='', page=1, per=60):
    where, args = ['status="done"'], []
    if uid:
        if uid == '__legacy__':
            where.append('(owner IS NULL OR owner="")')
        else:
            where.append('owner=?')
            args.append(uid)
    conn = db()
    rows = conn.execute('SELECT id,owner,mode,engine,created,prompt,images,ip FROM jobs WHERE ' +
                        ' AND '.join(where) + ' ORDER BY created DESC', args).fetchall()
    conn.close()
    flat = []
    for r in rows:
        for fn in json.loads(r[6] or '[]'):
            flat.append({'job': r[0], 'owner': r[1] or '', 'mode': r[2],
                         'engine': r[3] or 'local', 'created': r[4], 'prompt': r[5],
                         'filename': fn, 'ip': r[7] or ''})
    total = len(flat)
    per = max(12, min(200, int(per or 60)))
    page = max(1, int(page or 1))
    return {'total': total, 'page': page, 'per': per,
            'items': flat[(page - 1) * per: page * per]}


def _gallery_rm(rel):
    parts = [x for x in (rel or '').split('/') if x and x not in ('.', '..')]
    if not parts:
        return
    try:
        p = os.path.join(GALLERY, *parts)
        if os.path.exists(p):
            os.remove(p)
    except OSError:
        traceback.print_exc()
    try:                                    # 顺带清掉缩略图缓存
        t = os.path.join(THUMBS, '320', *parts[:-1], parts[-1] + '.jpg')
        if os.path.exists(t):
            os.remove(t)
    except OSError:
        pass


def make_thumb(rel, w=320):
    """管理台缩略图（磁盘缓存，PIL 不可用时退回原图）。"""
    parts = [x for x in (rel or '').split('/') if x and x not in ('.', '..')]
    if not parts:
        return None
    src = os.path.join(GALLERY, *parts)
    if not os.path.exists(src):
        return None
    dst = os.path.join(THUMBS, str(w), *parts[:-1], parts[-1] + '.jpg')
    try:
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            return dst
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        from PIL import Image
        im = Image.open(src).convert('RGB')
        im.thumbnail((w, w))
        im.save(dst, 'JPEG', quality=82)
        return dst
    except Exception:
        traceback.print_exc()
        return src if os.path.exists(src) else None


def admin_delete_job(job_id):
    conn = db()
    row = conn.execute('SELECT images FROM jobs WHERE id=?', (job_id,)).fetchone()
    if row is None:
        conn.close()
        return False
    for rel in json.loads(row[0] or '[]'):
        _gallery_rm(rel)
    conn.execute('DELETE FROM jobs WHERE id=?', (job_id,))
    conn.commit()
    conn.close()
    return True


def admin_delete_image(job_id, rel):
    conn = db()
    row = conn.execute('SELECT images FROM jobs WHERE id=?', (job_id,)).fetchone()
    if row is None:
        conn.close()
        return False
    imgs = json.loads(row[0] or '[]')
    if rel not in imgs:
        conn.close()
        return False
    imgs.remove(rel)
    _gallery_rm(rel)
    if imgs:
        conn.execute('UPDATE jobs SET images=? WHERE id=?', (json.dumps(imgs), job_id))
    else:
        conn.execute('DELETE FROM jobs WHERE id=?', (job_id,))
    conn.commit()
    conn.close()
    return True


def admin_delete_user_works(uid):
    if not uid or uid == '__legacy__':
        return -1                       # 公共作品不给整批删（只能单条）
    conn = db()
    rows = conn.execute('SELECT id, images FROM jobs WHERE owner=?', (uid,)).fetchall()
    for _jid, imgs in rows:
        for rel in json.loads(imgs or '[]'):
            _gallery_rm(rel)
    conn.execute('DELETE FROM jobs WHERE owner=?', (uid,))
    conn.commit()
    conn.close()
    return len(rows)


def admin_claim_legacy(uid, release=False):
    """把隔离前的老作品划给某个用户；release=True 则收回成公共。"""
    conn = db()
    if release:
        cur = conn.execute('UPDATE jobs SET owner=NULL WHERE owner=?', (uid,))
    else:
        if not UID_RE.match(uid or ''):
            conn.close()
            return -1
        cur = conn.execute('UPDATE jobs SET owner=? WHERE owner IS NULL OR owner=""', (uid,))
    n = cur.rowcount
    conn.commit()
    conn.close()
    return n


JQ = JobQueue()


# ---------------------------------------------------------------- HTTP
MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
        '.woff2': 'font/woff2'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):
        print('[%s] %s' % (time.strftime('%H:%M:%S'), fmt % a))

    # ---------------- 身份（账号体系） ----------------
    # 会话 = 签名 cookie（uid.exp.pw_ver.sig）。没登录时 self.user 为 None，
    # 所有创作/相册接口一律 401 —— 老版本那个"随机 uid + ?u=xxx"的口子已经封掉。
    def _resolve_auth(self):
        self.user = None
        self.uid = ''
        self.role = ''
        cookie = self.headers.get('Cookie') or ''
        m = re.search(r'(?:^|;\s*)atlas_sess=([A-Za-z0-9_\-]+\.[0-9]+\.[0-9]+\.[0-9a-f]{64})', cookie)
        if not m:
            return
        got = parse_session(m.group(1))
        if not got:
            return
        uid, pwv = got
        u = user_get(uid)
        if not u or not u.get('pw_hash') or u['status'] != 'active':
            return
        if (u['pw_ver'] or 0) != pwv:
            return                      # 改过密码 / 被封禁 → 旧会话作废
        self.user = u
        self.uid = uid
        self.role = u['role']

    def _is_admin(self):
        if self.user and self.role == 'admin':
            return True
        # 应急通道：老的管理台专用口令（admin.json 里的全局密码）仍然有效
        m = re.search(r'(?:^|;\s*)atlas_admin=([0-9]+\.[0-9a-f]{64})',
                      self.headers.get('Cookie') or '')
        return bool(m) and admin_token_ok(m.group(1))

    def _need_login(self):
        if self.user:
            return False
        self._err(401, '请先登录')
        return True

    def _sess_cookie(self, uid, pwv, clear=False):
        val = '' if clear else make_session(uid, pwv)
        age = 0 if clear else SESS_TTL
        return '%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax' % (SESS_COOKIE, val, age)

    def _send(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _err(self, code, msg):
        self._send(code, {'ok': False, 'error': msg})

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        path = p.path
        self._resolve_auth()
        try:
            if path == '/api/health':
                return self._send(200, {
                    'ok': True,
                    'cloud': any(p['key'] for p in CLOUD_PROVIDERS),
                    'mode': 'cloud-only',
                    'comfy': False,
                    'starting': False})
            if path == '/api/modes':
                return self._send(200, {'ok': True, 'modes': [
                    {'id': k, 'label': v['label'], 'sizes': v['sizes'],
                     'cloud': v.get('cloud') or [],
                     'cloud_res': v.get('cloud_res') or {},
                     'cloud_counts': v.get('cloud_counts') or [1],
                     'needs_image': v['needs_image'], 'placeholder': v['placeholder']}
                    for k, v in MODES.items()]})
            if path == '/api/auth/session':
                st = settings_all()
                works = None
                if self.user:
                    conn = db()
                    works = conn.execute("SELECT COUNT(*) FROM jobs WHERE status='done' "
                                         "AND owner=?", (self.uid,)).fetchone()[0]
                    conn.close()
                return self._send(200, {
                    'ok': True, 'authed': bool(self.user),
                    'user': public_user(self.user, works) if self.user else None,
                    'admin': self._is_admin(),
                    'registration': {'open': st.get('open_register') == '1',
                                     'invite_required': bool((st.get('invite_code') or '').strip())},
                    'site': st.get('site_name') or 'Atlas Studio'})
            if path.startswith('/api/job/'):
                if self._need_login():
                    return
                j = JQ.get(path.rsplit('/', 1)[-1])
                if not j or j.get('owner') != self.uid:
                    return self._err(404, '任务不存在')
                return self._send(200, {'ok': True, 'job': public_job(j)})
            if path == '/api/jobs':
                if self._need_login():
                    return
                # 批量查进度：一次轮询拿回所有在跑的任务（并发提交用）
                qs = urllib.parse.parse_qs(p.query)
                ids = [x for x in (qs.get('ids') or [''])[0].split(',') if x][:50]
                out = []
                for jid in ids:
                    j = JQ.get(jid)
                    if j and j.get('owner') == self.uid:
                        out.append(public_job(j))
                return self._send(200, {'ok': True, 'jobs': out})
            if path == '/api/gallery':
                if self._need_login():
                    return
                items = load_gallery(self.uid, with_public=(self.role == 'admin'))
                pend = [public_job(j) for j in JQ.pending(self.uid)]
                touch_user(self.uid, self.client_address[0],
                           (self.headers.get('User-Agent') or '')[:300])
                return self._send(200, {'ok': True, 'items': items, 'pending': pend})

            # ---------------- 管理后台（只读部分） ----------------
            if path == '/api/admin/session':
                return self._send(200, {'ok': True, 'authed': self._is_admin()})
            if path.startswith('/api/admin/'):
                if not self._is_admin():
                    return self._err(401, '需要管理员登录')
                qs = urllib.parse.parse_qs(p.query)
                g = lambda k, d='': (qs.get(k) or [d])[0]
                if path == '/api/admin/overview':
                    return self._send(200, {'ok': True, 'overview': admin_overview(),
                                            'comfy': False, 'cloud_only': True})
                if path == '/api/admin/jobs':
                    return self._send(200, {'ok': True, 'data': admin_jobs(
                        q=g('q'), uid=g('uid'), engine=g('engine'), status=g('status'),
                        days=int(g('days') or 0), page=int(g('page') or 1),
                        per=int(g('per') or 30))})
                if path == '/api/admin/users':
                    return self._send(200, {'ok': True, 'data': admin_users(q=g('q'))})
                if path == '/api/admin/settings':
                    return self._send(200, {'ok': True, 'settings': settings_all()})
                if path == '/api/admin/works':
                    return self._send(200, {'ok': True, 'data': admin_works(
                        uid=g('uid'), page=int(g('page') or 1), per=int(g('per') or 60))})
                if path == '/api/admin/export.csv':
                    return self._admin_export_csv(q=g('q'), uid=g('uid'),
                                                  engine=g('engine'), status=g('status'),
                                                  days=int(g('days') or 0))
                return self._err(404, 'not found')
            if path == '/api/prompts/preview/status':
                return self._send(200, {
                    'ok': True, 'disabled': True,
                    'state': {'running': False, 'done': 0, 'failed': 0, 'total': 0,
                              'current': '', 'results': {}, 'comfy': False}})
            if path == '/api/prompts':
                d = load_prompts()
                # 标记哪些配方已有预览图
                for it in d.get('items', []):
                    fn = it.get('id', '') + '.jpg'
                    it['preview'] = '/previews/' + fn if os.path.exists(os.path.join(PREVIEWS, fn)) else None
                return self._send(200, {'ok': True, 'categories': d.get('categories', []),
                                        'items': d.get('items', [])})
            if path.startswith('/thumb/'):
                # 管理台缩略图（只给管理员）
                if not self._is_admin():
                    return self._err(404, 'not found')
                rest = path[7:]
                w_s, _, rel = rest.partition('/')
                try:
                    w = max(64, min(768, int(w_s)))
                except ValueError:
                    w = 320
                p = make_thumb(urllib.parse.unquote(rel), w)
                if not p:
                    return self._err(404, 'not found')
                return self._serve_file(p, 'image/jpeg')
            if path.startswith('/previews/'):
                return self._serve_file(os.path.join(PREVIEWS, os.path.basename(path[10:])), None)
            if path.startswith('/images/'):
                return self._serve_owned(GALLERY, path[8:])
            if path.startswith('/uploads/'):
                return self._serve_owned(UPLOADS, path[9:])
            # 静态资源（/admin → 管理后台）
            if path in ('/admin', '/admin/'):
                rel = 'admin.html'
            else:
                rel = path.lstrip('/') or 'index.html'
            full = os.path.normpath(os.path.join(WEB, rel))
            if os.path.commonpath([WEB, full]) != WEB:
                return self._err(403, 'forbidden')
            if os.path.isdir(full):
                full = os.path.join(full, 'index.html')
            if not os.path.exists(full):
                return self._err(404, 'not found')
            ext = os.path.splitext(full)[1].lower()
            with open(full, 'rb') as f:
                data = f.read()
            self._send(200, data, MIME.get(ext, 'application/octet-stream'))
        except Exception as e:
            traceback.print_exc()
            self._err(500, str(e)[:300])

    def _serve_file(self, path, ctype):
        if not os.path.exists(path):
            return self._err(404, 'not found')
        ext = os.path.splitext(path)[1].lower()
        with open(path, 'rb') as f:
            data = f.read()
        self._send(200, data, ctype or MIME.get(ext, 'application/octet-stream'))

    def _serve_owned(self, base, rel):
        """归属校验：新文件都放在 <uid>/ 子目录里，只给本人取；管理员可看全部；
        无前缀的是隔离前的老文件（历史公共样例）。未登录一律拒绝。"""
        if not self.user and not self._is_admin():
            return self._err(403, '请先登录')
        rel = urllib.parse.unquote(rel or '')
        parts = [x for x in rel.split('/') if x and x not in ('.', '..')]
        if not parts:
            return self._err(404, 'not found')
        if len(parts) >= 2 and parts[0] != self.uid and not self._is_admin():
            return self._err(404, 'not found')     # 别人的文件，一概看不见
        return self._serve_file(os.path.join(base, *parts), None)

    def _admin_export_csv(self, q='', uid='', engine='', status='', days=0, limit=5000):
        """导出当前筛选条件下的来源记录（Excel 可直接打开）。"""
        import csv
        w, args = _jobs_where(q, uid, engine, status, days)
        conn = db()
        rows = conn.execute(
            'SELECT created,mode,engine,status,elapsed,owner,ip,ua,prompt,id,images '
            'FROM jobs' + w + ' ORDER BY created DESC LIMIT ?', args + [limit]).fetchall()
        conn.close()
        buf = io.StringIO()
        wr = csv.writer(buf)
        wr.writerow(['时间', '模式', '引擎', '状态', '耗时(秒)', '用户', 'IP', '浏览器',
                     '图片数', '提示词', '任务ID'])
        for r in rows:
            wr.writerow([
                time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(r[0] or 0)),
                r[1], r[2] or 'local', r[3], r[4] or '', r[5] or '（公共）', r[6] or '',
                r[7] or '', len(json.loads(r[10] or '[]')), (r[8] or '').replace('\n', ' '), r[9]])
        body = ('\ufeff' + buf.getvalue()).encode('utf-8')      # BOM：Excel 认中文
        stamp = time.strftime('%Y%m%d_%H%M%S')
        self._send(200, body, 'text/csv; charset=utf-8', {
            'Content-Disposition': 'attachment; filename="atlas-records-%s.csv"' % stamp})

    def do_POST(self):
        p = urllib.parse.urlparse(self.path)
        self._resolve_auth()
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 40 * 1024 * 1024:
                return self._err(413, '文件过大（上限 40MB）')
            body = self.rfile.read(n) if n else b''
            ctype = self.headers.get('Content-Type', '')
            ip = self.client_address[0]
            ua = (self.headers.get('User-Agent') or '')[:300]

            # ---------------- 账号：注册 / 登录 / 登出 / 改密 ----------------
            if p.path == '/api/auth/register':
                st = settings_all()
                if st.get('open_register') != '1':
                    return self._err(403, '当前未开放注册，请联系管理员开通账号')
                d = json.loads(body or b'{}')
                code = (st.get('invite_code') or '').strip()
                if code and (d.get('invite') or '').strip() != code:
                    return self._err(403, '邀请码不正确')
                uid = (d.get('username') or '').strip().lower()
                pw = (d.get('password') or '')
                if not UID_RE.match(uid):
                    return self._err(400, '用户名需 3~24 位，小写字母/数字开头')
                if len(pw) < PW_MIN:
                    return self._err(400, '密码至少 %d 位' % PW_MIN)
                old = user_get(uid)
                if old and old.get('pw_hash'):
                    return self._err(409, '这个用户名已经被注册了')
                u = user_create(uid, pw, role='user', ip=ip, ua=ua)
                touch_login(uid, ip, ua)
                u = user_get(uid)
                return self._send(200, {'ok': True, 'user': public_user(u, 0)}, extra={
                    'Set-Cookie': self._sess_cookie(uid, u['pw_ver'])})

            if p.path == '/api/auth/login':
                d = json.loads(body or b'{}')
                uid = (d.get('username') or '').strip().lower()
                if login_blocked(ip, uid):
                    return self._err(429, '尝试太频繁，请 5 分钟后再试')
                u = user_auth(uid, (d.get('password') or ''))
                if not u:
                    login_fail(ip, uid)
                    return self._err(401, '用户名或密码不正确')
                login_reset(ip, uid)
                touch_login(uid, ip, ua)
                works = None
                conn = db()
                works = conn.execute("SELECT COUNT(*) FROM jobs WHERE status='done' "
                                     "AND owner=?", (uid,)).fetchone()[0]
                conn.close()
                return self._send(200, {'ok': True, 'user': public_user(u, works),
                                        'admin': u['role'] == 'admin'}, extra={
                    'Set-Cookie': self._sess_cookie(uid, u['pw_ver'])})

            if p.path == '/api/auth/logout':
                return self._send(200, {'ok': True}, extra={
                    'Set-Cookie': self._sess_cookie('', 0, clear=True)})

            if p.path == '/api/auth/password':
                if self._need_login():
                    return
                d = json.loads(body or b'{}')
                if not user_auth(self.uid, d.get('current') or ''):
                    return self._err(400, '当前密码不正确')
                new = d.get('new') or ''
                if len(new) < PW_MIN:
                    return self._err(400, '新密码至少 %d 位' % PW_MIN)
                user_set_password(self.uid, new)
                u = user_get(self.uid)
                return self._send(200, {'ok': True}, extra={
                    'Set-Cookie': self._sess_cookie(self.uid, u['pw_ver'])})

            if p.path == '/api/create':
                if self._need_login():
                    return
                cfg = json.loads(body or b'{}')
                mode = cfg.get('mode')
                if mode not in MODES:
                    return self._err(400, '未知模式')
                if not (cfg.get('prompt') or '').strip():
                    return self._err(400, '请填写提示词')
                if mode == 'edit':
                    ref = os.path.basename(cfg.get('ref_filename') or '')
                    if not ref or not os.path.exists(owner_abspath(UPLOADS, self.uid, ref)):
                        return self._err(400, '参考图不存在，请重新上传后再试')
                # 云端唯一引擎：无论前端传什么 provider，都归一到 cloud。
                allowed = [m['id'] for m in (MODES[mode].get('cloud') or [])]
                if not allowed:
                    return self._err(400, '该模式暂不支持云端引擎')
                cfg['provider'] = 'cloud'
                if cfg.get('cloud_model') not in allowed:
                    cfg['cloud_model'] = allowed[0]
                ip = self.client_address[0]
                ua = (self.headers.get('User-Agent') or '')[:300]
                job = {'id': uuid.uuid4().hex, 'mode': mode, 'status': 'queued',
                       'message': '已入队', 'cfg': cfg, 'created': time.time(),
                       'images': [], 'owner': self.uid, 'ip': ip, 'ua': ua,
                       'engine': 'cloud'}
                JQ.submit(job)
                touch_user(self.uid, ip, ua)
                return self._send(200, {'ok': True, 'job': public_job(job)})

            if p.path == '/api/prompts/save':
                if self._need_login():
                    return
                try:
                    body_d = json.loads(body or b'{}')
                except Exception:
                    return self._err(400, '参数格式错误')
                prompt = (body_d.get('prompt') or '').strip()
                if not prompt:
                    return self._err(400, '提示词为空，无法收藏')
                if len(prompt) > 4000:
                    return self._err(400, '提示词过长（上限 4000 字）')
                title = (body_d.get('title') or '').strip()[:60]
                category = (body_d.get('category') or '全部').strip()
                ratio = (body_d.get('ratio') or '').strip()[:12]
                lib = load_prompts()
                items = lib.get('items') or []
                for it in items:
                    if (it.get('prompt') or '').strip() == prompt:
                        return self._send(200, {'ok': True, 'duplicate': True,
                                                'id': it.get('id'),
                                                'title': it.get('title')})
                cats = lib.get('categories') or ['全部']
                if category and category not in cats:
                    cats.append(category)
                if not title:
                    title = prompt.replace('\n', ' ').strip()[:24] or '我的配方'
                new_item = {
                    'id': slugify(prompt, 'mine'),
                    'title': title,
                    'category': category or '全部',
                    'ratio': ratio,
                    'zh': (body_d.get('zh') or '我的收藏').strip()[:80],
                    'prompt': prompt,
                    'source': 'mine',
                    'created': time.time(),
                }
                existing_ids = set(it.get('id') for it in items)
                if new_item['id'] in existing_ids:
                    new_item['id'] = '%s-%d' % (new_item['id'], int(time.time()))
                items.insert(0, new_item)
                lib['items'] = items
                lib['categories'] = cats
                save_prompts(lib)

                # 收藏后自动建一个生图任务（用用户选的引擎）
                job_pub = None
                try:
                    auto = body_d.get('autogen', True)
                    if auto:
                        eng = (body_d.get('engine') or '').strip()
                        mode = 'generate'
                        mode_cfg = MODES[mode]
                        cloud_ids = [m['id'] for m in (mode_cfg.get('cloud') or [])]
                        if not cloud_ids:
                            raise RuntimeError('该模式暂不支持云端引擎')
                        if eng not in cloud_ids:
                            eng = cloud_ids[0]
                        cfg = {'mode': mode, 'prompt': prompt,
                               'provider': 'cloud', 'cloud_model': eng,
                               'resolution': (body_d.get('resolution') or '1K'),
                               'count': 1}
                        ratio_v = (body_d.get('ratio') or ratio or '').strip()
                        res_ok = (mode_cfg.get('cloud_res') or {}).get('ratios') or []
                        if ratio_v in res_ok:
                            cfg['ratio'] = ratio_v
                        ip2 = self.client_address[0]
                        ua2 = (self.headers.get('User-Agent') or '')[:300]
                        job = {'id': uuid.uuid4().hex, 'mode': mode, 'status': 'queued',
                               'message': '已入队（收藏自动生成）',
                               'cfg': cfg, 'created': time.time(),
                               'images': [], 'owner': self.uid, 'ip': ip2, 'ua': ua2,
                               'engine': 'cloud'}
                        JQ.submit(job)
                        touch_user(self.uid, ip2, ua2)
                        job_pub = public_job(job)
                except Exception as e:
                    print('[prompts] 自动生图任务创建失败：%s' % e, flush=True)

                return self._send(200, {'ok': True, 'item': new_item,
                                        'count': len(items), 'job': job_pub})

            if p.path == '/api/prompts/preview':
                if self._need_login():
                    return
                # 本地 GPU 已下线：预览图生成停用，已有预览照常访问。
                return self._err(410, '本地 GPU 已下线，预览图生成功能已停用')

            if p.path == '/api/upload':
                if self._need_login():
                    return
                if 'multipart/form-data' not in ctype:
                    return self._err(400, '需要 multipart 上传')
                data, filename, mime = parse_multipart(body, ctype)
                if not data:
                    return self._err(400, '没有收到图片')
                ext = os.path.splitext(filename)[1].lower()
                if ext not in ('.png', '.jpg', '.jpeg', '.webp'):
                    ext = '.png'
                name, rel = upload_ref(self.uid, data, ext)
                return self._send(200, {'ok': True, 'filename': name,
                                        'preview': '/uploads/' + rel})

            # ---------------- 管理后台（写操作） ----------------
            if p.path == '/api/admin/login':
                ip = self.client_address[0]
                if login_blocked(ip):
                    return self._err(429, '尝试太频繁，请 5 分钟后再试')
                d = json.loads(body or b'{}')
                if not check_pw((d.get('password') or '').strip()):
                    login_fail(ip)
                    return self._err(401, '密码不正确')
                return self._send(200, {'ok': True}, extra={
                    'Set-Cookie': 'atlas_admin=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax'
                                  % (admin_token(), ADMIN_TTL)})
            if p.path == '/api/admin/logout':
                return self._send(200, {'ok': True}, extra={
                    'Set-Cookie': 'atlas_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'})

            if p.path.startswith('/api/admin/'):
                if not self._is_admin():
                    return self._err(401, '需要管理员登录')
                d = json.loads(body or b'{}')
                if p.path == '/api/admin/password':
                    # 账号登录进来的改自己账号的密码；应急口令进来的改 admin.json
                    if self.user:
                        if not user_auth(self.uid, d.get('current') or ''):
                            return self._err(400, '当前密码不正确')
                        new = (d.get('new') or '').strip()
                        if len(new) < PW_MIN:
                            return self._err(400, '新密码至少 %d 位' % PW_MIN)
                        user_set_password(self.uid, new)
                        u = user_get(self.uid)
                        return self._send(200, {'ok': True}, extra={
                            'Set-Cookie': self._sess_cookie(self.uid, u['pw_ver'])})
                    if not check_pw((d.get('current') or '').strip()):
                        return self._err(400, '当前密码不正确')
                    new = (d.get('new') or '').strip()
                    if len(new) < 6:
                        return self._err(400, '新密码至少 6 位')
                    salt, h = _hash_pw(new)
                    ADMIN.update({'salt': salt, 'hash': h, 'updated': time.time()})
                    ADMIN.pop('initial', None)
                    _save_admin(ADMIN)
                    return self._send(200, {'ok': True})

                # ---- 账号管理 ----
                if p.path == '/api/admin/accounts/create':
                    uid = (d.get('uid') or '').strip().lower()
                    pw = d.get('password') or ''
                    role = 'admin' if d.get('role') == 'admin' else 'user'
                    if not UID_RE.match(uid):
                        return self._err(400, '用户名需 3~24 位，小写字母/数字开头')
                    if len(pw) < PW_MIN:
                        return self._err(400, '密码至少 %d 位' % PW_MIN)
                    old = user_get(uid)
                    if old and old.get('pw_hash'):
                        return self._err(409, '这个用户名已存在')
                    user_create(uid, pw, role=role, name=(d.get('name') or '').strip())
                    u = user_get(uid)
                    return self._send(200, {'ok': True, 'user': public_user(u, 0)})
                if p.path == '/api/admin/accounts/update':
                    uid = (d.get('uid') or '').strip().lower()
                    u = user_get(uid)
                    if not u:
                        return self._err(404, '账号不存在')
                    is_self = (uid == self.uid)
                    if 'role' in d:
                        role = 'admin' if d.get('role') == 'admin' else 'user'
                        if is_self and role != 'admin':
                            return self._err(400, '不能取消自己的管理员身份')
                        if role != 'admin' and u['role'] == 'admin' and admin_count_admins() <= 1:
                            return self._err(400, '至少要保留一个管理员')
                        conn = db()
                        conn.execute("UPDATE users SET role=? WHERE uid=?", (role, uid))
                        conn.commit()
                        conn.close()
                    if 'status' in d:
                        st = 'blocked' if d.get('status') == 'blocked' else 'active'
                        if is_self and st == 'blocked':
                            return self._err(400, '不能封禁自己')
                        conn = db()
                        # 改状态同时 pw_ver+1 → 已登录的会话立刻失效
                        conn.execute("UPDATE users SET status=?, pw_ver=COALESCE(pw_ver,0)+1 "
                                     "WHERE uid=?", (st, uid))
                        conn.commit()
                        conn.close()
                        if is_self:
                            u2 = user_get(uid)
                            return self._send(200, {'ok': True}, extra={
                                'Set-Cookie': self._sess_cookie(uid, u2['pw_ver'])})
                    if d.get('password'):
                        pw = d['password']
                        if len(pw) < PW_MIN:
                            return self._err(400, '密码至少 %d 位' % PW_MIN)
                        user_set_password(uid, pw)
                        if is_self:
                            u2 = user_get(uid)
                            return self._send(200, {'ok': True}, extra={
                                'Set-Cookie': self._sess_cookie(uid, u2['pw_ver'])})
                    if 'name' in d:
                        conn = db()
                        conn.execute("UPDATE users SET name=? WHERE uid=?",
                                     ((d.get('name') or '').strip() or uid, uid))
                        conn.commit()
                        conn.close()
                    return self._send(200, {'ok': True})
                if p.path == '/api/admin/accounts/delete':
                    uid = (d.get('uid') or '').strip().lower()
                    if not uid:
                        return self._err(400, '缺少账号')
                    if uid == self.uid:
                        return self._err(400, '不能删除自己')
                    u = user_get(uid)
                    if u and u['role'] == 'admin' and admin_count_admins() <= 1:
                        return self._err(400, '至少要保留一个管理员')
                    ok, msg, n = admin_account_delete(uid)
                    return self._send(200, {'ok': ok, 'deleted_works': n, 'message': msg})
                if p.path == '/api/admin/transfer_works':
                    n = transfer_works((d.get('from') or '').strip().lower(),
                                       (d.get('to') or '').strip().lower())
                    if n < 0:
                        return self._err(400, '目标账号或用户名不合法')
                    return self._send(200, {'ok': True, 'moved': n})
                if p.path == '/api/admin/settings':
                    if 'open_register' in d:
                        settings_set('open_register', '1' if d.get('open_register') else '0')
                    if 'invite_code' in d:
                        settings_set('invite_code', (d.get('invite_code') or '').strip())
                    if 'site_name' in d:
                        settings_set('site_name', (d.get('site_name') or '').strip() or 'Atlas Studio')
                    return self._send(200, {'ok': True, 'settings': settings_all()})
                if p.path == '/api/admin/delete_job':
                    ok = admin_delete_job(d.get('id') or '')
                    return self._send(200, {'ok': ok})
                if p.path == '/api/admin/delete_image':
                    ok = admin_delete_image(d.get('job') or '', d.get('filename') or '')
                    return self._send(200, {'ok': ok})
                if p.path == '/api/admin/delete_user_works':
                    n = admin_delete_user_works((d.get('uid') or '').strip())
                    if n < 0:
                        return self._err(400, '公共作品不支持整批删除')
                    return self._send(200, {'ok': True, 'deleted': n})
                if p.path == '/api/admin/claim_legacy':
                    n = admin_claim_legacy((d.get('uid') or '').strip().lower(),
                                           release=bool(d.get('release')))
                    if n < 0:
                        return self._err(400, '用户名不合法（小写字母/数字，3~24 位）')
                    return self._send(200, {'ok': True, 'changed': n})
                return self._err(404, 'not found')

            return self._err(404, 'not found')
        except Exception as e:
            traceback.print_exc()
            self._err(500, str(e)[:300])


def public_job(j):
    cfg = j.get('cfg') or {}
    d = {k: j.get(k) for k in ('id', 'mode', 'status', 'message', 'images',
                               'seed', 'elapsed', 'error', 'created', 'effective_prompt')}
    d['engine'] = 'cloud' if cfg.get('provider') == 'cloud' else 'local'
    d['prompt'] = j.get('effective_prompt') or cfg.get('prompt') or ''
    d['ahead'] = JQ.ahead(j)
    return d


def parse_multipart(body, ctype):
    m = re.search(r'boundary=([^;]+)', ctype)
    if not m:
        return None, '', ''
    boundary = ('--' + m.group(1).strip().strip('"')).encode()
    for part in body.split(boundary):
        if b'Content-Disposition' not in part:
            continue
        head, _, data = part.partition(b'\r\n\r\n')
        if b'filename=' not in head:
            continue
        fn = re.search(rb'filename="([^"]*)"', head)
        mt = re.search(rb'Content-Type:\s*([^\r\n]+)', head)
        data = data.rstrip(b'\r\n')
        return data, (fn.group(1).decode() if fn else 'upload.png'), (mt.group(1).decode() if mt else '')
    return None, '', ''


class _DualStackServer(ThreadingHTTPServer):
    address_family = _socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(_socket.IPPROTO_IPV6, _socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


def _make_server():
    if BIND in ('', '::', '0.0.0.0'):
        try:
            return _DualStackServer(('::', PORT), Handler), 'dual-stack'
        except OSError as e:
            print('dual-stack bind failed (%s), falling back to IPv4' % e)
    return ThreadingHTTPServer((BIND, PORT), Handler), 'ipv4'


if __name__ == '__main__':
    srv, mode = _make_server()
    print('Atlas Studio on http://%s:%d  [cloud-only, %s]' % (BIND, PORT, mode))
    srv.serve_forever()
