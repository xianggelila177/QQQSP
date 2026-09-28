"""Live smoke test of the reported Taiwan card; no fixtures or API interception.
Usage: python tests/v2/v111-taiwan-browser.py --url URL --output DIR
Uses an isolated browser profile, without production admin credentials.
"""
import argparse,json,os,time
from pathlib import Path
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--url',required=True)
parser.add_argument('--output',required=True)
args=parser.parse_args()
out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(channel='msedge' if os.name=='nt' else None,headless=True)
    page=browser.new_page(viewport={'width':1500,'height':1100})
    # Playwright wait_for_function uses eval in the page, which our production
    # CSP forbids. Poll via the debugging protocol while preserving site CSP.
    def until(expression,timeout=30000):
        deadline=time.monotonic()+timeout/1000
        while time.monotonic()<deadline:
            if page.evaluate('()=>('+expression+')'):return
            page.wait_for_timeout(250)
        raise AssertionError('Browser condition timed out: '+expression)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script("localStorage.setItem('qqq-watchlist',JSON.stringify(['2330.TW','TSM']));window.__PANEL_TEST_HOOK__=x=>window.__panelTest=x;")
    try:
        page.goto(args.url,wait_until='domcontentloaded',timeout=30000)
        until("window.__panelTest?.cardCache.get('2330.TW')?.d?.price>0",timeout=30000)
        # A ready first-open chart is the regression requirement.
        until("window.__panelTest.cardCache.get('2330.TW')?.plot?.bars?.length>30 && window.__panelTest.cardCache.get('2330.TW').d.fxMap?.TWD>0",timeout=25000)
        card=page.locator('[id="card-2330.TW"]')
        card.locator('[data-ccy="NATIVE"]').click()
        until("window.__panelTest.cardCache.get('2330.TW').unit.textContent==='TWD'")
        native=card.locator('.cur').inner_text()
        card.screenshot(path=str(out/'taiwan-native.png'))
        card.locator('[data-ccy="USD"]').click()
        until("window.__panelTest.cardCache.get('2330.TW').unit.textContent==='USD'")
        usd=card.locator('.cur').inner_text()
        assert usd.startswith('≈'),usd
        card.locator('[data-ccy="CNY"]').click()
        cny=card.locator('.cur').inner_text()
        assert cny.startswith('≈¥'),cny
        card.locator('[data-tf="daily30"]').click()
        until("window.__panelTest.cardCache.get('2330.TW').tf==='daily30' && window.__panelTest.cardCache.get('2330.TW').plot?.bars?.length>5",timeout=25000)
        card.locator('[data-tf="intraday"]').click()
        card.locator('[data-ccy="NATIVE"]').click()
        until("window.__panelTest.cardCache.get('TSM')?.plot?.bars?.length>5",timeout=25000)
        report=page.evaluate("""()=>Object.fromEntries(['2330.TW','TSM'].map(s=>{const q=__panelTest.cardCache.get(s),c=q.d.regularChart;return [s,{currency:q.d.currency,source:c?.source,status:c?.status,tradeDate:c?.tradeDate,targetDate:c?.targetDate,points:q.plot?.bars?.length,last:c?.bars?.at(-1),fxSource:q.d.fxSource,fxDate:q.d.fxDate,price:q.d.price}]}))""")
        assert report['2330.TW']['currency']=='TWD' and report['2330.TW']['status']=='ready',report
        assert report['TSM']['currency']=='USD',report
        assert not errors,errors
        report.update(native=native,usd=usd,cny=cny,javascriptErrors=errors)
        (out/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(report,ensure_ascii=True))
    finally:
        state=page.evaluate("""()=>['2330.TW','TSM'].map(s=>{const q=window.__panelTest?.cardCache.get(s),d=q?.d||{},c=d.regularChart||{};return {symbol:s,source:d.src,price:d.price,stale:d.stale,error:d.error,slowFields:d.slowFields,chart:{...c,bars:c.bars?.length,recentSessions:undefined},plotPoints:q?.plot?.bars?.length,fxStale:d.fxStale,fxMap:d.fxMap}})""")
        (out/'panel-state.json').write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf8')
        page.screenshot(path=str(out/'panel.png'),full_page=True)
        browser.close()
