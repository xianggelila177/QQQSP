// Default: local search/route checks only. --live also exercises public quotes
// and all historical periods; it never hides source failures or inserts fixtures.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const expectedVersion=readFileSync(new URL('../VERSION',import.meta.url),'utf8').trim();
const args=process.argv.slice(2),base=new URL(args.find(x=>/^https?:/.test(x))||'http://127.0.0.1:8568');
const live=args.includes('--live'),selected=args.find(x=>/=F$|\.FUT$/.test(x))||'NQ00Y.FUT';
async function read(route){const r=await fetch(new URL(route,base),{signal:AbortSignal.timeout(35000)});const j=await r.json();if(!r.ok)throw Error(route+' HTTP '+r.status+' '+(j.code||j.error||''));return j;}
try{
 const ready=await read('/readyz');assert.equal(ready.ready,true);assert.equal(String(ready.version),expectedVersion,'服务器资源版本与本地交付包不一致');
 for(const q of ['NQ0W','NQW00:CME_EMINIS','纳指夜盘','NQ=F']){
  const results=await read('/api/search?q='+encodeURIComponent(q));assert.ok(results.some(x=>x.type==='FUTURE'),q+' 未返回期货');
  if(q==='NQ0W')assert.ok(results.some(x=>x.symbol==='NQ00Y.FUT'&&x.matchType==='related'));
  console.log('搜索通过：'+q+' → '+results.map(x=>x.symbol).join('，'));
 }
 const directory=await read('/api/markets');assert.ok(directory.markets.find(x=>x.key==='futures'));console.log('国际期货目录通过');
 if(live){
  let quote;
  for(let i=0;i<15;i++){quote=(await read('/api/market?symbols='+encodeURIComponent(selected)))[0];if(quote?.price>0||quote?.error&&!quote?.pending)break;await new Promise(r=>setTimeout(r,2000));}
  assert.ok(quote?.price>0,'期货报价不可用：'+JSON.stringify(quote));assert.equal(quote.instrumentType,'FUTURE');assert.equal(quote.symbol,selected);
  console.log('真实报价来源：'+quote.src+'；成交时间：'+(quote.quoteAt||'来源未提供')+'；检查时间：'+quote.sourceCheckedAt);
  if(quote.stale)throw Error('仅取得旧缓存，不计作实时来源验收通过');
  for(const period of ['daily','weekly','monthly','yearly']){
   const history=await read('/api/history?symbol='+encodeURIComponent(selected)+'&period='+period+'&count=5');
   assert.equal(history.status,'ready');assert.ok(history.bars.length>0);assert.ok(history.bars.every(b=>[b.o,b.h,b.l,b.c].every(Number.isFinite)));
   console.log(period+' 通过：'+history.bars.length+' 根，来源 '+history.source);
  }
 }else console.log('未请求真实报价/历史；在目标服务器追加 --live 验证来源连通性。');
 console.log('期货验收通过'+(live?'（来源延迟仍按实际权限与响应判断）':'（仅搜索与服务）'));
}catch(error){console.error('期货验收失败：'+error.message);process.exitCode=1;}
