"""Production app/bundle, controlled data. Tests only; not installed on the server."""
from pathlib import Path
import json,os,re,shutil,subprocess,urllib.request,time
from playwright.sync_api import sync_playwright
from browser_bridge import BrowserBridge
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'docs/evidence/v2.9-release';OUT.mkdir(parents=True,exist_ok=True)
p=subprocess.Popen(['node','tests/v2/history-v28-browser-server.mjs'],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
bridge=None;report={'mode':'actual app and built frontend; synthetic upstream','tabs':[]}
try:
 first=json.loads(p.stdout.readline());origin='http://127.0.0.1:'+str(first['port']);control='http://127.0.0.1:'+str(first['controlPort']);bridge=BrowserBridge(origin)
 def get(route='/'):
  with urllib.request.urlopen(control+route,timeout=25) as r:return json.load(r)
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  context=browser.new_context(viewport={'width':1440,'height':1050},timezone_id='America/Los_Angeles')
  setup="""(()=>{const base=performance.now();Date.now=()=>Math.floor(AT+performance.now()-base);window.__PANEL_TEST_HOOK__=v=>window.__app=v;const m=new Map([['qqq-watchlist','["NVDA","MRVL","LITE","AAOI"]'],['qqq-refresh-mode','continuous']]);Object.defineProperty(window,'localStorage',{value:{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)},configurable:true});})();""".replace('AT',str(first['at']))
  context.add_init_script(setup);page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  try:
   page.goto(origin,wait_until='domcontentloaded',timeout=7000);page.wait_for_function('window.__app',timeout=5000);report['transport']='native HTTP/SSE'
  except Exception as e:
   report['nativeAttemptError']=str(e)[:350];report['transport']='test-only local HTTP/SSE bridge';page.close();errors.clear();page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html);html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>')
   page.set_content(html);page.add_script_tag(content=setup);bridge.install(page);page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text())
  page.wait_for_function("window.__app&&['NVDA','MRVL','LITE','AAOI'].every(s=>__app.cardCache.get(s)?.d&&__app.cardCache.get(s)?.historyStore.getSeries('yearly').length>=20)",timeout=60000)
  before=get()['historyCalls'];report['callsBeforeTabs']=before
  for symbol in ['NVDA','MRVL','LITE','AAOI']:
   for tf in ['daily30','weekly','monthly','yearly']:
    page.locator('#card-'+symbol+' [data-tf="'+tf+'"]').scroll_into_view_if_needed()
    result=page.evaluate("""async ([s,tf])=>{const q=__app.cardCache.get(s),start=performance.now();document.querySelector('#card-'+s+' [data-tf="'+tf+'"]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {symbol:s,tf,ms:performance.now()-start,bars:q.plot?.n,candle:q.plot?.candle,status:q.chartState.textContent};}""",[symbol,tf])
    assert result['bars']>0 and result['candle'] and result['ms']<250,result;report['tabs'].append(result)
  report['callsAfterTabs']=get()['historyCalls'];assert report['callsBeforeTabs']==report['callsAfterTabs'],report
  page.locator('#card-NVDA [data-tf="intraday"]').click()
  old=page.evaluate("__app.cardCache.get('NVDA').historyStore.getSeries('daily30').at(-1).c")
  get('/advance');page.wait_for_function("old=>__app.cardCache.get('NVDA').historyStore.getSeries('daily30').at(-1).c!==old",arg=old,timeout=25000);report['unselectedPeriodUpdated']=True
  page.evaluate("document.querySelector('.macrobox').open=true");page.wait_for_selector('.macro-event',timeout=15000)
  page.locator('#mfilters [data-f="全部"]').click()
  report['news']=[{'title':row.locator('.event-link').inner_text(),'labels':row.locator('.impact-row').inner_text()} for row in page.locator('.macro-event').all()]
  assert any('Gold Rebounds' in n['title'] and '黄金 · 条件偏利多' in n['labels'] for n in report['news']),report['news']
  assert any('加息' in n['title'] and '纳指100 · 条件偏利空' in n['labels'] for n in report['news']),report['news']
  assert any('Gold Price Forecast' in n['title'] and '纳指100' not in n['labels'] for n in report['news']),report['news']
  get('/advance?mode=failed');page.wait_for_function("__app.cardCache.get('NVDA').historyStore.getMeta('daily30').status==='stale'",timeout=25000)
  page.locator('#card-NVDA [data-tf="daily30"]').click();assert page.evaluate("__app.cardCache.get('NVDA').plot.n>0");report['failureKeepsCandles']=True
  report['viewports']=[]
  for width in [320,375,768,1024,1440,1730]:
   page.set_viewport_size({'width':width,'height':1050});page.wait_for_timeout(140);assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),width;report['viewports'].append(width)
  page.set_viewport_size({'width':1440,'height':1050});page.evaluate("(()=>{const b=document.createElement('div');b.textContent='自动化验证：以下价格与资讯均为测试样本，不是真实市场数据';b.style.cssText='padding:12px;background:#fff4d6;text-align:center';document.body.prepend(b);window.scrollTo(0,0);})()")
  page.screenshot(path=str(OUT/'desktop.png'),full_page=True);report['javascriptErrors']=errors;assert not errors,errors;report['passed']=True;browser.close()
except Exception as e:
 report['error']=str(e)
 try:report['debug']=page.evaluate("[...(window.__app?.cardCache||[])].map(([s,q])=>({s,tf:q.tf,d:!!q.d,history:q.historyPrepared,state:q.historyStore?.getMeta('daily30')}))")
 except Exception:pass
 raise
finally:
 (OUT/'browser-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 if bridge:bridge.cleanup()
 p.terminate()
 try:p.wait(timeout=13)
 except subprocess.TimeoutExpired:p.kill();p.wait()
print(json.dumps(report,ensure_ascii=False,indent=2))
