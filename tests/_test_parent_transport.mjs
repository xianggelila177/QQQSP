import assert from 'node:assert/strict';
import http from 'node:http';
process.env.PORT='0';process.env.LOG_LEVEL='error';
const S=await import('../server.js');
const upstream=http.createServer((req,res)=>{
 if(req.url==='/split'){
  const body=Buffer.from('中文行情');res.writeHead(200);
  res.write(body.subarray(0,1));setTimeout(()=>res.end(body.subarray(1)),5);
 }else {res.writeHead(200,{'Content-Length':'100'});res.write('partial');setTimeout(()=>res.destroy(),5);}
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
let failed=false;
try{
 const base='http://127.0.0.1:'+upstream.address().port;
 assert.equal((await S.__test.rawHttpsGet(base+'/split')).body,'中文行情');
 await assert.rejects(S.__test.rawHttpsGet(base+'/broken'));
 console.log('PASS split UTF-8 and interrupted upstream body handled without process failure');
}catch(error){failed=true;console.error(error);}finally{upstream.close();S.httpServer.close();process.exit(failed?1:0);}
