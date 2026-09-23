"""Deterministic desktop and portrait-fallback smoke check for the chart detail."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs' / 'evidence'
OUT.mkdir(parents=True, exist_ok=True)

days = ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22']
base = 100
def bars(day):
    import datetime
    start = datetime.datetime.fromisoformat(day + 'T13:30:00+00:00').timestamp()
    return [{'t': start + i * 300, 'o': base + i * .04, 'h': base + i * .04 + .3,
             'l': base + i * .04 - .2, 'c': base + i * .04 + .1, 'v': 1000 + i * 12}
            for i in range(78)]

sessions = [{'open_at_ms': int(__import__('datetime').datetime.fromisoformat(d + 'T13:30:00+00:00').timestamp()*1000),
             'close_at_ms': int(__import__('datetime').datetime.fromisoformat(d + 'T20:00:00+00:00').timestamp()*1000)} for d in days]
one = bars(days[-1])
five = {'status':'ready','source':'yahoo','coveredDays':5,'totalDays':5,'tradeDates':days,
        'days':[{'date':d,'status':'ready','bars':bars(d),'regularSessions':[sessions[i]]} for i,d in enumerate(days)],
        'bars':[b for d in days for b in bars(d)],'regularSessions':sessions,
        'previousCloseReference':{'value':99,'tradeDate':'2026-09-15','status':'source-dated'}}
detail = {'symbol':'AAOI','book':{'status':'unavailable','reason':'SOURCE_HAS_NO_BOOK'},
          'tape':{'status':'unavailable','reason':'NO_RECEIVED_TRADES','events':[]},'fiveDay':five}

fixture = r"""
window.PANEL_FORMAT={fmtDate:(t,withTime=false)=>{const d=new Date(t*1000+8*3600000).toISOString();return withTime?d.slice(0,16).replace('T',' '):d.slice(0,10)},
 fmtVol:v=>v==null?'—':Number(v).toLocaleString('en-US')};
document.body.innerHTML='<section class="price-card"><button class="chart-expand">展开图表</button><canvas class="chart-main" width="600" height="240"></canvas></section>';
const canvas=document.querySelector('.chart-main');canvas.style.width='min(100%,600px)';canvas.style.height='240px';
const data=window.FIXTURE;
const card={symbol:'AAOI',el:document.querySelector('.price-card'),cv:canvas,
  d:{symbol:'AAOI',displayName:'Applied Optoelectronics',instrumentType:'EQUITY',currency:'USD',src:'yahoo',
    price:107.02,change:-1.65,changePct:-1.52,priceSession:'POST',marketState:'POST',quoteAt:Date.parse('2026-09-22T22:00:00Z'),
    quoteTradeDate:'2026-09-22',prevClose:108.67,previousCloseTradeDate:'2026-09-21',regularPrice:107,
    open:106,dayHigh:109,dayLow:105,volume:8932100,ext:{post:{price:107.02,change:.02,changePct:.02}},
    regularChart:{status:'ready',tradeDate:'2026-09-22',exchangeZone:'America/New_York',source:'yahoo',
      bars:data.one,regularSessions:[data.sessions[4]],volumeQuality:{status:'ready'},
      previousCloseReference:{value:108.67,tradeDate:'2026-09-21',status:'source-dated'}}},
  historyStore:{getSeries:tf=>tf==='daily30'?data.five.days.map((d,i)=>({t:d.bars[0].t,o:100+i,h:103+i,l:99+i,c:102+i,v:100000+i*1000})):[],
    getRevision:()=>1,getMeta:()=>({meta:{volumeUnit:'shares'}}),load:async()=>{} }};
window.CHART_CARD=card;
window.PANEL_CHART_DETAIL.createChartDetailView({document,UP:'#db3d4c',DOWN:'#14875c',
  formatterFor:()=>({money:v=>v==null?'—':'$'+Number(v).toFixed(2)})}).mount(card);
