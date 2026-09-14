// SYNTHETIC PROVIDER RESPONSES ONLY. Never imported by server.js or lib/.
import {createMacroFixture} from './macro-fixture.mjs';
export function createRecoveryFixture(){
 const f=createMacroFixture({survey:true});let mode='degraded',requests=[];
 const reply=body=>({status:200,headers:{},body:typeof body==='string'?body:JSON.stringify(body)});
 const fields=()=>new Date(f.now()+8*3600e3).toISOString();
 const proxy=()=>`var hq_str_hf_NQ="20200,0,20199,20201,20300,20000,${fields().slice(11,19)},20100,20100,0,0,0,${fields().slice(0,10)},纳指100,0";var hq_str_hf_CL="99.16,0,99,100,101,98,${fields().slice(11,19)},98,98,0,0,0,${fields().slice(0,10)},WTI原油,0";var hq_str_hf_OIL="104.3,0,104,105,106,100,${fields().slice(11,19)},102,103,0,0,0,${fields().slice(0,10)},布伦特原油,0";var hq_str_DINIW="${fields().slice(11,19)},98.4,98.4,98.5,0,98.6,99,98,98.6,美元指数,${fields().slice(0,10)}";`;
 async function upstream(url,headers,options){
  const u=new URL(url);requests.push({url,at:f.now(),mode});
  const isQuote=/yahoo\.com$/.test(u.hostname)||['push2.eastmoney.com','futsseapi.eastmoney.com','hq.sinajs.cn','fred.stlouisfed.org','bond.finance.sina.com.cn'].includes(u.hostname);
  if(mode==='offline'&&isQuote)throw Object.assign(new Error('sandbox simulated DNS failure'),{code:'EAI_AGAIN'});
  if(u.hostname==='hq.sinajs.cn'){
   if(mode==='degraded')throw Object.assign(new Error('simulated blocked Sina host'),{code:'EAI_AGAIN'});
   if(!u.searchParams.has('list'))return {status:404,headers:{},body:''};
   return reply(Buffer.from(proxy(),'utf8').toString('latin1'));
  }
  if(u.hostname==='fred.stlouisfed.org'){
   const day=new Date(f.now()-864e5).toISOString().slice(0,10),ids=u.searchParams.get('id').split(',');
   return reply('observation_date,'+ids.join(',')+'\n'+day+','+ids.map(id=>({DCOILBRENTEU:109.51,DCOILWTICO:99.16,DGS10:4.83,DTWEXBGS:118.0732}[id])).join(',')+'\n');
  }
  if(u.hostname==='bond.finance.sina.com.cn')return reply({result:{data:[[new Date(f.now()-864e5).toISOString().slice(0,10),4,5,4,4.9499,0]]}});
  if(u.hostname==='futsseapi.eastmoney.com')return reply({total:2,list:[{dm:'NQ00Y',p:20000+(f.now()%100000)/10000,zjsj:20000},{dm:'CL00Y',p:99.16,zjsj:100}]});
  if(mode==='degraded'&&u.hostname==='push2.eastmoney.com')return reply({data:null});
  if(mode==='degraded'&&/yahoo\.com$/.test(u.hostname))return {status:429,headers:{'retry-after':'120'},body:''};
  return f.upstream(url,headers,options);
 }
 return {now:f.now,upstream,requests,advance(ms=30000){f.advance(ms);},setMode(value){mode=value;},getMode:()=>mode};
}
