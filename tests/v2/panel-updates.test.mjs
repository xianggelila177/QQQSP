import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../../public/modules/panel-updates.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function events(extra={}){const handlers=new Map();return {...extra,handlers,
  addEventListener(type,fn){const list=handlers.get(type)||[];list.push(fn);handlers.set(type,list);},
  removeEventListener(type,fn){handlers.set(type,(handlers.get(type)||[]).filter(value=>value!==fn));},
  emit(type){for(const fn of handlers.get(type)||[])fn();}};}
const worker=version=>events({version,state:'activated',postMessage(message,ports){
  assert.equal(message.type,'QQQSP_GET_VERSION');ports[0].postMessage({type:'QQQSP_VERSION',version:this.version});
}});
function harness({pageVersion='113',controller=worker('113'),storage=new Map(),installing=null,waiting=null}={}){
  let clock=100000,serial=0,reloads=0,updates=0,registerFailure=false;const timers=new Map(),statuses=[],registrations=[];
  const setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:clock+ms});return id;},clearTimeout=id=>timers.delete(id);
  class Channel{constructor(){this.port1={onmessage:null,close(){}};this.port2={close(){},postMessage:value=>queueMicrotask(()=>this.port1.onmessage?.({data:value}))};}}
  const window=events({MessageChannel:Channel,setTimeout,clearTimeout,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
  const document=events({hidden:false}),registration=events({installing,waiting,async update(){updates++;}});
  const sw=events({controller,async register(url,options){registrations.push({url,options});if(registerFailure)throw Error('offline');return registration;}});
  const navigator={serviceWorker:sw,onLine:true},location={reload(){reloads++;}};
  vm.runInNewContext(source,{window,Date});
  const updater=window.PANEL_UPDATES.createPanelUpdates({window,document,navigator,location,pageVersion,now:()=>clock,onStatus:value=>statuses.push(value)});
  return {window,document,navigator,sw,registration,updater,statuses,registrations,timers,
    reloads:()=>reloads,updates:()=>updates,advance:ms=>{clock+=ms;},failRegister:value=>{registerFailure=value;}};
}

async function expireVersionProbe(h){
  await flush();
  // The repeating check is five minutes; only expire the handshake timers.
  for(const [id,timer] of [...h.timers])if(timer.at<200000){h.timers.delete(id);timer.fn();}
  await flush();
}

test('stable uncached registration observes an already installing worker and reloads only after its version is active',async()=>{
  const next=worker('114');next.state='installed';const h=harness({installing:next});
  await h.updater.start();await flush();
  assert.equal(h.registrations[0].url,'/sw.js');assert.equal(h.registrations[0].options.updateViaCache,'none');assert.equal(h.registrations[0].options.scope,'/');
  assert.equal(h.reloads(),0);assert.ok(next.handlers.get('statechange')?.length,'installation before registration resolves is still observed');
  h.sw.controller=next;h.sw.emit('controllerchange');next.state='activated';next.emit('statechange');await flush();
  assert.equal(h.reloads(),1);assert.ok(h.statuses.some(state=>state.state==='ready'&&state.version==='114'));
  h.sw.emit('controllerchange');await flush();assert.equal(h.reloads(),1);h.updater.stop();
});

test('first install and same-version controller changes never reload the page automatically',async()=>{
  const next=worker('114'),h=harness({controller:null,waiting:next});await h.updater.start();
  assert.ok(next.handlers.get('statechange')?.length,'an existing waiting worker is observed');
  h.sw.controller=next;h.sw.emit('controllerchange');next.emit('statechange');await flush();
  h.window.emit('focus');h.window.emit('pageshow');await flush();assert.equal(h.reloads(),0);h.updater.stop();
  const same=harness();await same.updater.start();same.sw.controller=worker('113');same.sw.emit('controllerchange');await flush();assert.equal(same.reloads(),0);same.updater.stop();
});

test('offline and hidden pages postpone activating a confirmed update until online and visible',async()=>{
  const h=harness();await h.updater.start();await flush();h.navigator.onLine=false;h.document.hidden=true;
  h.sw.controller=worker('114');h.sw.emit('controllerchange');await flush();assert.equal(h.reloads(),0);
  h.navigator.onLine=true;h.window.emit('online');await flush();assert.equal(h.reloads(),0);
  h.document.hidden=false;h.document.emit('visibilitychange');await flush();assert.equal(h.reloads(),1);h.updater.stop();
});

test('a stale document cannot enter an automatic reload loop and blocked storage keeps a manual update path',async()=>{
  const storage=new Map(),first=harness({storage,controller:worker('114')});await first.updater.start();await flush();assert.equal(first.reloads(),1);first.updater.stop();
  const held=harness({storage,controller:worker('114')});await held.updater.start();await flush();assert.equal(held.reloads(),0);assert.equal(held.statuses.at(-1).state,'ready');held.updater.stop();
  const blocked=harness({controller:worker('114')});Object.defineProperty(blocked.window,'sessionStorage',{get(){throw Error('denied');}});
  await blocked.updater.start();await flush();assert.equal(blocked.reloads(),0);await blocked.updater.activate();assert.equal(blocked.reloads(),1);blocked.updater.stop();
});

test('focus, visibility and online checks share one throttled update and do not poll while hidden/offline',async()=>{
  const h=harness();await h.updater.start();await flush();h.window.emit('focus');h.window.emit('pageshow');await flush();assert.equal(h.updates(),0);
  h.advance(60001);h.window.emit('focus');h.window.emit('online');h.document.emit('visibilitychange');await flush();assert.equal(h.updates(),1);
  h.document.hidden=true;h.advance(60001);await h.updater.check(true);assert.equal(h.updates(),1);
  h.document.hidden=false;h.navigator.onLine=false;await h.updater.check(true);assert.equal(h.updates(),1);
  h.navigator.onLine=true;await h.updater.check(true);assert.equal(h.updates(),2);h.updater.stop();assert.equal(h.timers.size,0);
});

test('a failed first registration can be retried from the persistent update button',async()=>{
  const h=harness();h.failRegister(true);await h.updater.start();assert.equal(h.registrations.length,1);
  h.failRegister(false);await h.updater.activate();await flush();assert.equal(h.registrations.length,2);assert.equal(h.updates(),1);assert.equal(h.reloads(),0);h.updater.stop();
});

test('a confirmed rollback is a deployment change, with the same loop guard as an upgrade',async()=>{
  const storage=new Map(),h=harness({pageVersion:'117',controller:worker('111'),storage});
  await h.updater.start();await flush();
  assert.equal(h.reloads(),1);assert.ok(h.statuses.some(s=>s.state==='ready'&&s.version==='111'));h.updater.stop();
  const held=harness({pageVersion:'117',controller:worker('111'),storage});
  await held.updater.start();await flush();assert.equal(held.reloads(),0);
  assert.equal(held.statuses.at(-1).state,'ready');held.updater.stop();
});

test('a deployment that returns to the page version clears an obsolete ready target',async()=>{
  const h=harness({pageVersion:'117'});h.document.hidden=true;
  h.sw.controller=worker('118');await h.updater.start();await flush();assert.equal(h.reloads(),0);
  h.sw.controller=worker('117');h.sw.emit('controllerchange');await flush();
  h.document.hidden=false;await h.updater.activate();await flush();
  assert.equal(h.reloads(),0);assert.equal(h.statuses.at(-1).state,'current');h.updater.stop();
});

test('a legacy v111 controller without a version protocol is unknown, never current, and permits one manual refresh',async()=>{
  // v111's deployed worker registered install/activate/fetch only. Its controller
  // has postMessage but no message handler, so it cannot answer GET_VERSION.
  const legacy=events({state:'activated',scriptURL:'https://fixture.test/sw.js',postMessage(){}});
  const h=harness({pageVersion:'118',controller:legacy});await h.updater.start();await expireVersionProbe(h);
  const checking=h.updater.check(true);await expireVersionProbe(h);await checking;
  assert.equal(h.reloads(),0);assert.equal(h.statuses.at(-1).state,'unknown');
  assert.equal(h.statuses.at(-1).canReload,true);assert.equal(h.statuses.at(-1).version,null);
  assert.equal(await h.updater.activate(),true);assert.equal(h.reloads(),1);
  assert.equal(await h.updater.activate(),false);assert.equal(h.reloads(),1);h.updater.stop();
});

test('unknown controller manual refresh works without session storage but waits for visible online state',async()=>{
  const legacy=events({state:'activated',postMessage(){}}),h=harness({controller:legacy});
  Object.defineProperty(h.window,'sessionStorage',{get(){throw Error('denied');}});
  await h.updater.start();await expireVersionProbe(h);
  h.navigator.onLine=false;assert.equal(await h.updater.activate(),false);assert.equal(h.reloads(),0);
  h.navigator.onLine=true;h.document.hidden=true;assert.equal(await h.updater.activate(),false);assert.equal(h.reloads(),0);
  h.document.hidden=false;assert.equal(await h.updater.activate(),true);assert.equal(h.reloads(),1);h.updater.stop();
});

test('an unconfirmed replacement controller cannot use a former worker ready version to auto reload',async()=>{
  const h=harness({pageVersion:'117',controller:worker('118')});h.document.hidden=true;
  await h.updater.start();await flush();assert.equal(h.statuses.at(-1).version,'118');
  h.sw.controller=events({state:'activated',postMessage(){}});h.sw.emit('controllerchange');
  h.document.hidden=false;h.window.emit('focus');await flush();assert.equal(h.reloads(),0);
  await expireVersionProbe(h);assert.equal(h.statuses.at(-1).state,'unknown');assert.equal(h.reloads(),0);h.updater.stop();
});
