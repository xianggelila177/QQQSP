import { volumeNumber } from '../quote-contract.js';
import { marketKeyFor, instrumentTypeFor } from '../instruments.js';
import { log as defaultLog } from '../../log.mjs';
import { cacheSet as boundedCacheSet } from '../cache.js';
export function createNasdaqProvider({now=()=>Date.now(),httpsGet,slowMap=new Map(),cacheSet=boundedCacheSet,slowTtl=300000,failureCooldown=60000,log=defaultLog}={}) {
  const inflight=new Map();
  let closed=false,generation=0;
  const ensure=owner=>{if(closed||generation!==owner)throw Object.assign(new Error('Nasdaq stopped'),{code:'STOPPED'});};
  async function request(url) {
    const r=await httpsGet(url,{Accept:'application/json',Referer:'https://www.nasdaq.com/'});
    if(r?.status!==200)throw new Error('Nasdaq HTTP '+(r?.status ?? 'unavailable'));
    const j=JSON.parse(r.body);if(!j||typeof j!=='object')throw new Error('Nasdaq invalid JSON');return j;
  }
  // Compatibility read helper still returns null; refresh preserves the failure class.
  async function ndqGet(url){try{return await request(url);}catch(error){log.debug('[ndq get fail]',{host:'api.nasdaq.com',err:String(error.message||error)});return null;}}
  const number=value=>{if(value==null||String(value).trim()==='')return null;const n=Number(String(value).replace(/[,$]/g,''));return Number.isFinite(n)?n:null;};
  function timestamp(value){const match=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value));if(!match)return null;const [,m,d,y]=match;const at=Date.UTC(+y,+m-1,+d),date=new Date(at);return date.getUTCFullYear()===+y&&date.getUTCMonth()===+m-1&&date.getUTCDate()===+d?at/1000:null;}
  function key(symbol){return String(symbol||'').toUpperCase()+':ndd';}
  async function refresh(symbol,prev) {
    const owner=generation;ensure(owner);
    const sUp=String(symbol||'').toUpperCase(),k=key(symbol),attemptAt=now();
    const unsupported=()=>{const entry={data:[],ts:attemptAt,lastSuccessAt:null,lastAttemptAt:attemptAt,status:'unsupported',retryAt:attemptAt+slowTtl};cacheSet(slowMap,k,entry);return [];};
    if(marketKeyFor(sUp)!=='us'||instrumentTypeFor(sUp)==='INDEX')return unsupported();
    let unsupportedCount=0,lastError;
    const candidates=[...new Set([prev?.ac,'stocks','etf'].filter(Boolean))];
    for(const ac of candidates){
      try{
        ensure(owner);
        const to=new Date(now()).toISOString().slice(0,10),from=new Date(now()-220*864e5).toISOString().slice(0,10);
        const j=await request('https://api.nasdaq.com/api/quote/'+encodeURIComponent(sUp)+'/historical?assetclass='+ac+'&fromdate='+from+'&todate='+to+'&limit=220');
        ensure(owner);
        const messages=j.status?.bCodeMessage;
        const explicitMissing=Array.isArray(messages)&&messages.some(m=>/symbol (?:not exist|does not exist|not found)|invalid symbol|unsupported symbol/i.test(String(m.errorMessage||'')));
        if(explicitMissing){unsupportedCount++;continue;}
        const rows=j.data?.tradesTable?.rows;
        if(!Array.isArray(rows))throw new Error('Nasdaq missing rows');
        // An empty table is a valid class miss, not proof that the symbol is unsupported.
        const bars=rows.map(x=>({t:timestamp(x.date),o:number(x.open),h:number(x.high),l:number(x.low),c:number(x.close),v:volumeNumber(typeof x.volume==='string'?x.volume.replaceAll(',',''):x.volume)})).filter(b=>b.t!=null&&b.o!=null&&b.h!=null&&b.l!=null&&b.c!=null).sort((a,b)=>a.t-b.t);
        if(!bars.length)continue;
        const successfulAt=now();cacheSet(slowMap,k,{data:bars,ac,ts:successfulAt,lastSuccessAt:successfulAt,lastAttemptAt:attemptAt,status:'ok'});return bars;
      }catch(error){ensure(owner);lastError=String(error.message||error);log.debug('[ndq get fail]',{symbol:sUp,ac,err:lastError});}
    }
    if(unsupportedCount===candidates.length&&!prev?.data?.length)return unsupported();
    const entry={...prev,data:prev?.data||[],ts:prev?.ts??null,lastSuccessAt:prev?.lastSuccessAt??prev?.ts??null,lastAttemptAt:attemptAt,status:'failed',error:lastError||'Nasdaq empty history',retryAt:now()+failureCooldown};
    cacheSet(slowMap,k,entry);return entry.data;
  }
  async function getNasdaqDaily(symbol){
    ensure(generation);
    const k=key(symbol),prev=slowMap.get(k);
    if(prev&&((prev.status!=='failed'&&prev.ts!=null&&now()-prev.ts<slowTtl)||now()<prev.retryAt))return prev.data;
    if(inflight.has(k))return inflight.get(k);
    const work=refresh(symbol,prev).finally(()=>{if(inflight.get(k)===work)inflight.delete(k);});inflight.set(k,work);return work;
  }
  function nasdaqDailyMetadata(symbol){const c=slowMap.get(key(symbol));return {source:'nasdaq',updatedAt:c?.lastSuccessAt??(c?.status==='unsupported'?null:c?.ts)??null,stale:!c||c.status==='failed'||c.ts==null||now()-c.ts>=slowTtl,status:c?.status||'missing',lastAttemptAt:c?.lastAttemptAt??null,retryAt:c?.retryAt??null};}
  return {nasdaqDailyMetadata,ndqGet,getNasdaqDaily,close:()=>{closed=true;generation++;inflight.clear();},reopen:()=>{closed=false;}};
}
