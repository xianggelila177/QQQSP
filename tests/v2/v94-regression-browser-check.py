"""Real HTTP server + shipped assets in Chromium; all provider data are offline fixtures."""
import json, os, re, shutil, subprocess, tempfile, urllib.request
from browser_bridge import BrowserBridge
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/v94/detail-regression';OUT.mkdir(parents=True,exist_ok=True)
report={'mode':'真实应用 HTTP 经测试桥接转送至 Chromium，正式构建；供应商均为离线样本','nativeBrowserTransport':False,'limitation':'环境策略禁止 Chromium 直接访问本机；未验证原生 SSE 重连及反向代理缓冲。','cases':[]}
with tempfile.TemporaryDirectory(prefix='qqqsp-v94-detail-regression-') as tmp:
    env={**os.environ,'LOG_FILE':'','HOME':tmp}
    server=subprocess.Popen(['node',str(ROOT/'tests/v2/v93-browser-server.mjs')],cwd=tmp,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        address={}
        for _ in range(40):
            line=server.stdout.readline()
            if not line: raise RuntimeError('Fixture failed: '+server.stderr.read())
            value=json.loads(line)
            if 'port' in value: address=value;break
        if not address: raise RuntimeError('Fixture did not announce a port')
        base='http://127.0.0.1:'+str(address['port'])
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
            for width in [1440,375]:
                context=browser.new_context(viewport={'width':width,'height':1000},accept_downloads=True)
                page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                bridge=BrowserBridge(base)
                html=bridge.get('/')['body']
                html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
                html=re.sub(r'<link[^>]+>','',html)
                html=html.replace('</head>','<style>'+bridge.get('/style.css')['body']+'</style></head>')
                page.set_content(html)
                page.add_script_tag(content="""const local={},session={};
                  const storage=(obj)=>({getItem:k=>Object.hasOwn(obj,k)?obj[k]:null,setItem:(k,v)=>{obj[k]=String(v)},removeItem:k=>delete obj[k]});
                  Object.defineProperty(window,'localStorage',{value:storage(local)});
                  Object.defineProperty(window,'sessionStorage',{value:storage(session)});
                  window.__storageValues=()=>JSON.stringify({local,session});
                  localStorage.setItem('qqq-watchlist',JSON.stringify(['NVDA','XLK']));""")
                bridge.install(page)
                page.add_script_tag(content="const transport=fetch;window.__httpDetailFault=false;window.fetch=(url,options)=>__httpDetailFault&&String(url).startsWith('/api/detail?')?Promise.resolve(new Response('{}',{status:503,headers:{'Content-Type':'application/json'}})):transport(url,options);")
                page.add_script_tag(content=bridge.get('/panel.bundle.js')['body'])
                page.wait_for_function("document.querySelector('#card-NVDA .cur')?.textContent.includes('105')")
                page.locator('#card-NVDA .market-detail-open').click();page.wait_for_selector('.detail-price')
                modal=page.locator('.market-detail-dialog')
                assert modal.is_visible()
                assert '单一交易所' in modal.inner_text()
                assert '整手（每手股数未核验）' in modal.inner_text()
                assert modal.locator('.detail-metric[data-field]').count()==24
                assert modal.locator('[data-field="turnoverAmount"]>strong').inner_text()=='—'
                pe=modal.locator('[data-field="peTTM"]');pe.locator('summary').click()
                assert '5.268' in pe.inner_text() and 'offline-earnings' in pe.inner_text()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                assert modal.evaluate('(el)=>el.scrollWidth<=el.clientWidth+1')
                with page.expect_download() as download_info: modal.get_by_role('button',name='导出完整数据').click()
                download=download_info.value;data=json.loads(Path(download.path()).read_text())
                assert data['schema_version']==2 and data['instrument']['symbol']=='NVDA'
                assert data['sections']['order_book']['data']['bid']['size']==2
                page.screenshot(path=str(OUT/('detail-desktop.png' if width==1440 else 'detail-mobile.png')))
                page.keyboard.press('Escape');assert not modal.is_visible()
                assert page.evaluate("document.activeElement===document.querySelector('#card-NVDA .market-detail-open')")
                page.locator('#card-XLK .cardclose').click()
                page.wait_for_function("document.querySelector('#watchlistSyncStatus')?.dataset.state==='auth-required'")
                page.locator('#btnAdmin').click();page.locator('#admin-key').fill('browser-admin-'*4)
                page.get_by_role('button',name='应用并重试').click()
                page.wait_for_function("document.querySelector('#watchlistSyncStatus')?.dataset.state==='saved'")
                assert page.locator('#admin-key').input_value()==''
                assert not page.evaluate("__storageValues().includes('browser-admin')")
                assert not page.evaluate("__storageValues().includes('browser-admin')")
                page.keyboard.press('Escape')
                assert json.loads(bridge.get('/api/history/status')['body'])['persistentWatchlist']==['NVDA']
                # Delayed response from a closed modal must not repopulate or reopen it.
                page.evaluate("window.__httpDetailFault=true")
                page.locator('#card-NVDA .market-detail-open').click()
                page.wait_for_function("document.querySelector('.detail-note')?.textContent.includes('读取失败')")
                page.keyboard.press('Escape')
                assert not errors,errors
                report['cases'].append({'viewport':width,'fields':24,'rawBookUnitPreserved':True,'exportVerified':True,'formulaEvidence':True,'missingNotZero':True,'escapeFocusRestore':True,'writeDeniedWithoutKey':True,'authenticatedRetryPersisted':True,'noSecretInStorage':True,'failureState':True,'javascriptErrors':errors})
                page.evaluate("window.__streams?.forEach(stream=>stream.close())");page.wait_for_timeout(200);bridge.cleanup();page.wait_for_timeout(200);context.close()
            browser.close()
        report['passed']=True
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
(OUT/'browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
