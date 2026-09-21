import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlpacaProvider} from '../../lib/providers/alpaca-stream.js';
import {createFinnhubProvider} from '../../lib/providers/finnhub-stream.js';

const START=Date.parse('2026-09-21T14:00:00Z');
class Socket extends EventTarget {
  readyState=0; sent=[];
  send(data){if(this.throwSend)throw Error('fixture send failure');this.sent.push(JSON.parse(data));}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  emit(data){this.dispatchEvent(new MessageEvent('message',{data:typeof data==='string'?data:JSON.stringify(data)}));}
}
function fixture(kind,options={}) {
  let at=START;const sockets=[];
  const common={now:()=>at,newSocket:()=>{const s=new Socket();sockets.push(s);return s;},schedule:()=>0,cancel(){},random:()=>0,...options};
  const p=kind==='alpaca'?createAlpacaProvider({...common,env:{ALPACA_ENABLED:'1',APCA_API_KEY_ID:'fixture',APCA_API_SECRET_KEY:'fixture',...options.env}}):createFinnhubProvider({...common,token:'fixture'});
  return {p,sockets,now:()=>at,advance:ms=>at+=ms,open(symbol='QQQ'){p.start();assert.equal(p.touch(symbol),true);const s=sockets.at(-1);s.open();if(kind==='alpaca'){s.emit([{T:'success',msg:'authenticated'}]);s.emit([{T:'subscription',trades:[symbol.replace('-', '.')],quotes:[symbol.replace('-', '.')]}]);}return s;}};
}
const alpacaTrade=(symbol,at)=>({T:'t',S:symbol,t:new Date(at).toISOString(),p:123,s:1,x:'V',i:1});
const finnhubTrade=(symbol,at)=>({type:'trade',data:[{s:symbol,t:at,p:123,v:1}]});
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('both streams translate canonical US share classes and reject foreign ticker suffixes',()=>{
  for(const kind of ['finnhub','alpaca']){
    const f=fixture(kind);const s=f.open('BRK-B');
    for(const symbol of ['9766.T','0700.HK','600519.SS','005930.KS','BTC-USD'])assert.equal(f.p.supports(symbol),false,symbol);
    assert.ok(s.sent.some(x=>x.symbol==='BRK.B'||x.trades?.includes('BRK.B')));
    s.emit(kind==='alpaca'?[alpacaTrade('BRK.B',f.now())]:finnhubTrade('BRK.B',f.now()));
    assert.equal(f.p.read('BRK-B').trade.symbol,'BRK-B');assert.equal(f.p.read('BRK-B').state,'streaming');f.p.stop();
  }
});

test('Finnhub bounds subscriptions and exposes an explicit local capacity downgrade',()=>{
  const f=fixture('finnhub',{maxSymbols:1});f.open();assert.equal(f.p.touch('SPY'),false);
  assert.equal(f.p.diagnostics().maxSymbols,1);assert.equal(f.p.diagnostics().counts.droppedSymbols,1);
  assert.equal(f.p.read('QQQ').delayMinutes,null);assert.match(f.p.read('QQQ').coverage,/未核验/);
  f.p.retain([]);assert.equal(f.p.touch('SPY'),true);f.p.stop();
});

test('Finnhub catches constructor/send errors and schedules exactly one retry per failed socket',()=>{
  const broken=fixture('finnhub',{newSocket(){throw Error('fixture');}});broken.p.start();
  assert.doesNotThrow(()=>broken.p.touch('QQQ'));assert.equal(broken.p.diagnostics().errorCode,'CONNECT_FAILED');broken.p.stop();
  const f=fixture('finnhub');f.p.start();f.p.touch('QQQ');const s=f.sockets[0];s.throwSend=true;
  assert.doesNotThrow(()=>s.open());assert.equal(f.p.diagnostics().errorCode,'SEND_FAILED');
  assert.equal(f.p.diagnostics().nextConnectAt,f.now()+1000);s.dispatchEvent(new Event('error'));s.close();
  assert.equal(f.p.diagnostics().nextConnectAt,f.now()+1000);f.p.stop();
});

test('Finnhub validates heartbeat frames and never confirms an old-generation trade using another symbol',()=>{
  const f=fixture('finnhub');const old=f.open();old.emit(finnhubTrade('QQQ',f.now()));
  f.advance(1000);old.emit('malformed');assert.equal(f.p.read('QQQ').state,'backoff');
  f.advance(1000);f.p.step();const current=f.sockets.at(-1);current.open();
  assert.equal(f.p.read('QQQ').connectionCheckedAt,null,'opening TCP is not an upstream data frame');
  f.p.touch('SPY');current.emit(finnhubTrade('SPY',f.now()));
  assert.equal(f.p.read('QQQ').state,'subscribing');assert.equal(f.p.read('SPY').state,'streaming');
  old.emit(finnhubTrade('QQQ',f.now()));assert.equal(f.p.read('QQQ').state,'subscribing');
  f.advance(1000);current.emit({type:'ping'});assert.equal(f.p.read('QQQ').connectionCheckedAt,f.now());
  assert.equal(f.p.read('QQQ').trade.quoteAt,START);f.advance(90001);f.p.step();assert.equal(f.p.read('QQQ').errorCode,'STREAM_SILENT');f.p.stop();
});

