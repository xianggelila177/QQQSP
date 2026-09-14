// Quote/chart prices remain in the provider's original currency unit. These
// helpers return factors only; volume and percentage changes are never scaled.
export const FX_CURRENCIES=Object.freeze(['USD','JPY','KRW','HKD','GBP','EUR','CHF','CAD','AUD','INR','SGD','TWD','BRL','MXN','ZAR']);
export const REFERENCE_CURRENCIES=Object.freeze(['CNY',...FX_CURRENCIES.filter(c=>!['USD','TWD'].includes(c))]);
export function currencyUnitInfo(raw='USD'){
  const unit=String(raw||'USD');
  if(unit==='GBp'||unit==='GBX')return {unit,currency:'GBP',scale:.01};
  if(unit==='ZAc'||unit==='ZAC')return {unit,currency:'ZAR',scale:.01};
  return {unit,currency:unit.toUpperCase(),scale:1};
}
export function currencyToCny(raw,rates={},options={}){
  if(options.index)return null;
  const {currency,scale}=currencyUnitInfo(raw);
  if(currency==='CNY')return scale;
  if(options.fxStale)return null;
  const usd=rates?.USD,units=rates?.[currency];
  if(!(typeof usd==='number'&&Number.isFinite(usd)&&usd>0))return null;
  if(currency==='USD')return usd*scale;
  return typeof units==='number'&&Number.isFinite(units)&&units>0?usd/units*scale:null;
}
export function usableFxRates(rates){return !!rates&&typeof rates.USD==='number'&&Number.isFinite(rates.USD)&&rates.USD>0;}
