import {marketKeyFor} from '../instruments.js';

// US share classes use a dot at this provider; foreign suffixes are not mapped.
const wireSymbol = symbol => symbol.replace('-', '.');
const canonicalSymbol = symbol => typeof symbol === 'string' ? symbol.replace('.', '-') : '';
const COVERAGE = '账户授权范围（未核验全市场覆盖）';

// Optional token-based backup. No REST polling; coverage/delay remain unverified.
// Protocol reference: https://finnhub.io/docs/api/websocket-trades
export function createFinnhubProvider({token='', maxSymbols=30, now=Date.now,
  newSocket=url=>new WebSocket(url), schedule=setInterval, cancel=clearInterval, random=Math.random}={}) {
  if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > 1000) throw new TypeError('Invalid Finnhub maxSymbols');
  const active=new Set(), sent=new Set(), confirmed=new Set(), records=new Map(), listeners=new Set();
  let socket=null, timer=null, running=false, generation=0, status=token?'idle':'disabled';
  let nextAt=0, failures=0, errorCode=null, openedAt=null, framesAt=null;
  const counts={receivedTrades:0,rejectedTrades:0,reconnects:0,droppedSymbols:0};
  const supports=s=>!!token && typeof s==='string' && /^[A-Z][A-Z0-9]{0,5}(?:-[A-Z])?$/.test(s) && marketKeyFor(s)==='us';
  function disconnect() {
    const old=socket;socket=null;sent.clear();confirmed.clear();framesAt=null;openedAt=null;
    try { old?.close(); } catch {}
  }
  function retry(code,minimum=1000) {
    errorCode=code;failures=Math.min(failures+1,10);
    nextAt=now()+Math.max(minimum,Math.min(300000,1000*2**(failures-1)))+Math.floor(Math.max(0,Math.min(1,random()))*1000);
    status='backoff';disconnect();
  }
  function send(value) {
    if(socket?.readyState!==1)return false;
    try {socket.send(JSON.stringify(value));return true;} catch {retry('SEND_FAILED');return false;}
  }
  function reconcile() {
    if(socket?.readyState!==1)return;
    for(const s of sent)if(!active.has(s)) {
      if(!send({type:'unsubscribe',symbol:wireSymbol(s)}))return;
      sent.delete(s);confirmed.delete(s);
    }
    for(const s of active)if(!sent.has(s)) {
      if(!send({type:'subscribe',symbol:wireSymbol(s)}))return;
      sent.add(s);
    }
  }
  function receive(data) {
    if(typeof data!=='string'||data.length>1048576){retry('INVALID_FRAME');return;}
    let message;try{message=JSON.parse(data);}catch{retry('INVALID_JSON');return;}
    if(!message || typeof message!=='object' || Array.isArray(message)){retry('INVALID_FRAME');return;}
    if(message.type==='error'){retry('PROVIDER_REJECTED',300000);return;} // Never expose echoed tokens/provider payloads.
    if(message.type==='ping'){framesAt=now();return;}
    if(message.type!=='trade'||!Array.isArray(message.data)||message.data.length>10000)return;
    framesAt=now();
    for(const item of message.data) {
      const symbol=canonicalSymbol(item?.s),old=records.get(symbol);
      if(!item || !sent.has(symbol) || item.s!==wireSymbol(symbol) || typeof item.p!=='number' || !Number.isFinite(item.p) || item.p<=0 ||
        !Number.isSafeInteger(item.t)||item.t<=0||item.t>now()+1000 || old&&item.t<old.quoteAt) {counts.rejectedTrades++;continue;}
      // Confirmation belongs to this socket, even when a reconnect replays its last trade.
      confirmed.add(symbol);status='streaming';failures=0;errorCode=null;
      if(old&&old.quoteAt===item.t&&old.price===item.p)continue;
      const size=typeof item.v==='number'&&Number.isFinite(item.v)&&item.v>=0?item.v:null;
      records.set(symbol,Object.freeze({symbol,price:item.p,quoteAt:item.t,receivedAt:now(),sourceTimestamp:new Date(item.t).toISOString(),
        size,exchange:null,conditions:Object.freeze(Array.isArray(item.c)?item.c.filter(x=>typeof x==='string').slice(0,32):[])}));
      counts.receivedTrades++;for(const fn of listeners)fn(symbol);
    }
  }
  function connect() {
    if(!running||!active.size||socket||now()<nextAt)return;
    const epoch=++generation;status='connecting';openedAt=now();framesAt=null;counts.reconnects++;
    try {
      const current=socket=newSocket('wss://ws.finnhub.io?token='+encodeURIComponent(token));
      const isCurrent=()=>running&&generation===epoch&&socket===current;
      current.addEventListener('open',()=>{if(isCurrent()){status='subscribing';reconcile();}});
      current.addEventListener('message',event=>{if(isCurrent())receive(event.data);});
      current.addEventListener('error',()=>{if(isCurrent())retry('SOCKET_ERROR');});
      current.addEventListener('close',()=>{if(isCurrent())retry('SOCKET_CLOSED');});
    } catch {retry('CONNECT_FAILED');}
  }
  function step() {
    if(!running)return;
    if(!active.size){disconnect();status='idle';return;}
    if(socket?.readyState===0&&now()-openedAt>=15000){retry('CONNECT_TIMEOUT');return;}
    // Finnhub sends application pings independent of instrument trading activity.
    if(socket?.readyState===1&&now()-(framesAt??openedAt)>=90000){retry('STREAM_SILENT');return;}
    connect();reconcile();
  }
  function touch(s) {
    if(!supports(s))return false;
    if(!active.has(s)&&active.size>=maxSymbols){counts.droppedSymbols++;return false;}
    active.add(s);step();return true;
  }
  function retain(symbols) {
    const keep=new Set(symbols);
    for(const s of active)if(!keep.has(s)){active.delete(s);confirmed.delete(s);records.delete(s);}
    step();
  }
  const connectionHealthy=()=>socket?.readyState===1&&framesAt!==null&&now()-framesAt<90000;
  return {
    supports,touch,retain,step,
    start(){if(running||!token)return;running=true;status='idle';failures=0;nextAt=0;errorCode=null;timer=schedule(step,1000);timer?.unref?.();step();},
    stop(){running=false;generation++;if(timer!==null)cancel(timer);timer=null;disconnect();active.clear();records.clear();status=token?'stopped':'disabled';},
    read(s){if(!active.has(s))return null;return {trade:records.get(s)||null,connectionCheckedAt:framesAt,connectionHealthy:connectionHealthy(),
      source:'finnhub',coverage:COVERAGE,delayMinutes:null,state:status==='streaming'&&!confirmed.has(s)?'subscribing':status,
      errorCode,snapshot:null,snapshotCheckedAt:null};},
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    diagnostics:()=>({enabled:!!token,status,errorCode,nextConnectAt:nextAt,active:active.size,activeSymbols:[...active],maxSymbols,
      socket:!!socket,connectionCheckedAt:framesAt,connectionHealthy:connectionHealthy(),confirmedSymbols:[...confirmed],counts:{...counts},coverage:COVERAGE,delayMinutes:null})
  };
}
