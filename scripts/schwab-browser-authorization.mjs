import {setTimeout as delay} from 'node:timers/promises';
import {launchSchwabBrowser} from './schwab-cdp.mjs';
import {openSchwabAuthConsole} from './schwab-auth-console.mjs';
import {parseSchwabCallback} from '../lib/providers/schwab-authorization.js';
import {schwabFailure} from '../lib/providers/schwab-token-store.js';

const trusted=url=>{try{const u=new URL(url);return u.protocol==='https:'&&['schwab.com','schwabapi.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}};
const inspect=`(()=>{const visible=s=>{const e=document.querySelector(s);return !!e&&!!e.getClientRects().length&&!e.hidden;};const p=location.pathname;return {href:location.href,
  login:visible('#loginIdInput')||visible('#passwordInput')||p.includes('/login-one-step'),
  mfa:/authenticators|mobile_approve|otp|verification/i.test(p),trust:p.includes('/devicetag/remember'),
  consent:p.includes('/third-party-auth/cag'),accounts:p.includes('/third-party-auth/account'),confirmation:p.includes('/third-party-auth/confirmation'),
  denied:/access denied|request blocked/i.test(document.title)||!!document.querySelector('iframe[src*="captcha"]')};})()`;
export async function runSchwabBrowserAuthorization({authorization,executable,profile,interactive=false,onCode,onPhase=async()=>{},onListening=()=>{},port=18774,timeoutMs=interactive?900000:120000}={}){
  const browser=await launchSchwabBrowser({executable,profile});let consoleServer,result,fatal,exchanging=false,phase='WAITING',canceled=false;
  const report=async next=>{if(phase!==next){phase=next;await onPhase(next);}};
  const deadline=Date.now()+timeoutMs;
  try{
    browser.on('Fetch.requestPaused',async(params,sessionId)=>{
      if(sessionId!==browser.sessionId)return;
      let code;
      try{code=parseSchwabCallback(params.request.url,authorization);}catch(error){fatal=error;}
      if(!code&&!fatal){await browser.page('Fetch.continueRequest',{requestId:params.requestId}).catch(()=>{});return;}
      // Intercept the registered redirect before transmission: the code never
      // reaches a third-party relay or the application journal.
      await browser.page('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from('<p>Authorization received. You can return to the private login window.</p>').toString('base64')}).catch(()=>{});
      if(!code||exchanging||result)return;exchanging=true;
      try{await report('EXCHANGING');result=await onCode(code);await report('READY');}catch(error){fatal=error;}
    });
    await browser.page('Fetch.enable',{patterns:[{urlPattern:authorization.redirect+'*',resourceType:'Document',requestStage:'Request'}]});
    if(interactive){consoleServer=await openSchwabAuthConsole(browser,{port,status:()=>({status:phase}),cancel:()=>{canceled=true;}});onListening(consoleServer.url);}
    await browser.page('Page.navigate',{url:authorization.url});
    let lastAction='',actionAt=0;
    while(Date.now()<deadline){
      if(fatal)throw fatal;if(canceled)throw schwabFailure('SCHWAB_AUTH_CANCELED');if(result){if(interactive)await delay(2000);return result;}
      if(exchanging){await delay(100);continue;}
      let state;
      try{state=(await browser.page('Runtime.evaluate',{expression:inspect,returnByValue:true})).result?.value;}catch{await delay(300);continue;}
      if(!state){await delay(300);continue;}
      if(!trusted(state.href)){await delay(300);continue;}
      if(state.denied)throw schwabFailure('SCHWAB_AUTH_BROWSER_BLOCKED');
      await report(state.login?'LOGIN':state.mfa?'MFA':state.trust?'TRUST_DEVICE':state.consent||state.accounts||state.confirmation?'CONSENT':'WAITING');
      if(!interactive){
        if(state.login)throw schwabFailure('SCHWAB_AUTH_LOGIN_REQUIRED');
        if(state.mfa)throw schwabFailure('SCHWAB_AUTH_MFA_REQUIRED');
        // Preserve preselected account permissions; never select every account.
        const expression=state.trust?`(()=>{const e=document.querySelector('#remember-device-yes'),b=document.querySelector('#btnContinue');if(e&&b&&!b.disabled){if(!e.checked)e.click();b.click();return 'trust';}})()`:
          state.consent?`(()=>{const modal=document.querySelector('#agree-modal-btn-');if(modal&&modal.getClientRects().length&&!modal.disabled){modal.click();return 'modal';}const e=document.querySelector('#acceptTerms'),b=document.querySelector('#submit-btn');if(e&&b){if(!e.checked)e.click();if(!b.disabled){b.click();return 'consent';}}})()`:
          state.accounts?`(()=>{const b=document.querySelector('#submit-btn');if(b&&!b.disabled){b.click();return 'accounts';}return 'selection-required';})()`:
          state.confirmation?`(()=>{const b=document.querySelector('#cancel-btn');if(b&&!b.disabled){b.click();return 'done';}})()`:null;
        if(expression&&(state.href!==lastAction||Date.now()-actionAt>5000)){
          const action=(await browser.page('Runtime.evaluate',{expression,returnByValue:true})).result?.value;
          if(action==='selection-required')throw schwabFailure('SCHWAB_AUTH_ACCOUNT_SELECTION_REQUIRED');
          if(action){lastAction=state.href;actionAt=Date.now();}
        }
      }
      await delay(400);
    }
    throw schwabFailure('SCHWAB_AUTH_TIMEOUT');
  }catch(error){phase='FAILED';if(interactive)await delay(1500);throw error;}
  finally{await consoleServer?.close();await browser.close();}
}
