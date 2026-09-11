import {publishQuote} from './quote-contract.js';
export function createChartEnricher({fetchChart,fallback,tx,now=Date.now,includeDaily=true}={}){
 const cache=new Map(),jobs=new Map();
 async function family(symbol,kind){
  const key=symbol+':'+kind,old=cache.get(key);if(old&&old.until>now())return old.value;
  if(jobs.has(key))return jobs.get(key);
  const job=(async()=>{
   let value;
   try{
    let chart;
    if(/^\d{6}\.(SS|SZ)$/.test(symbol)){
     const bars=kind==='intraday'?await tx.txMinuteBarsCn(symbol):await tx.txDailyBarsCn(symbol,320);
     value={bars,source:'tencent'};
    }else{
     chart=await fetchChart(symbol,kind==='intraday'?'?interval=5m&range=1d&includePrePost=true':'?interval=1d&range=2y&includePrePost=false');
     if(chart.meta?.symbol&&chart.meta.symbol.toUpperCase()!==symbol)throw new Error('Chart identity mismatch');
     const q=chart.indicators?.quote?.[0]||{},bars=(chart.timestamp||[]).map((t,i)=>({t,c:q.close?.[i],v:q.volume?.[i]??null,...(kind==='intraday'?{}:{o:q.open?.[i],h:q.high?.[i],l:q.low?.[i]})})).filter(b=>Number.isFinite(b.t)&&b.t*1000<=now()&&b.c>0&&(kind==='intraday'||[b.o,b.h,b.l].every(Number.isFinite)));
     value={bars,source:chart.source||'yahoo',currency:chart.meta?.currency};
    }
    if(!value.bars.length)throw new Error('Chart empty');
    value={...value,bars:Object.freeze(value.bars.map(Object.freeze)),updatedAt:now(),stale:false};
   }catch(error){value={...(old?.value||{bars:[],source:'unavailable',updatedAt:null}),stale:true,status:old?.value?.bars?.length?'degraded':'missing',retryable:true,error:'历史来源暂不可用',retryAt:error.retryAt||null};}
   cache.set(key,{value,until:Math.max(now()+(value.stale||kind==='intraday'?60000:300000),value.retryAt||0)});
   while(cache.size>48)cache.delete(cache.keys().next().value);
   return value;
  })().finally(()=>jobs.delete(key));jobs.set(key,job);return job;
 }
 return async function enrich(symbol,base){
  if(!base||base.price==null)return fallback(symbol);
  const [i,d]=await Promise.all([family(symbol,'intraday'),includeDaily?family(symbol,'daily30'):Promise.resolve({bars:base.charts?.daily30||[],source:'on-demand',updatedAt:null,stale:false,status:'not-requested'})]);
  const safe=x=>x.currency&&x.currency!==base.currency?{...x,bars:[],stale:true,status:'missing',error:'图表币种不匹配',retryable:true}:x;
  const intra=safe(i),daily=safe(d),meta=({bars,currency,...m})=>m;
  return publishQuote({...base,charts:{intraday:intra.bars,daily30:daily.bars.slice(-126)},slowFields:{intraday:meta(intra),daily30:meta(daily),charts:{source:intra.source+'/'+daily.source,updatedAt:now(),stale:intra.stale||daily.stale}},daily30Version:daily.bars.at(-1)?.t||0});
 };
}
