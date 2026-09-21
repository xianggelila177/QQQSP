// Isolated real application: deterministic, explicitly labelled provider fixtures.
import {createApplication} from '../../app.js';
import {quote,record} from './fundamentals-fixture.mjs';
const at=Date.parse('2026-09-18T14:00:00Z');
const app=createApplication({now:()=>at,env:{HOST:'127.0.0.1',PORT:0,LOG_FILE:'',PUBLIC_ORIGIN:'https://qqqsp.test',STATS_TOKEN:'browser-admin-'.repeat(4),LLM_API_KEY:'browser-read-'.repeat(4),REALTIME_SNAPSHOTS:'0',PUBLIC_SOURCE_REDUNDANCY:'0',HISTORY_BACKGROUND_ENABLED:'0',HISTORY_STATE_PATH:'',SAMPLES_BACKGROUND_ENABLED:'0',SAMPLES_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:''},
 providerOverrides:{fetchQuote:async symbol=>quote(symbol,{displayName:'离线浏览器验收样本 '+symbol,quoteAt:at,sourceCheckedAt:at,ts:at}),fetchFundamentals:async symbol=>record(symbol,at)},
 upstream:async()=>({status:200,body:'{"quotes":[],"news":[]}',headers:{}})});
app.start();app.httpServer.once('listening',()=>console.log(JSON.stringify({port:app.httpServer.address().port})));
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>app.stop().then(()=>process.exit()));
