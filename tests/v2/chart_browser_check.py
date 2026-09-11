"""Chart fault reproduction through the production bundle and real HTTP/SSE.
Only upstream responses are fixtures. The test bridge is necessary when managed
Chromium blocks localhost. It does not generate quotes/history or run in production.
"""
from pathlib import Path
import json, os, re, shutil, subprocess, threading, queue, urllib.request, urllib.error, time, sys
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/v2.4';OUT.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen([os.environ.get('NODE_BIN','node'),str(ROOT/'tests/v2/chart-browser-server.mjs')],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
first=json.loads(process.stdout.readline());origin='http://127.0.0.1:'+str(first['port'])
requests=[];streams={};next_id=0

def get_http(url):
    requests.append(str(url))
    try: response=urllib.request.urlopen(origin+str(url),timeout=150)
    except urllib.error.HTTPError as error: response=error
    with response:
        return {'status':response.status,'headers':dict(response.headers),'body':response.read().decode('utf-8')}

def open_stream(url):
    global next_id
    next_id+=1;sid=next_id;q=queue.Queue();streams[sid]={'q':q,'closed':False};requests.append(str(url))
    def receive():
        try:
            with urllib.request.urlopen(origin+str(url),timeout=20) as response:
                event='message';data=[]
                while not streams[sid]['closed']:
                    line=response.readline().decode('utf-8').rstrip('\r\n')
                    if line.startswith('event:'):event=line[6:].strip()
                    elif line.startswith('data:'):data.append(line[5:].lstrip())
                    elif not line and data:q.put({'event':event,'data':'\n'.join(data)});event='message';data=[]
        except Exception as error:
            if not streams[sid]['closed']:q.put({'error':str(error)})
    threading.Thread(target=receive,daemon=True).start();return sid

def read_stream(sid):
    result=[]
    while not streams[sid]['q'].empty():result.append(streams[sid]['q'].get_nowait())
    return result

def close_stream(sid):
    if sid in streams:streams[sid]['closed']=True

