// TEST-ONLY synthetic responses. Never imported by server.js or any lib/ module.
export function createMacroFixture({survey=false}={}){
 const base=Date.now()-15*60000;let offset=0,failed=false;const calls=[];
 const now=()=>base+offset;
 const xml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 const rss=(items)=>'<rss version="2.0"><channel>'+items.map(x=>`<item><title>${xml(x.title)}</title><pubDate>${new Date(now()-60000).toUTCString()}</pubDate><link>${xml(x.link)}</link><source url="${xml(x.publisherUrl||'https://www.reuters.com')}">${xml(x.src||'Reuters（验收样本）')}</source>${x.text?'<description>'+xml(x.text)+'</description>':''}</item>`).join('')+'</channel></rss>';
 const response=body=>({status:200,headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
 async function upstream(url){
  calls.push(url);if(failed)return {status:429,headers:{'retry-after':'120'},body:''};
  const u=new URL(url);
  if(u.hostname==='api.tradingeconomics.com')return response([{CalendarId:'fixture-cpi',Country:'United States',Event:'Core Inflation Rate MoM',Reference:'Aug',ReferenceDate:'2026-08-31T00:00:00',DateSpan:'0',Date:new Date(base+10*60000).toISOString(),Actual:offset?'0.2%':'',Forecast:offset?'0.2%':'0.3%',TEForecast:'0.4%',Previous:'0.3%',Revised:'0.2%',Unit:'%',Source:'BLS（验收样本）',SourceURL:'https://www.bls.gov/cpi/'}]);
  if(u.hostname==='push2.eastmoney.com'){
   const code=u.searchParams.get('secid')?.split('.')[1],isNq=code==='NQ00Y',price=isNq?(offset?20200:20000):(offset?78.4:80);
   return response({data:{f57:code,f43:price,f60:isNq?20000:80,f86:Math.floor(now()/1000),f169:isNq?200:-1.6,f170:isNq?1:-2}});
  }
  if(u.pathname.includes('/v8/finance/chart/')){
   const symbol=decodeURIComponent(u.pathname.split('/').at(-1)),isFuture=symbol.endsWith('=F');
   const price=symbol==='BZ=F'?(offset?82:83):symbol==='^TNX'?(offset?4.1:4.2):offset?99.8:100;
   return response({chart:{result:[{meta:{symbol,instrumentType:isFuture?'FUTURE':'INDEX',currency:'USD',regularMarketPrice:price,regularMarketTime:Math.floor(now()/1000),exchangeDataDelayedBy:0},timestamp:[Math.floor(now()/1000)],indicators:{quote:[{close:[price]}]}}],error:null}});
  }
  if(u.hostname==='zhibo.sina.com.cn')return response({result:{data:{feed:{list:[
   ...(survey?['英国央行表示，8月份Savanta民调显示，受访者对五年后的通胀预期为3.2%。','英国央行表示，Savanta在8月开展的调查显示，受访者对未来1-2年的通胀预期为2.9%。','英国央行表示，8月Savanta民调显示，民众对未来一年的通胀预期为3.2%。'].map(rich_text=>({rich_text,create_time:new Date(now()-120000+8*3600e3).toISOString().slice(0,19).replace('T',' ')})):[]),
   {rich_text:'美国8月核心CPI月率实际0.2%，预期0.3%，前值0.3%',docurl:'https://finance.sina.com.cn/test/cpi',create_time:new Date(now()-60000+8*3600e3).toISOString().slice(0,19).replace('T',' ')},
   {rich_text:'原油下跌，纳指期货上涨，资金获利了结后转去赌CPI',docurl:'https://finance.sina.com.cn/test/rotation',create_time:new Date(now()-60000+8*3600e3).toISOString().slice(0,19).replace('T',' ')}
  ]}}}});
  if(u.hostname==='news.google.com')return response(rss([
   {title:'OPEC announces oil production cuts',link:'https://example.test/oil-supply'},
   {title:'Oil demand declines amid recession concerns',link:'https://example.test/oil-demand'},
   {title:'US August CPI MoM actual 0.2%, consensus 0.3%',link:'https://example.test/cpi'},
   {title:'Treasury yields ahead of Federal Reserve decision',link:'https://example.test/rates'},
   {title:'Fed comments: rates unchanged',link:'https://example.test/fed'},
   {title:'Gold price outlook',link:'https://example.test/gold'},
   {title:'Gold market review',link:'https://example.test/gold2'}
  ]));
  if(u.hostname.endsWith('bls.gov'))return response(rss([{title:'Consumer Price Index for August',text:'Consumer price index official release. Core index increased 0.2 percent.',link:'https://www.bls.gov/news.release/cpi.htm'}]));
  if(u.hostname.endsWith('eia.gov'))return response(rss([{title:'Oil supply recovers after production restart',link:'https://www.eia.gov/todayinenergy/detail.php?id=fixture',text:'Production increases as crude supply recovers.'}]));
  if(u.hostname.endsWith('federalreserve.gov'))return response(rss([{title:'Federal Reserve issues FOMC statement',link:'https://www.federalreserve.gov/newsevents/pressreleases/fixture.htm'}]));
  if(u.hostname.endsWith('bea.gov')||u.hostname.endsWith('ecb.europa.eu'))return response(rss([]));
  return {status:429,headers:{'retry-after':'120'},body:''};
 }
 return {now,upstream,calls,advance(ms=15*60000){offset+=ms;},fail(){failed=true;}};
}
