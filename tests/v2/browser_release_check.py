"""新增功能的离线浏览器验收；页面使用构建产物，数据均为明确的测试样本。"""
from pathlib import Path
import re,json,shutil,os
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'docs/evidence/v2.2';OUT.mkdir(parents=True,exist_ok=True)
html=(ROOT/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+>','',html);html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>')
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1730,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
 page.add_script_tag(content=(ROOT/'tests/v2/browser-fixture.js').read_text())
 page.add_script_tag(content="""
localStorage.setItem('qqq-watchlist',JSON.stringify(['000660.KS','SKHY','LITE']));
const original=window.__quote;window.__quote=symbol=>{
 const q=original(symbol);const kr=symbol==='000660.KS',adr=symbol==='SKHY';
 Object.assign(q,{displayName:kr?'SK海力士 · 韩国普通股':adr?'SK海力士 · 美国存托证券':'Lumentum',currency:kr?'KRW':'USD',gmtoff:kr?32400:-14400,market:kr?'韩股':'美股',exchangeName:kr?'KOSPI':adr?'OTC':'NASDAQ',instrumentType:'EQUITY',src:kr?'naver-kr':'sina-batch',quoteAt:Date.now()-10000,sourceCheckedAt:Date.now()-1000,price:kr?200000:adr?192.21:980.62,priceSession:kr?'REGULAR':'PRE',marketState:kr?'REGULAR':'PRE',fxMap:{USD:7.1,CNY:1,KRW:.005},currency2cny:kr?.005:7.1,prevClose:kr?198000:adr?190:975,open:null,dayHigh:null,dayLow:null,volume:null,quoteTimePrecision:kr?'second':'minute'});
 q.change=q.price-q.prevClose;q.changePct=q.change/q.prevClose*100;q.charts={intraday:kr?Array.from({length:60},(_,i)=>({t:Math.floor(q.quoteAt/1000)-3540+i*60,c:199000+1000*Math.sin(i/8),v:100+i})):adr?[]:[{t:Math.floor(q.quoteAt/1000)-86400,c:985,v:100}],daily30:[]};return q;
};
""")
 page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text());page.wait_for_timeout(750)
 page.locator('[id="card-000660.KS"] [data-ccy="NATIVE"]').click();page.wait_for_timeout(120)
 state=page.evaluate("""()=>[...__app.cardCache].map(([symbol,q])=>({symbol,currency:q.d.currency,points:q._displayIntraday.length,sampled:q._sampled,note:q._observationNote,painted:!!q.plot,pointLabel:q.point.textContent,volume:q._displayIntraday.at(-1)?.v}))""")
 kr=next(x for x in state if x['symbol']=='000660.KS');adr=next(x for x in state if x['symbol']=='SKHY');lite=next(x for x in state if x['symbol']=='LITE')
 assert kr['currency']=='KRW' and kr['points']==60 and not kr['sampled'],kr
 assert adr['currency']=='USD' and adr['points']==1 and adr['sampled'] and adr['painted'],adr
 assert adr['volume'] is None and '报价采样' in adr['pointLabel'],adr
 assert lite['sampled'] and lite['points']==1 and '非完整历史' in lite['note'],lite
 # Streaming the same listing updates its observation without recreating candles.
 page.evaluate("""()=>{const q=__quote('SKHY');q.price=193;q.quoteAt=Date.now()-5000;__streams.at(-1).emit([q]);}""");page.wait_for_timeout(100)
 assert page.evaluate("__app.cardCache.get('SKHY')._displayIntraday.at(-1).c")==193
 widths=[]
 for width in [320,375,768,1024,1440,1730]:
  page.set_viewport_size({'width':width,'height':1100});page.wait_for_timeout(100)
  assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),width
  widths.append(width)
 # Clearly mark screenshots as fixtures, not live market prices.
 page.evaluate("""()=>{const banner=document.createElement('div');banner.textContent='离线功能验收 · 下列价格为测试样本，不是真实行情';banner.style.cssText='background:#fff6d9;padding:10px 24px;text-align:center;font-size:14px;color:#704b00';document.body.prepend(banner);}""")
 page.screenshot(path=str(OUT/'release-desktop.png'),full_page=True)
 page.set_viewport_size({'width':375,'height':1000});page.wait_for_timeout(200);page.screenshot(path=str(OUT/'release-mobile.png'),full_page=True)
 assert not errors,errors
 report={'mode':'offline browser with production bundle and labelled fixtures','cards':state,'observationUpdated':True,'viewports':widths,'javascriptErrors':errors};(OUT/'release-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2));browser.close()
