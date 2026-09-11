"""Production bundle and application HTTP, synthetic upstream only; no test paths in runtime."""
from pathlib import Path
import json, os, re, shutil, subprocess, urllib.request, urllib.error, select
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'docs/evidence/v2.4';OUT.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen([os.environ.get('NODE_BIN','node'),str(ROOT/'tests/v2/macro-browser-server.mjs')],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
origin='http://127.0.0.1:'+str(json.loads(process.stdout.readline())['port']);requests=[]
def get_http(url):
 requests.append(str(url));print('HTTP '+str(url),flush=True)
 try:response=urllib.request.urlopen(origin+str(url),timeout=30)
 except urllib.error.HTTPError as error:response=error
 with response:return {'status':response.status,'headers':dict(response.headers),'body':response.read().decode('utf-8')}
def command(value):
 process.stdin.write(value+'\n');process.stdin.flush();
 assert select.select([process.stdout],[],[],20)[0], 'server command timeout: '+value
 return json.loads(process.stdout.readline())
html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html);html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>')
report={'mode':'production HTTP + built browser bundle; synthetic upstream, not live financial validation','browserTransport':'test-only localhost bridge','cases':[]}
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1440,'height':1150});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.expose_function('__http',get_http)
  page.set_content(html);page.add_script_tag(content="""
const memory=new Map([['qqq-watchlist','[]'],['qqq-refresh-mode','continuous']]);
Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},configurable:true});
window.__PANEL_TEST_HOOK__=v=>window.__app=v;
window.fetch=async(url,options={})=>{if(options.signal?.aborted)throw options.signal.reason;const r=await __http(String(url));if(options.signal?.aborted)throw options.signal.reason;const body=window.__macroTransform&&String(url)==='/api/macro'?JSON.stringify(window.__macroTransform(JSON.parse(r.body))):r.body;return new Response(body,{status:r.status,headers:r.headers});};
""")
  page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text());page.wait_for_timeout(1200)
  assert not any('/api/macro' in r for r in requests),requests
  order=page.evaluate("({macro:document.querySelector('.macrobox').getBoundingClientRect().top,panels:document.querySelector('#panels').getBoundingClientRect().top,directory:document.querySelector('#marketDirectory').getBoundingClientRect().top})")
  assert order['macro']<order['panels']<order['directory'],order;report['order']=order
  print('STEP open',flush=True)
  page.locator('.macrohead').click();page.wait_for_function("document.querySelectorAll('.macro-event').length>3",timeout=30000)
  page.wait_for_function("document.querySelectorAll('.macro-factor').length===5",timeout=20000)
  page.wait_for_function("document.querySelector('#macroContextStatus').textContent.includes('5/5')",timeout=20000)
  assert '规则·利好' not in page.locator('.macrobox').inner_text()
  assert '宏观规则标签' not in page.locator('#digest').inner_text()
  assert '等待' in page.locator('#macroObservation').inner_text()
  page.locator('.macro-evidence').first.locator('summary').click();assert '反证与其他解释' in page.locator('.macro-evidence').first.inner_text()
  print('STEP advance',flush=True)
  assert command('advance')['ok']
  print('STEP refresh-advanced',flush=True)
  page.evaluate('__app.refreshMacro()');page.wait_for_function("document.querySelector('#macroObservation').textContent.includes('不能确认资金')",timeout=20000)
  assert '本机发布前记录' in page.locator('#macroCalendar').inner_text()
  assert '实际−预期 -0.1' in page.locator('#macroCalendar').inner_text()
  report['comparableObservation']=page.locator('#macroObservation').inner_text();report['calendar']=page.locator('#macroCalendar').inner_text()
  print('STEP filters',flush=True)
  for topic in ['原油','通胀','全部','重点']:
   page.locator('#mfilters button').filter(has_text=re.compile('^'+topic+'$')).click();page.wait_for_timeout(50)
   assert page.locator('.macro-event').count()>0,topic
  # Unsafe links/text must not become executable markup, even in evidence detail.
  print('STEP xss',flush=True)
  page.evaluate("""()=>{window.__macroTransform=x=>{x.items=[{title:'<img src=x onerror=window.__xss=1> 原油',link:'javascript:alert(1)',t:Date.now(),topic:'原油',src:'<svg/onload=alert(1)>',assessment:{importance:'watch',summary:'<script>window.__xss=1</script>',impacts:[{target:'原油',direction:'positive onmouseover=alert(1)',label:'待验证'}]}}];return x;};}""")
  page.evaluate('__app.refreshMacro()');page.wait_for_function("document.querySelector('#macrolist').textContent.includes('<img')");assert page.locator('#macrolist img, #macrolist script, #macrolist svg').count()==0;assert page.evaluate('window.__xss??null') is None
  # Restore actual tested API payload.
  page.evaluate('window.__macroTransform=null')
  page.evaluate('__app.refreshMacro()');page.wait_for_function("document.querySelectorAll('.macro-event').length>3")
  print('STEP viewports',flush=True)
  widths=[]
  for w in [320,375,768,1024,1440,1730]:
   page.set_viewport_size({'width':w,'height':1150});page.wait_for_timeout(130);assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),w;widths.append(w)
  page.set_viewport_size({'width':1440,'height':1150});page.evaluate("(()=>{const el=document.createElement('div');el.textContent='验收测试样本 · 所有报价与事件均为模拟，不是真实行情';el.style.cssText='padding:10px;background:#fff4d6;text-align:center;font-size:13px';document.body.prepend(el);})()")
  print('STEP screenshots',flush=True)
  page.screenshot(path=str(OUT/'macro-desktop.png'),full_page=True);page.set_viewport_size({'width':375,'height':1050});page.screenshot(path=str(OUT/'macro-mobile.png'),full_page=True)
  print('STEP close',flush=True)
  page.locator('.macrohead').click();page.wait_for_timeout(200);before=len([r for r in requests if '/api/macro' in r]);page.evaluate('__app.refreshMacro()');page.wait_for_timeout(5300);assert len([r for r in requests if '/api/macro' in r])==before
  report.update({'viewports':widths,'closedPanelNoRequests':True,'xssBlocked':True,'javascriptErrors':errors,'macroRequests':len([r for r in requests if '/api/macro' in r])});assert not errors,errors
  browser.close()
finally:
 process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill();process.wait()
(OUT/'macro-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2))
