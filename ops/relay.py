#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqq-relay — Yahoo 温和中继（规范副本: <panel>/ops/relay.py，对齐 RackNerd 在用版 /root/qqq-relay/relay.py）

【部署方式】由编排者人工执行（本物料仓库内不允许 SSH/部署，代理只准备物料）:
    1) scp /var/lib/dsh/qqq/panel/ops/relay.py root@107.172.90.49:/root/qqq-relay/relay.py
    2) ssh root@107.172.90.49 'systemctl restart qqq-relay'
    3) 验证: RackNerd 上 systemctl status qqq-relay / tail relay.log；面板侧观察 /api/stats 上游耗时回落
    （systemd 单元 qqq-relay: ExecStart=/usr/bin/python3 /root/qqq-relay/relay.py, Restart=always）

【防风控设计】（与在用版协议一致；本副本补充有界并发、响应上限和重定向校验）
    1) 仅绑 127.0.0.1:8801  —— 不暴露公网，只能经 SSH 隧道（沙箱 127.0.0.1:8801 → RackNerd 127.0.0.1:8801）到达
    2) token 鉴权           —— 每请求校验 ?token=，来源两处都支持:
                               环境变量 QQQ_RELAY_TOKEN 优先，兜底读文件 /root/qqq-relay/token；
                               两者皆空则 fail closed（所有 /relay 一律 403）
    3) 目标白名单           —— 仅转发 query1.finance.yahoo.com / fc.yahoo.com（https），其余一律 403
    4) 串行 + GAP           —— 上游调用全局串行，相邻调用锁内强制最小间隔 GAP=0.15s
                               （v52 由 0.45 下调: /api/market avg 4.9s 的主要贡献者之一；
                                 若 Yahoo 429 变频繁，回调 0.30~0.45 并观察 relay.log 的 BUCKET/429）
    5) 令牌桶 60/min        —— 容量 60、补充速率 60/min，突发超额直接 429（reject 记 BUCKET 日志），
                               保护 RackNerd 出口 IP
    6) 日志轮转             —— relay.log 单文件 5MB → .1（RotatingFileHandler backupCount=1），防盘满

【协议】（与面板 server.js 的 relayRewrite 契约一致，见 tests/_test_yahoo_relay.mjs）
    GET /relay?token=<tok>&url=<https://query1.finance.yahoo.com/...>
      请求头 X-Relay-Cookie → 上游 Cookie（面板把 Cookie 换名透传）
      返回: 上游原样 status / Content-Type / Set-Cookie / body；429 原样透传（面板熔断逻辑照常工作）
    GET /healthz → 200 ok（存活探针）

改动记录（相对 RackNerd 在用版）:
    - GAP: 0.45 → 0.15（延迟优化，锁内最小间隔）
    - 令牌: 环境变量 QQQ_RELAY_TOKEN 优先、/root/qqq-relay/token 兜底（在用版仅读文件）
    - 有界并发: MAX_ACTIVE 默认16；响应体上限默认2MiB；仅允许白名单 HTTPS 重定向
