// Default mode checks the installed page/version without opening macro providers.
// --live reads real sources; no fixtures and no automatic retries around 429.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
const base=new URL(args.find(x=>/^https?:\/\//.test(x))||'http://127.0.0.1:8568');
const live=args.includes('--live');
const expected=readFileSync(new URL('../VERSION',import.meta.url),'utf8').trim();
async function request(route){const r=await fetch(new URL(route,base),{signal:AbortSignal.timeout(80000)});if(!r.ok)throw Error(`${route} HTTP ${r.status}`);return r;}
try{
 const ready=await (await request('/readyz')).json();assert.equal(ready.ready,true);assert.equal(String(ready.version),expected,'运行版本与本地交付包不一致');
 const html=await (await request('/')).text(),macro=html.indexOf('class="macrobox"'),panels=html.indexOf('id="panels"'),directory=html.indexOf('id="marketDirectory"');
 assert.ok(macro>0&&panels>macro&&directory>panels,'宏观/行情/市场目录位置不正确');
 assert.ok(html.includes('panel.bundle.js?v='+expected),'前端资源版本不一致');
 assert.ok(html.includes('id="macroFactors"')&&html.includes('id="macroCalendar"'),'缺少宏观观察区域');
 const report={version:expected,pageOrder:'宏观资讯 → 行情卡片 → 全球市场目录',mode:live?'真实来源读取':'页面与服务检查（没有主动读取宏观源）'};
 if(live){
  const newsPromise=request('/api/macro').then(r=>r.json());
  let context;
  for(let n=0;n<20;n++){
   context=await (await request('/api/macro/context')).json();
   assert.equal(context.schemaVersion,1);assert.equal(context.factors.length,5);
   if(!context.refreshing&&context.factors.every(f=>f.source||f.error))break;
   await new Promise(r=>setTimeout(r,2000));
  }
  const news=await newsPromise;assert.equal(news.analysisVersion,1);
  report.news={count:news.items.length,stale:news.stale,evidenceItems:news.items.filter(x=>x.assessment?.schemaVersion===1).length};
  report.factors=context.factors.map(({id,symbol,price,source,quoteAt,status,feedDelayMinutes,error})=>({id,symbol,price,source,quoteAt,status,feedDelayMinutes,error}));
  report.calendar={enabled:context.calendar?.enabled,status:context.calendar?.status,note:context.calendar?.note};
  report.comparison=context.comparison;
  report.note='首次打开需积累约15分钟的同窗数据；成功读取不是收益预测或全市场实时权限证明。';
  console.log(JSON.stringify(report,null,2));
  assert.ok(news.items.length>0,'未取得实际资讯，服务启动不代表资讯源可达');
  assert.ok(context.factors.every(f=>typeof f.price==='number'&&Number.isFinite(f.price)&&!f.error),'至少一个宏观来源不可用；详情见以上列表。请检查来源冷却与服务器网络，不要增加重试并发');
  console.log('五个来源均已返回价格；新鲜度与可比窗口请以列出的状态为准，休市不承诺形成新窗口。');
 }else{console.log(JSON.stringify(report,null,2));console.log('需要验证目标服务器真实数据时，追加 --live。');}
}catch(error){console.error('宏观验收失败：'+error.message);process.exitCode=1;}
