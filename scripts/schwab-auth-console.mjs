import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

const keys={Enter:[13,'Enter'],Tab:[9,'Tab'],Backspace:[8,'Backspace'],Delete:[46,'Delete'],Escape:[27,'Escape'],
  ArrowLeft:[37,'ArrowLeft'],ArrowUp:[38,'ArrowUp'],ArrowRight:[39,'ArrowRight'],ArrowDown:[40,'ArrowDown'],Home:[36,'Home'],End:[35,'End'],PageUp:[33,'PageUp'],PageDown:[34,'PageDown'],a:[65,'KeyA']};
export async function openSchwabAuthConsole(browser,{port=18774,status=()=>({status:'WAITING'}),cancel=()=>{}}={}){
  const nonce=randomBytes(24).toString('base64'),template=await readFile(new URL('../ops/schwab-auth-console.html',import.meta.url),'utf8');
  const origin='http://127.0.0.1:'+port;let active=0;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const host=req.headers.host,allowedOrigin=host==='127.0.0.1:'+port?origin:host==='localhost:'+port?'http://localhost:'+port:null;
    if(!allowedOrigin||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==allowedOrigin)){
      res.writeHead(403);res.end();return;
    }
    if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(template.replaceAll('__NONCE__',nonce));return;}
    if(req.headers['x-qqqsp-local-auth']!=='1'){res.writeHead(403);res.end();return;}
    if(active>=3){res.writeHead(429);res.end();return;}active++;
    try{
      if(req.method==='GET'&&req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status()));return;}
      if(req.method==='GET'&&req.url==='/frame'){
        const {data}=await browser.page('Page.captureScreenshot',{format:'jpeg',quality:78});res.setHeader('Content-Type','image/jpeg');res.end(Buffer.from(data,'base64'));return;
      }
      if(req.method!=='POST'||req.url!=='/action'||req.headers.origin!==allowedOrigin||req.headers['content-type']!=='application/json'){
        res.writeHead(403);res.end();return;
      }
      let body='',size=0;for await(const part of req){size+=part.length;if(size>40000)throw new Error();body+=part.toString();}
      const value=JSON.parse(body);
      if(value.type==='cancel')cancel();
      else if(value.type==='text'){
        if(typeof value.text!=='string'||value.text.length>16000)throw new Error();
        await browser.page('Input.insertText',{text:value.text});
      }else if(value.type==='click'){
        const {x,y}=value;if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1200||y<0||y>900)throw new Error();
        await browser.page('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
        await browser.page('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
      }else if(value.type==='wheel'){
        if(!Number.isFinite(value.deltaY))throw new Error();await browser.page('Input.dispatchMouseEvent',{type:'mouseWheel',x:600,y:450,deltaX:0,deltaY:Math.max(-1500,Math.min(1500,value.deltaY))});
      }else if(value.type==='key'){
        const entry=keys[value.key];if(!entry||!Number.isInteger(value.modifiers)||value.modifiers<0||value.modifiers>15)throw new Error();
        const params={key:value.key,code:entry[1],windowsVirtualKeyCode:entry[0],nativeVirtualKeyCode:entry[0],modifiers:value.modifiers};
        await browser.page('Input.dispatchKeyEvent',{type:'keyDown',...params});await browser.page('Input.dispatchKeyEvent',{type:'keyUp',...params});
      }else throw new Error();
      res.writeHead(204);res.end();
    }catch{if(!res.headersSent)res.writeHead(503);res.end();}finally{active--;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:origin,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
