import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
import {createChartEnricher} from '../../lib/chart-enricher.js';
const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-chart-engine.js',import.meta.url),'utf8'),sandbox);
const observation=sandbox.window.PANEL_CHART_ENGINE.createObservationSeries;
const base=Date.parse('2026-09-10T14:00:00Z');
const quote=(overrides={})=>({symbol:'SKHY',currency:'USD',src:'fixture',marketState:'REGULAR',priceSession:'REGULAR',gmtoff:-14400,quoteAt:base,price:190,charts:{intraday:[]},...overrides});
test('missing history renders one true point, then real observations without fabricating OHLC or volume',()=>{
 let now=base;const select=observation({now:()=>now});let view=select(quote());assert.equal(view.bars.length,1);assert.equal(view.sampled,true);assert.equal(view.bars[0].v,null);assert.equal(view.bars[0].o,undefined);
 now+=1000;view=select(quote({quoteAt:now,price:191}));assert.equal(view.bars.length,1);assert.equal(view.bars[0].t,now/1000);assert.equal(view.bars[0].c,191);
 now+=60000;view=select(quote({quoteAt:now,price:192}));assert.equal(view.bars.length,2);assert.match(view.note,/非完整历史/);
 const snapshot=view.bars;view=select(quote({quoteAt:now-1000,price:100}));assert.strictEqual(view.bars,snapshot);assert.equal(view.bars.at(-1).c,192);
});
test('yesterday is never joined to current premarket; source and currency changes reset samples',()=>{
 const select=observation({now:()=>base});const history=[{t:base/1000-86400,c:180,v:200}];
 let view=select(quote({charts:{intraday:history},marketState:'PRE',priceSession:'PRE'}));assert.equal(view.bars.length,1);assert.equal(view.bars[0].c,190);assert.equal(history.length,1);
 view=select(quote({symbol:'000660.KS',currency:'KRW',gmtoff:32400,src:'naver-kr',price:200000}));assert.equal(view.bars.length,1);assert.equal(view.bars[0].c,200000);
});
test('real current historical series remains authoritative; invalid quotes create no made-up point',()=>{
 const select=observation({now:()=>base});const history=[{t:base/1000-60,c:180,v:200}];const v=select(quote({charts:{intraday:history}}));assert.strictEqual(v.bars,history);assert.equal(v.sampled,false);
 const no=observation({now:()=>base})(quote({price:null,quoteAt:null}));assert.equal(no.bars.length,0);assert.equal(no.sampled,false);
});
test('history enrichment is cached separately; failed refresh retains real bars and successful time',async()=>{
 let now=base,calls=0,fail=false;const enrich=createChartEnricher({now:()=>now,fallback:()=>{throw new Error('must not fetch price again');},fetchChart:async(symbol)=>{calls++;if(fail)throw new Error('429');return {source:'fixture',meta:{symbol,currency:'USD'},timestamp:[base/1000-60],indicators:{quote:[{close:[100],open:[99],high:[101],low:[98],volume:[20]}]}};}});
 const q=quote();const first=await enrich('SKHY',q);assert.equal(calls,2);await enrich('SKHY',q);assert.equal(calls,2);
 now+=60000;fail=true;const retained=await enrich('SKHY',q);assert.equal(calls,3);assert.strictEqual(retained.charts.intraday,first.charts.intraday);assert.equal(retained.slowFields.intraday.updatedAt,base);assert.equal(retained.slowFields.intraday.stale,true);assert.equal(retained.price,q.price);
});
test('a US ADR cannot receive Korean-won history by name similarity',async()=>{
 const enrich=createChartEnricher({now:()=>base,fetchChart:async symbol=>({source:'fixture',meta:{symbol,currency:'KRW'},timestamp:[base/1000-60],indicators:{quote:[{close:[200000],open:[199000],high:[201000],low:[198000]}]}})});
 const q=await enrich('SKHY',quote());assert.equal(q.charts.intraday.length,0);assert.match(q.slowFields.intraday.error,/币种/);
});
