import {createSharedTasks} from './shared-task.js';
import {createCachedResource} from './cached-resource.js';
import { decodeGbkSmart } from './providers/tx.js';
import { classifyMarket, instrumentTypeFor, marketKeyFor } from './instruments.js';
import { log } from '../log.mjs';
import { MARKET_ALIASES, MARKET_SUFFIXES, marketDirectory } from './market-registry.js';
import {canonicalSearchQuery} from './equity-directory.js';
import {symbolValid} from './symbol-validation.js';

  // 中文常用名 → 英文/代码 映射(Yahoo搜索拒绝中文查询, 400)
export const ALIAS = {
    '海力士':'Hynix','sk海力士':'SK hynix','三星':'Samsung','三星电子':'Samsung',
    '腾讯':'Tencent','茅台':'Moutai','贵州茅台':'Moutai','五粮液':'Wuliangye',
    '丰田':'Toyota','索尼':'Sony','苹果':'Apple','英伟达':'Nvidia','特斯拉':'Tesla',
    '微软':'Microsoft','谷歌':'Google','亚马逊':'Amazon','脸书':'Meta','Meta':'Meta',
    '阿里巴巴':'Alibaba','中芯国际':'SMIC','宁德时代':'CATL','比亚迪':'BYD',
    '京东':'JD','百度':'Baidu','网易':'NetEase','拼多多':'PDD','台积电':'TSMC',
    '可口可乐':'Coca-Cola','迪士尼':'Disney','麦当劳':'McDonalds','波音':'Boeing',
    '英特尔':'Intel','amd':'AMD','超微':'AMD','高通':'Qualcomm','思科':'Cisco',
    '奈飞':'Netflix','星巴克':'Starbucks','耐克':'Nike','沃尔玛':'Walmart',
    '现代':'Hyundai','起亚':'Kia','sk电信':'SK Telecom','naver':'Naver','NAVER':'Naver',
    '任天堂':'Nintendo','软银':'SoftBank','优衣库':'Uniqlo','基恩士':'Keyence',
    '汇丰':'HSBC','友邦':'AIA','美团':'Meituan','小米':'Xiaomi','快手':'Kuaishou',
    '伯克希尔':'Berkshire','摩根大通':'JPMorgan','美国银行':'BankOfAmerica','visa':'VISA',
  };

  // 指数别名 → 符号(直接合成候选, 不走Yahoo搜索)
export const ALIAS_SYM = {
    ...MARKET_ALIASES,
    '纳指100':'^NDX','纳斯达克100':'^NDX','纳斯达克100指数':'^NDX','nasdaq100':'^NDX','nasdaq 100':'^NDX','ndx':'^NDX',
    '纳斯达克':'^IXIC','纳指':'^IXIC','纳斯达克指数':'^IXIC','纳斯达克综合指数':'^IXIC',
    '标普':'^GSPC','标普500':'^GSPC','普尔500':'^GSPC','标准普尔':'^GSPC',
    '道琼斯':'^DJI','道指':'^DJI','道琼斯工业':'^DJI',
    '费城半导体':'^SOX','罗素2000':'^RUT','恐慌指数':'^VIX','vix':'^VIX',
    '上证指数':'000001.SS','上证':'000001.SS','大盘':'000001.SS','沪指':'000001.SS',
    '深证成指':'399001.SZ','成指':'399001.SZ','创业板指':'399006.SZ','创业板指数':'399006.SZ',
    '科创50':'000688.SS','科创板50':'000688.SS','沪深300':'000300.SS','沪深三百':'000300.SS',
    '恒生指数':'^HSI','恒指':'^HSI','国企指数':'^HSCE',
    '日经':'^N225','日经225':'^N225','日经指数':'^N225',
    'kospi':'^KS11','韩国综合指数':'^KS11','韩国指数':'^KS11','kosi':'^KS11',
    'nikkei':'^N225','nikkei225':'^N225','nikkei index':'^N225',
  };
export const IDX_NAME = {
    ...Object.fromEntries(marketDirectory().markets.flatMap(m=>m.benchmarks.map(x=>[x.symbol,x.name]))),
    '^NDX':'纳斯达克100现货指数',
    '^IXIC':'纳斯达克综合指数','^GSPC':'标普500指数','^DJI':'道琼斯工业指数','^SOX':'费城半导体指数','^RUT':'罗素2000','^VIX':'VIX恐慌指数',
    '000001.SS':'上证指数','399001.SZ':'深证成指','399006.SZ':'创业板指','000688.SS':'科创50','000300.SS':'沪深300',
    '^HSI':'恒生指数','^HSCE':'国企指数','^N225':'日经225','^KS11':'韩国KOSPI',
  };
  // ---- 个股相关新闻: Yahoo News(海外/指数) + 东方财富(A股), 每符号缓存10分钟 ----
