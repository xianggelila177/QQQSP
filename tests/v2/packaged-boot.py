"""Release check: production server.js, default-enabled background, no fixtures.
Run from the extracted ZIP: python3 tests/v2/packaged-boot.py [--background]
Uses only Python standard library. Real public sources may fail; no live-source
success is asserted. HTTP/status/SSE and persisted checkpoint are verified.
"""
from pathlib import Path
import argparse, json, os, shutil, socket, subprocess, tempfile, time, urllib.request

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--background', action='store_true', help='observe 65 seconds with no browser')
args = parser.parse_args()
node = os.environ.get('NODE_BIN') or shutil.which('node')
if not node:
    raise SystemExit('Node.js is required')
node = str(Path(node).resolve())
report = {'mode': 'production entry, no fixtures and no browser', 'version': (ROOT/'VERSION').read_text().strip(),
          'node': subprocess.check_output([node, '--version'], text=True).strip(),
          'upstreamConnectivityClaimed': False, 'systemdInstallationExecuted': False}
# A free loopback port is used only by this local release check.
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
origin = f'http://127.0.0.1:{port}'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def get(route):
    with opener.open(origin+route, timeout=5) as response:
        return response.read()
with tempfile.TemporaryDirectory(prefix='qqqsp-release-') as tmp:
    state = Path(tmp)/'macro.json'
    env = {'PATH': os.environ.get('PATH',''), 'HOME': tmp, 'HOST':'127.0.0.1', 'PORT':str(port),
           'LOG_FILE':str(Path(tmp)/'panel.log'), 'MACRO_STATE_PATH':str(state),
           'RECOVERY_PATH':str(Path(tmp)/'quotes.json'), 'HISTORY_STATE_PATH':str(Path(tmp)/'history.json'), 'LOG_LEVEL':'info'}
    with (Path(tmp)/'stdout.log').open('w') as output:
        child = subprocess.Popen([node, 'server.js'], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
    try:
        ready = None
        for _ in range(150):
            if child.poll() is not None:
                raise RuntimeError('server exited before ready: '+(Path(tmp)/'stdout.log').read_text()[-4000:])
            try:
                ready = json.loads(get('/readyz'))
                if ready.get('ready'): break
            except (OSError, ValueError): pass
            time.sleep(.1)
        assert ready and ready['ready'], 'ready timeout'
        assert str(ready['version']) == report['version']
        html = get('/').decode(); assert 'panel.bundle.js?v='+report['version'] in html
        assert 'id="macroMonitorStatus"' in html
        bundle = get('/panel.bundle.js?v='+report['version']); assert len(bundle)>10000
        report['ready'] = ready; report['bundleBytes'] = len(bundle)
        prepared = json.loads(get('/api/history/status'))
        assert prepared['enabled'] and prepared['running']
        report['historyBackground'] = prepared
        history_smoke = subprocess.run([node,'ops/history-prewarm-smoke.mjs',origin],cwd=ROOT,env=env,text=True,capture_output=True,timeout=15)
        assert history_smoke.returncode == 0, history_smoke.stdout+'\n'+history_smoke.stderr
        report['historySmoke'] = json.loads(history_smoke.stdout)
        status = json.loads(get('/api/macro/status')); assert status['running'] and status['enabled']
        cmd = [node, 'ops/macro-smoke.mjs', origin, '--stream']
        if args.background: cmd.append('--background')
        smoke = subprocess.run(cmd,cwd=ROOT,env=env,text=True,capture_output=True,timeout=110)
        assert smoke.returncode == 0, smoke.stdout+'\n'+smoke.stderr
        payload, _ = json.JSONDecoder().raw_decode(smoke.stdout)
        report['smoke'] = payload
        snapshot = json.loads(get('/api/macro/snapshot'))
        assert snapshot['news']['analysisVersion']==1
        assert len(snapshot['context']['factors'])==5
        report['snapshotSchema'] = {'news':snapshot['news']['analysisVersion'],'context':snapshot['context']['schemaVersion']}
        report['finalLanes'] = json.loads(get('/api/macro/status'))['lanes']
    finally:
        if child.poll() is None: child.terminate()
        try: code = child.wait(timeout=13)
        except subprocess.TimeoutExpired:
            child.kill();child.wait();raise RuntimeError('graceful stop timed out')
    assert code == 0, (code,(Path(tmp)/'stdout.log').read_text()[-4000:])
    assert state.is_file(), 'macro checkpoint missing'
    checkpoint = json.loads(state.read_text());assert checkpoint['schemaVersion']==1
    history_state = json.loads((Path(tmp)/'history.json').read_text())
    assert history_state['schemaVersion']==1
    report['historyCheckpointBytes'] = (Path(tmp)/'history.json').stat().st_size
    report['shutdownExitCode'] = code
    report['checkpoint'] = {'schemaVersion':checkpoint['schemaVersion'], 'bytes':state.stat().st_size,
                            'savedAt':checkpoint['savedAt']}
    report['passed'] = True
print(json.dumps(report,ensure_ascii=False,indent=2))
