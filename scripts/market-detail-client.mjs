import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {queryMarketDetail,safeOutputPath,saveNewFile} from './market-context-client.mjs';
export {queryMarketDetail};
export function detailCliOptions(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
  const [symbol,...rest]=args;
  if(!symbol||symbol.startsWith('-'))throw Object.assign(new Error('SYMBOL_REQUIRED'),{code:'SYMBOL_REQUIRED'});
  const query={symbol},options={query},seen=new Set();
  const flags={'--profile':'profile','--format':'format','--daily-bars':'daily_bar_count','--sample-days':'sample_trading_days','--wait-ms':'max_wait_ms','--before':'daily_before','--series-id':'daily_series_id','--include':'include','--adjustment':'adjustment','--granularity':'daily_granularity','--intraday-date':'intraday_date','--intraday-before':'intraday_before','--intraday-month':'intraday_month','--minutes':'aggregate_minutes','--aggregate-source':'aggregate_source','--actions-start':'actions_start','--actions-end':'actions_end'};
  while(rest.length){
    const flag=rest.shift(),value=rest.shift();
    if(seen.has(flag)||value==null||value.startsWith('--'))throw Object.assign(new Error('INVALID_ARGUMENT'),{code:'INVALID_ARGUMENT'});seen.add(flag);
    if(flag==='--output'){options.output=safeOutputPath(value);continue;}
    if(!Object.hasOwn(flags,flag))throw Object.assign(new Error('UNKNOWN_FLAG'),{code:'UNKNOWN_FLAG'});
    if(['--daily-bars','--sample-days','--wait-ms','--minutes'].includes(flag)){if(!/^\d+$/.test(value))throw Object.assign(new Error('INVALID_NUMBER'),{code:'INVALID_NUMBER'});query[flags[flag]]=Number(value);}
    else query[flags[flag]]=flag==='--include'?value.split(','):value;
  }
  return options;
}
async function main(){
  try{
    const options=detailCliOptions(process.argv.slice(2));
    if(options.help){process.stdout.write('证券详情查询（零第三方运行时依赖）\nnode --env-file=/private/client.env scripts/market-detail-client.mjs NVDA --output nvda.json\n可选：--profile snapshot|analysis --format objects|compact --daily-bars 252 --sample-days 3 --wait-ms 15000 --before YYYY-MM-DD --series-id 来源序列标识\n环境变量：LLM_API_KEY、LLM_API_BASE_URL。密钥不得出现在命令行；文件必须是新的 .json 文件。\n退出码：0 有完整或部分数据；2 全部不可用（仍输出诊断）；1 请求或保存失败。\n');return;}
    const data=await queryMarketDetail(options.query,{apiKey:process.env.LLM_API_KEY,baseUrl:process.env.LLM_API_BASE_URL});
    const text=JSON.stringify(data)+'\n';if(options.output)await saveNewFile(options.output,text);else process.stdout.write(text);
    if(data.status==='unavailable')process.exitCode=2;
  }catch(error){const code=typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'CLIENT_FAILED';process.stderr.write(JSON.stringify({error:{code,...(Number.isInteger(error.status)?{status:error.status}:{}),...(error.retry_after_seconds?{retry_after_seconds:error.retry_after_seconds}:{})}})+'\n');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
