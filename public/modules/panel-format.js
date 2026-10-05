(() => {
  const numeric = value => {
    if(typeof value!=='number' && (typeof value!=='string'||!value.trim()))return null;
    const n=Number(value);return Number.isFinite(n)?n:null;
  };
  const fmtNum = (value, digits = 2) => {const n=numeric(value);return n==null?'—':n.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});};
  const fmtVol = value => {const n=numeric(value);return n==null||n<0?'—':n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(n);};
  const exactSizeFormat=new Intl.NumberFormat('en-US',{maximumSignificantDigits:21});
  const fmtSize=value=>{const n=numeric(value);return n==null||n<0?'—':exactSizeFormat.format(n);};
  const pct = value => {const n=numeric(value);return n==null?'—':(n>=0?'+':'')+n.toFixed(2)+'%';};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fmtDate = (t, withTime = true) => { const d = new Date((t + 8 * 3600) * 1000), pad = n => String(n).padStart(2, '0'); const date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); return withTime ? date + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) : date; };
  const fmtTime8 = t => fmtDate(t / 1000).slice(5).replace(/^0/, '');
  const historyGapNote=(meta={},bar=null)=>{
    meta ||= {};
    const quality=meta.historyQuality||{},list=value=>Array.isArray(value)?value:[];
    const dates=[...new Set([...list(bar?.missingTradingDates),...list(quality.missingTradingDates)])]
      .filter(date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&
        (!bar||date>=bar.periodStart&&date<(bar.periodEndExclusive||bar.periodStart+'~'))).sort();
    const invalid=bar?list(bar.qualityFlags).includes('source-invalid-ohlc'):
      quality.reason==='source-invalid-ohlc'||list(meta.warnings).includes('source-invalid-ohlc');
    if(!dates.length)return invalid?'来源数据异常，已排除异常日线；'+(bar?'本周期':'历史')+'覆盖不完整':'';
    return '来源数据异常，已排除 '+dates.slice(0,3).join('、')+(dates.length>3?' 等日期':'')+'；'+(bar?'本周期':'历史')+'缺失 '+dates.length+' 个交易日';
  };
  const quoteBaseline = (data = {}, money = String) => {
    const settlement=data.changeBasis==='previous-settlement',future=data.instrumentType==='FUTURE';
    const label=settlement?'较前结算基准':future?'较来源基准':'较上一交易日常规收盘';
    return Object.freeze({label,shortLabel:settlement?'前结算':future?'来源前值':'昨收',
      text:label+(data.previousCloseTradeDate?' '+data.previousCloseTradeDate:'')+(data.prevClose!=null?' '+money(data.prevClose):'（基准待核验）'),
      title:data.previousCloseMissingReason||data.previousCloseStatus||(future?'期货涨跌按来源声明的结算价或前值计算。':'主涨跌相对报价交易日的上一交易日常规收盘；盘后行相对本交易日常规收盘。')});
  };
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
  window.PANEL_FORMAT = Object.freeze({ createFormatter, quoteBaseline, historyGapNote, fmtNum, fmtVol, fmtSize, pct, esc, fmtDate, fmtTime8 });
})();
