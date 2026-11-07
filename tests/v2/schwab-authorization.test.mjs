import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSchwabAuthorization,parseSchwabCallback,exchangeSchwabAuthorization,schwabRenewalDecision,SCHWAB_RENEW_AFTER_MS} from '../../lib/providers/schwab-authorization.js';
import {createSchwabClient} from '../../lib/providers/schwab-client.js';
import {publicSourceHealth} from '../../lib/source-health-public.js';

const at=Date.parse('2026-11-07T12:00:00Z');
const credentials={SCHWAB_CLIENT_ID:'test-client',SCHWAB_CLIENT_SECRET:'test-secret',SCHWAB_REDIRECT_URI:'https://developer.schwab.com/oauth2-redirect.html'};
const response=data=>new Response(JSON.stringify(data));
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'qqqsp-schwab-auth-')),tokenFile=join(dir,'token.json'),envFile=join(dir,'schwab.env');
  await writeFile(tokenFile,JSON.stringify({access_token:'prior-access',refresh_token:'prior-refresh',expires_at_ms:at-1}));
  await writeFile(envFile,'SCHWAB_CLIENT_ID=test-client\nSCHWAB_CLIENT_SECRET=test-secret\n');
  try{await fn({dir,tokenFile,envFile});}finally{await rm(dir,{recursive:true,force:true});}}

test('OAuth callback pins redirect and one fresh state, rejects errors and ambiguous codes',()=>{
  const auth=createSchwabAuthorization(credentials),url=new URL(auth.url);
  assert.equal(url.origin,'https://api.schwabapi.com');assert.equal(url.searchParams.get('state'),auth.state);
  const callback=auth.redirect+'?state='+auth.state+'&code=example%40code';
  assert.equal(parseSchwabCallback(callback,auth),'example@code');
  assert.equal(parseSchwabCallback(callback.replace('developer.schwab.com','developer.schwab.com.invalid'),auth),null);
  assert.equal(parseSchwabCallback(callback.replace('oauth2-redirect.html','different'),auth),null);
  assert.throws(()=>parseSchwabCallback(callback.replace(auth.state,'wrong'),auth),{code:'SCHWAB_AUTH_STATE_MISMATCH'});
  assert.throws(()=>parseSchwabCallback(callback+'&code=second',auth),{code:'SCHWAB_AUTH_BAD_CALLBACK'});
  assert.throws(()=>parseSchwabCallback(auth.redirect+'?state='+auth.state+'&error=denied',auth),{code:'SCHWAB_AUTH_DENIED'});
  assert.throws(()=>createSchwabAuthorization({...credentials,SCHWAB_REDIRECT_URI:'http://example.com'}),{code:'SCHWAB_REDIRECT_CONFIG'});
});

test('complete authorization persists its own six-day schedule and survives later ordinary refresh',()=>fixture(async({tokenFile,envFile})=>{
  const authorization=createSchwabAuthorization(credentials);
  const out=await exchangeSchwabAuthorization({code:'test-code',authorization,credentials,tokenFile,now:()=>at,fetchImpl:async(url,request)=>{
    assert.equal(url,'https://api.schwabapi.com/v1/oauth/token');assert.equal(request.redirect,'error');
    assert.equal(request.body.get('grant_type'),'authorization_code');assert.equal(request.body.get('redirect_uri'),authorization.redirect);
    return response({access_token:'grant-access',refresh_token:'grant-refresh',expires_in:1800});
  }});
  assert.equal(out.renewAt,at+SCHWAB_RENEW_AFTER_MS);assert.ok(!JSON.stringify(out).includes('grant-refresh'));
  const initial=JSON.parse(await readFile(tokenFile,'utf8'));
  const client=createSchwabClient({tokenFile,envFile,now:()=>at+1000,fetchImpl:async()=>response({access_token:'next-access',refresh_token:'next-refresh',expires_in:1800})});
  await client.keepAlive();client.close();const after=JSON.parse(await readFile(tokenFile,'utf8'));
  assert.deepEqual(after.qqqsp_authorization,initial.qqqsp_authorization);assert.equal(after.created_at,at/1000);
}));

