"""Supplemental offline browser validation. This is not the release E2E gate.
Requires an existing Python Playwright installation and compatible Chromium.
Uses local application assets and mock data; never requests provider credentials.
"""
import argparse,json,time,re,pathlib,os,tempfile
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[2],help='Project root containing public/')
parser.add_argument('--output-dir',type=pathlib.Path,help='Evidence destination; defaults to a new temporary directory')
parser.add_argument('--chromium',default=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),help='Existing Chromium executable')
args=parser.parse_args()
ROOT=args.root.resolve()
OUT=(args.output_dir or pathlib.Path(tempfile.mkdtemp(prefix='qqqsp-v72-browser-'))).resolve()
OUT.mkdir(parents=True,exist_ok=True)
if not pathlib.Path(args.chromium).is_file():
 parser.error('Chromium executable not found; pass --chromium or set CHROMIUM_EXECUTABLE.')
try:
 from playwright.sync_api import sync_playwright
except ImportError:
 parser.error('Python Playwright is not installed in this environment; this supplemental script does not replace the project release gate.')
results=[]
html=(ROOT/'public/index.html').read_text()
html=re.sub(r'<script[^>]*src=[^>]*>\s*</script>','',html)
html=re.sub(r'<link\b[^>]*>','',html)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
 for mode in ['normal','worker-silent','worker-error']:
  context=browser.new_context(viewport={'width':1730,'height':1080},service_workers='block')
  page=context.new_page();errors=[]
  page.on('pageerror',lambda err:errors.append(str(err)))
  page.evaluate("""()=>{let store={'qqq-watchlist':JSON.stringify(['QQQ','SPY','NVDA']),'qqq-refresh-mode':'continuous'};Object.defineProperty(window,'localStorage',{value:{getItem:k=>store[k]??null,setItem:(k,v)=>store[k]=String(v),removeItem:k=>delete store[k]}});} """)
  if mode!='normal':
   page.evaluate("()=>{window.Worker=class {constructor(){%s} terminate(){} };}" % ("queueMicrotask(()=>this.onerror?.(new Error('fixture worker failure')));" if mode=='worker-error' else ''))
  baseline=int(time.time()*1000)-15000
  prices={'QQQ':716.49,'SPY':763.12,'NVDA':223.67}
  body=[{'symbol':sym,'displayName':sym,'price':price,'quoteAt':baseline,'ts':baseline,'sourceCheckedAt':baseline,
    'fetchedAt':baseline,'market':'美股','marketState':'REGULAR','currency':'USD','src':'fixture','gmtoff':-14400,
    'instrumentType':'EQUITY' if sym=='NVDA' else 'ETF','change':-1,'changePct':-0.2,'prevClose':price+1,
    'priceSession':'REGULAR','pollAfterMs':2000,'checkIntervalMs':2000,'charts':{'intraday':[
     {'t':(baseline//1000)-60*(60-i),'o':price-1,'h':price+1,'l':price-2,'c':price+i/100,'v':1} for i in range(60)]}}
     for sym,price in prices.items()]
  page.evaluate("""data=>{window.marketReads=[];window.fetch=async(url)=>{url=String(url);let body={markets:[]};if(url.includes('/api/market?')){window.marketReads.push(performance.now());body=data;}else if(url.includes('/api/news'))body={QQQ:[],SPY:[],NVDA:[]};else if(url.includes('/api/macro'))body={items:[]};return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json','X-Server-Now-Ms':String(Date.now())}});};}""",body)
  page.set_content(html,wait_until='domcontentloaded')
  page.add_style_tag(content=(ROOT/'public/style.css').read_text())
  page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text())
  page.wait_for_function("document.querySelector('#card-QQQ .quote-age')?.textContent.includes('报价年龄')")
  page.evaluate("""()=>{ const el=document.querySelector('#card-QQQ .quote-age');window.ageChanges=[];let prev=el.textContent;new MutationObserver(()=>{if(el.textContent!==prev){prev=el.textContent;window.ageChanges.push({at:performance.now(),text:prev});}}).observe(el,{childList:true,subtree:true,characterData:true});} """)
  page.wait_for_timeout(8200)
  changes=page.evaluate('window.ageChanges')
  gaps=[round(changes[i]['at']-changes[i-1]['at'],2) for i in range(1,len(changes))]
  result={'mode':mode,'observation_ms':8200,'text_changes':len(changes),'maximum_gap_ms':max(gaps) if gaps else None,'market_requests':page.evaluate('window.marketReads.length'),'page_errors':errors,'layout_hint_count':page.locator('#layoutHint').count(),'samples':changes}
  assert len(changes)>=7 and max(gaps)<=1200,(mode,result)
  assert not errors,errors
  if mode=='normal':
   sizes=[]
   for width in [320,375,768,1024,1440,1730]:
    page.set_viewport_size({'width':width,'height':1080});page.wait_for_timeout(120)
    metrics=page.evaluate("""()=>({width:innerWidth,bodyWidth:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.price-card')].map(e=>({width:e.getBoundingClientRect().width,overflow:e.scrollWidth>e.clientWidth+1}))})""")
    assert metrics['bodyWidth']<=width+1,metrics
    sizes.append(metrics)
   result['viewports']=sizes
   page.screenshot(path=str(OUT/'desktop-v72.png'),full_page=True)
  results.append(result)
  context.close()
 browser.close()
(OUT/'browser-validation.json').write_text(json.dumps({'method':'Real Chromium; about:blank offline HTML/CSS/bundle injection and mock fetch; no real HTTP server, upstream or production website','results':results},ensure_ascii=False,indent=2))
print(json.dumps([{k:v for k,v in r.items() if k not in ['samples','viewports']} for r in results],ensure_ascii=False,indent=2))

print('Evidence directory:', OUT)
