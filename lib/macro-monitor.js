import fs from 'node:fs/promises';
import {atomicWriteFile} from './atomic-file.js';
import {createHash} from 'node:crypto';
import {mergeMacroItems,assessMacro} from './macro-analysis.js';
import {filterRecentNews,combineNewsQuality} from './news-policy.js';
// One application-level monitor, independent of HTTP, tabs, visibility and SSE.
// A small atomic JSON checkpoint replaces a database for this single-user panel.
export function createMacroMonitor({macro,context,calendar,now=Date.now,enabled=true,statePath='',contextMs=30000,newsMs=60000,tickMs=1000,notify=null,log={warn(){}}}={}){
 let running=false,timer=null,startedAt=null,news={analysisVersion:1,items:[],sources:{},updatedAt:null,refreshing:true},revision=0,loadError=null,saveError=null,saveChain=Promise.resolve(),init=null,primed=false,restoredAt=null;
 const lanes={news:{nextAt:0,attemptAt:null,successAt:null,runs:0,task:null,error:null},context:{nextAt:0,attemptAt:null,successAt:null,runs:0,task:null,error:null},calendar:{nextAt:0,attemptAt:null,successAt:null,runs:0,task:null,error:null}};
 const listeners=new Set(),delivered=new Set(),outbox=new Map();let notificationTask=null,notificationNextAt=0,lastDelivery=null;
 const eventId=item=>createHash('sha256').update([item.linkScope==='feed'?'':item.link,item.title,Math.floor(item.t/864e5),JSON.stringify(item.assessment?.releases||[])].join('|')).digest('hex').slice(0,24);
 function status(){return {enabled,running,startedAt,restoredAt,revision,persistence:{enabled:!!statePath,loadError,saveError},lanes:Object.fromEntries(Object.entries(lanes).map(([k,v])=>[k,{...v,task:undefined,inflight:!!v.task}])),delivery:{mode:notify?'sse+webhook':'sse',pending:outbox.size,lastDelivery,subscribers:listeners.size,note:notify?'页面关闭仍向配置的通知地址发送重点事件':'页面关闭仍采集；重新打开立即取得快照。系统通知需配置外部通知地址。'}};}
 function snapshot(){const checked=filterRecentNews(news.items,now());return {schemaVersion:1,revision,serverNow:now(),news:{...news,items:checked.items.map(item=>({...item,assessment:assessMacro(item,now())})),quality:combineNewsQuality(checked.quality,news.quality),refreshing:!!lanes.news.task},context:{...context.snapshot(),calendar:calendar.snapshot()},monitor:status()};}
 function emit(){revision++;const data=snapshot();for(const fn of listeners)try{fn(data);}catch(e){log.warn('[macro subscriber]',{err:String(e.message)});}}
 // Individual factor completions are visible immediately, even if another source is slow.
 context.subscribe?.(()=>{if(running){const data=context.snapshot(),available=data.factors.some(f=>f.price!==null&&!['error','stale','unavailable'].includes(f.status));if(available){lanes.context.successAt=now();lanes.context.error=null;}else if(!data.refreshing)lanes.context.error='本轮未取得可用数据';emit();}});
 function checkpoint(){return {schemaVersion:1,savedAt:now(),revision,news,context:context.exportState(),calendar:calendar.exportState?.(),primed,delivered:[...delivered].slice(-500),outbox:[...outbox].slice(-20)};}
 function save(){if(!statePath||startedAt===null)return Promise.resolve();const payload=JSON.stringify(checkpoint());saveChain=saveChain.then(async()=>{try{await atomicWriteFile(statePath,payload);saveError=null;}catch(e){saveError='状态写入失败：'+e.code;log.warn('[macro state write]',{code:e.code});}});return saveChain;}
 async function restore(){if(!statePath)return;try{
  const stat=await fs.stat(statePath);if(stat.size>2*1024*1024)throw new Error('状态文件过大');const data=JSON.parse(await fs.readFile(statePath,'utf8'));
  if(data.schemaVersion!==1)throw new Error('状态版本无效');
  if(data.savedAt>now()+60000)throw new Error('状态时间在未来');
  if(data.news&&Array.isArray(data.news.items)){news={...data.news,items:filterRecentNews(data.news.items,now()).items.slice(0,100),stale:true,restored:true};news.items=news.items.map(x=>({...x,assessment:assessMacro(x,now())}));}
  context.restore(data.context);calendar.restore?.(data.calendar);revision=Number.isSafeInteger(data.revision)?data.revision:0;primed=!!data.primed;
  for(const id of (data.delivered||[]).slice(-500))if(typeof id==='string')delivered.add(id);
  for(const [id,x]of (data.outbox||[]).slice(-20))if(x?.item?.t>now()-2*3600e3)outbox.set(id,x);
  restoredAt=now();
 }catch(e){if(e.code!=='ENOENT'){loadError='未恢复宏观状态：'+String(e.message).slice(0,160);log.warn('[macro state read]',{code:e.code||'INVALID_STATE'});}}}
 function recordNews(data){
  const current=Array.isArray(data.items)?data.items:[];
  const merged=mergeMacroItems(filterRecentNews([...current,...news.items],now()).items).slice(0,100).map(x=>({...x,assessment:assessMacro(x,now())}));
  news={...data,items:merged,restored:false};
  for(const item of merged){const id=eventId(item);if(!primed){delivered.add(id);continue;}
   if(!notify||delivered.has(id)||outbox.has(id)||item.assessment.importance!=='focus'||!item.assessment.impacts.some(x=>['positive','negative','mixed'].includes(x.direction))||now()-item.t>2*3600e3)continue;
   outbox.set(id,{item,attempts:0,nextAt:now()});
  }
  if(current.length)primed=true;while(delivered.size>500)delivered.delete(delivered.keys().next().value);while(outbox.size>20)outbox.delete(outbox.keys().next().value);
 }
 function deliver(){if(!running||!notify||notificationTask||now()<notificationNextAt)return;
  const entry=[...outbox].find(([,x])=>x.nextAt<=now());if(!entry)return;const [id,row]=entry;
  notificationTask=(async()=>{try{
   if(now()-row.item.t>2*3600e3){outbox.delete(id);return;}
   await notify({id,title:row.item.title,link:row.item.link,publishedAt:row.item.t,assessment:row.item.assessment});
   delivered.add(id);outbox.delete(id);lastDelivery={at:now(),status:'sent',id};
  }catch(e){row.attempts++;row.nextAt=Math.max(now()+Math.min(900000,60000*2**Math.min(row.attempts-1,4)),Number(e.retryAt)||0);lastDelivery={at:now(),status:'error',id,error:String(e.message).slice(0,120)};if(row.attempts>=5){outbox.delete(id);delivered.add(id);lastDelivery.status='abandoned';while(delivered.size>500)delivered.delete(delivered.keys().next().value);}}
  finally{notificationNextAt=now()+30000;notificationTask=null;void save();emit();}})();
 }
 function launch(name,fn,interval){const lane=lanes[name];if(!running||lane.task||now()<lane.nextAt)return;
  lane.nextAt=now()+interval;lane.attemptAt=now();lane.runs++;
  lane.task=Promise.resolve().then(fn).then(value=>{if(!running)return;if(name==='context')value=context.snapshot();if(name==='news')recordNews(value);lane.completedAt=now();
   const available=name==='news'?!!value.items?.length:name==='context'?value.factors?.some(f=>f.price!==null&&!['error','stale','unavailable'].includes(f.status)):value.status==='ready';
   lane.error=name==='calendar'&&value.status==='disabled'?null:available?(value.error||null):(value.error||'本轮未取得可用数据');
   if(available&&!(name==='news'&&value.stale===true))lane.successAt=now();},e=>{lane.error=String(e.message).slice(0,200);lane.nextAt=Math.max(lane.nextAt,now()+60000,Number(e.retryAt)||0);}).finally(()=>{lane.task=null;if(running){emit();void save();deliver();}});
 }
 function runDue(){if(!running)return;context.requestContext?.();launch('context',()=>context.getContext({wait:false}),contextMs);launch('news',()=>macro.getMacro({waitForRefresh:true}),newsMs);launch('calendar',()=>calendar.getCalendar(),60000);deliver();}
 function schedule(){if(!running)return;timer=setTimeout(()=>{runDue();schedule();},tickMs);timer.unref?.();}
 function start(){if(running||!enabled)return init||Promise.resolve();running=true;startedAt=now();
  init=restore().then(()=>{if(!running)return;emit();runDue();schedule();});return init;}
 async function stop(){running=false;clearTimeout(timer);timer=null;await init;await Promise.allSettled([...Object.values(lanes).map(l=>l.task),notificationTask].filter(Boolean));await context.settled?.();await save();await saveChain;}
 return {start,stop,runDue,snapshot,status,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  async settled(){await init;await Promise.allSettled(Object.values(lanes).map(l=>l.task).filter(Boolean));await context.settled?.();},
  clear(){news={analysisVersion:1,items:[],sources:{},updatedAt:null};primed=false;delivered.clear();outbox.clear();for(const lane of Object.values(lanes))lane.nextAt=0;},persist:save};
}
