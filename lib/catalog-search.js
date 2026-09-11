import {catalogInstruments,MARKET_REGISTRY} from './market-registry.js';
const key=value=>String(value||'').toLowerCase().replace(/[\s（）()_-]/g,'');
// Exact aliases are one-to-many. Never deduplicate by company name.
export function catalogSearch(query){
 const q=key(query);if(!q)return [];
 return catalogInstruments().map(row=>{
  const names=[row.symbol,row.name,...row.aliases||[]].map(key);
  const score=names.includes(q)?2:names.some(x=>x.includes(q))?1:0;
  return {row,score};
 }).filter(x=>x.score).sort((a,b)=>b.score-a.score).slice(0,24).map(({row,score})=>{
  const market=MARKET_REGISTRY[row.market];
  return {symbol:row.symbol,name:row.name,type:row.type,market:market.label,exch:row.exchange||market.exchange,currency:row.currency||market.currency,source:'catalog',exact:score===2};
 });
}
