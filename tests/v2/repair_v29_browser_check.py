"""2.9 repair acceptance: production bundle in Chromium; every quote is synthetic."""
from pathlib import Path
import json, os, shutil, subprocess, time, re
from browser_bridge import BrowserBridge
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/v2.9-release';OUT.mkdir(parents=True,exist_ok=True)
report={'mode':'Chromium / production bundle / synthetic upstream','checks':[]};bridges=[]
server=subprocess.Popen(['node','tests/v2/history-v28-browser-server.mjs'],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)

def check(name,detail=True): report['checks'].append({'name':name,'passed':True,'detail':detail})
def module(page,name):page.add_script_tag(content=(ROOT/'public/modules'/f'{name}.js').read_text())
try:
 first=json.loads(server.stdout.readline());origin=f"http://127.0.0.1:{first['port']}"
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  def make_page(mode='normal',symbols=None):
   ctx=browser.new_context(viewport={'width':1440,'height':1050},accept_downloads=True)
   ctx.add_init_script("""({mode,symbols,at})=>{}""") if False else None
   setup="""(()=>{const mode=MODE,base=performance.now();Date.now=()=>Math.floor(AT+performance.now()-base);window.__PANEL_TEST_HOOK__=x=>window.__app=x;
   const m=new Map([['qqq-watchlist',JSON.stringify(SYMS)],['qqq-refresh-mode','continuous']]);
   if(mode==='getter')Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')},configurable:true});
   else Object.defineProperty(window,'localStorage',{value:{getItem(k){if(mode==='read')throw Error('blocked');return mode==='json'&&k==='qqq-watchlist'?'{broken':m.get(k)??null;},setItem(k,v){if(mode==='quota')throw new DOMException('full','QuotaExceededError');m.set(k,v);},removeItem:k=>m.delete(k)},configurable:true});
   const Native=window.EventSource;window.__sseCount=0;window.EventSource=class extends Native{constructor(...args){super(...args);window.__sseCount++;}};})();"""
   ctx.add_init_script(setup.replace('MODE',json.dumps(mode)).replace('AT',str(first['at'])).replace('SYMS',json.dumps(symbols or ['NVDA','MRVL','LITE','AAOI'])))
   page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   try:
    page.goto(origin,wait_until='domcontentloaded',timeout=5000);page.wait_for_function('window.__app',timeout=10000);report['transport']='native HTTP/SSE'
   except Exception as error:
    report['nativeAttemptError']=str(error)[:400];report['transport']='test-only loopback HTTP/SSE bridge; native HTTP/SSE separately covered by Node integration tests'
    page.close();errors.clear();page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html);html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>');page.set_content(html)
    bridge=BrowserBridge(origin);bridges.append(bridge);bridge.install(page)
    page.add_script_tag(content=setup.replace('MODE',json.dumps(mode)).replace('AT',str(first['at'])).replace('SYMS',json.dumps(symbols or ['NVDA','MRVL','LITE','AAOI'])))
    page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text());page.wait_for_function('window.__app',timeout=10000)
   return ctx,page,errors
  def close_context(ctx,page):
   page.evaluate('window.__streams?.forEach(s=>s.close())');page.wait_for_timeout(100)
   for bridge in bridges:bridge.cleanup()
   page.wait_for_timeout(100);ctx.close()
  for mode in ['getter','read','quota','json']:
   ctx,page,errors=make_page(mode,['NVDA']);page.evaluate("__app.addToWatch('NVDA','测试')");page.wait_for_function("__app.cardCache.get('NVDA')?.d",timeout=12000)
   assert not errors,errors
   if mode!='json':assert page.locator('.msg').count()<=1
   check('R04 storage '+mode,{'cards':page.locator('.price-card').count(),'errors':errors});close_context(ctx,page)
  ctx,page,errors=make_page()
  page.wait_for_function("['NVDA','MRVL','LITE','AAOI'].every(s=>__app.cardCache.get(s)?.d&&__app.cardCache.get(s)?.historyStore.getSeries('daily30').length)",timeout=20000)
  # One DOM clock owner, independently of the worker/network heartbeat.
  page.evaluate("window.__clockWrites=0;window.__observer=new MutationObserver(()=>__clockWrites++);__observer.observe(document.getElementById('clock'),{childList:true});")
  page.wait_for_timeout(5250);writes=page.evaluate('__clockWrites');assert 4<=writes<=7,writes;page.evaluate('__observer.disconnect()');check('R08 single display clock',{'writesIn5250ms':writes})
  before=page.evaluate('__sseCount');page.evaluate("__app.addToWatch('NVDA','已有标的')");page.wait_for_timeout(200);assert page.evaluate('__sseCount')==before;check('R24 existing symbol does not reconnect')
  page.locator('#card-NVDA [data-tf="daily30"]').click()
  with page.expect_download() as download:page.locator('#card-NVDA [data-z="shot"]').click()
  assert download.value.suggested_filename.endswith('.png');assert page.locator('.msg-success[role="status"]').count()==1
  page.evaluate("__app.flash('第一条','warn');__app.flash('第二条','success');")
  assert page.locator('.msg').count()==1 and '第二条' in page.locator('.msg').inner_text();check('R23 PNG success semantics and bounded toast')
  page.locator('#card-NVDA [data-tf="intraday"]').click()
  dimensions=[]
  for width in [320,375]:
   page.set_viewport_size({'width':width,'height':950});page.wait_for_timeout(100)
   sizes=page.locator('#card-NVDA .chart-modes button').evaluate_all('(nodes)=>nodes.map(n=>({text:n.textContent,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}))')
   assert sizes and all(n['h']>=44 for n in sizes),sizes;assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');dimensions.append({'width':width,'buttons':sizes})
  check('R22 mobile touch dimensions',dimensions)
  page.locator('#card-NVDA [data-tf="daily30"]').click()
  page.set_viewport_size({'width':1440,'height':950});page.locator('#card-NVDA .chart-main').scroll_into_view_if_needed()
  wheel=page.evaluate("""()=>{const q=__app.cardCache.get('NVDA'),cv=q.cv,r=cv.getBoundingClientRect();const ordinary=new WheelEvent('wheel',{deltaY:-100,clientX:r.left+r.width/2,cancelable:true});const old=q.plot.vis;cv.dispatchEvent(ordinary);const plain=q.plot.vis;const zoom=new WheelEvent('wheel',{deltaY:-100,ctrlKey:true,clientX:r.left+r.width/2,cancelable:true});cv.dispatchEvent(zoom);return {ordinaryPrevented:ordinary.defaultPrevented,old,plain,zoomPrevented:zoom.defaultPrevented,zoom:q.plot.vis}}""")
  assert not wheel['ordinaryPrevented'] and wheel['old']==wheel['plain'] and wheel['zoomPrevented'] and wheel['zoom']<wheel['old'],wheel;check('R19 normal wheel versus modifier zoom',wheel)
  # Position the chart inside the viewport; a top-of-page assumption breaks
  # when header/status height changes. Wait for observable scroll, not 250 ms.
  page.locator('#card-NVDA .chart-main').scroll_into_view_if_needed();page.wait_for_timeout(150)
  box=page.locator('#card-NVDA .chart-main').bounding_box();scroll_before=page.evaluate('scrollY')
  page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);page.mouse.wheel(0,450)
  page.wait_for_function('before=>scrollY>before',arg=scroll_before,timeout=2000);check('R19 real wheel scrolls page over chart')
  history_payload=page.evaluate("__app.cardCache.get('NVDA').historyStore.getMeta('daily30').meta")
  # Remove while focus is in the card; the last deletion leads back to search.
  for symbol in ['NVDA','MRVL','LITE','AAOI']:
   page.evaluate("s=>{const b=__app.cardCache.get(s).closeBtn;b.focus();b.click();}",symbol)
  assert page.evaluate("document.activeElement===document.getElementById('q')");assert page.locator('.watchlist-empty').is_visible();check('R24 deletion focus and actionable empty state')
  assert not errors,errors;check('production page JavaScript errors',errors);close_context(ctx,page)
  # Isolated real DOM: use unchanged shipped modules, not mock DOM objects.
  iso=browser.new_context();page=iso.new_page();page.set_content('<div class="searchwrap"><input id="q"><div id="sr"></div></div><div id="macroCalendar"></div><div id="factors"></div><div id="status"></div><div id="macroObservation"></div>')
  for name in ['panel-client','panel-currency','panel-state','panel-format','panel-timeframes','panel-scheduler','panel-network','panel-history-store','panel-live-store','panel-search-controller','panel-news-controller','panel-macro-context']:module(page,name)
  # Headers and body are part of the same deadline. Old series stays available.
  timeouts=page.evaluate("""async payload=>{const out=[];for(const phase of ['headers','body']){const stuck=()=>new Promise(()=>{}),fetchImpl=phase==='headers'?stuck:async()=>({ok:true,status:200,json:stuck});const h=PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',fetchImpl,timeoutMs:45});h.hydrate('daily30',payload);const count=h.getSeries('daily30').length,start=performance.now();await h.load('daily30');out.push({phase,ms:performance.now()-start,status:h.getMeta('daily30').status,bars:h.getSeries('daily30').length,count});h.abort();}return out;}""",history_payload)
  assert all(x['status']=='stale' and x['bars']==x['count'] and x['ms']<500 for x in timeouts),timeouts;check('R02 header and body timeout preserve candles',timeouts)
  polling=page.evaluate("""async()=>{let calls=0,policy={marketMs:60000};const live=PANEL_LIVE_STORE.createLiveStore({getSymbols:()=>['NVDA'],getCv:()=>'',EventSourceImpl:null,getPolicy:()=>policy,readSnapshot:async()=>{calls++},onQuotes:()=>{}});live.resume();await new Promise(r=>setTimeout(r,6700));const economy=calls;policy={marketMs:1000};live.reschedule();await new Promise(r=>setTimeout(r,1100));const active=calls;live.pause();await new Promise(r=>setTimeout(r,1100));const paused=calls;live.stop();return {economy,active,paused};}""")
  assert polling['economy']==1 and polling['active']>=2 and polling['paused']==polling['active'],polling;check('R07 fallback policy and pause',polling)
  macro=page.evaluate("""()=>{const ui=PANEL_MACRO_CONTEXT.createMacroContext({document,network:{},root:document.getElementById('factors'),status:document.getElementById('status')});const payload={calendar:{items:[{id:'a',event:'事件一',reference:'本期',releaseAt:Date.now(),caveat:'说明',label:'中性'},{id:'b',event:'事件二',reference:'本期',releaseAt:Date.now(),caveat:'说明',label:'中性'}]},factors:[{id:'gold',name:'黄金',symbol:'GC=F',price:100,unit:'美元',status:'ready',fresh:true}]};ui.apply(payload);const row=document.querySelector('[data-event-id="a"]'),details=row.querySelector('details'),summary=row.querySelector('summary');details.open=true;summary.focus();ui.apply(structuredClone(payload));const same=document.activeElement===summary&&details.open&&row===document.querySelector('[data-event-id="a"]');payload.calendar.items[0].actual='3.1%';payload.factors[0].price=101;ui.apply(payload);const changed=document.activeElement===summary&&details.open&&row===document.querySelector('[data-event-id="a"]');payload.calendar.items.shift();ui.apply(payload);const deletion=document.activeElement.closest('[data-event-id]')?.dataset.eventId==='b';const factor=document.querySelector('.factor-details');factor.open=true;factor.querySelector('summary').focus();payload.factors[0].price=102;ui.apply(payload);return {same,changed,deletion,factorFocus:document.activeElement===factor.querySelector('summary'),factorOpen:factor.open};}""")
  assert all(macro.values()),macro;check('R12 keyed macro DOM preserves reading and focus',macro)
  search=page.evaluate("""async()=>{const q=document.getElementById('q'),sr=document.getElementById('sr');let resolve,fail=false;const list=['AAPL','NVDA','MRVL','LITE'].map(symbol=>({symbol,name:symbol,type:'EQUITY',market:'美股'}));const ctrl=PANEL_SEARCH_CONTROLLER.createSearchController({qEl:q,srEl:sr,document,esc:PANEL_FORMAT.esc,client:{normalizeList:x=>x},network:{request:()=>fail?Promise.reject(Error('source failed')):new Promise(r=>resolve=()=>r({ok:true,json:async()=>list}))},onSelect:()=>{}});q.value='test';const pending=ctrl.runSearch(true);const loading=q.getAttribute('aria-busy')==='true';resolve();await pending;q.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));const up=q.getAttribute('aria-activedescendant');const again=ctrl.runSearch(true);resolve();await again;q.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));const down=q.getAttribute('aria-activedescendant');fail=true;await ctrl.runSearch();return {loading,up,down,retry:!!sr.querySelector('[data-search-retry]'),busy:q.getAttribute('aria-busy')};}""")
  assert search=={'loading':True,'up':'sitem-3','down':'sitem-0','retry':True,'busy':'false'},search;check('R21 search loading/retry and first up/down',search)
  news=page.evaluate("""async()=>{let symbols=[];const ui=PANEL_NEWS_CONTROLLER.createNewsController({getWatchlist:()=>symbols,getCards:()=>new Map(),client:{decodeNewsMetadata:()=>({})},network:{request:async()=>({ok:true,json:async()=>Object.fromEntries(symbols.map(s=>[s,[]]))})}});let peak=0;for(let i=0;i<100;i++){symbols=['S'+i];ui.invalidate();await ui.refreshNews();peak=Math.max(peak,ui.cacheSize());symbols=[];ui.invalidate();}return {peak,remaining:ui.cacheSize()};}""")
  assert news=={'peak':1,'remaining':0},news;check('R20 100 news add/remove cycles bounded',news)
  iso.close();browser.close();report['passed']=True
except Exception as error:
 report['passed']=False;report['error']=str(error);raise
finally:
 (OUT/'repair-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 for bridge in bridges:bridge.cleanup()
 server.terminate()
 try:server.wait(timeout=13)
 except subprocess.TimeoutExpired:server.kill();server.wait()
print(json.dumps(report,ensure_ascii=False,indent=2))
