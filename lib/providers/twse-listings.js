// Official MIS identity was checked against ex=tse, c=2330, ch=2330.tw on
// 2026-09-25. Other .TW instruments require the same venue check before use.
const LISTINGS=Object.freeze({'2330.TW':Object.freeze({symbol:'2330.TW',code:'2330',ex:'tse',channel:'2330.tw',instrumentType:'EQUITY',currency:'TWD'})});
export function twseListingFor(symbol){return LISTINGS[String(symbol||'').toUpperCase()]||null;}
