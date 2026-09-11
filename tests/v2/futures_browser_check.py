"""Chart fault reproduction through the production bundle and real HTTP/SSE.
Only upstream responses are fixtures. The test bridge is necessary when managed
Chromium blocks localhost. It does not generate quotes/history or run in production.
"""
from pathlib import Path
import json, os, re, shutil, subprocess, threading, queue, urllib.request, urllib.error, time, sys
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/v2.4';OUT.mkdir(parents=True,exist_ok=True)
process=subprocess.Popen([os.environ.get('NODE_BIN','node'),str(ROOT/'tests/v2/futures-browser-server.mjs')],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
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
  page=browser.new_page(viewport={'width':1440,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  for name,fn in [('__http',get_http),('__openStream',open_stream),('__readStream',read_stream),('__closeStream',close_stream)]:page.expose_function(name,fn)
  page.set_content(html)
  page.add_script_tag(content="""
const memory=new Map([['qqq-watchlist','["NQ00Y.FUT"]'],['qqq-refresh-mode','continuous']]);
Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)},configurable:true});
window.__PANEL_TEST_HOOK__=v=>window.__app=v;
window.fetch=async(url,options={})=>{if(options.signal?.aborted)throw options.signal.reason;const r=await __http(String(url));if(options.signal?.aborted)throw options.signal.reason;return new Response(r.body,{status:r.status,headers:r.headers});};
window.EventSource=class extends EventTarget{
 constructor(url){super();this.closed=false;this.start(url);}
 async start(url){this.id=await __openStream(url);while(!this.closed){for(const f of await __readStream(this.id)){if(f.error)this.onerror?.(new Event('error'));else this.dispatchEvent(new MessageEvent(f.event,{data:f.data}));}await new Promise(r=>setTimeout(r,20));}}
 close(){this.closed=true;if(this.id)__closeStream(this.id);}
};
""")
  page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text())
  page.wait_for_function("window.__app?.cardCache.get('NQ00Y.FUT')?.d?.price>0",timeout=12000)
  assert page.evaluate("__app.cardCache.get('NQ00Y.FUT').unit.textContent")=='点'
  assert page.evaluate("[...__app.cardCache.get('NQ00Y.FUT').ccybtns].every(b=>b.disabled)")
  page.locator('#q').fill('NQ0W');page.wait_for_function("document.querySelectorAll('.sitem').length===2",timeout=5000)
  assert '未核实' in page.locator('#sresults').inner_text()
  report['searchCandidates']=page.locator('.sitem b').all_text_contents()
  assert set(report['searchCandidates'])=={'NQ00Y.FUT','NQ=F'}
  page.locator('.search-more').click();page.wait_for_function("!!document.querySelector('[data-sym=\"NQ26Z.FUT\"]')",timeout=15000)
  report['expandedCandidates']=page.locator('.sitem b').all_text_contents()
  page.locator('[data-sym="NQ26Z.FUT"]').click()
  page.wait_for_function("__app.cardCache.get('NQ26Z.FUT')?.d?.price>0",timeout=12000)
  page.wait_for_function("__app.cardCache.get('NQ26Z.FUT')?.plot?.n===1 && __app.cardCache.get('NQ26Z.FUT')._sampled===true",timeout=5000)
  report['noHistoryObservation']={'symbol':'NQ26Z.FUT','sampled':True,'n':1}
  for tf in ['daily30','weekly','monthly','yearly']:
   page.locator('[id="card-NQ00Y.FUT"] [data-tf="'+tf+'"]').click()
   page.wait_for_function("tf=>__app.cardCache.get('NQ00Y.FUT').historyStore.getMeta(tf).status==='ready'",arg=tf,timeout=20000)
   case=page.evaluate("""()=>{const q=__app.cardCache.get('NQ00Y.FUT');return {tf:q.tf,n:q.plot.n,candle:q.plot.candle,unit:q.unit.textContent,ohlc:q.ohlc.textContent};}""")
   assert case['candle'] and case['n']>=4 and case['unit']=='点',case
   report['cases'].append(case)
  page.locator('#q').fill('NQ=F');page.wait_for_function("!!document.querySelector('[data-sym=\"NQ=F\"]')",timeout=5000)
  page.locator('[data-sym="NQ=F"]').click();page.wait_for_function("__app.cardCache.get('NQ=F')?.d?.price>0",timeout=12000)
  assert page.evaluate("__app.cardCache.get('NQ=F').d.src")=='yahoo-futures'
  assert page.evaluate("JSON.parse(localStorage.getItem('qqq-watchlist')).includes('NQ=F')")
  page.evaluate("document.querySelector('#q').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
  widths=[]
  for width in [320,375,768,1024,1440,1730]:
   page.set_viewport_size({'width':width,'height':1050});page.wait_for_timeout(130)
   assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),width
   widths.append(width)
  report['viewports']=widths;report['javascriptErrors']=errors;assert not errors,errors
  page.evaluate("()=>{const b=document.createElement('div');b.textContent='期货搜索与图表回归测试 · 以下价格为测试样本，并非真实行情';b.style.cssText='padding:14px;text-align:center;background:#fff4d6';document.body.prepend(b);}")
  page.screenshot(path=str(OUT/'futures-desktop.png'),full_page=True)
  report['quotePrice']=page.evaluate("__app.cardCache.get('NQ00Y.FUT').cur.textContent")
  assert report['quotePrice']=='25,234.75'
  browser.close()
finally:
 for sid in streams:streams[sid]['closed']=True
 process.terminate()
 try:process.wait(timeout=15)
 except subprocess.TimeoutExpired:process.kill()
(OUT/'futures-browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
