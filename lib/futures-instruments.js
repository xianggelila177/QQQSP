// Provider namespaces are security identities. A Google/TradingView continuous
// ticker is a related search hint, never proof of identical rolling contracts.
import {readFileSync} from 'node:fs';
export const futuresProducts=Object.freeze(JSON.parse(readFileSync(new URL('../data/futures-products.json',import.meta.url),'utf8')));
export const futuresMarket=Object.freeze({key:'futures',name:'国际期货',label:'国际期货',region:'衍生品',exchange:'CME / CBOT / COMEX / NYMEX',timezone:'America/Chicago',currency:'USD'});
function instrument(product,provider,sourceSymbol){
 const continuous=provider==='yahoo' ? sourceSymbol===product.root+'=F' : sourceSymbol===product.root+'00Y';
 return {...product,symbol:provider==='yahoo'?sourceSymbol:sourceSymbol+'.FUT',sourceSymbol,provider,
  secid:provider==='eastmoney'?product.eastmoneyMarket+'.'+sourceSymbol:null,
  name:product.name+(continuous?(provider==='eastmoney'?' · 东财当月连续':' · Yahoo连续'):' · '+sourceSymbol),
  market:'futures',type:'FUTURE',providerType:'FUTURE',typeSource:'catalog',continuous,
  seriesNote:continuous?'供应商连续序列；换月口径可能不同，不与其他来源拼接':'指定月份合约；历史只使用此代码',
  aliases:[...(continuous?product.aliases:[]),sourceSymbol],relatedAliases:continuous?product.relatedAliases:[]};
}
export const futureInstruments=Object.freeze(futuresProducts.flatMap(p=>[
 instrument(p,'eastmoney',p.root+'00Y'),instrument(p,'yahoo',p.root+'=F')
]));
const bySymbol=new Map(futureInstruments.map(x=>[x.symbol,x]));
export function futureInstrumentFor(symbol){
 const s=String(symbol||'').toUpperCase();if(bySymbol.has(s))return bySymbol.get(s);
 const m=/^([A-Z]{1,3})(\d{2}[FGHJKMNQUVXZ])\.FUT$/.exec(s);
 const p=m&&futuresProducts.find(p=>p.root===m[1]);
 return p?instrument(p,'eastmoney',m[1]+m[2]):null;
}
export const isFutureSymbol=s=>/^[A-Z0-9][A-Z0-9.-]{0,12}=F$/.test(String(s||'').toUpperCase())||!!futureInstrumentFor(s);
export function futuresDirectory(){return {...futuresMarket,benchmarks:[],examples:futureInstruments.map(({symbol,name,type})=>({symbol,name,type})),sourceNote:'期货不是现货指数。连续合约可能换月；Google代码仅作相关检索。延迟与交易日历未保证，来源不可用时不会补造行情。'};}
export function futureSearchNote(query,row){
 const q=String(query||'').toUpperCase();
 if(q==='NQ0W')return 'NQ0W 未核实为标准代码；以下是 CME 纳指100期货的相关候选，不等同现货纳指。';
 return '相关产品候选；'+row.seriesNote+'。原输入不是本来源的精确行情代码。';
}
