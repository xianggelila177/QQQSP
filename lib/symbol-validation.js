import {MARKET_SUFFIXES} from './market-registry.js';
export function symbolValid(symbol){
 const s=String(symbol||'').toUpperCase();
 if(!s.length||s.length>16)return false;
 if(/^[A-Z][A-Z0-9.-]{0,15}$/.test(s)||/^\^[A-Z0-9=.-]{1,15}$/.test(s))return true;
 const m=/^([A-Z0-9][A-Z0-9&-]*)\.([A-Z]{1,4})$/.exec(s);
 return !!m&&Object.hasOwn(MARKET_SUFFIXES,m[2])&&(!m[1].includes('&')||m[2]==='NS');
}
