"""Exercise the shipped bundle in Chromium; all market data are offline fixtures.
No claim is made about live upstream availability or exchange feed entitlement.
"""
from pathlib import Path
import json, os, re, shutil, subprocess
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'docs/evidence/v2.11-release'; OUT.mkdir(parents=True,exist_ok=True)
html=(ROOT/'public/index.html').read_text()
html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
html=re.sub(r'<link[^>]+>','',html)
html=html.replace('</head>','<style>'+(ROOT/'public/style.css').read_text()+'</style></head>')
quotes=subprocess.check_output([os.environ.get('NODE_BIN','node'),'--input-type=module','-e',"import {browserQuotes} from './tests/v2/fundamentals-fixture.mjs';console.log(JSON.stringify(browserQuotes()));"],cwd=ROOT,text=True).strip()
report={'mode':'真实 Chromium 执行正式构建产物；行情与财务为离线样本','assetVersion':(ROOT/'VERSION').read_text().strip(),'cases':[]}
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
    for storage_disabled in [False,True]:
        page=browser.new_page(viewport={'width':1730,'height':1100});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html);page.add_script_tag(content=(ROOT/'tests/v2/browser-fixture.js').read_text())
        page.add_script_tag(content="""
        memory.set('qqq-watchlist','["AAOI","NVDA","XLK"]');
        window.__financialFixtures=new Map(FIXTURES.map(q=>[q.symbol,q]));
        const basicQuote=window.__quote;
        window.__quote=(symbol,price)=>({...basicQuote(symbol,price),...(structuredClone(__financialFixtures.get(symbol)||{}))});
        """.replace('FIXTURES',quotes))
        if storage_disabled:
            page.add_script_tag(content="Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Storage blocked','SecurityError');}});")
        page.add_script_tag(content=(ROOT/'public/panel.bundle.js').read_text())
        page.wait_for_function("window.__app?.cardCache.size>0 && [...__app.cardCache.values()].every(q=>q.d?.price>0)")
        page.wait_for_timeout(250)
        counts=page.locator('.statistics').evaluate_all('(els)=>els.map(el=>[...el.querySelectorAll("[data-metric]")].filter(n=>!n.hidden).length)')
        assert counts and all(n==16 for n in counts),counts
        page.locator('.statistics-toggle').first.click()
        counts=page.locator('.statistics').evaluate_all('(els)=>els.map(el=>[...el.querySelectorAll("[data-metric]")].filter(n=>!n.hidden).length)')
        assert all(n==24 for n in counts),counts
        page.locator('.statistics-toggle').first.click()
        case={'storageDisabled':storage_disabled,'cardCount':len(counts),'compactMetrics':16,'expandedMetrics':24,'synchronizedExpansion':True}
        if not storage_disabled:
            assert page.locator('#card-AAOI [data-metric="priceToBook"] b').inner_text()=='5.33'
            assert page.locator('#card-AAOI [data-metric="peTTM"] b').inner_text()=='亏损'
            assert page.locator('#card-AAOI [data-metric="turnoverRate"] b').inner_text()=='6.18%'
            assert page.locator('#card-XLK [data-metric="priceToBook"] b').inner_text()=='不适用'
            assert page.locator('#card-AAOI [data-metric="turnoverAmount"] b').inner_text()=='—'
            old_pb=page.locator('#card-AAOI [data-metric="priceToBook"] b').inner_text()
            old_cap=page.locator('#card-AAOI [data-metric="marketCap"] b').inner_text()
            page.locator('#card-AAOI [data-ccy="CNY"]').click();page.wait_for_timeout(100)
            new_cap=page.locator('#card-AAOI [data-metric="marketCap"] b').inner_text()
            assert new_cap!=old_cap and new_cap.endswith(' CNY'),(old_cap,new_cap)
            assert page.locator('#card-AAOI [data-metric="priceToBook"] b').inner_text()==old_pb
            page.locator('#card-AAOI [data-ccy="USD"]').click()
            case['currencyConversion']={'before':old_cap,'after':new_cap,'ratioUnchanged':True}
            page.locator('#card-AAOI .statistics-help').click()
            assert page.locator('.metrics-dialog').is_visible()
            assert '取得时间不等于财报或股本日期' in page.locator('.metrics-dialog').inner_text()
            page.keyboard.press('Escape');page.wait_for_timeout(100)
            assert not page.locator('.metrics-dialog').is_visible()
            assert page.evaluate("document.activeElement===document.querySelector('#card-AAOI .statistics-help')")
            case['dialogKeyboardAndFocus']=True
            page.evaluate("""()=>{const q=__app.cardCache.get('AAOI');window.__oldQuoteAt=q.d.quoteAt;window.__oldSourceAt=q.d.sourceCheckedAt;
              const d=structuredClone(q.d);d.fundamentals.fields.priceToBook.value=6.66;d.fundamentals.fetchedAt=Date.now();__streams.find(s=>s.url.includes('/api/stream?')&&!s.closed).emit([d]);}""")
            page.wait_for_function("__app.cardCache.get('AAOI').d.fundamentals.fields.priceToBook.value===6.66")
            # Observe steady display ticks after the independent financial render.
            # Immediate render writes are not one-second scheduler ticks.
            page.wait_for_timeout(1500)
            page.evaluate("""()=>{const el=__app.cardCache.get('AAOI').quoteAge;window.__ageChanges=[];let text=el.textContent;new MutationObserver(()=>{if(el.textContent!==text){text=el.textContent;__ageChanges.push({at:performance.now(),text});}}).observe(el,{childList:true,characterData:true,subtree:true});}""")
            page.wait_for_timeout(4300)
            assert page.locator('#card-AAOI [data-metric="priceToBook"] b').inner_text()=='6.66'
            assert page.evaluate("__app.cardCache.get('AAOI').d.quoteAt===__oldQuoteAt && __app.cardCache.get('AAOI').d.sourceCheckedAt===__oldSourceAt")
            changes=page.evaluate('__ageChanges');gaps=[changes[i]['at']-changes[i-1]['at'] for i in range(1,len(changes))]
            assert len(changes)>=3 and max(gaps)<1200,(changes,gaps)
            case['quoteClock']={'unchangedTimestamps':True,'updates':len(changes),'maximumGapMs':round(max(gaps),2)}
            geometries=[]
            for width in [320,375,768,1024,1440,1730]:
                page.set_viewport_size({'width':width,'height':1100});page.wait_for_timeout(160)
                g=page.evaluate("""()=>{const heights=[...document.querySelectorAll('.price-card')].map(el=>el.getBoundingClientRect().height);return {scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,cardHeightDifference:Math.max(...heights)-Math.min(...heights)};}""")
                assert g['scroll']<=g['client']+1,(width,g)
                if width>=1440:assert g['cardHeightDifference']<=2,(width,g)
                geometries.append({'viewport':width,**g})
            case['layouts']=geometries
            page.evaluate("""()=>{const banner=document.createElement('p');banner.textContent='基础信息布局验收 · 以下行情与财务均为离线测试样本，不是真实行情';banner.style.cssText='padding:10px;text-align:center';document.body.prepend(banner);}""")
            page.screenshot(path=str(OUT/'fundamentals-desktop.png'),full_page=True)
            page.locator('#card-AAOI .statistics-toggle').click();page.wait_for_timeout(200)
            assert page.evaluate("localStorage.getItem('qqqsp.basicMetrics.expanded')==='1'")
            page.screenshot(path=str(OUT/'fundamentals-expanded.png'),full_page=True)
            page.set_viewport_size({'width':375,'height':1000});page.wait_for_timeout(160)
            assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1')
            page.screenshot(path=str(OUT/'fundamentals-mobile.png'),full_page=True)
        assert not errors,errors
        case['javascriptErrors']=errors;report['cases'].append(case);page.close()
    browser.close()
report['passed']=True
(OUT/'fundamentals-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
