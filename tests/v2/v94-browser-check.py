"""Shipped management HTML/CSS/JS with a real HTTP bridge. The sandbox blocks navigation.
CSP text is checked but removed from the test DOM to permit bridge injection; the
unchanged script receives an HTTPS location argument. Not a native TLS/CSP validation.
"""
import json, os, shutil, subprocess, tempfile, urllib.request, urllib.error, re
from browser_bridge import BrowserBridge
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/v94';OUT.mkdir(parents=True,exist_ok=True)
report={'mode':'正式页面和未改动JS经HTTP测试桥接运行；浏览器环境禁止导航本机／测试域名','nativeTlsOrProxy':False,'cspRuntimeValidated':False,'secureContextGuard':'测试传入https位置对象；真实TLS/原生CSP仍需上线验证；CSP文本单独检查','cases':[]}
admin='browser-admin-'*4
with tempfile.TemporaryDirectory(prefix='qqqsp-v94-browser-') as tmp:
    server=subprocess.Popen(['node',str(ROOT/'tests/v2/v94-browser-server.mjs')],cwd=tmp,env={**os.environ,'HOME':tmp},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        address={}
        for _ in range(40):
            line=server.stdout.readline()
            if not line:raise RuntimeError('Fixture did not start: '+server.stderr.read())
            x=json.loads(line)
            if 'port' in x:address=x;break
        base='http://127.0.0.1:'+str(address['port'])
        def call(route,body=None,token=admin,method=None):
            h={'X-Admin-Token':token}
            if body is not None:h['Content-Type']='application/json'
            req=urllib.request.Request(base+route,data=json.dumps(body).encode() if body is not None else None,headers=h,method=method or ('POST' if body is not None else 'GET'))
            try:r=urllib.request.urlopen(req,timeout=20)
            except urllib.error.HTTPError as e:r=e
            with r:return r.status,r.read().decode()
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
            for width in [1440,375]:
                context=browser.new_context(viewport={'width':width,'height':1100});page=context.new_page();errors=[];console_errors=[];requests=[]
                page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:console_errors.append(m.text) if m.type=='error' else None)
                bridge=BrowserBridge(base)
                html=bridge.get('/api-keys.html')['body']
                assert "script-src 'self'" in html and "connect-src 'self'" in html
                html=re.sub(r'<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>','',html)
                html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
                html=re.sub(r'<link[^>]+>','',html)
                html=html.replace('</head>','<style>'+bridge.get('/api-keys.css')['body']+'</style></head>')
                page.set_content(html)
                page.add_script_tag(content="const local={},session={};const storage=o=>({getItem:k=>o[k]??null,setItem:(k,v)=>{o[k]=String(v)},removeItem:k=>delete o[k]});Object.defineProperty(window,'localStorage',{value:storage(local)});Object.defineProperty(window,'sessionStorage',{value:storage(session)});window.__storageEmpty=()=>Object.keys(local).length===0&&Object.keys(session).length===0;")
                page.expose_function('__http',bridge.get)
                page.add_script_tag(content="window.fetch=async(url,options={})=>{const r=await __http(String(url),{method:options.method||'GET',headers:options.headers||{},body:options.body??null});return new Response(r.body,{status:r.status,headers:r.headers});};")
                page.evaluate("src => new Function('location',src)({protocol:'https:',hostname:'qqqsp.test'})",bridge.get('/api-keys.js')['body'])
                assert page.title()=='接口密钥管理 · QQQSP'
                assert page.locator('#controls').is_hidden()
                page.locator('#admin').fill('wrong-token');page.locator('#unlock button').first.click()
                page.wait_for_function("document.querySelector('#status').textContent.includes('ADMIN_AUTH_REQUIRED')")
                assert page.locator('#controls').is_hidden()
                page.locator('#admin').fill(admin);page.locator('#unlock button').first.click()
                page.wait_for_selector('#controls',state='visible');assert page.locator('#admin').input_value()==''
                label='桌面研究助手' if width==1440 else '<img src=x onerror=alert(1)>手机研究助手'
                page.locator('#label').fill(label);page.locator('input[value="history"]').check();page.locator('#create button').click()
                page.wait_for_selector('#secret-area',state='visible');secret=page.locator('#secret').input_value()
                assert len(secret)>=32;assert page.locator('#secret').get_attribute('type')=='password'
                row=page.locator('#keys tr').filter(has=page.get_by_text(label,exact=True));row.wait_for()
                assert row.count()==1 and row.locator('img').count()==0
                assert '历史／日历' in row.inner_text()
                page.once('dialog',lambda dialog:dialog.accept());row.get_by_role('button',name='轮换',exact=True).click()
                page.wait_for_function("document.querySelector('#status').textContent.includes('已轮换')")
                newsecret=page.locator('#secret').input_value();assert newsecret!=secret
                assert '轮换宽限期' in page.locator('#keys').inner_text()
                assert page.evaluate('__storageEmpty()')
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                assert not errors,errors
                # Secrets stay masked in evidence. No tokens or responses containing secrets are logged.
                page.screenshot(path=str(OUT/('keys-desktop.png' if width==1440 else 'keys-mobile.png')),full_page=True)
                active=page.locator('#keys tr').filter(has=page.get_by_text(label,exact=True)).filter(has=page.get_by_text('有效',exact=True))
                page.once('dialog',lambda d:d.accept());active.get_by_role('button',name='撤销',exact=True).click()
                page.wait_for_function("document.querySelector('#status').textContent.includes('已撤销')")
                values=json.loads(call('/api/admin/keys')[1])['keys'];familyrows=[k for k in values if k['label']==label];assert all(k['status']=='revoked' for k in familyrows)
                page.locator('#lock').click();assert page.locator('#controls').is_hidden();assert page.locator('#secret').input_value()==''
                assert page.locator('#keys tr').count()==0
                assert not any(secret in json.dumps(item) or newsecret in json.dumps(item) for item in requests)
                unexpected=[e for e in console_errors if '403' not in e] # The intentional wrong-admin request produces one network console error.
                assert not unexpected,unexpected
                report['cases'].append({'viewport':width,'shippedCspTextChecked':True,'runtimeCsp':False,'wrongAdminDenied':True,'scopedCreate':True,'rotationGraceVisible':True,'familyRevoked':True,'textInjectionEscaped':True,'noSecretStorage':True,'lockClearsSecret':True,'noPageOverflow':True,'javascriptErrors':errors,'httpPaths':bridge.requests})
                context.close()
            browser.close()
        report['passed']=True
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
(OUT/'keys-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':report['passed'],'viewports':[c['viewport'] for c in report['cases']]},ensure_ascii=False))
