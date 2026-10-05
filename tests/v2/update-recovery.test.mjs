import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../public/update.js',import.meta.url),'utf8');
const settle=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function harness({offline=false,unsupported=false,updateFailure=false}={}){
  const nodes=new Map(['update-status','update-retry','update-progress'].map(id=>[id,
    {textContent:'',dataset:{},hidden:false,disabled:false,listeners:new Map(),addEventListener(name,fn){this.listeners.set(name,fn);}}]));
  let nextTimer=0,time=0,storageAccesses=0;const timers=new Map(),redirects=[],registrations=[],channels=[];
  const localData=new Map([['watchlist','["NVDA","QQQ"]'],['theme','light']]);
  const storage=new Proxy(localData,{get(){storageAccesses++;throw Error('Recovery must not access or mutate browser storage');}});
  const worker=(url,version,{state='activated',silent=false,type='QQQSP_VERSION'}={})=>({scriptURL:url,state,messages:[],
    postMessage(message,ports){this.messages.push({message,port:ports[0]});if(!silent)ports[0].postMessage({type,version});}});
  const old=worker('https://qqqsp.test/sw.js?v=113','113');
  const registration={active:old,installing:null,waiting:null,updates:0,
    update(){this.updates++;return updateFailure?Promise.reject(new Error('offline')):Promise.resolve(this);}};
  const serviceWorker={controller:old,register(url,options){registrations.push({url,options});return Promise.resolve(registration);}};
  class Channel {
    constructor(){
      this.port1={onmessage:null,closed:false,close(){this.closed=true;}};
      this.port2={closed:false,close(){this.closed=true;},postMessage:value=>{
        Promise.resolve().then(()=>{if(!this.port1.closed)this.port1.onmessage?.({data:value});});
      }};channels.push(this);
    }
  }
  const context={document:{getElementById:id=>nodes.get(id)},navigator:{onLine:!offline,...(unsupported?{}:{serviceWorker})},
    location:{origin:'https://qqqsp.test',href:'https://qqqsp.test/update.html',replace:url=>redirects.push(url)},
    URL,AbortController,MessageChannel:Channel,encodeURIComponent,
    setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,at:time+delay});return id;},clearTimeout:id=>timers.delete(id),
    localStorage:storage,sessionStorage:storage,indexedDB:storage,caches:storage};
  vm.runInNewContext(source,context);
  async function advance(ms){const target=time+ms;await settle();
    for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].callback();await settle();}
    time=target;await settle();
  }
  return {nodes,registration,serviceWorker,worker,registrations,redirects,channels,advance,settle,
    setUpdateFailure:value=>{updateFailure=value;},storageAccesses:()=>storageAccesses,localData,
    activate(value){value.state='activated';registration.active=value;registration.installing=null;registration.waiting=null;serviceWorker.controller=value;},
    retry(){nodes.get('update-retry').listeners.get('click')();}};
}

test('recovery keeps local data and waits for stable active worker and controller before a verified redirect',async()=>{
  const h=harness();await h.settle();
  assert.equal(h.registrations.length,1);assert.equal(h.registrations[0].url,'/sw.js');
  assert.equal(h.registrations[0].options.scope,'/');assert.equal(h.registrations[0].options.updateViaCache,'none');
  assert.equal(h.registration.updates,1);assert.deepEqual(h.redirects,[]);
  const next=h.worker('https://qqqsp.test/sw.js','114',{state:'installing'});
  h.registration.installing=next;await h.advance(600);assert.equal(next.messages.length,0);
  h.registration.installing=null;h.registration.active=next;next.state='activated';
  await h.advance(600);assert.equal(next.messages.length,0); // old controller still owns this document
  h.serviceWorker.controller=next;await h.advance(600);
  assert.deepEqual(h.redirects,['/?updated=114']);assert.equal(next.messages[0].message.type,'QQQSP_GET_VERSION');
  assert.equal(h.nodes.get('update-status').dataset.state,'complete');
  assert.equal(h.storageAccesses(),0);assert.deepEqual([...h.localData],[['watchlist','["NVDA","QQQ"]'],['theme','light']]);
  assert.ok(h.channels.every(c=>c.port1.closed&&c.port2.closed));
});

test('an existing stable worker cannot finish while a new worker is installing',async()=>{
  const h=harness();const old=h.worker('https://qqqsp.test/sw.js','114'),next=h.worker('https://qqqsp.test/sw.js','207');
  h.activate(old);h.registration.installing=next;await h.advance(1000);
  assert.equal(old.messages.length,0);assert.deepEqual(h.redirects,[]);
  h.activate(next);await h.advance(600);assert.deepEqual(h.redirects,['/?updated=207']);
});

test('failed update stays on the recovery page and retries only after the user clicks',async()=>{
  const h=harness({updateFailure:true,offline:true});await h.settle();
  assert.deepEqual(h.redirects,[]);assert.equal(h.nodes.get('update-retry').hidden,false);
  assert.match(h.nodes.get('update-status').textContent,/离线/);
  await h.advance(60000);assert.equal(h.registrations.length,1);assert.equal(h.registration.updates,1);
  h.setUpdateFailure(false);h.activate(h.worker('https://qqqsp.test/sw.js','115'));h.retry();await h.advance(600);
  assert.equal(h.registrations.length,2);assert.deepEqual(h.redirects,['/?updated=115']);assert.equal(h.storageAccesses(),0);
});

test('unrecognized version replies and unresponsive workers never report success',async()=>{
  for(const options of [{version:'v114'},{version:'114',type:'UNKNOWN'},{version:'114',silent:true}]){
    const h=harness();h.activate(h.worker('https://qqqsp.test/sw.js',options.version,options));await h.advance(5000);
    assert.deepEqual(h.redirects,[]);assert.equal(h.nodes.get('update-status').dataset.state,'error');
    assert.equal(h.nodes.get('update-retry').hidden,false);assert.ok(h.channels.every(c=>c.port1.closed&&c.port2.closed));
    await h.advance(60000);assert.equal(h.registrations.length,1);assert.equal(h.storageAccesses(),0);
  }
});

test('activation timeout stops waiting; a late worker cannot trigger an automatic refresh',async()=>{
  const h=harness();await h.advance(31000);
  assert.deepEqual(h.redirects,[]);assert.equal(h.nodes.get('update-status').dataset.state,'error');
  assert.match(h.nodes.get('update-status').textContent,/尚未完成/);
  const late=h.worker('https://qqqsp.test/sw.js','114');h.activate(late);await h.advance(60000);
  assert.equal(late.messages.length,0);assert.deepEqual(h.redirects,[]);assert.equal(h.storageAccesses(),0);
});

test('unsupported browsers show a usable failure message and HTML uses external assets under strict CSP',async()=>{
  const h=harness({unsupported:true});await h.settle();assert.equal(h.registrations.length,0);
  assert.match(h.nodes.get('update-status').textContent,/不支持/);assert.deepEqual(h.redirects,[]);
  const html=fs.readFileSync(new URL('../../public/update.html',import.meta.url),'utf8');
  assert.match(html,/<script src="\/update\.js" defer><\/script>/);
  assert.match(html,/script-src 'self'; style-src 'self'/);assert.doesNotMatch(html,/<style\b|\son\w+=|unsafe-inline/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|\.unregister\(|caches\./);
});