export const ENG_NAME = {
    '0700.HK':'Tencent', '9988.HK':'Alibaba', '3690.HK':'Meituan', '1810.HK':'Xiaomi', '9618.HK':'JD.com', '9999.HK':'NetEase',
    '000660.KS':'SK Hynix', '005930.KS':'Samsung Electronics', '7203.T':'Toyota', '6758.T':'Sony', '9984.T':'SoftBank Group',
  };


export function createSearchService({ now = () => Date.now(), httpsGet, yGated, finnhubRequest = null, failureCooldown = 30000 } = {}) {
  // lib/search.js — 多市场搜索(Yahoo 开放接口) + 腾讯 smartbox 联想 + 别名表

  const searchCache = new Map(), failures = new Map(), inflight = new Map();
  const shared=createSharedTasks();
  async function confirmListing(term,signal){
    const symbol=canonicalSearchQuery(term).toUpperCase();
    const code=/^([A-Z0-9][A-Z0-9&-]{0,11})\.([A-Z]{1,4})$/.exec(symbol);
    if(!code||!Object.hasOwn(MARKET_SUFFIXES,code[2]))return null;
    // A valid-looking symbol is only a query. Publish it only when the source
    // confirms the exact listing; never fabricate a card for arbitrary text.
    const url='https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(symbol)+'?interval=1d&range=5d';
    const response=await yGated((signal,remaining)=>httpsGet(url,{},{signal,timeout:remaining}),{signal});
    if(response?.status===404)return null;
    if(response?.status!==200)throw Object.assign(new Error('Yahoo identity HTTP '+response?.status),{status:response?.status});
    const meta=JSON.parse(response.body)?.chart?.result?.[0]?.meta;
    const type=String(meta?.instrumentType||'').toUpperCase();
    if(!meta||String(meta.symbol||'').toUpperCase()!==symbol||!['EQUITY','ETF','MUTUALFUND','INDEX'].includes(type)||!(meta.shortName||meta.longName))return null;
    return {symbol,name:meta.shortName||meta.longName,exch:meta.fullExchangeName||meta.exchangeName||'',
      type:instrumentTypeFor(symbol,type),market:classifyMarket(symbol,meta.exchangeName,meta.fullExchangeName,type),
      currency:meta.currency||null,source:'yahoo-chart-identity'};
  }
  async function loadSearch(key,signal) {
    const term = ALIAS[key] || key;   // 中文别名 → 英文
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(term) + '&quotesCount=12&newsCount=0&listsCount=0';
    let rows=[],failure=null;
    try{
      const r = await yGated((signal, remaining) => httpsGet(url, {}, { signal, timeout: remaining }),{signal});
      if (r?.status !== 200) throw Object.assign(new Error('Yahoo search HTTP '+r?.status),{status:r?.status});
      const j = JSON.parse(r.body);
      if (!Array.isArray(j?.quotes)) throw new Error('Yahoo search invalid response');
      rows=j.quotes;
    }catch(error){if(signal?.aborted)throw error;failure=error;}
    const out = rows.filter(x => x && x.symbol && String(x.quoteType || '').toUpperCase() !== 'CRYPTOCURRENCY').map(x => {
      const symbol=canonicalSearchQuery(x.symbol).toUpperCase(),type=instrumentTypeFor(symbol,x.quoteType || x.typeDisp || '');
      return {symbol,name:x.shortname || x.longname || x.symbol,exch:x.exchDisp || x.exchange || x.exch || '',type,
        market:classifyMarket(symbol,x.exchange || x.exch,x.exchDisp,type)};
    }).filter(row=>row.type!=='INDEX'||marketKeyFor(row.symbol));
    if(!out.some(row=>row.symbol===term.toUpperCase())){
      try{const confirmed=await confirmListing(term,signal);if(confirmed){out.unshift(confirmed);failure=null;}}
      catch(error){if(signal?.aborted)throw error;if(!out.length)failure=error;}
    }
    if(failure)throw failure;
    signal?.throwIfAborted();
    searchCache.set(key, { data: out, ts: now() });
    if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);   // 上限保护
    return out;
  }

  async function yahooSearch(q,options={}) {
    options.signal?.throwIfAborted();
    const key=canonicalSearchQuery(q).toLowerCase();if(!key)return [];
    const cached=searchCache.get(key);if(cached&&now()-cached.ts<60000)return cached.data;
    const failed=failures.get(key);if(failed&&now()<failed.retryAt)throw failed.error;
    return shared.run(key,signal=>{
    const work=loadSearch(key,signal).then(result=>{failures.delete(key);return result;},error=>{
      if(signal.aborted)throw error;
      failures.set(key,{error,retryAt:Math.max(now()+failureCooldown,Number(error.retryAt)||0)});
      if(failures.size>300)failures.delete(failures.keys().next().value);
      throw error;
    }).finally(()=>{if(inflight.get(key)===work)inflight.delete(key);});
    inflight.set(key,work);return work;
    },options);
  }

  const finnhubType = value => {
    const type=String(value||'').toUpperCase();
    if(/INDEX/.test(type))return 'INDEX';
    if(/MUTUAL/.test(type))return 'MUTUALFUND';
    if(/ETF|ETP|EXCHANGE TRADED/.test(type))return 'ETF';
    if(/FUTURE/.test(type))return 'FUTURE';
    return 'EQUITY';
  };
  async function loadFinnhubSearch(key,{signal}={}) {
    const term=ALIAS[key]||key;
    const response=await finnhubRequest('/search?q='+encodeURIComponent(term),{signal,timeout:3500});
    if(response?.status!==200)throw Object.assign(new Error('Finnhub search HTTP '+response?.status),{code:'FINNHUB_SEARCH_HTTP',status:response?.status});
    let body;try{body=JSON.parse(response.body);}catch{throw Object.assign(new Error('Finnhub search invalid response'),{code:'FINNHUB_SEARCH_RESPONSE'});}
    if(!Array.isArray(body?.result))throw Object.assign(new Error('Finnhub search invalid response'),{code:'FINNHUB_SEARCH_RESPONSE'});
    const seen=new Set(),out=[];
    for(const row of body.result.slice(0,100)){
      const providerType=String(row?.type||'').toUpperCase();
      if(!row||/CRYPTO|FOREX|CURRENCY/.test(providerType))continue;
      const symbol=canonicalSearchQuery(row.symbol||row.displaySymbol).toUpperCase(),type=finnhubType(providerType);
      if(!symbolValid(symbol)||!marketKeyFor(symbol)||seen.has(symbol))continue;
      seen.add(symbol);out.push({symbol,name:row.description||row.displaySymbol||symbol,exch:'',type,
        market:classifyMarket(symbol,'','',type),source:'finnhub-search'});
    }
    return out;
  }
  const finnhubResource=finnhubRequest?createCachedResource({loader:loadFinnhubSearch,ttlMs:60000,retryMs:30000,now,maxEntries:128}):null;
  const finnhubSearch=finnhubResource?(q,options={})=>{
    const key=canonicalSearchQuery(q).toLowerCase();return key?finnhubResource.get(key,options):Promise.resolve([]);
  }:null;

  async function loadTencentSuggest(q,{signal}={}) {
    const url = 'https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q) + '&t=all';
    const r = await httpsGet(url,{},{signal});
    if(r.status!==200)throw Object.assign(new Error('Tencent search unavailable'),{status:r.status});
    const m = r.body.match(/v_hint="([^"]*)"/);
    if (!m || !m[1]) return [];
    const out = [];
    for (const entry of m[1].split('^')) {
      const f = entry.split('~');
      if (f.length < 3) continue;
      const prefix = f[0].toLowerCase();
      const code = String(f[1] || '');
      const name = decodeGbkSmart(f[2]);
      let sym;
      if (prefix === 'sh') sym = code + '.SS';
      else if (prefix === 'sz') sym = code + '.SZ';
      else if (prefix === 'bj') sym = code + '.BJ';
      else if (prefix === 'hk') sym = canonicalSearchQuery(code + '.HK');
      else if(prefix==='us')sym=code.toUpperCase().replace(/\.(OQ|N|AM|AQ|PR|WS|GS|GJ|BG)$/,'').replaceAll('.','-');
      else continue;
      if (!/^[A-Z][A-Z0-9-]{0,14}$/.test(sym) && !/^\d{4,6}\.(SS|SZ|BJ|HK)$/.test(sym)) continue;
      out.push({ symbol: sym, name, exch: '', type: instrumentTypeFor(sym), market: prefix === 'us' ? '美股' : classifyMarket(sym, '', '') });   // 腾讯不给交易所名/类型；已有目录决定类型，不从名字猜测
    }
    return out;
  }
  const suggest=createCachedResource({loader:loadTencentSuggest,ttlMs:60000,retryMs:30000,now,maxEntries:64});
  const tencentSuggest=(q,options)=>suggest.get(String(q||'').trim(),options);
  function clearSearchCache() { searchCache.clear(); failures.clear();suggest.clear();finnhubResource?.clear();shared.close(); }   // 测试隔离(resetState 由组合根统一调用)
  return { ALIAS, ALIAS_SYM, IDX_NAME, ENG_NAME, finnhubSearch, yahooSearch, tencentSuggest, clearSearchCache, searchCache };
}