"""

import os
import sys
import time
import hmac
import socketserver
import socket
import http.client
import subprocess
import json
import base64
import email.message
import logging
import threading
import urllib.parse
import urllib.request
import urllib.error
from logging.handlers import RotatingFileHandler
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from http.server import ThreadingHTTPServer          # py3.7+
except ImportError:                                      # py3.6 兜底
    class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True

# ---- 可调参数（默认值=部署版；环境变量可覆盖便于演练，不改部署语义） ----
def bounded_int(name, fallback, minimum, maximum):
    try:
        value = int(os.environ.get(name, str(fallback)))
    except (TypeError, ValueError):
        return fallback
    return value if minimum <= value <= maximum else fallback


BIND_HOST = os.environ.get('QQQ_RELAY_BIND', '127.0.0.1')     # 防风控第1条: 仅内网回环
PORT = bounded_int('QQQ_RELAY_PORT', 8801, 1, 65535)
GAP = 0.15                          # 锁内相邻上游调用最小间隔(秒); 在用版 0.45, v52 下调(见改动记录)
BUCKET_CAP = 60                     # 令牌桶容量(个)
BUCKET_RATE = 60.0 / 60.0           # 令牌补充速率(个/秒) = 60 每分钟
UPSTREAM_TIMEOUT = bounded_int('QQQ_RELAY_TIMEOUT', 15, 1, 60)  # 上游总超时(秒)
TOKEN_ENV = 'QQQ_RELAY_TOKEN'       # 令牌来源1: 环境变量
TOKEN_FILE = '/root/qqq-relay/token'  # 令牌来源2: 文件兜底
LOG_PATH = os.environ.get('QQQ_RELAY_LOG', '/root/qqq-relay/relay.log')
LOG_MAX_BYTES = 5 * 1024 * 1024     # 5MB 轮转 → relay.log.1
WHITELIST_HOSTS = ('query1.finance.yahoo.com', 'fc.yahoo.com')
MAX_BODY = bounded_int('QQQ_RELAY_MAX_BODY', 2 * 1024 * 1024, 1024, 32 * 1024 * 1024)  # 上游响应体上限
MAX_ACTIVE = bounded_int('QQQ_RELAY_MAX_ACTIVE', 16, 1, 128)
CLIENT_READ_TIMEOUT = bounded_int('QQQ_RELAY_CLIENT_TIMEOUT', 30, 1, 300)
SKIP_RESP_HEADERS = frozenset(('connection', 'keep-alive', 'transfer-encoding',
                               'content-length', 'content-encoding', 'server', 'date'))
DEFAULT_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')


def setup_logger():
    lg = logging.getLogger('qqq-relay')
    lg.setLevel(logging.INFO)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(message)s')
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        h = RotatingFileHandler(LOG_PATH, maxBytes=LOG_MAX_BYTES, backupCount=1)  # 5MB → .1
    except OSError:                       # 本地演练目录不可写时退回 stderr，不阻塞
        h = logging.StreamHandler(sys.stderr)
    h.setFormatter(fmt)
    lg.addHandler(h)
    return lg


LOG = setup_logger()
TOKEN = ''
TOKEN_SRC = ''
LOCK = threading.Lock()       # 串行: 上游调用全局互斥（防风控第4条）
BUCKET_LOCK = threading.Lock()
LAST_CALL = 0.0               # 上次上游调用完成时刻(monotonic)
BUCKET = float(BUCKET_CAP)    # 令牌桶余量
BUCKET_TS = 0.0               # 上次补充时刻(monotonic)


def load_token():
    """令牌双通道: 环境变量 QQQ_RELAY_TOKEN 优先，文件 /root/qqq-relay/token 兜底。"""
    tok = os.environ.get(TOKEN_ENV, '').strip()
    if tok:
        return tok, 'env:' + TOKEN_ENV
    try:
        with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
            tok = f.read().strip()
    except OSError:
        tok = ''
    return tok, 'file:' + TOKEN_FILE


def token_matches(candidate, expected):
    try:
        return bool(candidate) and bool(expected) and hmac.compare_digest(str(candidate).encode('utf-8'), str(expected).encode('utf-8'))
    except (UnicodeError, AttributeError):
        return False


def take_token():
    """令牌桶 60/min（防风控第5条）。"""
    global BUCKET, BUCKET_TS
    with BUCKET_LOCK:
        now = time.monotonic()
        BUCKET = min(float(BUCKET_CAP), BUCKET + (now - BUCKET_TS) * BUCKET_RATE)
        BUCKET_TS = now
        if BUCKET < 1.0:
            return False
        BUCKET -= 1.0
        return True


class WhitelistRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow only same-allowlist HTTPS redirects; never let upstream choose a new host."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            parsed = urllib.parse.urlsplit(newurl)
            host = parsed.hostname or ''
            port = parsed.port
        except ValueError:
            host, parsed, port = '', None, None
        if (parsed is None or parsed.scheme != 'https' or host not in WHITELIST_HOSTS or port not in (None, 443)
                or parsed.username is not None or parsed.password is not None):
            raise urllib.error.HTTPError(req.full_url, 403, 'redirect outside allowlist', headers, fp)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            redirected._deadline = req._deadline
            redirected._connections = req._connections
        return redirected


class DeadlineConnectionMixin:
    """Shut down a connected socket at the request's absolute deadline.

    This also interrupts slow response headers before urllib returns a stream.
    The request owns the guards so fetch_upstream can cancel them after cleanup.
    """
    def __init__(self, *args, deadline, **kwargs):
        self.deadline = deadline
        self.deadline_guard = None
        super().__init__(*args, **kwargs)

    def connect(self):
        super().connect()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            self.close()
            raise TimeoutError('upstream connection deadline exceeded')
        current_socket = self.sock

        def expire():
            try:
                current_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        self.deadline_guard = threading.Timer(remaining, expire)
        self.deadline_guard.daemon = True
        self.deadline_guard.start()


class DeadlineHTTPConnection(DeadlineConnectionMixin, http.client.HTTPConnection):
    pass


class DeadlineHTTPSConnection(DeadlineConnectionMixin, http.client.HTTPSConnection):
    pass


def deadline_connection(req, cls, host, **kwargs):
    connection = cls(host, deadline=req._deadline, **kwargs)
    req._connections.append(connection)
    return connection


class DeadlineHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(lambda host, **kw: deadline_connection(req, DeadlineHTTPConnection, host, **kw), req)


class DeadlineHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(lambda host, **kw: deadline_connection(req, DeadlineHTTPSConnection, host, **kw), req,
                            context=self._context)


def build_upstream_opener():
    return urllib.request.build_opener(WhitelistRedirectHandler(), DeadlineHTTPHandler(), DeadlineHTTPSHandler())


UPSTREAM_OPENER = build_upstream_opener()


def read_bounded(stream, deadline):
    """Read in bounded chunks with one monotonic end-to-end deadline."""
    expired = threading.Event()
    candidates = []
    pending = [stream]
    seen = set()
    while pending and len(seen) < 12:
        item = pending.pop()
        if id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, socket.socket):
            candidates.append(item)
        for attr in ('fp', 'raw', '_sock'):
            child = getattr(item, attr, None)
            if child is not None:
                pending.append(child)

    def close_response():
        # Never close a BufferedReader first: its lock may be held by read().
        expired.set()
        for candidate in candidates:
            try:
                candidate.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    watchdog = threading.Timer(max(0.0, deadline - time.monotonic()), close_response)
    watchdog.daemon = True
    watchdog.start()
    chunks = []
    total = 0
    try:
        while total <= MAX_BODY:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('upstream deadline exceeded')
            # Update the underlying socket timeout before every read as well as
            # using the watchdog; this bounds both inactivity and total time.
            fp = getattr(stream, 'fp', None)
            raw = getattr(fp, 'raw', None)
            sock = getattr(raw, '_sock', None) or getattr(fp, '_sock', None) or getattr(stream, '_sock', None)
            if sock is not None:
                sock.settimeout(max(0.001, remaining))
            reader = getattr(stream, 'read1', stream.read)
            chunk = reader(min(65536, MAX_BODY + 1 - total))
            if expired.is_set() or time.monotonic() >= deadline:
                raise TimeoutError('upstream deadline exceeded')
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_BODY:
                raise ValueError('upstream response exceeds limit')
        return b''.join(chunks)
    finally:
        watchdog.cancel()


def upstream_worker_main():
    """Isolated network worker: even blocked DNS is killable by the parent."""
    try:
        payload = sys.stdin.buffer.read(65537)
        if len(payload) > 65536:
            raise ValueError('worker input too large')
        params = json.loads(payload)
        deadline = float(params['deadline'])
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('upstream deadline exceeded')
        req = urllib.request.Request(params['url'], headers=params['headers'], method='GET')
        req._deadline = deadline
        req._connections = []
        try:
            try:
                response = UPSTREAM_OPENER.open(req, timeout=remaining)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = read_bounded(response, deadline)
                result = {'status': response.code, 'headers': list(response.headers.items()),
                          'body': base64.b64encode(body).decode('ascii')}
        finally:
            for connection in req._connections:
                if connection.deadline_guard is not None:
                    connection.deadline_guard.cancel()
                connection.close()
        sys.stdout.write(json.dumps(result))
    except Exception as error:
        sys.stdout.write(json.dumps({'error': type(error).__name__}))


def fetch_upstream(url, headers):
    """One deadline covers queue, process startup, DNS, TCP, TLS and body.

    Only one bounded child runs under LOCK. Request data travels through stdin,
    never through command arguments or logs. A stuck resolver cannot retain the
    relay's lock or worker slot after the parent terminates the child.
    """
    global LAST_CALL
    deadline = time.monotonic() + UPSTREAM_TIMEOUT
    proc = None
    locked = False
    try:
        remaining = deadline - time.monotonic()
        locked = LOCK.acquire(timeout=max(0, remaining))
        if not locked:
            raise TimeoutError('relay queue deadline exceeded')
        wait = max(0, GAP - (time.monotonic() - LAST_CALL))
        if wait >= deadline - time.monotonic():
            raise TimeoutError('relay gap deadline exceeded')
        if wait:
            time.sleep(wait)
        payload = json.dumps({'url': url, 'headers': headers, 'deadline': deadline}).encode('utf-8')
        if len(payload) > 65536:
            raise ValueError('worker input too large')
        proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), '--fetch-worker'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            raw, _ = proc.communicate(payload, timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            raise TimeoutError('upstream deadline exceeded')
        if time.monotonic() >= deadline:
            raise TimeoutError('upstream deadline exceeded')
        result = json.loads(raw)
        if result.get('error'):
            raise OSError('upstream worker failed')
        body = base64.b64decode(result['body'], validate=True)
        if len(body) > MAX_BODY:
            raise ValueError('upstream response exceeds limit')
        response_headers = email.message.Message()
        for key, value in result['headers']:
            response_headers.add_header(key, value)
        return int(result['status']), response_headers, body, None
    except Exception as error:
        return 0, None, b'', error
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.communicate()
        if locked:
            LAST_CALL = time.monotonic()
            LOCK.release()


class RelayHandler(BaseHTTPRequestHandler):
    server_version = 'qqq-relay/2'
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        # Prevent idle TCP clients from occupying one of the bounded worker slots.
        self.connection.settimeout(CLIENT_READ_TIMEOUT)

    def log_message(self, fmt, *args):    # 静默默认 stderr 访问日志，统一走 relay.log
        pass

    def _reply(self, code, body=b'', ctype='text/plain; charset=utf-8', headers=()):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        ip = self.client_address[0]
        try:
            parsed = urllib.parse.urlsplit(self.path)
        except ValueError:
            self._reply(400, b'bad request\n')
            return
        if parsed.path == '/healthz':
            self._reply(200, b'ok\n')
            return
        if parsed.path != '/relay':
            LOG.info('REJECT path=%s ip=%s', parsed.path, ip)
            self._reply(404, b'not found\n')
            return

        # 1) token 鉴权（防风控第2条, 常量时间比较）
        qs = urllib.parse.parse_qs(parsed.query)
        tok = (qs.get('token') or [''])[0]
        if not token_matches(tok, TOKEN):
            LOG.info('REJECT bad-token ip=%s', ip)
            self._reply(403, b'forbidden\n')
            return

        # 2) 白名单（防风控第3条）: 仅 https + 指定两个 Yahoo 域
        target = (qs.get('url') or [''])[0]
        try:
            tu = urllib.parse.urlsplit(target)
            host = tu.hostname or ''
        except ValueError:
            host, tu = '', None
        try:
            port = tu.port if tu is not None else None
        except ValueError:
            port = -1
        if (tu is None or tu.scheme != 'https' or host not in WHITELIST_HOSTS or port not in (None, 443)
                or tu.username is not None or tu.password is not None):
            LOG.info('REJECT whitelist ip=%s reason=target_not_allowed', ip)
            self._reply(403, b'forbidden\n')
            return

        # 3) 令牌桶（防风控第5条）
        if not take_token():
            LOG.info('BUCKET reject ip=%s host=%s (60/min 超额)', ip, host)
            self._reply(429, b'bucket limit\n')
            return

        # 4) 串行 + GAP 上游调用（防风控第4条）; Cookie 由 X-Relay-Cookie 换名还原
        headers = {}
        ua = self.headers.get('User-Agent')
        headers['User-Agent'] = ua if ua else DEFAULT_UA
        relay_cookie = self.headers.get('X-Relay-Cookie')
        if relay_cookie:
            headers['Cookie'] = relay_cookie

        t0 = time.monotonic()
        status, rhdr, body, err = fetch_upstream(target, headers)
        ms = int((time.monotonic() - t0) * 1000)

        if err is not None:
            LOG.info('UPSTREAM fail host=%s ms=%d code=%s', host, ms, type(err).__name__)
            self._reply(502, b'upstream error\n')
            return

        LOG.info('OK host=%s status=%s ms=%d bytes=%d ip=%s', host, status, ms, len(body), ip)
        out, ctype = [], None
        for k, v in rhdr.items():
            lk = k.lower()
            if lk in SKIP_RESP_HEADERS:
                continue
            if lk == 'content-type':
                ctype = v
                continue
            out.append((k, v))            # 含 Set-Cookie（fc.yahoo.com 发 cookie 流程依赖）
        self._reply(status, body, ctype or 'application/octet-stream', out)


class LimitedThreadingHTTPServer(ThreadingHTTPServer):
    """Bound handler work so a burst cannot create an unbounded active relay set."""
    daemon_threads = True

    def __init__(self, server_address, handler_cls):
        super().__init__(server_address, handler_cls)
        self._slots = threading.BoundedSemaphore(MAX_ACTIVE)

    def process_request(self, request, client_address):
        if not self._slots.acquire(False):
            try:
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
            self.shutdown_request(request)
            return
        thread = threading.Thread(target=self.process_request_thread, args=(request, client_address), daemon=True)
        try:
            thread.start()
        except BaseException:
            self._slots.release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def main():
    global TOKEN, TOKEN_SRC, BUCKET_TS
    TOKEN, TOKEN_SRC = load_token()
    BUCKET_TS = time.monotonic()
    if not TOKEN:
        # fail closed: 不退出（保留 healthz 便于观察），但所有 /relay 一律 403
        LOG.critical('no token found (env %s / file %s) — fail closed', TOKEN_ENV, TOKEN_FILE)
    else:
        LOG.info('token loaded from %s; GAP=%s bucket=%d/min bind=%s:%s',
                 TOKEN_SRC, GAP, BUCKET_CAP, BIND_HOST, PORT)
    srv = LimitedThreadingHTTPServer((BIND_HOST, PORT), RelayHandler)   # 仅绑 127.0.0.1（防风控第1条）
    LOG.info('qqq-relay listening on %s:%s', BIND_HOST, PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == '__main__':
    if sys.argv[1:] == ['--fetch-worker']:
        upstream_worker_main()
    else:
        main()
