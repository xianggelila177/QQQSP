// Volume units are independent of the quote currency and price scale.
// Nasdaq historical stock/ETF volumes and Yahoo chart OHLCV volumes are share counts.
const US_SHARE_SOURCES=new Set(['nasdaq-history','yahoo','alpaca-iex','alpaca-sip','finnhub-candle','naver-world-chart']);
const US_SHARE_TYPES=new Set(['EQUITY','ETF']);

export function volumeCapability({source,market,instrumentType}={}){
  if(market==='us'&&US_SHARE_SOURCES.has(source)&&US_SHARE_TYPES.has(instrumentType))
    return {unit:'shares',scale:1,status:'verified',kind:'interval',revision:'volume-normalizer-v1'};
  return {unit:null,scale:null,status:'unverified',kind:'interval',revision:'volume-normalizer-v1'};
}

function rawNumber(value){
  if(typeof value==='string'){
    const clean=value.trim().replaceAll(',','');
    if(!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(clean))return null;
    value=Number(clean);
  }
  return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
}

export function normalizeVolume({source,market,instrumentType,rawVolume,unit,scale,kind='interval',coverage,
  tradeDate,session}={}){
  const capability=volumeCapability({source,market,instrumentType});
  const raw=rawNumber(rawVolume);
  if(raw===null)return {value:null,unit:capability.unit,kind,status:'missing',source:source||null,
    coverage:coverage||null,tradeDate:tradeDate||null,session:session||null,missingReason:'SOURCE_VOLUME_MISSING'};
  if(kind!=='interval'&&kind!=='trade'&&kind!=='session-total')return {value:null,unit:null,kind,status:'unverified',source:source||null,
    coverage:coverage||null,tradeDate:tradeDate||null,session:session||null,missingReason:'VOLUME_KIND_UNVERIFIED'};
  const selectedUnit=unit??capability.unit,selectedScale=scale??capability.scale;
  if(capability.status!=='verified'||selectedUnit!==capability.unit||selectedScale!==capability.scale)
    return {value:null,unit:null,kind,status:'unverified',source:source||null,
      coverage:coverage||null,tradeDate:tradeDate||null,session:session||null,missingReason:'VOLUME_UNIT_UNVERIFIED'};
  const value=raw*selectedScale;
  return {value:Number.isFinite(value)?value:null,unit:selectedUnit,kind,
    status:Number.isFinite(value)?'ready':'unverified',source:source||null,coverage:coverage||null,
    tradeDate:tradeDate||null,session:session||null,
    missingReason:Number.isFinite(value)?null:'VOLUME_OVERFLOW'};
}
