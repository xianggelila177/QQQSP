// Actual loopback relay sockets plus injected direct upstream: no Internet dependency.
import http from 'node:http';
import assert from 'node:assert/strict';
process.env.PORT='0';process.env.LOG_LEVEL='error';process.env.Y_MIN_GAP='1';
process.env.YAHOO_RELAY_TOKEN='test-token';
const chart = symbol => ({chart:{result:[{meta:{symbol,regularMarketPrice:717.2},timestamp:[10],indicators:{quote:[{close:[717.2]}]}}]}});
let behavior='ok';
const seen=[];
const mock=http.createServer((req,res)=>{
 const parsed=new URL(req.url,'http://localhost');
 if(parsed.searchParams.get('token')!=='test-token'){res.writeHead(403);res.end('forbidden');return;}
 const target=parsed.searchParams.get('url') || '';
 seen.push({target,cookie:req.headers['x-relay-cookie']});
 if(behavior==='dead'){res.destroy();return;}
 if(behavior==='429'){res.writeHead(429);res.end('limited');return;}
 if(target.startsWith('https://fc.yahoo.com')){res.writeHead(404,{'Set-Cookie':'test-cookie=1; Path=/'});res.end();return;}
 if(target.includes('getcrumb')){res.writeHead(200);res.end('test-crumb');return;}
 res.writeHead(200,{'Content-Type':'application/json'});
 res.end(JSON.stringify(chart('QQQ')));
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const relay='http://127.0.0.1:'+mock.address().port;
process.env.YAHOO_RELAY=relay;
const S=await import('../server.js');
const T=await import('../lib/transport.js');
const direct=[];
T.initTransport({rawHttpsGet:async(url,headers,opts,countUrl)=>{
 if(url.startsWith(relay+'/'))return S.__test.rawHttpsGet(url,headers,opts,countUrl);
 direct.push(url);
 return {status:200,headers:{},body:JSON.stringify(chart('QQQ'))};
}});
let failed=false, checks=0;
try{
 assert.equal((await fetch(relay+'/relay')).status,403);checks++;
 assert.equal((await fetch(relay+'/relay?token=wrong')).status,403);checks++;
 S.__test.seedCrumb();
 let result=await S.__deps.fetchChart('QQQ','?interval=5m&range=1d');
 assert.equal(result.meta.regularMarketPrice,717.2);checks++;
 assert.ok(seen.some(row=>row.target.includes('/chart/QQQ')&&row.cookie==='test-cookie=1'));checks++;
 const count=seen.length;
 await T.httpsGet('https://qt.gtimg.cn/q=usQQQ');
 assert.equal(seen.length,count);assert.ok(direct.some(url=>url.includes('qt.gtimg.cn')));checks++;
 behavior='429';
 await assert.rejects(S.__deps.fetchChart('QQQ','?interval=5m&range=1d'),error=>error.rateLimited===true);checks++;
 behavior='dead';S.__test.resetState();S.__test.seedCrumb();
 result=await S.__deps.fetchChart('QQQ','?interval=5m&range=1d');
 assert.equal(result.meta.regularMarketPrice,717.2);assert.ok(direct.some(url=>url.includes('/chart/QQQ')));checks++;
 assert.equal(S.__test.relayRewrite('https://qt.gtimg.cn/q=usQQQ'),null);checks++;
 assert.ok(S.__test.relayRewrite('https://query1.finance.yahoo.com/v1/test/getcrumb').startsWith(relay+'/relay?token='));checks++;
 behavior='ok';S.__test.resetState();
 result=await S.__deps.fetchChart('QQQ','?interval=5m&range=1d');
 assert.equal(result.meta.regularMarketPrice,717.2);assert.ok(seen.some(row=>row.target.includes('fc.yahoo.com')));checks++;
 console.log('PASS hermetic relay: '+checks+' socket, cookie, routing, auth and fallback checks');
}catch(error){failed=true;console.error(error);}finally{mock.close();S.httpServer.close();process.exit(failed?1:0);}
