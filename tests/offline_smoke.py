#!/usr/bin/env python3
"""仅在副本内使用全新数据，真实 HTTP 离线冒烟；不请求生图接口。"""
import ast
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / 'backend/server.py'
ast.parse(SERVER.read_text())
# 子进程通过审计钩子阻止任何向非回环地址的 socket.connect。
BOOT = '''import sys, socket, runpy
import ipaddress
def audit(event, args):
    if event == 'socket.connect':
        host = args[1][0]
        try:
            allowed = ipaddress.ip_address(host).is_loopback
        except ValueError:
            allowed = False
        if not allowed:
            raise RuntimeError('offline test: blocked non-loopback network')
sys.addaudithook(audit)
runpy.run_path(sys.argv[1], run_name='__main__')
'''

def request(port, path, payload=None, cookie=None):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    headers = {'Content-Type': 'application/json'}
    if cookie:
        headers['Cookie'] = cookie
    c.request('POST' if payload is not None else 'GET', path,
              json.dumps(payload) if payload is not None else None, headers)
    r = c.getresponse()
    body = r.read()
    result = r.status, body, r.getheader('Set-Cookie')
    c.close()
    return result

with tempfile.TemporaryDirectory(prefix='.offline-', dir=ROOT) as tmp:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('AGENT3_', 'RELAY_', 'ATLAS_'))}
    env.update(BIND='127.0.0.1', PORT=str(port), ATLAS_DATA_DIR=tmp,
               ATLAS_CLOUD_WORKERS='1', AGENT3_BASE='', AGENT3_KEY='',
               RELAY_BASE='', RELAY_TOKEN='', ATLAS_ADMIN_PW='')
    cmd = [sys.executable, '-I', '-c', BOOT, str(SERVER)]
    failed = subprocess.run(cmd, env=env, cwd=ROOT, capture_output=True, timeout=15)
    assert failed.returncode != 0
    assert not (Path(tmp) / 'admin.json').exists()
    password = secrets.token_urlsafe(24)
    env['ATLAS_ADMIN_PW'] = password
    def start():
        proc = subprocess.Popen(cmd, env=env, cwd=ROOT,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            if proc.poll() is not None:
                raise AssertionError('backend exited during initialization')
            try:
                if request(port, '/api/health')[0] == 200:
                    return proc
            except OSError:
                pass
            time.sleep(.05)
        proc.terminate()
        proc.wait(timeout=5)
        raise AssertionError('backend startup timed out')
    proc = start()
    try:
        assert json.loads(request(port, '/api/health')[1])['cloud'] is False
        for path in ['/', '/admin', '/js/app.js', '/css/atlas.css', '/placeholder.svg', '/api/modes', '/api/prompts']:
            assert request(port, path)[0] == 200, path
        prompts = json.loads(request(port, '/api/prompts')[1])
        assert len(prompts['items']) == 1
        assert request(port, '/api/admin/overview')[0] in (401, 403)
        assert request(port, '/api/admin/login', {'password': 'incorrect'})[0] == 401
        code, _, cookie = request(port, '/api/admin/login', {'password': password})
        assert code == 200 and cookie
        cookie = cookie.split(';')[0]
        assert request(port, '/api/admin/overview', cookie=cookie)[0] == 200
        settings = json.loads(request(port, '/api/admin/settings', cookie=cookie)[1])
        assert settings['settings']['open_register'] == '0'
        assert request(port, '/api/auth/register', {'username': 'offlineuser', 'password': password})[0] == 403
        assert request(port, '/api/admin/accounts/create',
                       {'uid': 'offlineuser', 'password': password}, cookie=cookie)[0] == 200
        code, _, user_cookie = request(port, '/api/auth/login',
                                       {'username': 'offlineuser', 'password': password})
        assert code == 200 and user_cookie
        user_cookie = user_cookie.split(';')[0]
        assert request(port, '/api/admin/overview', cookie=user_cookie)[0] in (401, 403)
        assert request(port, '/api/auth/session', cookie=user_cookie)[0] == 200
        admin = Path(tmp) / 'admin.json'
        before = admin.read_bytes()
        assert password.encode() not in before
        assert admin.stat().st_mode & 0o777 == 0o600
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    env.pop('ATLAS_ADMIN_PW')
    proc = start()
    try:
        assert admin.read_bytes() == before
        assert request(port, '/api/admin/login', {'password': password})[0] == 200
    finally:
        proc.terminate()
        proc.wait(timeout=5)
print('PASS: syntax, blank-password refusal, isolated initialization, local HTTP, admin auth, registration disabled, restart; no upstream calls')
