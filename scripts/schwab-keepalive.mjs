import {createSchwabClient} from '../lib/providers/schwab-client.js';
import {setTimeout as delay} from 'node:timers/promises';

const client=createSchwabClient({envFile:process.env.SCHWAB_ENV_FILE||'/opt/schwab/schwab.env',
  tokenFile:process.env.SCHWAB_TOKEN_FILE||'/opt/schwab/token.json'});
try{
  let result;
  for(let attempt=0;attempt<3;attempt++){
    try{result=await client.keepAlive();break;}
    catch(error){if(error.code!=='SCHWAB_REFRESH_BUSY'||attempt===2)throw error;await delay(1500);}
  }
  console.log(JSON.stringify({event:'schwab-keepalive',status:'ready',checkedAt:Date.now(),...result}));
}catch(error){
  // Only internally generated error codes are logged; never token responses.
  const code=/^SCHWAB_[A-Z_]+$/.test(error.code||'')?error.code:'SCHWAB_KEEPALIVE_FAILED';
  console.error(JSON.stringify({event:'schwab-keepalive',status:'failed',checkedAt:Date.now(),code,
    reauthorizationRequired:code==='SCHWAB_AUTH_REQUIRED'}));
  process.exitCode=code==='SCHWAB_AUTH_REQUIRED'?2:1;
}finally{client.close();}
