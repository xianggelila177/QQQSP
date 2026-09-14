// 服务和 SSE 检查；不打印凭据，不要求当时有新成交。
const base=new URL(process.argv[2]||'http://127.0.0.1:8568');
async function read(route){const response=await fetch(new URL(route,base),{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error(route+' HTTP '+response.status);return response.json();}
const ready=await read('/readyz');console.log('服务就绪：',ready.ready,'有效报价就绪：',ready.dataReady??'见业务字段');
const markets=await read('/api/markets');console.log('市场目录：',Array.isArray(markets)?markets.length:'已读取');
const health=await read('/api/sources');console.log('来源状态：',JSON.stringify(health));
const abort=new AbortController();
const timeout=setTimeout(()=>abort.abort(),10000);
try{const response=await fetch(new URL('/api/stream?symbols=QQQ,SPY&history=off',base),{signal:abort.signal});
 if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('SSE 响应无效');
 const reader=response.body.getReader();let text='';const decoder=new TextDecoder();
 while(!text.includes('event: quotes')){const part=await reader.read();if(part.done)throw new Error('尚未收到行情事件，连接已关闭');text+=decoder.decode(part.value,{stream:true});}
 console.log('SSE 首个快照：已收到（PENDING 也是合法冷启动状态）');await reader.cancel();
}finally{clearTimeout(timeout);abort.abort();}
