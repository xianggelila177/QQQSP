(() => {
  // BEGIN GENERATED CURRENCY CONTRACT (lib/currency.js; npm run build)
  const sourceCurrencyUnit = function currencyUnitInfo(raw='USD'){
  const unit=String(raw||'USD').trim();
  if(unit==='GBp'||unit.toUpperCase()==='GBX')return {unit:unit==='GBp'?'GBp':'GBX',currency:'GBP',scale:.01};
  if(unit==='ZAc'||unit.toUpperCase()==='ZAC')return {unit:unit==='ZAc'?'ZAc':'ZAC',currency:'ZAR',scale:.01};
  return {unit:unit.toUpperCase(),currency:unit.toUpperCase(),scale:1};
};
  // END GENERATED CURRENCY CONTRACT
  const currencyUnit = value => {const {unit,currency:base,scale}=sourceCurrencyUnit(value);return {unit,base,scale};};
  const convert = (value, from, to, rates, options = {}) => {
    if (value == null || options.index) return value;
    if (to === 'NATIVE') return value;
    const source = currencyUnit(from), target = currencyUnit(to);
    if (target.unit === source.unit) return value;
    const amount = Number(value) * source.scale;
    if (!Number.isFinite(amount)) return null;
    if (target.base === source.base) return amount / target.scale;
    if (options.fxStale) return null;
    const rate = code => code === 'USD' ? 1 : Number(rates && rates[code === 'CNY' ? 'USD' : code]);
    const sourceRate = rate(source.base), targetRate = rate(target.base);
    if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) return null;
    return amount / sourceRate * targetRate / target.scale;
  };
  window.PANEL_CURRENCY = Object.freeze({ convert, currencyUnit });
})();