html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html)
html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>')
report={'mode':'production application HTTP/SSE + built browser bundle; simulated upstream','browserTransport':'test-only localhost bridge; Chromium policy blocks direct localhost','cases':[]}
try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1730,'height':1100});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
  for name,fn in [('__http',get_http),('__openStream',open_stream),('__readStream',read_stream),('__closeStream',close_stream)]:page.expose_function(name,fn)
  page.set_content(html)
  page.add_script_tag(content="""
const memory=new Map([['qqq-watchlist','["NVDA","MRVL","ALAB","INTC"]'],['qqq-refresh-mode','continuous']]);
Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},configurable:true});
window.__PANEL_TEST_HOOK__=value=>window.__app=value;
window.fetch=async(url,options={})=>{if(options.signal?.aborted)throw options.signal.reason;const r=await __http(String(url));if(options.signal?.aborted)throw options.signal.reason;return new Response(r.body,{status:r.status,headers:r.headers});};
window.EventSource=class extends EventTarget{
 constructor(url){super();this.closed=false;this.start(url);}
 async start(url){this.id=await __openStream(url);while(!this.closed){for(const frame of await __readStream(this.id)){if(frame.error)this.onerror?.(new Event('error'));else this.dispatchEvent(new MessageEvent(frame.event,{data:frame.data}));}await new Promise(r=>setTimeout(r,20));}}
 close(){this.closed=true;if(this.id)__closeStream(this.id);}
};
""")
  page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text());page.wait_for_function("window.__app?.cardCache.get('NVDA')?.d?.price>0",timeout=10000)
  # Real-source history should remain a line even if its upstream bars carry OHLC.
  page.wait_for_timeout(250)
  modes=page.evaluate("""()=>['ALAB','INTC'].map(s=>{const q=__app.cardCache.get(s);return {symbol:s,n:q.plot?.n,candle:q.plot?.candle,sampled:q._sampled,text:q.chartState?.textContent,note:q._observationNote};})""")
  assert modes[0]['candle'] is False and modes[0]['sampled'] is False,modes
  assert modes[1]['candle'] is False and modes[1]['sampled'] is True,modes
  report['chartModeComparison']=modes
  page.locator('#card-ALAB [data-chart-mode="samples"]').click();page.wait_for_timeout(50);assert page.evaluate("__app.cardCache.get('ALAB')._sampled")
  page.locator('#card-ALAB [data-chart-mode="history"]').click();page.wait_for_timeout(50);assert not page.evaluate("__app.cardCache.get('ALAB')._sampled")
  for symbol,tf,source in [('NVDA','daily30','nasdaq-history'),('MRVL','weekly','eastmoney-history')]:
   page.locator('#card-'+symbol+' [data-tf="'+tf+'"]').click()
   page.wait_for_function("([s,tf])=>__app.cardCache.get(s).historyStore.getMeta(tf).status==='ready'",arg=[symbol,tf],timeout=30000)
   case=page.evaluate("""([s,tf])=>{const q=__app.cardCache.get(s),m=q.historyStore.getMeta(tf);return {symbol:s,tf,state:m.status,source:m.meta.source,loaded:q.historyStore.getSeries(tf).length,visible:q.plot.n,candle:q.plot.candle};}""",[symbol,tf])
   assert case['candle'] and case['source']==source and case['visible']>10,case;report['cases'].append(case)
  for tf in ['weekly','monthly','yearly','daily30']:
   page.locator('#card-NVDA [data-tf="'+tf+'"]').click()
   page.wait_for_function("tf=>__app.cardCache.get('NVDA').historyStore.getMeta(tf).status==='ready'",arg=tf,timeout=30000)
   geometry=page.evaluate("""()=>{const q=__app.cardCache.get('NVDA'),p=q.plot;return {tf:q.tf,n:p.n,candle:p.candle,finite:p.bars.every(b=>[p.y(b.o),p.y(b.h),p.y(b.l),p.y(b.c)].every(Number.isFinite)),text:q.ohlc.textContent};}""")
   assert geometry['candle'] and geometry['finite'] and geometry['n']>1,geometry;report['cases'].append(geometry)
  # All four chart canvases must actually paint, not just contain nominal arrays.
  report['painted']=page.evaluate("""()=>['NVDA','MRVL','ALAB','INTC'].map(symbol=>{const q=__app.cardCache.get(symbol),a=q.cv.getContext('2d').getImageData(0,0,q.cv.width,q.cv.height).data;let pixels=0;for(let i=0;i<a.length;i+=4)if(a[i+3]>50&&Math.max(a[i],a[i+1],a[i+2])-Math.min(a[i],a[i+1],a[i+2])>40)pixels++;return {symbol,pixels};})""")
  assert all(x['pixels']>20 for x in report['painted']),report['painted']
  widths=[]
  for width in [320,375,768,1024,1440,1730]:
   page.set_viewport_size({'width':width,'height':1100});page.wait_for_timeout(130)
   assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),width
   widths.append(width)
  report['viewports']=widths
  page.evaluate("""()=>{const banner=document.createElement('div');banner.textContent='离线故障回归验证 · 下列价格为测试样本，不是真实行情';banner.style.cssText='padding:10px;background:#fff4d6;text-align:center;color:#624c1a;font-size:14px';document.body.prepend(banner);}""")
  page.screenshot(path=str(OUT/'charts-desktop.png'),full_page=True)
  page.set_viewport_size({'width':375,'height':1000});page.wait_for_timeout(150);page.screenshot(path=str(OUT/'charts-mobile.png'),full_page=True)
  page.set_viewport_size({'width':1730,'height':1100})
  page.evaluate("__app.addToWatch('AAOI','全部历史来源失败测试')")
  page.wait_for_function("window.__app?.cardCache.get('AAOI')?.d?.price>0",timeout=10000)
  page.locator('#card-AAOI [data-tf="daily30"]').click()
  page.wait_for_function("__app.cardCache.get('AAOI').historyStore.getMeta('daily30').status==='error'",timeout=30000)
  error_state=page.evaluate("""()=>{const q=__app.cardCache.get('AAOI'),e=q.historyStore.getMeta(q.tf);return {status:e.status,retryAt:e.retryAt,buttonVisible:!q.chartRetry.hidden,disabled:q.chartRetry.disabled,text:q.chartState.textContent,empty:q.ohlc.textContent};}""")
  assert error_state['retryAt']>time.time()*1000 and error_state['buttonVisible'] and error_state['disabled'],error_state
  report['allSourcesFailure']=error_state
  before=len([u for u in requests if '/api/history?' in u]);page.evaluate("__app.cardCache.get('AAOI').historyStore.load('daily30')");page.wait_for_timeout(100)
  assert len([u for u in requests if '/api/history?' in u])==before
  report['cooldownSuppressesRequest']=True
  report['javascriptErrors']=errors;assert not errors,errors
  report['marketPollRequests']=len([u for u in requests if '/api/market?' in u]);assert report['marketPollRequests']==0,requests
  browser.close()
finally:
 for sid in streams:close_stream(sid)
 process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill();process.wait()
(OUT/'chart-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
