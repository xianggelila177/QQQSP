// Production smoke: read cached diagnostics only. Does not force/override source
// intervals. Background collection is independently owned by the running server.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
const base=new URL(args.find(x=>/^https?:\/\//.test(x))||'http://127.0.0.1:8568');
const expected=readFileSync(new URL('../VERSION',import.meta.url),'utf8').trim();
const diagnose=args.includes('--diagnose'),live=args.includes('--live'),background=args.includes('--background'),stream=args.includes('--stream');
const durationArg=args.find(x=>x.startsWith('--seconds='));
const seconds=durationArg?Number(durationArg.split('=')[1]):65;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(route){
 const response=await fetch(new URL(route,base),{signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error(`${route} HTTP ${response.status}`);
 return response;
}
async function json(route){return (await request(route)).json();}
async function checkStream(){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);let reader;
 try{
  const response=await fetch(new URL('/api/macro/stream',base),{signal:controller.signal});
  assert.ok(response.ok);assert.match(response.headers.get('content-type')||'',/text\/event-stream/);
  reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  while(buffer.length<2*1024*1024){
   const part=await reader.read();if(part.done)throw Error('宏观事件流提前结束');
   buffer+=decoder.decode(part.value,{stream:true});
   for(const frame of buffer.split('\n\n').slice(0,-1)){
    if(!frame.includes('event: macro'))continue;
    const payload=JSON.parse(frame.split('\n').filter(x=>x.startsWith('data: ')).map(x=>x.slice(6)).join('\n'));
    assert.ok(payload.monitor?.running);assert.equal(payload.context?.factors?.length,5);
    return {received:true,revision:payload.revision,note:'已收到服务器缓存快照；不是五个上游均可达的证明'};
   }
  }
  throw Error('事件流消息超出验收上限');
 }finally{clearTimeout(timer);controller.abort();await reader?.cancel().catch(()=>{});}
}
try{
 if(!Number.isFinite(seconds)||seconds<1||seconds>900)throw Error('--seconds 必须为1至900秒');
 const ready=await json('/readyz');assert.equal(ready.ready,true);assert.equal(String(ready.version),expected,'运行版本与交付包不一致');
 const html=await (await request('/')).text(),macro=html.indexOf('class="macrobox"'),panels=html.indexOf('id="panels"'),directory=html.indexOf('id="marketDirectory"');
 assert.ok(macro>0&&panels>macro&&directory>panels,'页面布局位置不正确');
 assert.ok(html.includes('panel.bundle.js?v='+expected),'静态资源版本不正确');
 assert.ok(html.includes('id="macroMonitorStatus"'),'缺少后台监控状态');
 const monitor=await json('/api/macro/status');
 assert.equal(monitor.enabled,true,'后台监控被配置关闭；请设 MACRO_BACKGROUND_ENABLED=1');
 assert.equal(monitor.running,true,'后台监控没有运行');
 const report={version:expected,mode:'检查服务与监控缓存；不额外触发采集',monitor};
 if(stream)report.stream=await checkStream();
 if(background){
  // No browser and no event stream are connected during this interval.
  const before=await json('/api/macro/status');await sleep(seconds*1000);const after=await json('/api/macro/status');
  report.background={seconds,before:Object.fromEntries(Object.entries(before.lanes).map(([k,v])=>[k,v.runs])),after:Object.fromEntries(Object.entries(after.lanes).map(([k,v])=>[k,v.runs])),note:'轮次递增证明后台调度；source success/error 需另查，不等同价格产生新成交'};
  assert.ok(['context','news'].every(k=>after.lanes[k].runs>before.lanes[k].runs),'观察时间内采集轮次未递增；核对监控状态/配置间隔，再用较长 --seconds 检查，不要提高上游并发');
 }
 if(live||diagnose){
  let payload;const until=Date.now()+80000;
  do{
   payload=await json('/api/macro/snapshot');
   if(Object.values(payload.monitor.lanes).every(l=>!l.inflight))break;
   await sleep(2000);
  }while(Date.now()<until);
  assert.equal(payload.context.schemaVersion,2);assert.equal(payload.context.factors.length,5);
  report.news={count:payload.news.items.length,stale:payload.news.stale,error:payload.news.error||null,updatedAt:payload.news.updatedAt};
  report.factors=payload.context.factors.map(({id,symbol,price,unit,source,quoteAt,sourceCheckedAt,status,error,comparisonBasis,daily,diagnostics})=>({id,symbol,price,unit,source,quoteAt,sourceCheckedAt,status,error,comparisonBasis,daily,diagnostics}));
  report.quality={prices:report.factors.filter(f=>f.price!==null).length,total:report.factors.length,sourceTime:report.factors.filter(f=>f.comparisonBasis==='source').length,serverObservation:report.factors.filter(f=>f.comparisonBasis==='observation').length,dailyReference:report.factors.filter(f=>f.daily&&f.status==='daily').length,unavailableOrStale:report.factors.filter(f=>['error','stale','unavailable'].includes(f.status)).length};
  report.quality.note='日度参考不等于实时期货/美元指数；服务器观察不等于成交时间。';
  report.observations=payload.context.observations;
  report.calendar={enabled:payload.context.calendar?.enabled,status:payload.context.calendar?.status,note:payload.context.calendar?.note};
  console.log(JSON.stringify(report,null,2));
  if(live)assert.ok(report.news.count>0,'尚无资讯；检查服务器网络、订阅源状态与冷却');
  if(live)assert.ok(report.factors.every(f=>typeof f.price==='number'&&Number.isFinite(f.price)&&!f.error&&!['error','stale','unavailable'].includes(f.status)),'部分来源缺失或陈旧，详见因子列表；请等来源冷却或检查网络，不要持续强制刷新');
 }else console.log(JSON.stringify(report,null,2));
 console.log(diagnose?'诊断读取完成；请检查quality和每条diagnostics，不代表数据源验收通过。':'宏观验收通过。--live 检查实际可用数据（可含明确标注的日度参考）；--background 检查后台轮次；--stream 检查事件流；--diagnose 仅输出来源诊断。');
}catch(error){console.error('宏观验收失败：'+error.message);process.exitCode=1;}
