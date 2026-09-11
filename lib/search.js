import {createCachedResource} from './cached-resource.js';
import { decodeGbkSmart } from './providers/tx.js';
import { classifyMarket, instrumentTypeFor } from './instruments.js';
import { log } from '../log.mjs';
import { MARKET_ALIASES, marketDirectory } from './market-registry.js';

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


export function createSearchService({ now = () => Date.now(), httpsGet, yGated, failureCooldown = 30000 } = {}) {
  // lib/search.js — 多市场搜索(Yahoo 开放接口) + 腾讯 smartbox 联想 + 别名表

  const searchCache = new Map(), failures = new Map(), inflight = new Map();
  async function loadSearch(key) {
    const term = ALIAS[key] || key;   // 中文别名 → 英文
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(term) + '&quotesCount=12&newsCount=0&listsCount=0';
    const r = await yGated((signal, remaining) => httpsGet(url, {}, { signal, timeout: remaining }));
    if (r?.status !== 200) throw new Error('Yahoo search HTTP '+r?.status);
    const j = JSON.parse(r.body);
    if (!Array.isArray(j?.quotes)) throw new Error('Yahoo search invalid response');
    const out = ((j && j.quotes) || []).filter(x => x && x.symbol && String(x.quoteType || '').toUpperCase() !== 'CRYPTOCURRENCY').map(x => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || x.symbol,
      exch: x.exchDisp || x.exch || '',
      type: instrumentTypeFor(x.symbol,x.quoteType || x.typeDisp || ''),
      market: classifyMarket(x.symbol, x.exch, x.exchDisp, x.quoteType),
    }));
    searchCache.set(key, { data: out, ts: now() });
    if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);   // 上限保护
    return out;
  }

  async function yahooSearch(q) {
    const key=String(q||'').trim().toLowerCase();if(!key)return [];
    const cached=searchCache.get(key);if(cached&&now()-cached.ts<60000)return cached.data;
    const failed=failures.get(key);if(failed&&now()<failed.retryAt)throw failed.error;
    if(inflight.has(key))return inflight.get(key);
    const work=loadSearch(key).then(result=>{failures.delete(key);return result;},error=>{
      failures.set(key,{error,retryAt:Math.max(now()+failureCooldown,Number(error.retryAt)||0)});
      if(failures.size>300)failures.delete(failures.keys().next().value);
      throw error;
    }).finally(()=>{if(inflight.get(key)===work)inflight.delete(key);});
    inflight.set(key,work);return work;
  }

  async function loadTencentSuggest(q) {
    const url = 'https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q) + '&t=all';
    const r = await httpsGet(url);
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
      else if (prefix === 'hk') sym = code.padStart(4, '0') + '.HK';
      else sym = code.split('.')[0].toUpperCase();                     // us~nvda.oq → NVDA (剥交易所后缀; 此前小写+后缀被正则过滤致美股正主消失)
      if (!/^[A-Z^]{1,10}$/.test(sym) && !/^\d{4,6}\.(SS|SZ|BJ|HK)$/.test(sym)) continue;
      out.push({ symbol: sym, name, exch: '', type: 'EQUITY', market: prefix === 'us' ? '美股' : classifyMarket(sym, '', '') });   // 腾讯不给交易所名, us前缀即美股证据
    }
    return out;
  }
  const suggest=createCachedResource({loader:loadTencentSuggest,ttlMs:60000,failureCooldownMs:30000,now,maxEntries:64});
  const tencentSuggest=q=>suggest.get(String(q||'').trim());
  function clearSearchCache() { searchCache.clear(); failures.clear();suggest.clear(); }   // 测试隔离(resetState 由组合根统一调用)
  return { ALIAS, ALIAS_SYM, IDX_NAME, ENG_NAME, yahooSearch, tencentSuggest, clearSearchCache, searchCache };
}
