import {marketKeyFor} from '../instruments.js';
// Optional token-based backup. No REST polling; coverage/delay remain unverified.
// Protocol reference: https://finnhub.io/docs/api/websocket-trades
export function createFinnhubProvider({token='',now=Date.now,newSocket=url=>new WebSocket(url),schedule=setInterval,cancel=clearInterval,random=Math.random}={}) {
  const active=new Set(),sent=new Set(),records=new Map(),listeners=new Set();
  let socket=null,timer=null,running=false,status='idle',nextAt=0,failures=0,errorCode=null,openedAt=0,framesAt=0;
  const counts={receivedTrades:0,rejectedTrades:0,reconnects:0};
  const supports=s=>!!token&&/^[A-Z]{1,6}$/.test(s)&&marketKeyFor(s)==='us';
  function disconnect(){const old=socket;socket=null;sent.clear();old?.close();}
  function retry(code,minimum=1000){errorCode=code;failures=Math.min(failures+1,10);nextAt=now()+Math.max(minimum,Math.min(300000,1000*2**(failures-1)))+Math.floor(random()*1000);status='backoff';disconnect();}
  function reconcile(){if(socket?.readyState!==1)return;for(const s of sent)if(!active.has(s)){socket.send(JSON.stringify({type:'unsubscribe',symbol:s}));sent.delete(s);}for(const s of active)if(!sent.has(s)){socket.send(JSON.stringify({type:'subscribe',symbol:s}));sent.add(s);}}
  function connect(){
    if(!running||!active.size||socket||now()<nextAt)return;
    status='connecting';openedAt=now();const current=socket=newSocket('wss://ws.finnhub.io?token='+encodeURIComponent(token));counts.reconnects++;
    current.addEventListener('open',()=>{if(socket!==current)return;status='subscribing';framesAt=now();reconcile();});
    current.addEventListener('message',event=>{
      if(socket!==current)return;framesAt=now();let message;try{message=JSON.parse(String(event.data));}catch{return;}
      if(message.type==='error'){retry('PROVIDER_REJECTED',300000);return;} // Do not log echoed tokens / provider payloads.
      if(message.type!=='trade'||!Array.isArray(message.data))return;
      for(const item of message.data){
        const old=records.get(item.s);if(!active.has(item.s)||typeof item.p!=='number'||!Number.isFinite(item.p)||item.p<=0||!Number.isSafeInteger(item.t)||item.t<=0||item.t>now()+1000||old&&item.t<old.quoteAt){counts.rejectedTrades++;continue;}
        if(old&&old.quoteAt===item.t&&old.price===item.p)continue;
        records.set(item.s,Object.freeze({symbol:item.s,price:item.p,quoteAt:item.t,receivedAt:now(),sourceTimestamp:new Date(item.t).toISOString(),size:item.v??null,exchange:null,conditions:Array.isArray(item.c)?item.c:[]}));
        counts.receivedTrades++;status='streaming';failures=0;errorCode=null;for(const fn of listeners)fn(item.s);
      }
    });
    current.addEventListener('error',()=>{if(socket===current)retry('SOCKET_ERROR');});
    current.addEventListener('close',()=>{if(socket===current)retry('SOCKET_CLOSED');});
  }
  function step(){if(!running)return;if(!active.size){disconnect();status='idle';return;}if(socket?.readyState===0&&now()-openedAt>15000){retry('CONNECT_TIMEOUT');return;}if(socket?.readyState===1&&framesAt&&now()-framesAt>90000){retry('STREAM_SILENT');return;}connect();reconcile();}
  function touch(s){if(!supports(s))return false;active.add(s);step();return true;}
  function retain(symbols){const keep=new Set(symbols);for(const s of active)if(!keep.has(s)){active.delete(s);records.delete(s);}step();}
  return {supports,touch,retain,step,start(){if(running)return;running=true;timer=schedule(step,1000);timer?.unref?.();step();},stop(){running=false;cancel(timer);timer=null;disconnect();active.clear();records.clear();status='stopped';},
    read(s){if(!active.has(s))return null;const trade=records.get(s)||null;return {trade,connectionCheckedAt:framesAt,source:'finnhub',coverage:'账户授权范围（未核验全市场覆盖）',delayMinutes:null,state:status==='streaming'&&!trade?'subscribing':status,errorCode,snapshot:null,snapshotCheckedAt:null};},
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},diagnostics:()=>({enabled:!!token,status,errorCode,nextConnectAt:nextAt,activeSymbols:[...active],socket:!!socket,counts:{...counts},coverage:'账户授权范围；延迟未核验'})};
}
