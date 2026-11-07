import {readFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createSchwabClient} from '../lib/providers/schwab-client.js';
import {readSchwabToken,readSchwabCredentials,atomicSchwabJson} from '../lib/providers/schwab-token-store.js';
import {createSchwabAuthorization,exchangeSchwabAuthorization,schwabRenewalDecision} from '../lib/providers/schwab-authorization.js';
import {runSchwabBrowserAuthorization} from './schwab-browser-authorization.mjs';

const tokenFile=process.env.SCHWAB_TOKEN_FILE||'/opt/schwab/token.json',envFile=process.env.SCHWAB_ENV_FILE||'/opt/schwab/schwab.env';
const stateFile=tokenFile+'.renewal.json',interactive=process.argv.includes('--interactive'),force=interactive||process.argv.includes('--force');
const client=createSchwabClient({tokenFile,envFile});
const safeCode=e=>/^SCHWAB_[A-Z_]+$/.test(e?.code||'')?e.code:'SCHWAB_RENEWAL_FAILED';
let state={};try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
const log=value=>console.log(JSON.stringify({event:'schwab-renewal',checkedAt:Date.now(),...value}));
try{
  let token=await readSchwabToken(tokenFile).catch(()=>({})),accessError=null;
  const expires=Number(token.expires_at_ms)||(Number(token.expires_at)||0)*1000;
  if(!interactive&&(!expires||expires<=Date.now()+120000)){
    try{await client.keepAlive();token=await readSchwabToken(tokenFile);}catch(error){accessError=safeCode(error);}
  }
  const recover=accessError==='SCHWAB_AUTH_REQUIRED'&&!state.requiresUserAction&&!!token.qqqsp_authorization;
  const decision=schwabRenewalDecision(token,state,Date.now(),{force:force||recover});
  if(decision.action==='wait'){
    const {action,...fields}=decision;state={...state,...fields,checkedAt:Date.now(),accessError};
    await atomicSchwabJson(stateFile,state);log(state);
  }else{
    const credentials=await readSchwabCredentials(envFile),authorization=createSchwabAuthorization(credentials);
    const profile=process.env.SCHWAB_BROWSER_PROFILE||join(dirname(tokenFile),'browser');
    await mkdir(profile,{recursive:true,mode:0o700});
    state={...state,authorizedAt:decision.authorizedAt,renewAt:decision.renewAt,status:'AUTHORIZING',requiresUserAction:interactive,
      checkedAt:Date.now(),lastAttemptAt:Date.now(),nextAttemptAt:0,accessError};
    await atomicSchwabJson(stateFile,state);
    const result=await runSchwabBrowserAuthorization({authorization,profile,interactive,
      executable:process.env.SCHWAB_BROWSER_BIN||'/usr/bin/google-chrome-stable',
      onListening:url=>log({status:'BOOTSTRAP_WAITING',localConsole:url}),
      onPhase:async phase=>{state={...state,browserPhase:phase,checkedAt:Date.now()};await atomicSchwabJson(stateFile,state);},
      onCode:code=>exchangeSchwabAuthorization({code,authorization,credentials,tokenFile})});
    state={...result,status:'READY',requiresUserAction:false,attempts:0,lastSuccessAt:result.authorizedAt,
      checkedAt:Date.now(),nextAttemptAt:result.renewAt,accessError:null};
    await atomicSchwabJson(stateFile,state);log(state);
  }
}catch(error){
  const code=safeCode(error),human=interactive||/LOGIN_REQUIRED|MFA_REQUIRED|ACCOUNT_SELECTION_REQUIRED|BROWSER_BLOCKED|STATE_MISMATCH|AUTH_DENIED|AUTH_EXCHANGE_REJECTED|AUTH_CANCELED|REDIRECT_CONFIG/.test(code);
  const attempts=(Number(state.attempts)||0)+1,backoff=[300000,1800000,7200000,21600000][Math.min(attempts-1,3)];
  state={...state,status:code,checkedAt:Date.now(),requiresUserAction:human,attempts,nextAttemptAt:human?0:Date.now()+backoff};
  await atomicSchwabJson(stateFile,state).catch(()=>{});log(state);
  // A known need for the user's login is a stable state, not a restart loop.
  if(!human)process.exitCode=1;
}finally{client.close();}
