import fs from 'node:fs';
import path from 'node:path';
import {safeError} from './http-admission.js';
import {assessCapacity} from './http-capacity.js';
import {quoteAgeLimitMs} from './quote-age.js';

import {UPSTREAM_ROLES} from './source-registry.js';
export {UPSTREAM_ROLES};

export function diskDiagnostics(env={}) {
  let target=env.DISK_PATH||env.LOG_FILE||process.cwd();
  while(!fs.existsSync(target) && path.dirname(target)!==target) target=path.dirname(target);
  try {
    return {path:target,...assessCapacity(fs.statfsSync(target))};
  } catch(error) {return {path:target,usedPct:null,warning:true,critical:true,error:safeError(error.code)};}
}

export function quoteStatus(q,at=Date.now()) {
  const raw=Number(q?.quoteAt??q?.ts),quoteAt=raw>0&&raw<1e12?raw*1000:raw;
  if(q?.pending) return {status:'pending',usable:false,quoteAt:null};
  if(!q || q.error || q.price==null || !Number.isFinite(Number(q.price))) return {status:'error',usable:false,quoteAt:null};
  const maxAge=quoteAgeLimitMs(q,at);
  const fetched=Number(q.fetchedAt||q.sourceCheckedAt)||0;
  const cadence=Math.max(Number(q.pollAfterMs)||0,Number(q.checkIntervalMs)||0);
  const overdue=fetched>0 && at-fetched>Math.max(30000,cadence+15000);
  const stale=q.stale||q.staleInfo||!Number.isFinite(quoteAt)||quoteAt<=0||quoteAt>at+60000||at-quoteAt>maxAge||overdue;
  return {status:stale?'stale':'ok',usable:!stale,quoteAt:Number.isFinite(quoteAt)?quoteAt:null,source:String(q.src||'primary').slice(0,32),ageMs:Number.isFinite(quoteAt)?Math.max(0,at-quoteAt):null};
}

export function createBusinessMonitor({symbols=['QQQ','SPY'],now=Date.now}={}) {
  const samples=new Map();
  const core=[...new Set(symbols)];
  function record(quotes) {
    const at=now();
    for(const q of quotes) if(q?.symbol) samples.set(q.symbol,{...quoteStatus(q,at),checkedAt:at});
    for(const [symbol,sample] of samples) if(at-sample.checkedAt>300000 && !core.includes(symbol)) samples.delete(symbol);
    while(samples.size>300) {const other=[...samples.keys()].find(s=>!core.includes(s));if(!other)break;samples.delete(other);}
  }
  function diagnostics() {
    const at=now();
    const effective=sample=>!sample?{status:'pending',usable:false}:at-sample.checkedAt>300000?{...sample,status:'stale',usable:false}:sample;
    const states=[...samples].map(([symbol,sample])=>({symbol,...effective(sample)}));
    const counts={ok:0,pending:0,stale:0,error:0};for(const state of states)counts[state.status]++;
    const coreQuotes=core.map(symbol=>({symbol,...effective(samples.get(symbol))}));
    return {ready:core.length>0&&coreQuotes.every(q=>q.usable),core:coreQuotes,active:states.length,counts,usableRatio:states.length?counts.ok/states.length:0,oldestQuoteAgeMs:Math.max(0,...states.map(s=>s.quoteAt?at-s.quoteAt:0))};
  }
  return Object.freeze({record,diagnostics});
}
