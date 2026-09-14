"""Macro v2.5 release checks: actual Node routes + actual built UI.
Synthetic upstream, test-only HTTP/SSE bridge; not native EventSource acceptance.
"""
from pathlib import Path
import json,os,re,shutil,subprocess,select
from playwright.sync_api import sync_playwright
from browser_bridge import BrowserBridge
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'docs/evidence/v2.7';OUT.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen([os.environ.get('NODE_BIN','node'),str(ROOT/'tests/v2/macro-browser-server.mjs')],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
bridge=None

def output(timeout=30):
    assert select.select([process.stdout],[],[],timeout)[0],'server output timeout'
    return json.loads(process.stdout.readline())
def command(value):
    process.stdin.write(value+'\n');process.stdin.flush();return output()
report={'mode':'production Node HTTP/SSE + built UI; synthetic upstream', 'browserTransport':'test-only localhost bridge; native EventSource/proxy buffering not tested'}
try:
    boot=output();report['bootWithoutClients']=boot['bootRuns'];assert all(boot['bootRuns'][k]['runs']>=1 for k in ['context','news'])
    bridge=BrowserBridge('http://127.0.0.1:'+str(boot['port']))
    html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html)
    html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>')
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1150});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html)
        page.add_script_tag(content="""const memory=new Map([['qqq-watchlist','[]'],['qqq-refresh-mode','continuous']]);Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},configurable:true});window.__PANEL_TEST_HOOK__=v=>window.__app=v;""")
        bridge.install(page);page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text())
        page.wait_for_function("document.querySelector('#macroMonitorStatus').textContent.includes('推送已连接')")
        assert not page.locator('.macrobox').evaluate('(x)=>x.open')
        assert page.locator('.macro-event').count()==0
        status=command('snapshot')['snapshot'];report['foldedReceivesSse']=status['monitor']['delivery']['subscribers']>=1
        assert report['foldedReceivesSse']
        page.locator('.macrohead').click();page.wait_for_function("document.querySelectorAll('.macro-event').length>3")
        page.wait_for_function("document.querySelectorAll('.macro-factor').length===5")
        order=page.evaluate("({macro:document.querySelector('.macrobox').getBoundingClientRect().top,panels:document.querySelector('#panels').getBoundingClientRect().top,directory:document.querySelector('#marketDirectory').getBoundingClientRect().top})")
        assert order['macro']<order['panels']<order['directory'];report['order']=order
        page.locator('.macro-evidence').first.locator('summary').click();assert '反证与其他解释' in page.locator('.macro-evidence').first.inner_text()
        # Exact screenshot case: group the three survey horizons, no NASDAQ tag.
        page.locator('#mfilters button').filter(has_text=re.compile('^全部$')).click()
        survey=page.locator('.macro-event').filter(has_text='Savanta');assert survey.count()==1
        survey.locator('summary').click();text=survey.inner_text();assert '纳指100' not in text and '美国同月' not in text
        assert '3条期限' in text and '2.9' in text and '3.2' in text;report['survey']=text
        # Fold without stopping stream, advance server collector, then reopen.
        page.locator('.macrohead').click();first=command('snapshot')['snapshot']['monitor']['revision']
        data=command('advance')['snapshot'];assert data['monitor']['revision']>first
        page.wait_for_timeout(500);page.locator('.macrohead').click()
        page.wait_for_function("document.querySelector('#macroObservation').textContent.includes('不能确认资金')")
        assert '实际−预期 -0.1' in page.locator('#macroCalendar').inner_text()
        report['observation']=page.locator('#macroObservation').inner_text();report['calendar']=page.locator('#macroCalendar').inner_text()
        for topic in ['原油','通胀','全部','重点']:
            page.locator('#mfilters button').filter(has_text=re.compile('^'+topic+'$')).click();assert page.locator('.macro-event').count()>0
        # Force transport loss, show snapshot fallback and test escaping via only
        # the test transport. Backend collectors remain untouched.
        page.evaluate('__disconnectMacro()');page.wait_for_function("document.querySelector('#macroMonitorStatus').textContent.includes('重连')")
        page.evaluate("""()=>{window.__snapshotTransform=x=>{x.news.items=[{title:'<img src=x onerror=window.__xss=1>',link:'javascript:alert(1)',t:Date.now(),topic:'原油',src:'<svg/onload=alert(1)>',assessment:{importance:'focus',summary:'<script>window.__xss=1</script>',impacts:[{target:'原油',direction:'positive onmouseover=alert(1)',label:'待验证'}]}}];return x;};}""")
        page.evaluate('__app.refreshMacro()');page.wait_for_function("document.querySelector('#macrolist').textContent.includes('<img')")
        assert page.locator('#macrolist img, #macrolist svg, #macrolist script').count()==0;assert page.evaluate('window.__xss??null') is None
        report['xssBlocked']=True
        page.evaluate('window.__snapshotTransform=null');page.evaluate('__app.refreshMacro()')
        page.evaluate("window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'))")
        page.wait_for_function("document.querySelector('#macroMonitorStatus').textContent.includes('推送已连接')")
        report['reconnect']=True
        widths=[]
        for width in [320,375,768,1024,1440,1730]:
            page.set_viewport_size({'width':width,'height':1150});page.wait_for_timeout(120)
            assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),width;widths.append(width)
        page.set_viewport_size({'width':1440,'height':1150});page.evaluate("(()=>{const el=document.createElement('p');el.textContent='验收测试样本 · 报价与事件均为模拟，不是真实行情';el.style.cssText='text-align:center;padding:10px;background:#fff4d6';document.body.prepend(el);})()")
        page.screenshot(path=str(OUT/'macro-desktop.png'),full_page=True)
        page.set_viewport_size({'width':375,'height':1050});page.screenshot(path=str(OUT/'macro-mobile.png'),full_page=True)
        failure=command('fail');page.wait_for_function("document.querySelector('#macroObservation').textContent.includes('暂停')",timeout=20000)
        assert all(not f['fresh'] and f['status'] in ['error','stale'] for f in failure['snapshot']['context']['factors'])
        assert '来源暂不可用' in page.locator('#macroFactors').inner_text()
        report['failureStates']=[f['status'] for f in failure['snapshot']['context']['factors']]
        report['failureObservation']=page.locator('#macroObservation').inner_text()
        report.update({'viewports':widths,'javascriptErrors':errors,'macroRequests':bridge.requests});assert not errors,errors
        browser.close()
finally:
    if bridge:bridge.cleanup()
    process.terminate()
    try:process.wait(timeout=12)
    except subprocess.TimeoutExpired:process.kill();process.wait()
(OUT/'macro-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2))
