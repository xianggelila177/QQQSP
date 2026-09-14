// Checks prepared history without replacing the user's retained watchlist.
// --ready waits for four usable periods for every retained symbol. No forced refresh.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const base=new URL(process.argv[2]||'http://127.0.0.1:8568');
const readyRequired=process.argv.includes('--ready');
const seconds=Number(process.argv.find(x=>x.startsWith('--wait='))?.split('=')[1]||120);
if(!Number.isFinite(seconds)||seconds<1||seconds>900)throw Error('--wait 必须为1～900秒');
const expected=fs.readFileSync(fileURLToPath(new URL('../VERSION',import.meta.url)),'utf8').trim();
async function get(route){
 const r=await fetch(new URL(route,base),{signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw Error(route+' HTTP '+r.status);
 return r.json();
}
const report={expectedAssetVersion:expected,readOnly:true,liveSourceGuarantee:false};
try{
 const service=await get('/readyz');if(String(service.version)!==expected)throw Error('服务资源版本不一致');
 let status=await get('/api/history/status');if(!status.enabled||!status.running)throw Error('历史后台预备未启用或未运行');
 if(readyRequired&&!status.watchlist.length)throw Error('尚未登记自选：先正常打开面板一次，不必点击K线');
 const deadline=Date.now()+seconds*1000;
 while(readyRequired&&status.ready<status.watchlist.length&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));status=await get('/api/history/status');}
 report.status=status;
 const bundle=await get('/api/history/bundle?readOnly=1&symbols='+encodeURIComponent(status.watchlist.join(',')));
 report.symbols=[];
 for(const entry of bundle.entries){
  const counts=Object.fromEntries(Object.entries(entry.periods||{}).map(([period,value])=>[period,{bars:value.bars?.length||0,source:value.source,sourceCheckedAt:value.sourceCheckedAt,status:value.status}]));
  report.symbols.push({symbol:entry.symbol,status:entry.status,periods:counts,retryAt:entry.retryAt,error:entry.error});
  if(readyRequired&&['daily','weekly','monthly','yearly'].some(p=>!counts[p]?.bars))throw Error(entry.symbol+'尚未准备四档历史；检查来源错误与冷却，勿反复强刷');
 }
 report.passed=true;
}catch(e){report.passed=false;report.error=e.message;process.exitCode=1;}
console.log(JSON.stringify(report,null,2));
