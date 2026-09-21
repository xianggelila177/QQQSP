import {number} from './context-values.js';
import {currencyUnitInfo} from './currency.js';
// Paid-dividend TTM needs payment-date coverage AND current-share normalization.
// Ex-date-only or process-date-only corporate feeds cannot establish that proof.
export function derivePaidDividends(quote,actions,now){
 if(!quote||!quote.currency||!actions?.paidWindowVerified||!actions?.splitWindowVerified||actions.limited||actions.rejected||actions.stale)return quote;
 const end=new Date(now).toISOString().slice(0,10),cutoff=new Date(now);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-1);const start=cutoff.toISOString().slice(0,10);
 if(actions.start>start||actions.end<end)return quote;
 const unit=currencyUnitInfo(quote.currency),events=actions.events||[],cash=events.filter(e=>e.type==='dividend');
 if(cash.some(e=>!e.payment_date))return quote;
 const recent=cash.filter(e=>e.payment_date>start&&e.payment_date<=end);
 if(recent.some(e=>e.currency!==unit.currency||number(e.amount)===null||e.amount<0||!['nominal_at_ex_date','current_share_basis'].includes(e.amount_basis)))return quote;
 if(recent.length>16)return quote; // Preserve every computational input; do not truncate evidence.
 const inputs=[];let total=0;
 for(const e of recent){
  let factor=1;if(e.amount_basis==='nominal_at_ex_date')for(const split of events.filter(s=>s.type==='split'&&s.ex_date>e.ex_date&&s.ex_date<=end)){if(!(split.ratio>0))return quote;factor*=split.ratio;}
  const value=e.amount/factor;if(!Number.isFinite(value))return quote;total+=value;
  inputs.push({name:'payment '+e.payment_date,value,source:e.source,asOf:e.as_of_ms,period:e.ex_date});
 }
 const fields={...quote.fundamentals?.fields},base={source:actions.source,asOf:now,fetchedAt:actions.sourceCheckedAt,currency:unit.currency,calculated:true,estimated:false,basis:'paid-cash-last-12-months-current-share-basis',financialPeriod:start+'/'+end,inputs};
 if(fields.dividendTTM?.value==null)fields.dividendTTM={...base,value:total,status:'available',unit:'money-per-share',formula:'sum(cash paid in trailing 12 months / subsequent split ratios)'};
 const price=number(quote.regularPrice??quote.regularMarketPrice??(quote.priceSession==='REGULAR'?quote.price:null));
 if(fields.dividendYieldTTM?.value==null&&price>0)fields.dividendYieldTTM={...base,value:total/(price*unit.scale)*100,status:'available',unit:'percent',formula:'event-derived paid dividend TTM / regular price * 100'};
 return {...quote,fundamentals:{...quote.fundamentals,fields}};
}
