import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {schwabFailure,atomicSchwabJson} from '../lib/providers/schwab-token-store.js';

// Dedicated persistent profile and inherited pipes: no public debugging port,
// no browser output or page content in the journal, no disabled TLS validation.
export async function launchSchwabBrowser({executable,profile,headless=true}={}){
  await mkdir(profile,{recursive:true,mode:0o700});
  await mkdir(join(profile,'Default'),{recursive:true,mode:0o700});
  const preferences=join(profile,'Default','Preferences');let prefs={};try{prefs=JSON.parse(await readFile(preferences,'utf8'));}catch{}
  await atomicSchwabJson(preferences,{...prefs,credentials_enable_service:false,
    profile:{...prefs.profile,password_manager_enabled:false},session:{...prefs.session,restore_on_startup:1}});
  const child=spawn(executable,[...(headless?['--headless=new']:[]),'--no-first-run','--no-default-browser-check',
    '--disable-dev-shm-usage','--remote-debugging-pipe','--window-size=1200,900','--user-data-dir='+profile,'about:blank'],
    {stdio:['ignore','ignore','ignore','pipe','pipe'],windowsHide:true});
  let sequence=0,buffer=Buffer.alloc(0),stopped=false;const pending=new Map(),listeners=new Map();
  function end(){if(stopped)return;stopped=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(schwabFailure('SCHWAB_BROWSER_CLOSED'));}pending.clear();}
  child.once('error',end);child.once('exit',end);
  child.stdio[4].on('data',part=>{
    buffer=Buffer.concat([buffer,part]);if(buffer.length>20*1024*1024){end();child.kill();return;}
    for(;;){const i=buffer.indexOf(0);if(i<0)break;const frame=buffer.subarray(0,i);buffer=buffer.subarray(i+1);
      let message;try{message=JSON.parse(frame.toString());}catch{continue;}
      if(message.id){const p=pending.get(message.id);if(!p)continue;pending.delete(message.id);clearTimeout(p.timer);
        if(message.error)p.reject(schwabFailure('SCHWAB_BROWSER_COMMAND'));else p.resolve(message.result||{});
      }else for(const fn of listeners.get(message.method)||[])Promise.resolve(fn(message.params,message.sessionId)).catch(()=>{});
    }
  });
  function send(method,params={},sessionId){
    if(stopped)return Promise.reject(schwabFailure('SCHWAB_BROWSER_CLOSED'));
    return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(schwabFailure('SCHWAB_BROWSER_TIMEOUT'));},10000);
      pending.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0',error=>{if(error)end();});});
  }
  const on=(event,fn)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);return ()=>listeners.get(event)?.delete(fn);};
  async function close(){if(!stopped)await send('Browser.close').catch(()=>{});await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1200)]);if(!stopped)child.kill('SIGTERM');end();}
  try{
    await send('Browser.getVersion');
    const {targetInfos}=await send('Target.getTargets');
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});
    for(const target of targetInfos)if(target.type==='page')await send('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const page=(method,params={})=>send(method,params,sessionId);
    await page('Page.enable');await page('Runtime.enable');
    await page('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
    return {send,page,on,sessionId,close:async()=>{await page('Page.navigate',{url:'about:blank'}).catch(()=>{});await page('Page.resetNavigationHistory').catch(()=>{});await close();}};
  }catch(error){await close();throw error;}
}