test('authorization exchange waits for ordinary refresh then cannot be overwritten by that older refresh',()=>fixture(async({tokenFile,envFile})=>{
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  const client=createSchwabClient({tokenFile,envFile,now:()=>at,fetchImpl:async()=>{entered();await new Promise(resolve=>{release=resolve;});return response({access_token:'old-refresh-result',expires_in:1800});}});
  const refresh=client.keepAlive();await started;
  let exchanges=0;
  const auth=exchangeSchwabAuthorization({code:'new-code',authorization:createSchwabAuthorization(credentials),credentials,tokenFile,now:()=>at+1000,
    fetchImpl:async()=>{exchanges++;return response({access_token:'new-grant-result',refresh_token:'new-grant-refresh',expires_in:1800});}});
  assert.equal(exchanges,0);release();await Promise.all([refresh,auth]);client.close();
  const saved=JSON.parse(await readFile(tokenFile,'utf8'));assert.equal(saved.access_token,'new-grant-result');assert.equal(saved.qqqsp_authorization.authorized_at_ms,at+1000);
}));

test('failed authorization preserves current token and never returns an upstream error body',()=>fixture(async({tokenFile})=>{
  const before=await readFile(tokenFile,'utf8');
  await assert.rejects(exchangeSchwabAuthorization({code:'bad',authorization:createSchwabAuthorization(credentials),credentials,tokenFile,
    fetchImpl:async()=>new Response(JSON.stringify({error:'invalid_grant',secret:'private upstream data'}),{status:400})}),error=>{
      assert.equal(error.code,'SCHWAB_AUTH_EXCHANGE_REJECTED');assert.ok(!error.message.includes('private'));return true;});
  assert.equal(await readFile(tokenFile,'utf8'),before);
}));

test('schedule uses authorization age, persists human handoff, resumes after a fresh grant',()=>{
  const unknown={refreshed_at_ms:at,qqqsp_refresh_audit:{first_observed_at_ms:at}};
  assert.equal(schwabRenewalDecision(unknown,{},at).status,'BOOTSTRAP_REQUIRED');
  const token={qqqsp_authorization:{authorized_at_ms:at}};
  assert.equal(schwabRenewalDecision(token,{},at+SCHWAB_RENEW_AFTER_MS-1).action,'wait');
  assert.equal(schwabRenewalDecision(token,{},at+SCHWAB_RENEW_AFTER_MS).action,'authorize');
  const blocked={authorizedAt:at,requiresUserAction:true,status:'SCHWAB_AUTH_MFA_REQUIRED'};
  assert.equal(schwabRenewalDecision(token,blocked,at+7*86400000).status,'SCHWAB_AUTH_MFA_REQUIRED');
  assert.equal(schwabRenewalDecision(token,blocked,at,{force:true}).action,'authorize');
  assert.equal(schwabRenewalDecision({qqqsp_authorization:{authorized_at_ms:at+1000}},blocked,at+1000).status,'READY');
  assert.equal(schwabRenewalDecision(token,{authorizedAt:at,nextAttemptAt:at+7*86400000},at+SCHWAB_RENEW_AFTER_MS).action,'wait');
});

test('public renewal diagnostics expose dates and action state only',()=>{
  const out=publicSourceHealth({schwab:{renewalStatus:'SCHWAB_AUTH_LOGIN_REQUIRED',renewalRequiresUserAction:true,authorizationAt:at,renewAt:at+SCHWAB_RENEW_AFTER_MS,
    username:'sensitive',browserProfile:'/private/browser',state:'oauth-state',refresh_token:'secret'}}).schwab;
  assert.deepEqual(out,{authorizationAt:at,renewAt:at+SCHWAB_RENEW_AFTER_MS,renewalStatus:'SCHWAB_AUTH_LOGIN_REQUIRED',renewalRequiresUserAction:true});
});
