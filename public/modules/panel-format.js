(() => {
  const numeric = value => {
    if(typeof value!=='number' && (typeof value!=='string'||!value.trim()))return null;
    const n=Number(value);return Number.isFinite(n)?n:null;
  };
  const fmtNum = (value, digits = 2) => {const n=numeric(value);return n==null?'—':n.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});};
  const fmtVol = value => {const n=numeric(value);return n==null||n<0?'—':n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(n);};
  const pct = value => {const n=numeric(value);return n==null?'—':(n>=0?'+':'')+n.toFixed(2)+'%';};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fmtDate = (t, withTime = true) => { const d = new Date((t + 8 * 3600) * 1000), pad = n => String(n).padStart(2, '0'); const date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); return withTime ? date + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) : date; };
  const fmtTime8 = t => fmtDate(t / 1000).slice(5).replace(/^0/, '');
  const createFormatter = ({ data = {}, displayCurrency = 'USD', fxMap = {} } = {}) => {
    const sourceInfo = window.PANEL_CURRENCY.currencyUnit(data.currency), source = sourceInfo.unit, index = data.instrumentType === 'INDEX' || data.priceUnit === 'POINTS';
    const rates=data.fxKind?data.fxMap||{}:fxMap;
    const convert = (value, from = source, to = displayCurrency) => window.PANEL_CURRENCY.convert(value, from, to, rates, { index, fxStale: data.fxStale === true });
    const canConvert = index || displayCurrency === 'NATIVE' || displayCurrency === source || convert(data.price) != null;
    const unit = index ? '点' : displayCurrency === 'NATIVE' ? source : canConvert ? displayCurrency : source;
    const referenceConversion=!index&&canConvert&&source!==unit&&data.fxKind==='reference';
    const money = value => { if(value == null) return '—'; const converted = convert(value); return (referenceConversion?'≈':'')+(!index && unit === 'CNY' ? '¥' : '') + fmtNum(converted == null ? value : converted); };
    const sourceDescription = !index && sourceInfo.scale !== 1 ? '报价原币 '+source+'（100 '+source+' = 1 '+sourceInfo.base+'）' : '';
    return Object.freeze({ money, convert, canConvert, unit, referenceConversion, sourceDescription });
  };
  window.PANEL_FORMAT = Object.freeze({ createFormatter, fmtNum, fmtVol, pct, esc, fmtDate, fmtTime8 });
})();
