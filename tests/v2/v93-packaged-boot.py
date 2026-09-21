"""Boot the actual released archive with no node_modules and no provider fixtures."""
from pathlib import Path
import hashlib, json, os, signal, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error, zipfile
archive=Path(sys.argv[1]).resolve();report={'archive':archive.name,'mode':'原生 Node 生产入口；后台网络生产者关闭；仅验证冷启动与接口边界'}
with tempfile.TemporaryDirectory(prefix='qqqsp-v93-boot-') as tmp:
    with zipfile.ZipFile(archive) as z:z.extractall(tmp)
    root=next(Path(tmp).iterdir());assert not (root/'node_modules').exists()
    subprocess.run(['node','scripts/init-config.mjs'],cwd=root,check=True,stdout=subprocess.DEVNULL)
    config=(root/'.env').read_text();secret=dict(line.split('=',1) for line in config.splitlines() if '=' in line and not line.startswith('#'))
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    env={**os.environ,'PORT':str(port),'HOST':'127.0.0.1','LOG_FILE':'','MACRO_BACKGROUND_ENABLED':'0','HISTORY_BACKGROUND_ENABLED':'0','SAMPLES_BACKGROUND_ENABLED':'0','PUBLIC_SOURCE_REDUNDANCY':'0','REALTIME_SNAPSHOTS':'0','FUNDAMENTALS_ENABLED':'0'}
    log=open(Path(tmp)/'boot.log','w');process=subprocess.Popen(['node','--env-file=.env','server.js'],cwd=root,env=env,stdout=log,stderr=log)
    def request(route,body=None,headers=None):
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+route,data=json.dumps(body).encode() if body is not None else None,headers=headers or {})
        try:r=urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as e:r=e
        with r:return r.status,r.read(),r.headers
    try:
        for _ in range(100):
            if process.poll() is not None:raise RuntimeError('Production process exited')
            try:
                status,body,_=request('/healthz')
                if status==200:break
            except OSError:pass
            time.sleep(.1)
        else:raise RuntimeError('Startup deadline exceeded')
        health=json.loads(body);assert health['version']=='93'
        code,html,_=request('/');assert code==200 and b'panel.bundle.js?v=93' in html
        code,js,_=request('/panel.bundle.js');assert code==200 and hashlib.sha256(js).digest()==hashlib.sha256((root/'public/panel.bundle.js').read_bytes()).digest()
        code,schema,_=request('/api/v2/openapi.json');assert code==200 and json.loads(schema)['openapi']=='3.1.0'
        code,body,_=request('/api/v2/market-detail',{'symbol':'NVDA','max_wait_ms':0},{'Content-Type':'application/json'});assert code==401
        code,body,_=request('/api/v2/market-detail',{'symbol':'NVDA','max_wait_ms':0},{'Content-Type':'application/json','Authorization':'Bearer '+secret['LLM_API_KEY']});data=json.loads(body);assert code==503 and data['schema_version']==2 and data['status']=='unavailable'
        code,_,_=request('/api/history/watchlist',{'symbols':['NVDA']},{'Content-Type':'application/json'});assert code==401
        # The shipped local client receives and persists an unavailable response, without fabricating values.
        client=subprocess.run(['node','--env-file=.env','scripts/market-detail-client.mjs','NVDA','--wait-ms','0','--output','cold-detail.json'],cwd=root,env={**env,'LLM_API_BASE_URL':f'http://127.0.0.1:{port}'},capture_output=True,text=True,timeout=10)
        assert client.returncode==2,client.stderr
        assert json.loads((root/'cold-detail.json').read_text())['sections']['quote']['data'] is None
        assert secret['LLM_API_KEY'] not in client.stderr and secret['STATS_TOKEN'] not in client.stderr
        report.update({'node':subprocess.check_output(['node','--version'],text=True).strip(),'noNodeModules':True,'health':True,'servedBundleExact':True,'openapi':True,'readOnlyAuth':True,'writeAuth':True,'coldUnavailableHonest':True,'clientExitCode':2})
    finally:
        process.send_signal(signal.SIGTERM)
        try:process.wait(timeout=12)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
    assert process.returncode==0;report['gracefulShutdown']=True;report['passed']=True
print(json.dumps(report,ensure_ascii=False,indent=2))
