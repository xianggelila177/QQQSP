// Financial facts are independent from price ticks. Never coerce missing data
// to zero, infer a trade amount from last price, or infer depth from top-of-book.
export const BASIC_FIELDS=Object.freeze(['turnoverAmount','turnoverRate','amplitude','priceToBook','peTTM','marketCap','floatMarketCap','sharesOutstanding','floatShares','volumeRatio','orderImbalance','peLYR','psTTM','dividendTTM','dividendYieldTTM','lotSize']);
export function financialNumber(value) {
  if(value&&typeof value==='object'&&!Array.isArray(value))value=value.raw;
  if(typeof value==='string'){
    const text=value.trim();
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))return null;
    value=Number(text);
  }
  return typeof value==='number'&&Number.isFinite(value)?value:null;
}
export function fact(value,metadata={}) {
  const n=financialNumber(value);
  return {value:n,status:n==null?'unavailable':'available',...metadata};
}
const positive=v=>{const n=financialNumber(v);return n!=null&&n>0?n:null;};
const nonnegative=v=>{const n=financialNumber(v);return n!=null&&n>=0?n:null;};
const atMs=v=>{const n=positive(v);return n==null?null:n<1e12?n*1000:n;};
const absent=reason=>({value:null,status:'unavailable',reason});
const inapplicable=()=>({value:null,status:'not-applicable',reason:'instrument-type'});
const REGULAR=new Set(['REGULAR','CACHED_REGULAR','CN_SNAPSHOT']);

export function regularStatistics(quote) {
  const explicit=quote.tradingStats;
  if(explicit?.session==='REGULAR')return {...explicit,asOf:atMs(explicit.asOf),source:explicit.source||quote.src};
  if(!REGULAR.has(quote.ohlcSession))return null;
  // Extended quotes can coexist with a regular-session cumulative volume. Keep
  // that statistic's own date, not the extended trade or the successful check.
  return {session:'REGULAR',volume:quote.volume,turnoverAmount:quote.turnoverAmount,high:quote.dayHigh,low:quote.dayLow,prevClose:quote.prevClose,
    volumeUnit:quote.volumeUnit,asOf:atMs(quote.regularQuoteAt??quote.quoteAt??quote.ts),source:quote.statisticsSource||quote.src,currency:quote.currency};
}

