import {catalogInstruments,MARKET_REGISTRY} from './market-registry.js';
import {futuresMarket,futureSearchNote} from './futures-instruments.js';
const key=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\s（）()_-]/g,'');
const typeTerms={INDEX:['指数','index'],FUTURE:['期货','国际期货','futures','夜盘'],ETF:['etf','交易所交易基金'],EQUITY:['股票','stock']};
// Build a small immutable local index once, not on every keystroke.
const index=catalogInstruments().map(row=>({row,code:key(row.symbol),names:[row.name,...row.aliases||[]].map(key),
 related:(row.relatedAliases||[]).map(key),terms:[MARKET_REGISTRY[row.market]?.label,row.exchange,...typeTerms[row.type]||[]].filter(Boolean).map(key)}));
export function catalogSearch(query){
 const q=key(query);if(!q)return [];
 return index.map(item=>{
  const {code,names,related,terms}=item;
  const match=code===q?'symbol':names.includes(q)?'alias':related.includes(q)?'related':'partial';
  const score=match==='symbol'?6:match==='alias'?5:match==='related'?4:[code,...names,...terms].some(x=>x.includes(q))?2:0;
  return {...item,match,score};
 }).filter(x=>x.score).sort((a,b)=>b.score-a.score).slice(0,40).map(({row,score,match})=>{
  const market=MARKET_REGISTRY[row.market]||futuresMarket;
  return {symbol:row.symbol,name:row.name,type:row.type,market:market.label,exch:row.exchange||market.exchange,
   currency:row.currency||market.currency,source:'catalog',exact:score>=5,matchType:match,
   ...(row.type==='FUTURE'?{seriesNote:row.seriesNote}:{}),
   ...(match==='related'?{matchNote:futureSearchNote(query,row)}:{})};
 });
}