test('Alpaca detects a silent open socket through a supported subscription acknowledgement probe',()=>{
  const f=fixture('alpaca');const s=f.open();f.advance(30001);f.p.step();
  const probes=s.sent.filter(x=>x.action==='subscribe');assert.equal(probes.length,2);
  assert.deepEqual(probes[1],{action:'subscribe',trades:['QQQ'],quotes:['QQQ']});
  assert.equal(f.p.read('QQQ').state,'streaming','no trade is not a failure');
  f.advance(10001);f.p.step();assert.equal(f.p.read('QQQ').state,'backoff');assert.equal(f.p.read('QQQ').errorCode,'STREAM_SILENT');
  const retry=f.p.diagnostics().nextConnectAt;s.dispatchEvent(new Event('error'));s.close();assert.equal(f.p.diagnostics().nextConnectAt,retry);
  f.advance(1000);f.p.step();const fresh=f.sockets.at(-1);assert.notEqual(fresh,s);s.emit([alpacaTrade('QQQ',f.now())]);assert.equal(f.p.read('QQQ').trade,null);f.p.stop();
});

test('Alpaca remains connected without trades when quiet-market subscription responses arrive',()=>{
  const f=fixture('alpaca');const s=f.open();
  for(let n=0;n<12;n++){f.advance(30001);f.p.touch('QQQ');f.p.step();s.emit([{T:'subscription',trades:['QQQ'],quotes:['QQQ']}]);}
  assert.equal(f.sockets.length,1);assert.equal(f.p.read('QQQ').trade,null);assert.equal(f.p.read('QQQ').state,'streaming');assert.equal(f.p.read('QQQ').connectionCheckedAt,f.now());f.p.stop();
});

test('Alpaca snapshots preserve canonical share-class identity without advancing WS health',async()=>{
  let f,url;f=fixture('alpaca',{httpsGet:async input=>{url=input;return{status:200,body:JSON.stringify({'BRK.B':{latestTrade:alpacaTrade('BRK.B',f.now())}})};}});
  f.open('BRK-B');const frameAt=f.p.read('BRK-B').connectionCheckedAt;f.advance(2000);f.p.step();await drain();
  assert.ok(url.includes('BRK.B'));assert.equal(f.p.read('BRK-B').trade.symbol,'BRK-B');assert.equal(f.p.read('BRK-B').snapshotCheckedAt,f.now());assert.equal(f.p.read('BRK-B').connectionCheckedAt,frameAt);f.p.stop();
});

test('Alpaca provider symbol limits preserve acknowledged symbols and expose unsupported ones',()=>{
  const f=fixture('alpaca');const s=f.open();f.advance(1000);f.p.touch('SPY');f.p.step();s.emit([{T:'error',code:405}]);
  assert.equal(f.p.read('QQQ').state,'streaming');assert.equal(f.p.read('SPY').state,'subscription-limited');assert.equal(f.p.read('SPY').errorCode,'SYMBOL_LIMIT');
  f.p.retain(['QQQ']);f.advance(1000);f.p.step();assert.equal(f.p.diagnostics().subscriptionBlocked,false);f.p.stop();
});

test('Alpaca REST failure cannot overwrite a separate WebSocket failure diagnosis',async()=>{
  let resolve;const f=fixture('alpaca',{httpsGet:()=>new Promise(done=>resolve=done)});const s=f.open();
  f.p.step();s.dispatchEvent(new Event('error'));resolve({status:403});await drain();
  assert.equal(f.p.read('QQQ').state,'backoff');assert.equal(f.p.read('QQQ').errorCode,'SOCKET_ERROR');assert.equal(f.p.read('QQQ').connectionErrorCode,'SOCKET_ERROR');
  assert.equal(f.p.read('QQQ').snapshotErrorCode,'REST_AUTH');assert.equal(f.p.read('QQQ').connectionCheckedAt,null);
  assert.equal(f.p.read('QQQ').connectionHealthy,false);f.p.stop();
});

test('Alpaca expires old subscriptions without probing the removed symbol',()=>{
  const f=fixture('alpaca',{env:{ALPACA_ACTIVE_TTL_MS:'180000'}});const s=f.open();
  f.advance(100000);f.p.touch('SPY');s.emit([{T:'subscription',trades:['QQQ','SPY'],quotes:['QQQ','SPY']}]);f.p.step();
  f.advance(80001);f.p.step();assert.equal(f.p.read('QQQ'),null);
  assert.ok(!f.p.diagnostics().acknowledged.includes('QQQ'));
  assert.deepEqual(s.sent.at(-1),{action:'subscribe',trades:['SPY'],quotes:['SPY']});f.p.stop();
});