export function buildBasicMetrics(quote,record=null,{now=Date.now(),ttlMs=21600000,maxAgeMs=604800000,loading=false,enabled=true,failure=null}={}) {
  const valid=record?.symbol===quote.symbol&&Number.isFinite(record.fetchedAt)&&record.fetchedAt<=now+5000,age=valid?Math.max(0,now-record.fetchedAt):Infinity;
  const expired=age>=maxAgeMs,stale=valid&&(age>=ttlMs||!!failure);
  const reportedKind=valid&&!expired&&['EQUITY','ETF','MUTUALFUND','INDEX','FUTURE'].includes(record.instrumentType)?record.instrumentType:null;
  const kind=(!quote.instrumentType||quote.instrumentTypeSource==='inferred')&&reportedKind?reportedKind:quote.instrumentType||'EQUITY';
  const equity=kind==='EQUITY',fund=['ETF','MUTUALFUND'].includes(kind),security=equity||fund,facts=valid&&!expired&&enabled?record.fields||{}:{};
  const fields=Object.fromEntries(BASIC_FIELDS.map(k=>[k,security?absent(!enabled?'disabled':expired&&valid?'expired':loading?'loading':'source-missing'):inapplicable()]));
  function read(key){
    const field=facts[key];if(!field)return null;
    return {...field,...(stale?{stale:true}:{})};
  }
  for(const key of ['sharesOutstanding','floatShares','lotSize','dividendTTM','dividendYieldTTM'])if(security&&read(key))fields[key]=read(key);
  for(const key of ['priceToBook','peTTM','peLYR','psTTM','marketCap','floatMarketCap']){
    if(!equity)fields[key]=inapplicable();else if(read(key))fields[key]=read(key);
  }
  for(const key of ['sharesOutstanding','floatShares','lotSize','marketCap','floatMarketCap'])if(fields[key].value!=null&&!(fields[key].value>0))fields[key]=absent('nonpositive-denominator');
  for(const key of ['peTTM','peLYR'])if(fields[key].value!=null&&fields[key].value<=0)fields[key]={...fields[key],value:null,status:fields[key].value<0?'loss':'unavailable',reason:fields[key].value<0?'negative-earnings':'zero-earnings'};
  if(fields.priceToBook.value!=null&&fields.priceToBook.value<=0)fields.priceToBook={...fields.priceToBook,value:null,status:'nonpositive-book',reason:'nonpositive-book'};
  if(fields.psTTM.value!=null&&fields.psTTM.value<=0)fields.psTTM=absent('nonpositive-revenue');
  const shares=positive(fields.sharesOutstanding.value),float=positive(fields.floatShares.value),floatConflict=float!=null&&shares!=null&&float>shares;
  if(floatConflict){fields.floatShares={...fields.floatShares,value:null,status:'conflict',reason:'float-exceeds-total'};fields.floatMarketCap=absent('float-exceeds-total');}
  const stats=regularStatistics(quote),statInfo={source:stats?.source||null,asOf:stats?.asOf||null,basis:'regular-session',...(quote.stale?{stale:true}:{})};
  const volume=stats&&(!stats.volumeUnit||stats.volumeUnit==='shares')?nonnegative(stats.volume):null;
  if(security&&stats){
    const amount=nonnegative(stats.turnoverAmount);
    fields.turnoverAmount=amount==null?absent('no-trade-amount'):fact(amount,{...statInfo,currency:stats.currency||quote.currency,unit:'money'});
    const denominator=!floatConflict?(float??shares):null,basis=float!=null?'float-shares':'total-shares';
    if(volume!=null&&denominator!=null){
      const shareInfo=basis==='float-shares'?fields.floatShares:fields.sharesOutstanding;
      fields.turnoverRate=fact(volume/denominator*100,{...statInfo,unit:'percent',basis,denominator,shareSource:shareInfo.source,shareAsOf:shareInfo.asOf??null,stale:!!(statInfo.stale||shareInfo.stale)});
    }else fields.turnoverRate=absent(floatConflict?'float-exceeds-total':volume==null?'no-regular-volume':'no-shares');
  }else if(security){fields.turnoverRate=absent('no-regular-volume');fields.turnoverAmount=absent('no-trade-amount');}
  const hi=positive(stats?.high),lo=positive(stats?.low),prev=positive(stats?.prevClose);
  fields.amplitude=hi!=null&&lo!=null&&prev!=null&&hi>=lo?fact((hi-lo)/prev*100,{...statInfo,unit:'percent'}):absent('no-regular-range');
  // A source-provided flow statistic needs an explicit definition, timestamp
  // and session. Otherwise it is not the screenshot's intraday volume ratio.
  if(security){
    fields.volumeRatio=absent('no-five-day-minute-baseline');fields.orderImbalance=absent('no-order-book');
    const ratio=stats?.volumeRatio;
    if(ratio?.basis==='five-day-per-minute'&&positive(ratio.asOf)&&nonnegative(ratio.value)!=null)fields.volumeRatio=fact(ratio.value,{source:stats.source,asOf:atMs(ratio.asOf),basis:ratio.basis,unit:'ratio'});
    const imbalance=stats?.orderImbalance;
    if(imbalance?.basis==='full-displayed-book'&&positive(imbalance.asOf)&&financialNumber(imbalance.value)!=null&&Math.abs(imbalance.value)<=100)fields.orderImbalance=fact(imbalance.value,{source:stats.source,asOf:atMs(imbalance.asOf),basis:imbalance.basis,unit:'percent'});
  }
  // Float value is a transparent estimate, not a second vendor's reported cap.
  // No share-count inference from rounded market caps. Source currency stays explicit.
  if(equity&&!floatConflict&&float!=null&&positive(quote.price)!=null&&!fields.floatMarketCap.value){
    const unit=quote.currency==='GBp'||quote.currency==='GBX'?{currency:'GBP',scale:.01}:quote.currency==='ZAc'||quote.currency==='ZAC'?{currency:'ZAR',scale:.01}:{currency:quote.currency,scale:1};
    fields.floatMarketCap=fact(quote.price*unit.scale*float,{currency:unit.currency,unit:'money',source:quote.src,shareSource:fields.floatShares.source,
      asOf:atMs(quote.quoteAt??quote.ts),shareAsOf:fields.floatShares.asOf??null,basis:'price-times-float',estimated:true,stale:!!(quote.stale||fields.floatShares.stale)});
  }
  const available=Object.values(fields).filter(f=>f.value!=null||['loss','nonpositive-book'].includes(f.status)).length;
  return {schemaVersion:1,instrumentType:kind,status:!security?'not-applicable':!enabled?'disabled':valid?(expired?'expired':stale?'stale':'ready'):loading?'loading':'unavailable',
    source:valid?record.source:null,fetchedAt:valid?record.fetchedAt:null,financialPeriod:valid?record.financialPeriod||null:null,
    retryAt:failure?.retryAt??null,available,fields};
}
