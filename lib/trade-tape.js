import {tradingDayInfo} from './market-calendar-api.js';
import {localDateAt} from './history-contract.js';
import {timezoneForSymbol} from '../mkt.mjs';

// This is the received stream fragment, not an exchange-complete trade feed.
export function createTradeTape({maxPerSymbol=1000,now=Date.now}={}){
  const active=new Set(),entries=new Map(),ids=new Map();
  const retain=symbols=>{
    const keep=new Set(symbols);
    for(const symbol of active)if(!keep.has(symbol)){entries.delete(symbol);ids.delete(symbol);}
    active.clear();for(const symbol of keep)active.add(symbol);
  };
  function record(event){
    const {symbol,source,price,size,at,id,connectionCursor,exchange}=event||{};
    if(!active.has(symbol)||typeof source!=='string'||!source||!Number.isFinite(price)||price<=0||
      !Number.isFinite(size)||size<=0||!Number.isFinite(at)||at<=0||at>now()+1000)return false;
    const key=id!=null?source+':'+(exchange||'')+':id:'+String(id):connectionCursor!=null?source+':cursor:'+String(connectionCursor):null;
    if(!key)return false;
    let seen=ids.get(symbol);if(!seen){seen=new Set();ids.set(symbol,seen);}
    if(seen.has(key))return false;
    const item=Object.freeze({symbol,source,price,size,sizeUnit:'shares',currency:'USD',at,receivedAt:now(),
      eventId:id==null?null:String(id),exchange:exchange||null,side:null,
      quality:id==null?'CONNECTION_CURSOR_UNVERIFIED_ACROSS_RECONNECT':null,reportState:'reported',_key:key});
    let list=entries.get(symbol);if(!list){list=[];entries.set(symbol,list);}
    list.push(item);seen.add(key);
    if(list.length>maxPerSymbol){const removed=list.shift();seen.delete(removed._key);}
    return true;
  }
  function invalidate({symbol,source,id,exchange,kind}={}){
    if(!active.has(symbol)||id==null)return false;
    const list=entries.get(symbol);if(!list)return false;
    const key=source+':'+(exchange||'')+':id:'+String(id),index=list.findIndex(e=>e._key===key);
    if(index<0)return false;
    list[index]=Object.freeze({...list[index],reportState:kind==='correction'?'corrected':'cancelled',receivedAt:now()});
    return true;
  }
  function snapshot(symbol,tradeDate){
    const list=entries.get(symbol)||[];
    const day=tradeDate?tradingDayInfo(symbol,tradeDate):null;
    if(!day?.known||!day.is_open)return {status:'unavailable',reason:'REGULAR_SESSION_UNKNOWN',events:[],coverage:null};
    const zone=timezoneForSymbol(symbol);
    const events=list.filter(e=>localDateAt(e.at,zone)===tradeDate&&
      day.regular_sessions.some(s=>e.at>=s.open_at_ms&&e.at<s.close_at_ms))
      .sort((a,b)=>a.at-b.at||a.receivedAt-b.receivedAt)
      .map(({_key,...rest})=>rest);
    return {status:events.length?'partial':'unavailable',reason:events.length?'RECEIVED_FRAGMENT':'NO_RECEIVED_TRADES',
      tradeDate,events,coverage:events.length?{firstAt:events[0].at,lastAt:events.at(-1).at,count:events.length,
        scope:'received-stream-fragment',complete:false}:null};
  }
  return Object.freeze({retain,record,invalidate,snapshot,diagnostics:()=>({active:active.size,events:[...entries.values()].reduce((n,v)=>n+v.length,0),maxPerSymbol})});
}
