import test from 'node:test';import assert from 'node:assert/strict';
import {createChartEnricher} from '../../lib/chart-enricher.js';
const now=Date.parse('2026-09-14T08:00:00Z');
test('explicit provider 52-week metadata survives chart enrichment without calculating from chart bars',async()=>{
 const fetchChart=async symbol=>({meta:{symbol,currency:'USD',fiftyTwoWeekHigh:999,fiftyTwoWeekLow:20},timestamp:[now/1000-60],indicators:{quote:[{close:[100],volume:[1]}]}});
 const enrich=createChartEnricher({fetchChart,now:()=>now,includeDaily:false});
 const q=await enrich('AAOI',{symbol:'AAOI',price:100,currency:'USD'});assert.equal(q.week52High,999);assert.equal(q.week52Low,20);assert.equal(q.slowFields.week52Range.source,'yahoo');
 const other=await enrich('LITE',{symbol:'LITE',price:100,currency:'KRW'});assert.equal(other.week52High,undefined);
});
