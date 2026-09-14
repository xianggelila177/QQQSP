import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const origin=process.argv[2]||'http://127.0.0.1:8568',output=process.argv[3];
const symbols=['QQQ','AAOI','MRVL','NVDA','LITE','000660.KS','AMD','XLK','161128.SZ','SPY','INTC'];
const snapshots=[],frames=[],controller=new AbortController();
const stream=await fetch(origin+'/api/stream?symbols='+symbols.join(',')+'&history=off',{signal:controller.signal});assert.equal(stream.status,200);
const reader=stream.body.getReader();let buffered='';
const consume=(async()=>{try{while(true){const {done,value}=await reader.read();if(done)break;buffered+=new TextDecoder().decode(value);let boundary;while((boundary=buffered.indexOf('\n\n'))>=0){const frame=buffered.slice(0,boundary);buffered=buffered.slice(boundary+2);const data=/^data: (.+)$/m.exec(frame)?.[1];if(!data)continue;const parsed=JSON.parse(data);if(parsed.quotes)for(const q of parsed.quotes)frames.push({at:Date.now(),symbol:q.symbol,coverage:q.fundamentals?.coverage,financialFetchedAt:q.fundamentals?.fetchedAt,quoteAt:q.quoteAt});}}}catch(error){if(!controller.signal.aborted)throw error;}})();
try{
  for(let i=0;i<18;i++){
    await new Promise(r=>setTimeout(r,10000));
    const response=await fetch(origin+'/api/market?symbols='+symbols.join(',')+'&history=off',{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);
    const rows=await response.json();snapshots.push({at:Date.now(),rows});
    console.log(JSON.stringify({round:i+1,coverage:rows.map(q=>[q.symbol,q.fundamentals?.coverage?.available,q.fundamentals?.coverage?.missing])}));
  }
  const final=snapshots.at(-1).rows;assert.equal(final.length,11);
  for(const q of final){assert.equal(q.fundamentals.coverage.total,24);assert.ok(q.price>0);for(const k of ['turnoverAmount','turnoverRate'])assert.ok(q.fundamentals.fields[k].value>=0,q.symbol+':'+k);assert.ok(q.week52High>0&&q.week52Low>0,q.symbol+':52week');assert.ok(frames.some(f=>f.symbol===q.symbol&&f.coverage),q.symbol+':SSE');}
  const sources=await (await fetch(origin+'/api/sources')).json();assert.ok(sources.fundamentals.queue.maxActive<=2);
  const health=await (await fetch(origin+'/readyz')).json();assert.equal(health.version,'88');
  const result={passed:true,origin,version:health.version,observedAt:new Date().toISOString(),snapshots,frames,sources};if(output)await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');console.log('LIVE_FUNDAMENTALS_PASS');
}finally{controller.abort();await consume;}
