"""Timezone integration: production bundle + actual app routes and controlled upstream.
Uses native Chromium HTTP when possible, otherwise the existing test-only bridge.
"""
from pathlib import Path
import json,os,re,shutil,subprocess,time
from playwright.sync_api import sync_playwright
from browser_bridge import BrowserBridge
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'docs/evidence/v2.7'; OUT.mkdir(parents=True,exist_ok=True)
proc=subprocess.Popen(['node','tests/v2/chart-time-browser-server.mjs'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
bridge=None
report={'mode':'production application + built frontend; simulated Nasdaq x/z upstream','cases':[]}
try:
 first=json.loads(proc.stdout.readline());origin='http://127.0.0.1:'+str(first['port']);bridge=BrowserBridge(origin)
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  ctx=browser.new_context(viewport={'width':1440,'height':1050},timezone_id='America/Los_Angeles')
  setup="""
(() => {
const base=performance.now();Date.now=()=>AT+performance.now()-base;
window.__PANEL_TEST_HOOK__=v=>window.__app=v;
const memory=new Map([['qqq-watchlist','["LITE","AAOI","ALAB","INTC"]'],['qqq-refresh-mode','continuous']]);
Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},configurable:true});
const originalFillText=CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){this.canvas.__timeLabels??=[];if(/^\\d{2}:\\d{2}$/.test(text)){this.canvas.__timeLabels.push(text);if(this.canvas.__timeLabels.length>50)this.canvas.__timeLabels.shift();}return originalFillText.call(this,text,x,y,...rest);};
})();
""".replace('AT',str(first['at']))
  ctx.add_init_script(setup);page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  try:
   page.goto(origin,wait_until='domcontentloaded',timeout=8000)
   page.wait_for_function("window.__app?.cardCache.get('LITE')?.d?.charts?.intraday?.length>0",timeout=8000)
   report['browserTransport']='native Chromium HTTP/SSE'
  except Exception as e:
   report['browserTransport']='test-only localhost HTTP/SSE bridge';report['nativeAttemptError']=str(e)[:400]
   errors.clear();page.close();page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html)
   html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>');page.set_content(html)
   page.add_script_tag(content=setup);bridge.install(page);page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text())
  page.wait_for_function("window.__app&&['LITE','AAOI','ALAB','INTC'].every(s=>__app.cardCache.get(s)?.d?.charts?.intraday?.length>0)",timeout=25000)
  page.wait_for_timeout(300)
  for symbol in ['LITE','AAOI','ALAB','INTC']:
   page.locator('#card-'+symbol+' canvas.chart-main').scroll_into_view_if_needed()
   page.wait_for_function("s=>__app.cardCache.get(s)?.plot?.n>0",arg=symbol,timeout=5000)
   page.wait_for_timeout(120)
   report['cases'].append(page.evaluate("""symbol=>{const q=__app.cardCache.get(symbol);return {symbol,quoteAt:q.d.quoteAt,historyLast:q.d.charts.intraday.at(-1).t,historyFormatted:PANEL_FORMAT.fmtDate(q.d.charts.intraday.at(-1).t),cardFormatted:PANEL_FORMAT.fmtDate(q.d.quoteAt/1000),status:q.chartState.textContent,point:q.ohlc.textContent,axisTimes:q.cv.__timeLabels,metadata:q.d.slowFields.intraday,candle:q.plot.candle};}""",symbol))
  for c in report['cases']:
   assert c['historyFormatted']=='2026-09-11 22:16',c
   assert c['cardFormatted']==c['historyFormatted'],c
   assert '22:16' in c['axisTimes'] and '18:16' not in c['axisTimes'],c
   assert 'UTC+8' in c['status'] and c['candle'] is False,c
   assert c['metadata']['timeContract']=='nasdaq-label-et-v2',c
  report['dailyPeriods']=[]
  for tf in ['daily30','weekly','monthly','yearly']:
   page.locator('#card-LITE [data-tf="'+tf+'"]').click()
   page.wait_for_function("tf=>__app.cardCache.get('LITE').historyStore.getMeta(tf).status==='ready'",arg=tf,timeout=25000)
   case=page.evaluate("""()=>{const q=__app.cardCache.get('LITE');return {tf:q.tf,n:q.plot.n,candle:q.plot.candle,status:q.chartState.textContent};}""")
   assert case['candle'] and case['n']>0,case;report['dailyPeriods'].append(case)
  page.locator('#card-LITE [data-tf="intraday"]').click();page.wait_for_timeout(100)
  report['viewports']=[]
  for width in [320,375,768,1024,1440,1730]:
   page.set_viewport_size({'width':width,'height':1050});page.wait_for_timeout(180)
   assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),width
   report['viewports'].append(width)
  page.evaluate("""()=>{const e=document.createElement('div');e.textContent='时区回归测试样本：来源 10:16 美东 → 卡片与图表均为 22:16 北京时间；不是真实行情';e.style.cssText='padding:12px;background:#fff4d6;color:#5d491a;text-align:center';document.body.prepend(e);} """)
  page.screenshot(path=str(OUT/'chart-time-desktop.png'),full_page=True)
  page.set_viewport_size({'width':375,'height':1050});page.wait_for_timeout(150);page.screenshot(path=str(OUT/'chart-time-mobile.png'),full_page=True)
  report['javascriptErrors']=errors;assert not errors,errors
  report['passed']=True;browser.close()
except Exception as exc:
 report['error']=str(exc)
 try:
  report['debug']=page.evaluate("({errors:window.__app?null:'hook absent',cards:[...(window.__app?.cardCache||[])].map(([s,q])=>({s,d:q.d}))})")
  report['javascriptErrors']=errors;report['requests']=bridge.requests if bridge else []
 except Exception:pass
 (OUT/'chart-time-browser-failure.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 raise
finally:
 if bridge:bridge.cleanup()
 proc.terminate()
 try:proc.wait(timeout=12)
 except subprocess.TimeoutExpired:proc.kill();proc.wait()
(OUT/'chart-time-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2))
