"""Verify the real archive using the production entry point, without node_modules or provider fixtures.
Usage: python3 tests/v2/v94-packaged-boot.py /path/to/qqqsp-v2.14.0-source.zip
No network producers are enabled. All generated credentials/state are temporary.
"""
from pathlib import Path
import hashlib, json, os, signal, socket, subprocess, sys, tempfile, time
import urllib.request, urllib.error, zipfile

archive=Path(sys.argv[1]).resolve()
report={'archive':archive.name,'archive_sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
        'mode':'原生 Node 生产入口；真实解压包；无供应商夹具；后台网络生产者关闭',
        'liveProviderValidated':False,'deploymentHostModified':False}
with tempfile.TemporaryDirectory(prefix='qqqsp-v94-boot-') as tmp:
    with zipfile.ZipFile(archive) as z:
        assert all(not Path(n).is_absolute() and '..' not in Path(n).parts for n in z.namelist())
        z.extractall(tmp)
    root=next(Path(tmp).iterdir());assert not (root/'node_modules').exists()
    subprocess.run(['node','scripts/init-config.mjs'],cwd=root,check=True,stdout=subprocess.DEVNULL)
    private=dict(line.split('=',1) for line in (root/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
    assert private['STATS_TOKEN']!=private['LLM_API_KEY']
    assert (root/'.env').stat().st_mode&0o077==0
    env={**os.environ,'HOST':'127.0.0.1','LOG_FILE':'','MACRO_BACKGROUND_ENABLED':'0','HISTORY_BACKGROUND_ENABLED':'0',
         'SAMPLES_BACKGROUND_ENABLED':'0','PUBLIC_SOURCE_REDUNDANCY':'0','REALTIME_SNAPSHOTS':'0','FUNDAMENTALS_ENABLED':'0',
         'ALPACA_ENABLED':'0','APCA_API_KEY_ID':'','APCA_API_SECRET_KEY':'','FINNHUB_TOKEN':'','TE_API_KEY':'',
         'LLM_KEY_STORE_PATH':str(root/'state/api-keys.json')}
    logs=[];process=None;port=0
    def request(route,body=None,key=None,admin=False,method=None,headers=None):
        h={**(headers or {})}
        if key:h['Authorization']='Bearer '+key
        if admin:h['X-Admin-Token']=private['STATS_TOKEN']
        if body is not None:h['Content-Type']='application/json'
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+route,data=json.dumps(body).encode() if body is not None else None,headers=h,method=method)
        try:r=urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as e:r=e
        with r:return r.status,r.read(),r.headers
    def start():
        global process,port
        with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        log=open(Path(tmp)/f'boot-{len(logs)}.log','w');logs.append(log)
        process=subprocess.Popen(['node','--env-file=.env','server.js'],cwd=root,env={**env,'PORT':str(port)},stdout=log,stderr=log)
        for _ in range(100):
            if process.poll() is not None:raise RuntimeError('Production process exited unexpectedly')
            try:
                status,body,_=request('/healthz')
                if status==200:
                    assert json.loads(body)['version']=='94';return
            except OSError:pass
            time.sleep(.1)
        raise RuntimeError('Startup deadline exceeded')
    def stop():
        global process
        if process is None:return
        process.send_signal(signal.SIGTERM)
        try:process.wait(timeout=12)
        except subprocess.TimeoutExpired:process.kill();process.wait();raise AssertionError('Shutdown deadline exceeded')
        assert process.returncode==0;process=None
    def manage(body):
        code,data,_=request('/api/admin/keys',body,admin=True)
        assert code==200,(code,data.decode());return json.loads(data)
    try:
        start()
        code,html,_=request('/');assert code==200 and b'panel.bundle.js?v=94' in html
        code,js,_=request('/panel.bundle.js');assert code==200 and hashlib.sha256(js).digest()==hashlib.sha256((root/'public/panel.bundle.js').read_bytes()).digest()
        for version in (1,2):
            code,schema,_=request(f'/api/v{version}/openapi.json');assert code==200 and json.loads(schema)['openapi']=='3.1.0'
        code,schema,_=request('/api/v1/openapi.json');spec=json.loads(schema)
        assert '/api/v1/movers' in spec['paths'] and 'get' in spec['paths']['/api/v1/market-context']
        code,html,_=request('/api-keys.html');assert code==200 and b'Content-Security-Policy' in html and b"script-src 'self'" in html
        code,_,_=request('/api/admin/keys');assert code==403
        code,_,_=request('/api/history/watchlist',{'symbols':['NVDA']});assert code==401
        code,_,_=request('/api/v2/market-detail',{'symbol':'NVDA','max_wait_ms':0});assert code==401
        code,body,headers=request('/api/v2/market-detail',{'symbol':'NVDA','max_wait_ms':0},key=private['LLM_API_KEY'])
        data=json.loads(body);assert code==503 and data['schema_version']==2 and data['status']=='unavailable'
        assert data['sections']['quote']['data'] is None and headers['X-RateLimit-Limit']=='20'
        scoped=manage({'action':'create','label':'验收历史只读','scopes':['history']})
        code,body,_=request('/api/v1/market-context',{'symbol':'NVDA','include':['quote'],'max_wait_ms':0},key=scoped['secret'])
        assert code==403 and json.loads(body)['error']['code']=='INSUFFICIENT_SCOPE'
        route='/api/v1/trading-calendar?exchange=US&start=2026-09-07&end=2026-09-08'
        code,body,headers=request(route,key=scoped['secret']);assert code==200
        dates=json.loads(body)['days'];assert dates[0]['is_open'] is False and dates[1]['is_open'] is True
        code,body,_=request(route,key=scoped['secret'],headers={'If-None-Match':headers['ETag']});assert code==304 and body==b''
        code,body,_=request(route,key=scoped['secret'],method='HEAD');assert code==200 and body==b''
        rotating=manage({'action':'create','label':'验收轮换密钥','scopes':['quote-only']})
        next_key=manage({'action':'rotate','id':rotating['id']})
        assert 86390000 <= next_key['previous_expires_at_ms']-int(time.time()*1000) <= 86410000
        code,body,headers=request('/api/v1/capabilities',key=rotating['secret'])
        assert code==200 and headers['X-API-Key-Status']=='rotating'
        code,body,_=request('/api/v1/capabilities',key=next_key['secret']);assert code==200
        client_key=manage({'action':'create','label':'验收命令行客户端','scopes':['quote-only']})
        client=subprocess.run(['node','scripts/market-api-client.mjs','NVDA,SPY,QQQ','--include','quote','--wait-ms','0','--output','cold-batch.json'],
            cwd=root,env={**env,'LLM_API_KEY':client_key['secret'],'LLM_API_BASE_URL':f'http://127.0.0.1:{port}'},capture_output=True,text=True,timeout=10)
        assert client.returncode==2,client.stderr
        result=json.loads((root/'cold-batch.json').read_text());assert result['status']=='unavailable' and len(result['results'])==3
        assert all(item['sections']['quote']['data'] is None for item in result['results'])
        assert (root/'cold-batch.json').stat().st_mode&0o077==0
        for value in [private['LLM_API_KEY'],private['STATS_TOKEN'],client_key['secret']]:assert value not in client.stderr
        statefile=root/'state/api-keys.json';state=statefile.read_text()
        assert statefile.stat().st_mode&0o077==0
        for value in [scoped['secret'],rotating['secret'],next_key['secret'],client_key['secret']]:assert value not in state
        manage({'action':'revoke','id':next_key['id']})
        stop();start()
        code,_,_=request(route,key=scoped['secret']);assert code==200
        for value in [rotating['secret'],next_key['secret']]:
            code,_,_=request('/api/v1/capabilities',key=value);assert code==401
        report.update({'node':subprocess.check_output(['node','--version'],text=True).strip(),
            'noNodeModules':True,'health':True,'servedBundleExact':True,'v1AndV2Openapi':True,
            'staticCspPresent':True,'browserCspRuntimeValidated':False,'readOnlyAuth':True,'writeAuth':True,'scopeIsolation':True,
            'calendarHoliday':True,'conditionalGet304EmptyBody':True,'headEmptyBody':True,'rotationGraceHeaders':True,
            'hashOnlyKeyStore0600':True,'keyPersistenceAfterRestart':True,'revokedFamilyDeniedAfterRestart':True,
            'coldBatchUnavailableHonest':True,'newClientExitCode':2})
    finally:
        stop()
        for log in logs:log.close()
    report['gracefulShutdown']=True;report['passed']=True
print(json.dumps(report,ensure_ascii=False,indent=2))
