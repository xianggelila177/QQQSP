import { readFileSync } from 'node:fs';
import { MARKET_SUFFIXES } from '../market-registry.js';
const documentation=JSON.parse(readFileSync(new URL('../../data/yahoo-delays.json',import.meta.url),'utf8'));
export function yahooDelayInfo(symbol,meta={},instrumentType=''){
  const value=meta.exchangeDataDelayedBy;
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1440)return {feedDelayMinutes:value,feedDelaySource:'provider'};
  const s=String(symbol||'').toUpperCase(),suffix=/\.([A-Z]+)$/.exec(s)?.[1];
  const index=instrumentType==='INDEX'||s.startsWith('^');
  const delay=index?documentation.explicitIndexMinutes[s]:MARKET_SUFFIXES[suffix]?documentation.suffixMinutes['.'+suffix]:undefined;
  return delay!=null?{feedDelayMinutes:delay,feedDelaySource:'yahoo-documentation',feedDelaySourceUrl:documentation.url}:{feedDelayMinutes:null,feedDelaySource:null};
}
