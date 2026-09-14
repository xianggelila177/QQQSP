#!/usr/bin/env bash
# Hermetic relay safety checks: bounded work, token bucket locking and redirect allowlist.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$ROOT/ops/relay.py" <<'PY'
import ast
import importlib.util
import pathlib
import sys
import threading
import time
import tempfile
import os
import http.server
import urllib.request
import socket
import http.client

path = pathlib.Path(sys.argv[1])
tree = ast.parse(path.read_text())
names = {node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
assert 'LimitedThreadingHTTPServer' in names
assert 'WhitelistRedirectHandler' in names
source = path.read_text()
for needle in ('MAX_ACTIVE', 'MAX_BODY', 'BUCKET_LOCK', 'UPSTREAM_OPENER', 'redirect outside allowlist'):
    assert needle in source, needle
assert 'CLIENT_READ_TIMEOUT' in source and 'settimeout(CLIENT_READ_TIMEOUT)' in source
relay_temp = tempfile.TemporaryDirectory(prefix='qqqsp-relay-test-')
import atexit
atexit.register(relay_temp.cleanup)
os.environ['QQQ_RELAY_LOG'] = str(pathlib.Path(relay_temp.name) / 'relay.log')
spec = importlib.util.spec_from_file_location('relay_test', path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert mod.token_matches('é', 'é')
assert not mod.token_matches('é', 'different')

class SlowDrip(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/ok':
            self.send_response(200); self.send_header('Content-Length', '2')
            self.send_header('Set-Cookie', 'a=1'); self.send_header('Set-Cookie', 'b=2')
            self.end_headers(); self.wfile.write(b'ok'); return
        if self.path == '/headers':
            try:
                self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Slow: ')
                for _ in range(30):
                    self.wfile.write(b'x'); self.wfile.flush(); time.sleep(0.03)
                self.wfile.write(b'\r\n\r\n')
            except OSError:
                pass
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        for _ in range(30):
            try:
                self.wfile.write(b'x')
                self.wfile.flush()
                time.sleep(0.03)
            except OSError:
                break
    def log_message(self, *_args):
        pass

slow_server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), SlowDrip)
slow_server.daemon_threads = True
threading.Thread(target=slow_server.serve_forever, daemon=True).start()
mod.UPSTREAM_OPENER = mod.build_upstream_opener()
mod.UPSTREAM_TIMEOUT = 0.12
mod.GAP = 0
started = time.monotonic()
result = mod.fetch_upstream(f'http://127.0.0.1:{slow_server.server_address[1]}/slow', {})
elapsed = time.monotonic() - started
assert result[3] is not None
assert elapsed <= mod.UPSTREAM_TIMEOUT + 0.15, elapsed
print(f'PASS: real local slow-drip bounded in {elapsed:.3f}s (deadline {mod.UPSTREAM_TIMEOUT:.3f}s)')
started = time.monotonic()
result = mod.fetch_upstream(f'http://127.0.0.1:{slow_server.server_address[1]}/headers', {})
elapsed = time.monotonic() - started
assert result[3] is not None and mod.UPSTREAM_TIMEOUT * 0.8 <= elapsed < mod.UPSTREAM_TIMEOUT + 0.15, elapsed
print(f'PASS: real slow headers bounded in {elapsed:.3f}s')
mod.UPSTREAM_TIMEOUT = 1
result = mod.fetch_upstream(f'http://127.0.0.1:{slow_server.server_address[1]}/ok', {})
assert result[0] == 200 and result[2] == b'ok' and result[3] is None, result
assert result[1].get_all('Set-Cookie') == ['a=1','b=2']
slow_server.shutdown(); slow_server.server_close()
print('PASS: isolated worker returns body and repeated response headers')
with tempfile.TemporaryDirectory() as temp:
    blocked = pathlib.Path(temp) / 'blocked_resolver.py'
    blocked.write_text('import socket, time\nsocket.getaddrinfo = lambda *a, **k: time.sleep(10) or []\n' + source)
    original_file = mod.__file__
    mod.__file__ = str(blocked); mod.UPSTREAM_TIMEOUT = 0.12
    started = time.monotonic()
    try:
        result = mod.fetch_upstream('https://query1.finance.yahoo.com/test', {})
    finally:
        mod.__file__ = original_file
    elapsed = time.monotonic() - started
    assert result[3] is not None and 0.09 <= elapsed < 0.3, elapsed
    print(f'PASS: blocked DNS worker terminated in {elapsed:.3f}s')

mod.UPSTREAM_TIMEOUT = 0.05
mod.LOCK.acquire()
try:
    started = time.monotonic()
    result = mod.fetch_upstream('https://query1.finance.yahoo.com/test', {})
    assert result[3] is not None and time.monotonic() - started < 0.3
finally:
    mod.LOCK.release()
mod.MAX_ACTIVE = 2
mod.CLIENT_READ_TIMEOUT = 0.05
mod.TOKEN = 'valid-test-token'
srv = mod.LimitedThreadingHTTPServer(('127.0.0.1', 0), mod.RelayHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
idlers = [socket.create_connection(srv.server_address) for _ in range(2)]
time.sleep(0.15)
for client in idlers: client.close()
client = http.client.HTTPConnection(*srv.server_address, timeout=1)
client.request('GET', '/healthz')
response = client.getresponse(); assert response.status == 200; response.read(); client.close()
client = http.client.HTTPConnection(*srv.server_address, timeout=1)
client.request('GET', '/relay?token=%C3%A9')
response = client.getresponse(); assert response.status == 403; response.read(); client.close()
time.sleep(0.06)
print('PASS: idle clients release slots; non-ASCII token gets403')
class BrokenThread:
    def __init__(self, *args, **kwargs): pass
    def start(self): raise RuntimeError('thread start test')
real_thread = mod.threading.Thread
left, right = socket.socketpair()
mod.threading.Thread = BrokenThread
try:
    try:
        srv.process_request(left, ('127.0.0.1', 1))
    except RuntimeError:
        pass
    else:
        raise AssertionError('thread start failure was swallowed')
    available = 0
    while srv._slots.acquire(False): available += 1
    assert available == mod.MAX_ACTIVE, 'worker slot leaked after thread start failure'
    for _ in range(available): srv._slots.release()
finally:
    mod.threading.Thread = real_thread
    right.close()
    srv.shutdown(); srv.server_close()
print('PASS: relay syntax, token safety, slow-drip and lock deadlines')
PY
