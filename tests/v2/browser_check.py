"""离线 Chromium 交互验证。真实 HTTP/SSE 由 http-integration.test.mjs 验证。"""
from pathlib import Path
import re, json, shutil, os
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/v2.2';OUT.mkdir(parents=True,exist_ok=True)
html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html);html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>')
report={'mode':'offline browser, real bundle; fixed data; native HTTP/SSE tested separately','cases':[]}
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 for mode in ['normal','worker-silent','worker-error']:
  page=browser.new_page(viewport={'width':1730,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(html);page.add_script_tag(content=(ROOT/'tests/v2/browser-fixture.js').read_text())
  if mode!='normal':page.add_script_tag(content="window.Worker=class { constructor(){"+("setTimeout(()=>this.onerror?.({preventDefault(){}}),50);" if mode=='worker-error' else '')+"} terminate(){} };")
  page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text());page.wait_for_timeout(500)
  assert page.locator('.price-card').count()==3
  page.evaluate("""()=>{const el=__app.cardCache.get('QQQ').quoteAge;window.__ageChanges=[];let last=el.textContent;new MutationObserver(()=>{if(el.textContent!==last){__ageChanges.push({at:performance.now(),text:el.textContent});last=el.textContent;}}).observe(el,{childList:true,characterData:true,subtree:true});}""")
  page.wait_for_timeout(4600)
  changes=page.evaluate('__ageChanges');gaps=[changes[i]['at']-changes[i-1]['at'] for i in range(1,len(changes))]
  assert len(changes)>=4,(mode,changes)
  assert max(gaps)<1200,(mode,gaps)
  assert page.evaluate('__requests.length')==0
  assert '空间不足时自动减少列数' not in page.locator('body').inner_text()
  case={'case':mode,'ageUpdates':len(changes),'maxGapMs':round(max(gaps),2),'healthyHttpRequests':0,'javascriptErrors':errors}
  if mode=='normal':
   page.evaluate("__streams.at(-1).emit([__quote('QQQ',105)])")
   assert page.evaluate("__app.cardCache.get('QQQ').d.price")==105
   assert page.evaluate("__app.cardCache.get('SPY').d.price")==100
   page.evaluate("__app.cardCache.get('QQQ').newsbox.open=true");page.wait_for_timeout(200)
   assert any('/api/news' in x['url'] and 'QQQ' in x['url'] and 'SPY' not in x['url'] for x in page.evaluate('__requests'))
   page.evaluate("__app.cardCache.get('QQQ').newsbox.open=false");page.wait_for_timeout(100)
   before=page.evaluate('__requests.length');page.evaluate('__app.refreshNews();__app.refreshMacro()');page.wait_for_timeout(100);assert page.evaluate('__requests.length')==before
   page.evaluate("document.querySelector('.macrobox').open=true");page.wait_for_timeout(200);assert any('/api/macro' in x['url'] for x in page.evaluate('__requests'))
   page.evaluate("document.querySelector('.macrobox').open=false")
   page.evaluate("__streams.at(-1).onerror(new Event('error'))");page.wait_for_timeout(200)
   assert any('/api/market' in x['url'] for x in page.evaluate('__requests'))
   page.wait_for_timeout(3500);before=page.evaluate("__requests.filter(x=>x.url.includes('/api/market')).length");page.wait_for_timeout(2200);assert page.evaluate("__requests.filter(x=>x.url.includes('/api/market')).length")==before
   case['fallbackRecovered']=True;case['closedPanelsNoRequests']=True;case['subsetUpdatesPreserved']=True
   page.evaluate("__app.addToWatch('AAPL','Apple')");page.wait_for_timeout(250);assert page.locator('.price-card').count()==4
   page.locator('#card-AAPL .cardclose').click()
   page.wait_for_timeout(200);assert page.locator('.price-card').count()==3
   viewports=[]
   for width in [320,375,768,1024,1440,1730]:
    page.set_viewport_size({'width':width,'height':1100});page.wait_for_timeout(100)
    sizes=page.evaluate('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');assert sizes['scroll']<=sizes['client']+1,(width,sizes);viewports.append(width)
   case['viewports']=viewports
   page.screenshot(path=str(OUT/'v2-desktop.png'),full_page=True)
   page.set_viewport_size({'width':375,'height':1000});page.wait_for_timeout(200);page.screenshot(path=str(OUT/'v2-mobile.png'),full_page=True)
  assert not errors,errors
  report['cases'].append(case);page.close()
 browser.close()
(OUT/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
