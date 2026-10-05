"""Offline visual/interaction regression using production UI factories and synthetic data."""
import json, math, os, re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT.parent/'qqqsp-chart-upgrade-20261005'/'evidence'
OUT.mkdir(parents=True,exist_ok=True)
last=datetime(2026,9,22,13,30,tzinfo=timezone.utc)
days=[]
day=last
while len(days)<200:
    if day.weekday()<5: days.append(day)
    day-=timedelta(days=1)
days.reverse()
def candle(at,i):
    o=100+i*.12+4*math.sin(i/9);c=o+.9*math.cos(i*1.7)
    return {'t':at.timestamp(),'o':o,'h':max(o,c)+.5,'l':min(o,c)-.5,'c':c,'v':12000+int(4000*(1+math.sin(i/3)))}
daily=[dict(candle(at,i),periodStart=at.strftime('%Y-%m-%d'),periodEndExclusive=(at+timedelta(days=1)).strftime('%Y-%m-%d'),periodState='closed') for i,at in enumerate(days)]
one=[candle(last+timedelta(minutes=5*i),i) for i in range(78)]
sessions=[{'open_at_ms':int(last.timestamp()*1000),'close_at_ms':int((last+timedelta(hours=6,minutes=30)).timestamp()*1000)}]
data={'one':one,'daily':daily,'sessions':sessions,'at':int((last+timedelta(hours=7)).timestamp()*1000)}
detail={'symbol':'NVDA','book':{'status':'unavailable','reason':'SOURCE_HAS_NO_BOOK'},'tape':{'status':'unavailable','reason':'NO_RECEIVED_TRADES','events':[]}}
fixture=r"""
const data=window.FIXTURE,noop=()=>{},formatterFor=()=>({money:v=>Number.isFinite(v)?'$'+v.toFixed(2):'—',unit:'USD',canConvert:true});
const controller=PANEL_CHART_CONTROLLER.createChartController({document,formatterFor,formatKey:()=> 'USD',client:{...PANEL_CHART_ENGINE,...PANEL_CHART},flash:noop,UP:'#cf3c4f',DOWN:'#168568',dpr:devicePixelRatio});
const view=PANEL_CARD_VIEW.createCardView({document,panelsEl:document.querySelector('#panels'),stripEl:document.querySelector('#strip'),chartController:controller,formatterFor,cardCurOf:()=> 'NATIVE',nameOf:s=>s==='NVDA'?'NVIDIA · 测试数据':'纳指100 · 测试数据',onRemove:noop,onRetry:noop,onCurrency:noop,humanizeAge:()=> '离线样本',UP:'#cf3c4f',DOWN:'#168568',quoteClock:{now:()=>data.at}});
window.CARDS=view.cardCache;window.CONTROLLER=controller;
for(const symbol of ['NVDA','QQQ']){
 const q=view.ensureCard(symbol);q.historyStore.abort();
 const meta={symbol,currency:'USD',instrumentType:'EQUITY',seriesId:'ui-fixture-v1',source:'ui-fixture',historyAsOf:'2026-09-22',sourceCheckedAt:data.at,volumeUnit:'shares',hasMore:false,adjustmentBasis:'source-default-unverified',status:'ready',coverageStatus:'complete-to-asof'};
 q.historyStore={getSeries:tf=>tf==='daily30'?data.daily:tf==='weekly'?data.daily.filter((_,i)=>i%5===0):[],getRevision:()=>1,getMeta:()=>({status:'ready',meta,bars:data.daily,loadedDirect:true}),load:async()=>{},abort(){},needsLoad:()=>false};
 q.d={symbol,displayName:symbol+' · 离线样本',currency:'USD',market:'美股',instrumentType:'EQUITY',src:'ui-fixture',price:111.42,change:1.22,changePct:1.107,priceSession:'POST',marketState:'POST',quoteAt:data.at,sourceCheckedAt:data.at,quoteTradeDate:'2026-09-22',prevClose:110.2,previousCloseTradeDate:'2026-09-21',regularPrice:111.12,volume:1425367,quoteKind:'snapshot',gmtoff:-14400,charts:{intraday:data.one},regularChart:{symbol,currency:'USD',status:'ready',source:'ui-fixture',seriesId:'ui-minute-v1',tradeDate:'2026-09-22',targetDate:'2026-09-22',bars:data.one,pointKind:'bar-start',intervalSeconds:300,regularSessions:data.sessions,exchangeZone:'America/New_York',volumeUnit:'shares',volumeQuality:{status:'ready'},sourceCheckedAt:data.at,previousCloseReference:{value:110.2,tradeDate:'2026-09-21',status:'source-dated'}},slowFields:{}};
 q.fetchStatus='ready';q.requestPending=false;view.render(q);controller.drawChart(q,true);
}
"""
modules=re.findall(r"'(public/modules/[^']+\.js)'",(ROOT/'scripts/build-static.mjs').read_text(encoding='utf8').split(']);',1)[0])
report={'mode':'production UI factories; synthetic offline fixtures, not live quotes','cases':[]}
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_BIN',r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    try:
        for name,width,height,mobile in [('desktop',1440,1000,False),('portrait',390,844,True),('small',320,740,True),('landscape',844,390,True)]:
            if os.environ.get('CHART_VIEWPORTS') and name not in os.environ['CHART_VIEWPORTS'].split(','):continue
            context=browser.new_context(viewport={'width':width,'height':height},device_scale_factor=1,is_mobile=mobile,has_touch=mobile,service_workers='block')
            page=context.new_page();page.set_default_timeout(8000);errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            def route(request):
                if '/api/' in request.request.url:
                    query=parse_qs(urlparse(request.request.url).query)
                    body=dict(detail,symbol=query.get('symbol',['NVDA'])[0],range=query.get('range',['1d'])[0])
                    request.fulfill(status=200,content_type='application/json',body=json.dumps(body))
                else:
                    request.fulfill(status=200,content_type='text/html; charset=utf-8',body='<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main style="padding:20px;max-width:1320px;margin:auto"><h1 style="font:600 20px system-ui">QQQSP · 图表工作台</h1><p style="font:12px system-ui;color:#667085">离线界面测试 · 合成行情，不代表真实价格</p><div id="strip" hidden></div><div id="panels" class="panels"></div></main></body></html>')
            page.route('http://workspace.test/**',route);page.goto('http://workspace.test/')
            page.add_style_tag(content=(ROOT/'public/style.css').read_text(encoding='utf8'))
            for module in modules:page.add_script_tag(path=str(ROOT/module))
            page.evaluate('window.FIXTURE='+json.dumps(data));page.evaluate(fixture)
            page.locator('#card-NVDA [data-tf="daily30"]').click()
            page.locator('#card-NVDA .chart-settings summary').click()
            page.locator('#card-NVDA [data-chart-study="ema20"]').check()
            page.locator('#card-NVDA [data-chart-study="rsi14"]').check()
            page.locator('#card-NVDA [data-chart-setting="scale"]').select_option('percent')
            page.wait_for_function("CARDS.get('NVDA').plot.scale==='percent' && !!CARDS.get('NVDA').plot.rsiPane")
            assert page.evaluate("CARDS.get('QQQ').chartSettings.studies.rsi14")
            page.locator('#card-NVDA .chart-settings summary').click()
            if name=='desktop':page.screenshot(path=str(OUT/'cards-desktop.png'),full_page=True)
            page.locator('#card-NVDA .chart-expand').click();page.locator('.chart-detail-dialog[open]').wait_for()
            assert not page.locator('.chart-detail-dialog').evaluate("el=>el.classList.contains('is-rotated')")
            page.locator('.cd-periods [data-tf="daily30"]').click()
            page.locator('.cd-settings summary').click()
            page.locator('.cd-settings [data-chart-setting="scale"]').select_option('log')
            page.screenshot(path=str(OUT/f'settings-{name}.png'))
            page.locator('.cd-settings [data-chart-study="boll20"]').check()
            page.locator('.cd-settings summary').click()
            page.locator('[data-range="90"]').click();page.wait_for_function("document.querySelector('.cd-range-state').textContent.includes('90')")
            assert 'RSI14' in page.locator('.cd-studies').inner_text()
            assert 'EMA20' in page.locator('.cd-studies').inner_text()
            assert '来源未提供盘口' in page.locator('.cd-book-status').inner_text()
            page.locator('[data-action="side"]').click()
            assert page.locator('.cd-side').is_hidden()
            cv=page.locator('.cd-canvas');box=cv.bounding_box()
            page.locator('[data-draw="trend"]').click()
            page.mouse.click(box['x']+box['width']*.25,box['y']+box['height']*.28)
            page.mouse.click(box['x']+box['width']*.7,box['y']+box['height']*.16)
            assert '已保存' in page.locator('.cd-draw-state').inner_text()
            cv.press('Escape');assert page.locator('.chart-detail-dialog[open]').count()==1
            page.locator('[data-draw="measure"]').click()
            page.mouse.click(box['x']+box['width']*.48,box['y']+box['height']*.36)
            page.mouse.click(box['x']+box['width']*.82,box['y']+box['height']*.24)
            cv.press('Escape')
            overflow=page.locator('.chart-detail-shell').evaluate('el=>({width:el.clientWidth,scroll:el.scrollWidth})')
            if overflow['scroll']>overflow['width']+2:
                page.screenshot(path=str(OUT/f'overflow-{name}.png'))
                print(page.locator('.chart-detail-shell').evaluate("el=>Array.from(el.querySelectorAll('*')).map(e=>({class:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,scroll:e.scrollWidth,width:e.clientWidth})).filter(e=>e.right>innerWidth||e.left<0)"))
            assert overflow['scroll']<=overflow['width']+2,(name,overflow)
            assert cv.bounding_box()['height']>=160,(name,cv.bounding_box())
            page.screenshot(path=str(OUT/f'workspace-{name}.png'))
            if name in ('small','landscape'):
                body=page.locator('.chart-detail-body');body_box=body.bounding_box()
                page.mouse.move(body_box['x']+body_box['width']/2,body_box['y']+8)
                page.mouse.wheel(0,1000)
                page.wait_for_function("document.querySelector('.chart-detail-body').scrollTop>0")
                lower=cv.bounding_box()
                assert body_box['y']<lower['y']+lower['height']<=body_box['y']+body_box['height']+2
                page.screenshot(path=str(OUT/f'workspace-{name}-lower.png'))
                page.mouse.move(body_box['x']+body_box['width']/2,body_box['y']+8);page.mouse.wheel(0,-1000)
                page.wait_for_function("document.querySelector('.chart-detail-body').scrollTop===0")
            if name=='portrait':
                page.locator('[data-action="rotate"]').click()
                assert page.locator('.chart-detail-dialog').evaluate("el=>el.classList.contains('is-rotated')")
                page.screenshot(path=str(OUT/'workspace-rotated.png'))
                assert cv.evaluate('el=>el.clientHeight')>=140
                page.locator('[data-action="rotate"]').click()
                assert not page.locator('.chart-detail-dialog').evaluate("el=>el.classList.contains('is-rotated')")
            saved=page.evaluate("JSON.parse(localStorage.getItem('qqqsp:detail-drawings:v1'))")
            assert saved is not None
            page.locator('[data-action="out"]').click();cv.press('ArrowLeft')
            assert '开 ' in page.locator('.cd-point').inner_text()
            page.locator('.cd-close').click();assert page.locator('.chart-detail-dialog[open]').count()==0
            assert page.locator('#card-NVDA .chart-expand').evaluate('el=>document.activeElement===el')
            assert page.evaluate("CARDS.get('NVDA').chartSettings.scale==='log'")
            assert not errors,(name,errors)
            report['cases'].append({'viewport':name,'size':[width,height],'passed':True,'overflow':overflow,'errors':errors})
            context.close()
    finally:browser.close()
(OUT/'browser-results.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf8')
print(json.dumps(report,ensure_ascii=False))
