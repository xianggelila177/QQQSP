// Test-only entry: all prices and news below are artificial. Not installed in production.
import http from 'node:http';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';
import {assessMacro} from '../../lib/macro-analysis.js';import {dailyData,fixtureNow} from './history-v28-fixture.mjs';
let offset=0,mode='ready',historyCalls=0;const started=Date.now(),now=()=>fixtureNow+Date.now()-started+offset;
const quote=symbol=>({symbol,price:150,prevClose:149,change:1,changePct:.67,quoteAt:now(),sourceCheckedAt:now(),src:'fixture',market:'美股',marketState:'REGULAR',calendarCoverage:{known:true},currency:'USD',instrumentType:'EQUITY',fxMap:{USD:7,CNY:1},charts:{intraday:Array.from({length:30},(_,i)=>({t:Math.floor(now()/1000)-(29-i)*60,c:147+i*.1,v:null}))}});
const titles=['美国核心通胀高于预期，交易员加大美联储加息押注，加息概率升至90%。','Gold Rebounds as US Inflation Data Cools Record-High Real Rates','U.S. Stocks Rise, Treasury Yields Slip Despite Stubborn Inflation','Oil Soars Past $100 as Saudi Output Crashes to Lowest Since 1990','Gold Price Forecast: Bulls Defend 200-Day EMA After Hot CPI'];
const app=createApplication({now,telemetry:createTelemetry(),env:{PORT:0,LOG_FILE:'',RECOVERY_PATH:'',MACRO_STATE_PATH:'',HISTORY_STATE_PATH:'',PUBLIC_SOURCE_REDUNDANCY:'0',REALTIME_SNAPSHOTS:'0'},
 providerOverrides:{fetchQuote:async s=>quote(s),fetchChart:async s=>{historyCalls++;if(mode==='failed')throw Object.assign(Error('fixture offline'),{code:'FIXTURE_OFFLINE',retryAt:now()+60000});
 const data=dailyData(s),raw=data.indicators.quote[0];const close=raw.close.slice();close[close.length-1]+=offset>0?.2:0;return {...data,indicators:{quote:[{...raw,close}]}};},macroQuote:async symbol=>({symbol,price:100,quoteAt:now(),sourceCheckedAt:now(),src:'fixture',feedDelayMinutes:0})},upstream:async()=>({status:429,headers:{'retry-after':'120'},body:''})});
app.services.macro.getMacro=async()=>({analysisVersion:1,items:titles.map((title,i)=>{const item={title,topic:i===1||i===4?'黄金':'快讯',src:'测试样本',link:'https://example.invalid/'+i,t:now()-i*60000};return {...item,assessment:assessMacro(item,now())};}),updatedAt:now(),sources:{fixture:{stale:false}},stale:false});
app.start();await once(app.httpServer,'listening');
const control=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/advance'){offset+=61000;mode=u.searchParams.get('mode')||'ready';app.services.historyPrewarm.runDue();await app.services.historyPrewarm.settled();}res.setHeader('content-type','application/json');res.end(JSON.stringify({mode,offset,historyCalls,history:app.services.historyPrewarm.status()}));});
control.listen(0,'127.0.0.1');await once(control,'listening');
console.log(JSON.stringify({port:app.httpServer.address().port,controlPort:control.address().port,at:now()}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{control.close();app.stop().then(()=>process.exit(0));});
