const VERSION = 'v101';
// 版本源: panel/VERSION(P1-Q5 单一来源) · 由 build_version.sh 同步 sw.js/index.html/app.js; 升版只改 VERSION 后跑一次脚本
const CACHE = 'qqq-panel-' + VERSION;
const CORE = ['/', '/index.html', '/style.css', '/panel.bundle.js', '/manifest.webmanifest', '/icon.svg'];
const CORE_REQUESTS = CORE.map(resource => resource === '/' || resource === '/index.html' ? resource : resource + '?v=' + VERSION.slice(1));
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE_REQUESTS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('qqq-panel-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 接口直连网络, 不写缓存(此前每个带 ?t= 时间戳的轮询响应都进 Cache Storage, 每2s一条无限增长)
  if (url.pathname.startsWith('/api/')) { e.respondWith(fetch(e.request)); return; }
  // Only application assets are eligible. Canonical keys prevent arbitrary
  // query strings from growing persistent Cache Storage without a bound.
  const cacheable=CORE.includes(url.pathname);
  const documentAsset=url.pathname==='/' || url.pathname==='/index.html';
  const key=documentAsset ? url.pathname : url.pathname+'?v='+VERSION.slice(1);
  const compatible=!url.searchParams.has('v') || url.searchParams.get('v')===VERSION.slice(1);
  const cachedOr = fallback => caches.match(e.request,{ignoreSearch:true})
    .then(cached => cached || fallback, () => fallback);
  e.respondWith(fetch(e.request).then(response => {
    if (!response.ok) return cachedOr(response);
    if (cacheable && compatible) {
      const copy=response.clone();
      const stored=caches.open(CACHE).then(cache=>cache.put(new URL(key,url.origin).href,copy)).catch(()=>{});
      if (typeof e.waitUntil==='function') e.waitUntil(stored);
    }
    return response;
  }).catch(()=>cachedOr(Response.error())));
});
