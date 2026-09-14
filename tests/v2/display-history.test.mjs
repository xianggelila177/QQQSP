import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
import {createChartEnricher} from '../../lib/chart-enricher.js';
const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/panel-chart-engine.js',import.meta.url),'utf8'),sandbox);
const observation=sandbox.window.PANEL_CHART_ENGINE.createObservationSeries;
const base=Date.parse('2026-09-10T14:00:00Z');
const quote=(overrides={})=>({symbol:'SKHY',currency:'USD',src:'fixture',marketState:'REGULAR',priceSession:'REGULAR',gmtoff:-14400,quoteAt:base,price:190,charts:{intraday:[]},...overrides});
test('empty history remains selected and browser quotes never accumulate samples',()=>{
 const select=observation({now:()=>base});
 for(let i=0;i<4;i++){const view=select(quote({quoteAt:base+i*60000,price:190+i}));assert.equal(view.bars.length,0);assert.equal(view.sampled,false);}
 assert.equal(select(quote(),'samples').bars.length,0);
});
test('previous-day history remains selected with an explicit date; samples require a server payload',()=>{
 const select=observation({now:()=>base}),history=[{t:base/1000-86400,c:180,v:200}];
 const view=select(quote({charts:{intraday:history},marketState:'PRE',priceSession:'PRE'}));assert.strictEqual(view.bars,history);assert.equal(view.sampled,false);assert.match(view.note,/历史分时日期/);
 const server=[{t:base/1000,c:190,v:null,_sample:true,currency:'USD',source:'fixture',tradingDate:'2026-09-10'}];
 assert.strictEqual(select(quote(),'samples',{points:server}).bars,server);
 assert.equal(select(quote({currency:'KRW'}),'samples',{points:server}).bars.length,0);
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
