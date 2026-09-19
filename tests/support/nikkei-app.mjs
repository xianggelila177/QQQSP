import {once} from 'node:events';
import {createApplication} from '../../app.js';
import {createTelemetry} from '../../log.mjs';
import {nikkeiNow,nikkeiSnapshot,nikkeiUpstream} from '../v2/nikkei-fixture.mjs';

// Full application and native HTTP/SSE; only external responses are fixtures.
export async function createNikkeiApp({now=nikkeiNow,background=false,directory='',providerOverrides={}}={}) {
  const state={now,snapshot:nikkeiSnapshot(),requests:[]};
  const app=createApplication({now:()=>state.now,env:{PORT:0,LOG_FILE:'',REALTIME_SNAPSHOTS:'1',PUBLIC_SOURCE_REDUNDANCY:'0',RECOVERY_PATH:'',
    HISTORY_BACKGROUND_ENABLED:background?'1':'0',HISTORY_STATE_PATH:'',MACRO_BACKGROUND_ENABLED:'0',MACRO_STATE_PATH:'',
    SAMPLES_BACKGROUND_ENABLED:background?'1':'0',SAMPLES_STATE_PATH:directory},telemetry:createTelemetry(),providerOverrides,
    upstream:async raw=>{
      state.requests.push(raw);const url=new URL(raw);
      if(state.naverUnavailable&&url.hostname==='polling.finance.naver.com')return {status:503,headers:{'retry-after':'120'},body:'{}'};
      if(url.hostname.endsWith('naver.com'))return nikkeiUpstream(raw,{snapshot:state.snapshot});
      if(url.hostname.endsWith('yahoo.com'))return {status:429,headers:{'retry-after':'120'},body:'{}'};
      if(url.hostname==='news.google.com')return {status:200,body:'<rss><channel/></rss>'};
      if(url.hostname==='zhibo.sina.com.cn')return {status:200,body:'{}'};
      throw Error('Unexpected fixture upstream '+url.hostname);
    }});
  app.start();await once(app.httpServer,'listening');
  return {app,state,url:'http://127.0.0.1:'+app.httpServer.address().port,quoteCalls:()=>state.requests.filter(u=>u.includes('/realtime/worldstock/index/')).length,close:()=>app.stop()};
}
