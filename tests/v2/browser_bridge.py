"""Test-only transport bridge for environments blocking Chromium localhost.
Actual Node HTTP/SSE responses are forwarded unchanged; no business fixtures here.
The shim covers only EventSource behavior needed by these tests, not native browser
reconnect implementation, proxy buffering or OS background suspension.
"""
import http.client, json, queue, threading, urllib.request, urllib.error
class BrowserBridge:
    def __init__(self, origin):
        self.origin=origin; self.requests=[]; self.channels={}; self.counter=0
    def get(self, route, options=None):
        assert str(route).startswith('/') and not str(route).startswith('//')
        self.requests.append(route)
        options=options or {}
        request=urllib.request.Request(self.origin+route, data=options.get('body','').encode('utf8') if options.get('body') is not None else None, headers=options.get('headers') or {}, method=options.get('method','GET'))
        try: response=urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error: response=error
        with response: return dict(status=response.status,headers=dict(response.headers),body=response.read().decode('utf-8'))
    def open(self, route):
        assert route.split('?')[0] in ['/api/macro/stream','/api/stream']
        self.counter+=1; key=str(self.counter)
        channel={'queue':queue.Queue(), 'stop':threading.Event(), 'connection':None}
        self.channels[key]=channel;self.requests.append(route)
        def receive():
            from urllib.parse import urlsplit
            target=urlsplit(self.origin);conn=http.client.HTTPConnection(target.hostname,target.port,timeout=20);channel['connection']=conn
            try:
                conn.request('GET',route);response=conn.getresponse()
                if response.status!=200: raise RuntimeError('SSE HTTP '+str(response.status))
                event='message'; lines=[];last_id=''
                while not channel['stop'].is_set():
                    line=response.fp.readline()
                    if not line:break
                    line=line.decode('utf8').rstrip('\r\n')
                    if not line:
                        if lines:channel['queue'].put({'type':event,'data':'\n'.join(lines),'lastEventId':last_id})
                        event='message';lines=[]
                    elif line.startswith('event:'):event=line[6:].strip()
                    elif line.startswith('id:'):last_id=line[3:].strip()
                    elif line.startswith('data:'):lines.append(line[5:].lstrip(' '))
            except Exception:
                if not channel['stop'].is_set():channel['queue'].put({'type':'error'})
            finally:conn.close()
        threading.Thread(target=receive,daemon=True).start();return key
    def poll(self,key):
        channel=self.channels.get(key);items=[]
        if channel:
            while not channel['queue'].empty():items.append(channel['queue'].get_nowait())
        return items
    def close(self,key):
        c=self.channels.pop(key,None)
        if c:
            c['stop'].set()
            conn=c['connection']
            if conn:
                try:
                    if conn.sock:conn.sock.shutdown(2)
                except OSError:pass
                conn.close()
    def install(self,page):
        page.expose_function('__http',self.get);page.expose_function('__openSse',self.open)
        page.expose_function('__pollSse',self.poll);page.expose_function('__closeSse',self.close)
        page.add_script_tag(content=r"""
window.fetch=async(url,options={})=>{
 if(options.signal?.aborted)throw options.signal.reason;
 const r=await __http(String(url),{method:options.method||'GET',headers:options.headers||{},body:options.body??null});if(options.signal?.aborted)throw options.signal.reason;
 const body=window.__snapshotTransform&&String(url)==='/api/macro/snapshot'?JSON.stringify(__snapshotTransform(JSON.parse(r.body))):r.body;
 return new Response(body,{status:r.status,headers:r.headers});
};
window.__streams=[];
window.EventSource=class extends EventTarget{
 constructor(url){super();this.url=url;this.readyState=0;this.closed=false;window.__streams.push(this);
  __openSse(url).then(id=>{this.id=id;if(this.closed){__closeSse(id);return;}this.readyState=1;
   this.timer=setInterval(async()=>{if(this.busy||this.closed)return;this.busy=true;try{for(const x of await __pollSse(id)){
     if(x.type==='error'){this.onerror?.(new Event('error'));continue;}
     this.dispatchEvent(new MessageEvent(x.type,{data:x.data,lastEventId:x.lastEventId}));
   }}finally{this.busy=false;}},60);
  });
 }
 close(){this.closed=true;this.readyState=2;clearInterval(this.timer);if(this.id)__closeSse(this.id);}
};
window.__disconnectMacro=()=>{for(const s of __streams)if(s.url==='/api/macro/stream'&&!s.closed){s.close();s.onerror?.(new Event('error'));}};
""")
    def cleanup(self):
        for key in list(self.channels):self.close(key)
