// Only the composition root supplies process.env. Modules receive explicit values.
export const DEFAULTS=Object.freeze({
  HOST:'127.0.0.1',PORT:8567,SYMBOLS:'QQQ,SPY',PUBLIC_ORIGIN:'',STATS_TOKEN:'',
  REALTIME_SNAPSHOTS:'1',PUBLIC_SOURCE_REDUNDANCY:'1',RECOVERY_PATH:'./state/quotes.json',FX_MODE:'reference',
  POLL_MS:1000,POLL_PRIMARY:'sina',CACHE_MS:2000,QUOTE_MAX_AGE:10000,UPSTREAM_TIMEOUT:8000,UPSTREAM_MAX_BODY_BYTES:2097152,
  Y429_BASE:30000,Y429_CAP:900000,Y_TASK_DEADLINE:20000,
  SLOW_TTL:300000,NEWS_TTL:540000,NEWS_FAILURE_COOLDOWN:60000,NEWS_MAX_ENTRIES:48,NEWS_MAX_ACTIVE:12,
  AUTH_TTL:3300000,AUTH_FAILURE_COOLDOWN:60000,FX_FAILURE_COOLDOWN:60000,
  ALPACA_ENABLED:'0',ALPACA_FEED:'iex',APCA_API_KEY_ID:'',APCA_API_SECRET_KEY:'',
  ALPACA_MAX_SYMBOLS:12,ALPACA_SNAPSHOT_MS:60000,ALPACA_REST_MIN_GAP_MS:2000,ALPACA_ACTIVE_TTL_MS:300000,
  FINNHUB_TOKEN:'',LOG_LEVEL:'info',LOG_FILE:'./logs/panel.log',LOG_MAX_BYTES:10485760,LOG_MAX_FILES:3
});
export function loadConfig(input={}){
  const result={...DEFAULTS};
  for(const [key,def] of Object.entries(DEFAULTS)){
    if(input[key]==null||input[key]==='')continue;
    const value=typeof def==='number'?Number(input[key]):String(input[key]);
    if(typeof def==='number'&&(!Number.isInteger(value)||value<0||!Number.isSafeInteger(value)))throw new TypeError('配置必须为非负整数：'+key);
    result[key]=value;
  }
  if(result.POLL_MS<1000||result.POLL_MS>60000)throw new TypeError('POLL_MS 必须为 1000～60000');
  if(!['sina','tencent'].includes(result.POLL_PRIMARY))throw new TypeError('POLL_PRIMARY 必须为 sina 或 tencent');
  if(result.PORT>65535)throw new TypeError('PORT 超出范围');
  if(!['reference','market'].includes(result.FX_MODE))throw new TypeError('FX_MODE 必须为 reference 或 market');
  for(const key of ['REALTIME_SNAPSHOTS','PUBLIC_SOURCE_REDUNDANCY','ALPACA_ENABLED'])if(!['0','1'].includes(result[key]))throw new TypeError(key+' 必须为 0 或 1');
  if(result.Y429_CAP<result.Y429_BASE)throw new TypeError('退避上限小于初始等待');
  if(!['debug','info','warn','error'].includes(result.LOG_LEVEL))throw new TypeError('LOG_LEVEL 无效');
  return Object.freeze(result);
}
