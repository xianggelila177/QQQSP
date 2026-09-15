import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const origin=process.argv[2]||'http://127.0.0.1:8568',output=process.argv[3],snapshots=[],frames=[],controller=new AbortController();
let consume=null;
try{
 for(let i=0;i<18;i++){
  const response=await fetch(origin+'/api/macro/snapshot',{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const data=await response.json();snapshots.push(data);
  console.log(JSON.stringify({round:i,at:data.serverNow,factors:data.context.factors.map(f=>({id:f.id,price:f.price,status:f.status,source:f.source,checked:f.sourceCheckedAt,quoteAt:f.quoteAt}))}));
  // First minute: HTTP only. The source checks must advance without an SSE
  // subscriber or an open macro panel. Then verify the production push path.
  if(i===6){const stream=await fetch(origin+'/api/macro/stream',{signal:controller.signal});assert.equal(stream.status,200);const reader=stream.body.getReader();let pending='';consume=(async()=>{try{while(true){const {value,done}=await reader.read();if(done)break;pending+=new TextDecoder().decode(value);let end;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const raw=/^data: (.+)$/m.exec(frame)?.[1];if(raw){const x=JSON.parse(raw);if(x.context?.factors)frames.push({revision:x.revision,at:x.serverNow,factors:x.context.factors});}}}}catch(e){if(!controller.signal.aborted)throw e;}})();}
  await new Promise(r=>setTimeout(r,10000));
 }
 const last=snapshots.at(-1);assert.equal(last.context.factors.length,5);assert.equal(last.monitor.running,true);
 const summary=last.context.factors.map(final=>{
  const rows=snapshots.map(s=>s.context.factors.find(f=>f.id===final.id)),checks=[...new Set(rows.map(q=>q.sourceCheckedAt).filter(Boolean))];
  assert.ok(final.price>0,final.id+' missing price');assert.ok(checks.length>=3,final.id+' source checks did not advance');assert.ok(!['stale','error','unavailable'].includes(final.status),final.id+' unhealthy');
  if(final.delayed){assert.equal(final.fresh,false);assert.equal(final.change,null);}
  const changes=rows.slice(1).filter((q,i)=>q.source===rows[i].source&&q.symbol===rows[i].symbol&&q.contractSymbol===rows[i].contractSymbol&&q.price!==rows[i].price).length;
  return {id:final.id,source:final.source,status:final.status,price:final.price,checks:checks.length,priceChanges:changes,feedDelayMinutes:final.feedDelayMinutes};
 });
 assert.ok(frames.length>=3,'SSE did not publish updates');
 const health=await (await fetch(origin+'/readyz')).json();assert.equal(health.version,'89');
 if(output)await fs.writeFile(output,JSON.stringify({passed:true,version:health.version,observedAt:new Date().toISOString(),summary,snapshots,frames},null,2)+'\n');
 console.log('LIVE_MACRO_PASS',JSON.stringify(summary));
}finally{controller.abort();if(consume)await consume;}
