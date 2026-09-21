import { requireNewsResponse } from './news.js';
export function createYahooNews({getCrumb,yGated,httpsGet,onRateLimit=()=>{}}) {
  return async function yahooNews(query,{signal}={}) {
    signal?.throwIfAborted();
    const {cookie}=await getCrumb();
    signal?.throwIfAborted();
    const url='https://query1.finance.yahoo.com/v1/finance/search?q='+encodeURIComponent(query)+'&quotesCount=0&newsCount=8';
    const r=await yGated((signal,remaining)=>httpsGet(url,{Cookie:cookie},{signal,timeout:remaining}),{signal});
    if(r?.status===429)onRateLimit('news');
    requireNewsResponse(r,'Yahoo News');
    const j=JSON.parse(r.body);
    if(!Array.isArray(j?.news))throw new Error('Yahoo News invalid response');
    return j.news.map(n=>({t:(+n.providerPublishTime || 0)*1000,src:n.publisher || '',title:String(n.title || ''),link:n.link || '',tickers:Array.isArray(n.relatedTickers)?n.relatedTickers.map(x=>String(x).toUpperCase()):[]})).filter(n=>n.t>0&&n.title);
  };
}
