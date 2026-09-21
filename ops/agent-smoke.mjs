import {queryMarketDetail} from '../scripts/market-context-client.mjs';
const symbol=process.argv[2]||'NVDA';
try{
 const data=await queryMarketDetail({symbol,profile:'snapshot'},{apiKey:process.env.LLM_API_KEY,baseUrl:process.env.LLM_API_BASE_URL||'http://127.0.0.1:'+(process.env.PORT||8567)});
 console.log(JSON.stringify({symbol:data.instrument.symbol,status:data.status,generated_at_ms:data.generated_at_ms,sections:Object.fromEntries(Object.entries(data.sections).map(([name,value])=>[name,{status:value.status,as_of_ms:value.as_of_ms,missing_reason:value.missing_reason}])),missing_fields:data.quality.missing_fields,sources:data.sources},null,2));
 if(data.status==='unavailable')process.exitCode=2;
}catch(error){console.error(JSON.stringify({code:/^[A-Z][A-Z0-9_]*$/.test(error.code||'')?error.code:'SMOKE_FAILED',status:error.status??null}));process.exitCode=1;}
