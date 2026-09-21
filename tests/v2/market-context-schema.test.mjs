import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import Ajv2020 from '../support/schema-validator.mjs';
import {querySchema,responseSchema,openapi,buildContextDocs} from '../../scripts/build-context-docs.mjs';
import {buildMarketContext} from '../../lib/market-context-format.js';import {parseContextQuery} from '../../lib/market-context-service.js';
const ajv=new Ajv2020({allErrors:true}),validate=ajv.compile(responseSchema),checkQuery=ajv.compile(querySchema);
const now=Date.parse('2026-09-18T14:00:00Z');
test('published schema validates full, partial and unavailable context with columnar row contracts',()=>{
 for(const symbol of ['NVDA','SOXX','^SOX','^N225','600519.SS']){
  const query=parseContextQuery({symbol}),q={symbol,instrumentType:symbol.startsWith('^')?'INDEX':symbol==='SOXX'?'ETF':'EQUITY',currency:symbol==='^N225'?'JPY':symbol.endsWith('.SS')?'CNY':'USD',price:100,quoteAt:now,sourceCheckedAt:now,src:'fixture',charts:{intraday:[{t:now/1000,c:100,v:null}]},fundamentals:{fields:{peTTM:{value:20,status:'available',unit:'ratio',source:'fixture',asOf:now}}}};
  const out=buildMarketContext({query,requestId:'fixture',generatedAt:now,quote:q,daily:{symbol,currency:q.currency,source:'fixture',bars:[{t:Date.parse('2026-09-18T00:00:00Z')/1000,periodStart:'2026-09-18',o:100,h:101,l:99,c:100,v:null}]},samples:{symbol,supported:true,tradingDays:['2026-09-18'],points:[]},news:{items:[],updatedAt:now},macro:{news:{items:[]},context:{factors:[]}}});
  assert.ok(validate(out),JSON.stringify(validate.errors));for(const section of Object.values(out.sections))if(section.rows)assert.ok(section.rows.every(row=>row.length===section.columns.length));
  const invalid=structuredClone(out);invalid.sections.daily.rows[0].push(123);assert.equal(validate(invalid),false);
  const empty=buildMarketContext({query,requestId:'empty',generatedAt:now});assert.ok(validate(empty),JSON.stringify(validate.errors));
 }
});
test('OpenAPI, tool input and runtime agree on defaults and explicit range failures',()=>{
 assert.ok(checkQuery({symbol:'NVDA'}));assert.ok(checkQuery({symbol:' ^SOX '}));for(const q of [{symbol:'NVDA',include:[]},{symbol:'NVDA',daily_bar_count:501},{symbol:'NVDA',daily_bar_count:'252'},{symbol:'NVDA',sample_trading_days:4},{symbol:'NVDA',secret:'ignored'}]){assert.equal(checkQuery(q),false);assert.throws(()=>parseContextQuery(q));}
 assert.equal(openapi.paths['/api/v1/market-context'].post.security[0].ReadOnlyApiKey.length,0);assert.equal(openapi.components.securitySchemes.ReadOnlyApiKey.scheme,'bearer');
 buildContextDocs(new URL('../..',import.meta.url).pathname,{check:true});assert.ok(fs.readFileSync(new URL('../../public/llms.txt',import.meta.url),'utf8').includes('untrusted'));
});
