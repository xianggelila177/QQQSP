import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const window={fetch:()=>{},PANEL_TIMEFRAMES:{get:tf=>({kind:'history',apiPeriod:tf,visible:20,prewarm:19})}};
for(const module of ['panel-scheduler','panel-network','panel-history-store'])vm.runInNewContext(fs.readFileSync(new URL('../public/modules/'+module+'.js',import.meta.url),'utf8'),{window,URLSearchParams,AbortController,Date,Number,Map,Object,Promise,Error,setTimeout,clearTimeout});
const bar={t:-31536000,periodStart:'1969-01-01',o:10,h:12,l:9,c:11,v:null};
const payload=(bars=[bar],extra={})=>({schemaVersion:1,symbol:'QQQ',period:'yearly',seriesId:'one',revision:'r1',bars,status:'ready',...extra});
let answer=payload(),calls=[];
const store=window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'QQQ',fetchImpl:async url=>{calls.push(url);return {ok:true,status:200,json:async()=>answer};}});
await store.load('yearly');assert.equal(store.getSeries('yearly')[0].v,null);assert.equal(store.getSeries('yearly')[0].t,-31536000);
for(const bad of [{o:null},{t:NaN},{h:5},{l:15},{periodStart:'1969-02-30'},{c:'11'},{v:-1}]){
 answer=payload([{...bar,...bad}]);await store.load('yearly');assert.equal(store.getMeta('yearly').status,'stale');assert.equal(store.getSeries('yearly')[0].o,10);
}
answer=payload([bar,bar]);await store.load('yearly');assert.equal(store.getMeta('yearly').status,'stale');
answer=payload([{...bar,c:12}],{revision:'r2'});await store.load('yearly');assert.equal(store.getRevision('yearly'),'r2');assert.equal(store.getSeries('yearly')[0].c,12);
let n=0,urls=[];
const identities=window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'QQQ',fetchImpl:async url=>{urls.push(url);n++;return {ok:n!==2,status:n===2?409:200,json:async()=>n===2?{error:'changed'}:payload([bar],{seriesId:n===1?'one':'two'})};}});
await identities.load('yearly');await identities.load('yearly');assert.equal(n,3);assert.ok(urls[1].includes('seriesId=one'));assert.ok(!urls[2].includes('seriesId'));assert.equal(identities.getMeta('yearly').meta.seriesId,'two');
let pending=[];
const race=window.PANEL_HISTORY_STORE.createHistoryStore({symbol:'QQQ',fetchImpl:(url,options)=>new Promise(resolve=>pending.push({resolve,options}))});
const a=race.load('yearly'),b=race.load('yearly');
pending[1].resolve({ok:true,json:async()=>payload([bar],{revision:'new'})});await b;
pending[0].resolve({ok:true,json:async()=>payload([bar],{revision:'old'})});await a;assert.equal(race.getRevision('yearly'),'new');
const late=race.load('yearly');race.abort();pending[2].resolve({ok:true,json:async()=>payload([bar],{revision:'removed'})});await late;assert.equal(race.getRevision('yearly'),'new');
const dates=['1969-01-01','1970-01-01','1971-01-01'];
answer=payload(dates.map(periodStart=>({...bar,periodStart,t:Date.parse(periodStart)/1000})));await store.load('yearly');
answer=payload([answer.bars[0],answer.bars[2]],{revision:'removed-date'});await store.load('yearly');assert.equal(store.getSeries('yearly').length,2,'Source removed date must not survive a refreshed range');
console.log('History store strict nullable volume, pre-epoch dates, corruption, revision, identity retry and late cancellation passed');