"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
    for name, width, height, mobile in [('desktop', 1360, 820, False), ('portrait', 390, 844, True)]:
        context = browser.new_context(viewport={'width':width,'height':height}, device_scale_factor=1,
                                      is_mobile=mobile, has_touch=mobile)
        page = context.new_page()
        errors=[]
        page.on('pageerror',lambda error: errors.append(str(error)))
        page.route('http://detail.test/**', lambda route: route.fulfill(status=200, content_type='text/html', body='<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>')
                   if '/api/' not in route.request.url else route.fulfill(status=200, content_type='application/json',
                                                                         body=json.dumps(detail)))
        page.goto('http://detail.test/')
        page.add_style_tag(content=(ROOT / 'public' / 'style.css').read_text(encoding='utf8'))
        page.evaluate("() => { HTMLDialogElement.prototype.requestFullscreen=function(){return Promise.reject(new Error('orientation unavailable'))}; return true; }")
        page.add_script_tag(path=str(ROOT / 'public' / 'modules' / 'panel-chart.js'))
        page.add_script_tag(path=str(ROOT / 'public' / 'modules' / 'panel-timeframes.js'))
        page.add_script_tag(path=str(ROOT / 'public' / 'modules' / 'panel-chart-engine.js'))
        page.evaluate("""() => { const original=window.PANEL_CHART_ENGINE;
          window.PANEL_CHART_ENGINE={...original,createChartEngine(args){const engine=original.createChartEngine(args);
            return {...engine,computePlot(q){const p=engine.computePlot(q);window.PLOT_DEBUG={n:p.n,
              x:[0,77,78,155,156,233,234,311,312,389].filter(i=>i<p.n).map(i=>p.x(i)),sessions:p.visibleSessions.length};return p;}};}}; }""")
        page.add_script_tag(path=str(ROOT / 'public' / 'modules' / 'panel-chart-detail.js'))
        page.evaluate('window.FIXTURE='+json.dumps({'one':one,'five':five,'sessions':sessions}))
        page.evaluate(fixture)
        page.locator('.chart-expand').click()
        page.locator('.chart-detail-dialog[open]').wait_for()
        page.locator('.cd-canvas').wait_for()
        assert page.locator('.cd-chart-info').inner_text().startswith('一日 2026-09-22')
        assert page.locator('.cd-book-status').inner_text() == '来源未提供盘口'
        if mobile:
            assert page.locator('.chart-detail-dialog').evaluate("el=>el.classList.contains('is-rotated')")
            assert page.evaluate('innerWidth') == 390
        box = page.locator('.cd-canvas').bounding_box()
        before = page.locator('.cd-point').inner_text()
        page.mouse.move(box['x']+box['width']*.5 if mobile else box['x']+box['width']*.25,
                        box['y']+box['height']*.25 if mobile else box['y']+box['height']*.5)
        assert page.locator('.cd-point').inner_text() != before
        page.screenshot(path=str(OUT / f'chart-detail-{name}-one-day.png'))
        page.locator('[data-tf="fiveDay"]').click()
        page.wait_for_function("document.querySelector('.cd-chart-info')?.textContent.includes('5/5')")
        debug = page.evaluate('window.PLOT_DEBUG')
        assert debug['n'] == 390 and debug['sessions'] == 5, debug
        assert debug['x'][2] > debug['x'][1], debug
        page.screenshot(path=str(OUT / f'chart-detail-{name}-five-day.png'))
        if not mobile:
            page.locator('[data-tf="daily30"]').click()
            page.wait_for_function("document.querySelector('.cd-chart-info')?.textContent.includes('交易所历史K线')")
            page.screenshot(path=str(OUT / 'chart-detail-desktop-daily.png'))
        assert page.locator('.cd-trade-row').count() == 0
        assert page.locator('.chart-detail-dialog button').filter(has_text='买入').count() == 0
        page.locator('.cd-close').click()
        assert page.locator('.chart-detail-dialog[open]').count() == 0
        assert page.locator('.chart-expand').evaluate('el=>document.activeElement===el')
        assert not errors, errors
        context.close()
    browser.close()
print('chart detail browser smoke passed; screenshots in', OUT)
