import {financialNumber,fact} from '../fundamentals.js';

// These layouts differ by market. CN volume is lots of 100, CN money below
// is the exact yuan total in column 35; US volume/money are shares/dollars.
export function tencentFinancials(p,{symbol,instrumentType,currency,quoteAt,now}) {
  const cn=/^\d{6}\.(SS|SZ)$/.test(symbol),us=/^[A-Z][A-Z0-9.-]*$/.test(symbol);
  if(!cn&&!us)return null;
  const fields={},source='tencent-financial',f=p.raw;
  const put=(key,value,extra={})=>{
    const n=financialNumber(value);if(n==null)return;
    fields[key]=fact(n,{source,asOf:null,quoteReferenceAt:quoteAt,...extra});
  };
  put('sharesOutstanding',f[cn?72:62],{unit:'shares'});
  put('floatShares',f[cn?73:63],{unit:'shares'});
  if(instrumentType==='EQUITY'){
    put('priceToBook',f[cn?46:51],{unit:'ratio',basis:'latest-book',asOf:quoteAt});
    // Capitalization columns are in hundreds of millions of native currency.
    for(const [key,index] of [['marketCap',45],['floatMarketCap',44]]){
      const n=financialNumber(f[index]);if(n!=null)put(key,n*1e8,{unit:'money',currency,asOf:quoteAt});
    }
  }
  return Object.keys(fields).length?{symbol,source,instrumentType,fetchedAt:now,refreshAfterMs:60000,fields}:null;
}

export function tencentTurnoverAmount(p,symbol) {
  const cn=/^\d{6}\.(SS|SZ)$/.test(symbol),us=/^[A-Z][A-Z0-9.-]*$/.test(symbol);
  let amount=null;
  if(cn){
    const parts=String(p.raw[35]||'').split('/');
    if(parts.length===3&&financialNumber(parts[0])===p.price&&financialNumber(parts[1])===p.volume)amount=financialNumber(parts[2]);
    if(amount==null){const tenThousands=financialNumber(p.raw[57]);if(tenThousands!=null)amount=tenThousands*10000;}
  }else if(us)amount=financialNumber(p.raw[37]);
  return amount!=null&&amount>=0?amount:null;
}
