// Verify sentiment on actual macro-route output, independent of source layout.
import assert from 'node:assert/strict';
process.env.PORT='0';process.env.Y_MIN_GAP='1';process.env.LOG_LEVEL='error';
const S=await import('../server.js');
S.__test.seedCrumb();
const date=new Date(Date.now()+8*3600e3).toISOString().slice(0,19).replace('T',' ');
const expected = new Map([
 ['央行宣布降准0.5个百分点','利好'],['沪指大跌2%，恐慌情绪蔓延','利空'],['纽约期金失守4600美元/盎司','中性']
]);
let rssCalls=0, sinaCalls=0;
S.__upstream.impl=async url=>{
 if(url.includes('news.google.com')) {rssCalls++;return {status:200,headers:{},body:'<rss><channel></channel></rss>'};}
 if(url.includes('zhibo.sina.com.cn')) {sinaCalls++;return {status:200,headers:{},body:JSON.stringify({result:{data:{feed:{list:[...expected.keys()].map(title=>({create_time:date,rich_text:title}))}}}})};}
 return {status:200,headers:{},body:JSON.stringify({news:[]})};
};
while(!S.httpServer.address()) await new Promise(resolve=>setTimeout(resolve,1));
let failed=false;
try{
 const response=await fetch('http://127.0.0.1:'+S.httpServer.address().port+'/api/macro');
 assert.equal(response.status,200);
 const data=await response.json();
 for(const [title,sentiment] of expected) assert.equal(data.items.find(item=>item.title===title)?.sent,sentiment);
 assert.equal(sinaCalls,1);assert.equal(rssCalls,4);
 console.log('PASS actual macro route, four RSS calls and three Sina sentiment cases');
}catch(error){failed=true;console.error(error);}finally{S.httpServer.close();process.exit(failed?1:0);}
