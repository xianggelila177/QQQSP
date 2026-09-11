// 调度间隔是本应用的请求下限，不是交易所实时性承诺。
export const SOURCES = Object.freeze([
  {id:'alpaca',name:'Alpaca',hosts:['data.alpaca.markets','stream.data.alpaca.markets'],markets:['us'],transport:'ws',batch:true,minGapMs:2000,feedCoverage:'IEX 或已授权 SIP',feedDelayMinutes:0},
  {id:'finnhub',name:'Finnhub',hosts:['finnhub.io','ws.finnhub.io'],markets:['us'],transport:'ws',batch:true,minGapMs:2000,feedCoverage:'账户订阅覆盖，非全市场保证',feedDelayMinutes:null},
  {id:'naver',name:'Naver',hosts:['polling.finance.naver.com','api.stock.naver.com','fchart.stock.naver.com'],markets:['us','kr'],transport:'poll',batch:true,minGapMs:1000,feedCoverage:'网站报价；遵循响应中的检查间隔',feedDelayMinutes:null},
  {id:'tencent',name:'腾讯',hosts:['qt.gtimg.cn','smartbox.gtimg.cn','web.ifzq.gtimg.cn'],markets:['cn','hk','us'],transport:'poll',batch:true,minGapMs:1000,feedCoverage:'网站报价；按市场标注延迟',feedDelayMinutes:null},
  {id:'yahoo',name:'Yahoo',hosts:['query1.finance.yahoo.com','query2.finance.yahoo.com','fc.yahoo.com','finance.yahoo.com'],markets:['global'],transport:'poll',batch:false,minGapMs:1500,feedCoverage:'历史及低频补充，不作为秒级报价源',feedDelayMinutes:null},
  {id:'eastmoney',name:'东方财富',hosts:['push2.eastmoney.com','push2his.eastmoney.com','search-api-web.eastmoney.com','futsseapi.eastmoney.com'],markets:['cn','hk','us','futures'],transport:'poll',batch:false,minGapMs:2000,feedDelayMinutes:null},
  {id:'sina',name:'新浪',hosts:['hq.sinajs.cn','quotes.sina.cn','money.finance.sina.com.cn','zhibo.sina.com.cn'],markets:['cn','hk','us'],transport:'poll',batch:true,minGapMs:1000,feedDelayMinutes:null},
  {id:'nasdaq',name:'Nasdaq',hosts:['api.nasdaq.com'],markets:['us'],transport:'poll',batch:false,minGapMs:2000,feedDelayMinutes:null},
  {id:'google-news',name:'Google 资讯',hosts:['news.google.com'],markets:['global'],transport:'poll',batch:false,minGapMs:1000,feedDelayMinutes:null},
  {id:'reference-fx',name:'ECB 参考汇率',hosts:['data-api.ecb.europa.eu','api.frankfurter.app','api.frankfurter.dev'],markets:['fx'],transport:'poll',batch:true,minGapMs:2000,feedDelayMinutes:null},
  {id:'official-rss',name:'官方公告',hosts:['www.federalreserve.gov','www.ecb.europa.eu','www.bea.gov'],markets:['news'],transport:'poll',batch:false,minGapMs:1000,feedDelayMinutes:null}
]);
export function sourceForHost(host) {
  if(host==='yahoo.com'||host.endsWith('.yahoo.com'))return SOURCES.find(x=>x.id==='yahoo');
  return SOURCES.find(source=>source.hosts.includes(host));
}
export function hostGroup(url) {
  const host=new URL(url).hostname.toLowerCase();
  // Yahoo 的认证、搜索、图表共同消耗同一出口的额度。其他来源按真实主机隔离。
  return host==='yahoo.com'||host.endsWith('.yahoo.com')?'yahoo':host;
}
export function minimumGap(host) {return host==='yahoo'?1500:sourceForHost(host)?.minGapMs??1000;}
