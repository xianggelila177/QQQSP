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
