// Read-only time diagnostics. A stale historical endpoint is NOT fixed by
// advancing its timestamps to match the latest quote. No upstream bypass here.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validSymbol} from '../lib/history-contract.js';
const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const clock=at=>Number.isFinite(at)&&at>0?formatter.format(new Date(at)):null;
export function describeChartTime(quote){
 const last=quote.charts?.intraday?.at(-1),meta=quote.slowFields?.intraday||{};
 const quoteAt=Number(quote.quoteAt),historyAt=Number(last?.t)*1000;
 const hasTimes=quoteAt>0&&Number.isFinite(quoteAt)&&historyAt>0&&Number.isFinite(historyAt);
 const nasdaq=meta.source==='nasdaq-intraday';
 const contractValid=!nasdaq||meta.timeContract==='nasdaq-label-et-v2';
 return {symbol:quote.symbol,source:meta.source||null,quoteAt:quoteAt>0?quoteAt:null,historyAt:historyAt>0?historyAt:null,
  cardBeijing:clock(quoteAt),historyBeijing:clock(historyAt),displayTimeZone:'Asia/Shanghai',timeContract:meta.timeContract||null,timeBasis:meta.timeBasis||null,
  gapSeconds:hasTimes?Math.round((quoteAt-historyAt)/1000):null,bars:quote.charts?.intraday?.length||0,
  contractValid,sourceLabelVerified:nasdaq?meta.timeBasis==='source-label':null,
  stale:!!meta.stale,error:quote.error||meta.error||null,
  note:!hasTimes?'报价或历史尚不可用':!contractValid?'旧 Nasdaq 分时时间契约，应更新服务并重新获取':
   meta.timeBasis==='epoch-unverified'?'来源未提供可核验时间标签；保留原始时间，不猜测加减小时':
   quoteAt-historyAt>600000?'历史更新落后于最新报价：请检查来源陈旧/限流，不把时差直接认定为时区错误':'卡片与分时均按北京时间显示；历史点与逐笔报价无需同秒'};
}
export async function checkChartTime(base,{symbols=['LITE','AAOI'],waitSeconds=30,fetchImpl=fetch}={}){
 const origin=new URL(base);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw new Error('无效服务地址');
 if(!symbols.length||symbols.length>12||symbols.some(s=>!validSymbol(s)))throw new Error('无效证券代码');
 if(!Number.isInteger(waitSeconds)||waitSeconds<0||waitSeconds>120)throw new Error('等待时间必须为0～120秒');
 const ready=await fetchImpl(new URL('/readyz',origin),{signal:AbortSignal.timeout(5000)});if(!ready.ok)throw new Error('服务未就绪');const health=await ready.json();
 const until=Date.now()+waitSeconds*1000;let quotes=[];
 do{
  const url=new URL('/api/market',origin);url.searchParams.set('symbols',symbols.join(','));
  const r=await fetchImpl(url,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('行情接口 HTTP '+r.status);
  quotes=await r.json();if(!Array.isArray(quotes))throw new Error('行情接口结构错误');
  if(symbols.every(s=>quotes.some(q=>q.symbol===s&&q.charts?.intraday?.length&&q.quoteAt>0)))break;
  if(Date.now()>=until)break;await new Promise(resolve=>setTimeout(resolve,1000));
 }while(Date.now()<until);
 const checks=symbols.map(s=>describeChartTime(quotes.find(q=>q.symbol===s)||{symbol:s,error:'未返回此证券'}));
 return {ok:checks.every(c=>c.cardBeijing&&c.historyBeijing&&c.contractValid&&c.sourceLabelVerified!==false),mode:'read-only service responses; this tool does not inject or rewrite data',version:health.version,checks};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const report=await checkChartTime(process.argv[2]||'http://127.0.0.1:8568',{symbols:process.argv[3]?.split(',')});console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;}
 catch(error){console.error(error.message);process.exitCode=1;}
}
