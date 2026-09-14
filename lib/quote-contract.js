// Volume is a numeric contract, including when an upstream sends numeric text.
// Reject coercible objects/booleans, partial numeric strings and unknown values.
export function isUsableChartFamily(bars) {
  return Array.isArray(bars)&&bars.length>0&&bars.every(bar=>bar&&typeof bar==='object'&&
    Number.isFinite(bar.t)&&bar.t>0&&Number.isFinite(bar.c)&&bar.c>0&&
    (bar.v==null||Number.isFinite(bar.v)&&bar.v>=0));
}
export function isTerminalChartField(info) {
  return info?.unsupported===true||['unsupported','no-history','not-applicable'].includes(info?.status);
}
export function volumeNumber(value) {
  if (typeof value === 'string') {
    const text=value.trim();
    if(!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))return null;
    value=Number(text);
  }
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
}
export function totalVolume(bars) {
  if(!bars.length)return null;
  let total=0;
  for(const bar of bars){const value=volumeNumber(bar.v);if(value==null)return null;total+=value;}
  return volumeNumber(total);
}
// Published chart arrays are immutable, enabling safe revision memoization.
export function publishCharts(charts) {
  if (!charts || typeof charts !== 'object') return charts;
  return Object.freeze(Object.fromEntries(Object.entries(charts).map(([key,bars])=>{
    if(!Array.isArray(bars))return [key,bars];
    const normalized=bar=>bar?.v===volumeNumber(bar?.v);
    if(Object.isFrozen(bars)&&bars.every(bar=>Object.isFrozen(bar)&&normalized(bar)))return [key,bars];
    return [key,Object.freeze(bars.map(bar=>Object.isFrozen(bar)&&normalized(bar)?bar:Object.freeze({...bar,v:volumeNumber(bar?.v)})))];
  })));
}
export function publishQuote(quote) {
  if(!quote||typeof quote!=='object')return quote;
  const out={...quote,volume:volumeNumber(quote.volume)};
  if(quote.charts)out.charts=publishCharts(quote.charts);
  if(quote.ext&&typeof quote.ext==='object')out.ext=Object.fromEntries(Object.entries(quote.ext).map(([key,value])=>
    [key,value&&typeof value==='object'&&('volume' in value||key==='pre'||key==='post')?{...value,volume:volumeNumber(value.volume)}:value]));
  return out;
}
