// P0-4 SW ignoreSearch —— RED 阶段测试
// 断言: 断网回退时 caches.match(e.request,{ignoreSearch:true}) 能把
//       '/style.css?v=42' 命中缓存里的 '/style.css'(忽略 query)。
// Cache/CacheStorage 以符合规范的 ignoreSearch 语义桩实现, 驱动真实 sw.js 的 fetch 处理器。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

let pass = 0; const fails = [];
const ok = (cond, name) => { cond ? pass++ : fails.push(name); console.log((cond ? '  \u2713 ' : '  \u2717 ') + name); };

function setup({ offline, status = 200, cacheFailure = false }) {
  const store = new Map([
    ['https://panel.test/style.css', new Response('CACHED_CSS')],
    ['https://panel.test/app.js', new Response('CACHED_APP_JS')],
  ]);
  const normKey = (url) => { const i = url.indexOf('?'); return i < 0 ? url : url.slice(0, i); };
  const cacheHits = [], cacheWrites = [];
  const cacheImpl = {
    match(req, opts) {
      const url = typeof req === 'string' ? req : req.url;
      cacheHits.push(url);
      if (cacheFailure) return Promise.reject(new Error('Cache storage unavailable'));
      return Promise.resolve(store.get(opts && opts.ignoreSearch ? normKey(url) : url));
    },
    put(req, resp) {
      const url = typeof req === 'string' ? req : req.url;
      cacheWrites.push(url); store.set(url, resp); return Promise.resolve();
    },
    addAll: async () => {},
  };
  const L = {};
  const selfShim = {
    location: new URL('https://panel.test/sw.js'),
    addEventListener: (t, f) => { (L[t] ||= []).push(f); },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  const netHits = [];
  const sandbox = {
    self: selfShim, console, URL, Response,
    caches: {
      open: async () => cacheImpl,
      match: (req, opts) => cacheImpl.match(req, opts),
      keys: async () => ['qqq-panel-v42'],
      delete: async () => true,
    },
    fetch: (req) => {
      netHits.push(String(req.url ?? req));
      return offline ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response(status >= 400 ? 'ERROR_BODY' : 'NETWORK_BODY', { status }));
    },
  };
  vm.runInNewContext(SRC, sandbox, { filename: path.join(ROOT,'public','sw.js') });
  return {
    netHits, cacheHits, cacheWrites,
    dispatch: async (p, method = 'GET') => {
      let captured;
      for (const fn of L.fetch || []) fn({ request: { url: new URL(p, 'https://panel.test').href, method }, respondWith: (x) => { captured = x; } });
      return captured;
    },
  };
}

try {
  // 场景1(核心): 断网 + 带版本参数请求 → 应命中无 query 的缓存条目
  const s1 = setup({ offline: true });
  let resp;
  try { resp = await s1.dispatch('/style.css?v=42'); } catch {}
  const body = resp ? await resp.text() : '(no response)';
  ok(body === 'CACHED_CSS', '断网时 /style.css?v=42 命中 /style.css 缓存 (实际: ' + body + ')');

  // 场景2: 不同参数值同样命中
  const s2 = setup({ offline: true });
  let resp2;
  try { resp2 = await s2.dispatch('/app.js?v=99'); } catch {}
  const body2 = resp2 ? await resp2.text() : '(no response)';
  ok(body2 === 'CACHED_APP_JS', '断网时 /app.js?v=99 命中 /app.js 缓存 (实际: ' + body2 + ')');

  // 场景3(回归): 联网时网络优先不受影响
  const s3 = setup({ offline: false });
  const resp3 = await s3.dispatch('/style.css?v=42');
  ok((await resp3.text()) === 'NETWORK_BODY', '联网时仍网络优先');
  ok(s3.netHits.length === 1, '联网请求直达网络一次');

  // 场景4(回归): 精确路径(无query)断网回退依旧工作
  const s4 = setup({ offline: true });
  let resp4;
  try { resp4 = await s4.dispatch('/style.css'); } catch {}
  const body4 = resp4 ? await resp4.text() : '(no response)';
  ok(body4 === 'CACHED_CSS', '断网精确匹配 /style.css 仍命中');

  // A transient HTTP error must fall back to the last valid cached asset.
  const s5 = setup({ offline: false, status: 500 });
  let resp5;
  try { resp5 = await s5.dispatch('/style.css?v=500'); } catch {}
  ok(resp5 && await resp5.text() === 'CACHED_CSS', '网络 500 时回退到有效 CSS 缓存');
  ok(s5.cacheWrites.length === 0, '失败的 HTTP 响应不写入静态缓存');

  // A missing offline asset must produce a valid error Response, never undefined.
  const s6 = setup({ offline: true });
  const resp6 = await s6.dispatch('/missing.js?v=64');
  ok(resp6 instanceof Response && resp6.type === 'error' && resp6.status === 0,
    '断网且无缓存时返回有效 Response.error');

  // An HTTP diagnostic remains intact when there is no last-good cache entry.
  const s7 = setup({ offline: false, status: 503 });
  const resp7 = await s7.dispatch('/missing.js?v=64');
  ok(resp7 instanceof Response && resp7.status === 503 && await resp7.text() === 'ERROR_BODY',
    '无缓存的 HTTP 503 保留原始状态与响应体');
  ok(s7.cacheWrites.length === 0, '无缓存的 HTTP 错误不污染缓存');

  // Browser-owned cross-origin fetches must never enter our offline handler.
  for (const foreign of ['https://static.cloudflareinsights.com/beacon.js', 'https://other.test/api/quotes']) {
    const foreignState = setup({ offline: true });
    let foreignResponse;
    try { foreignResponse = await foreignState.dispatch(foreign); } catch {}
    ok(foreignResponse === undefined && foreignState.netHits.length === 0 && foreignState.cacheHits.length === 0,
      '跨域请求完全绕过 SW: ' + foreign);
  }

  const api = setup({ offline: true });
  let apiFailed = false;
  try { await api.dispatch('/api/quotes?t=1'); } catch (error) { apiFailed = error instanceof TypeError; }
  ok(apiFailed && api.netHits.length === 1 && api.cacheHits.length === 0 && api.cacheWrites.length === 0,
    '同源 API 仍为纯网络请求，不回退静态缓存');
  const post = setup({ offline: false });
  ok(await post.dispatch('/api/quotes', 'POST') === undefined && post.netHits.length === 0,
    '非 GET 请求保持浏览器默认处理');

  // CacheStorage can fail too: respondWith must still resolve to a Response.
  const brokenCacheOffline = setup({ offline: true, cacheFailure: true });
  let resp8;
  try { resp8 = await brokenCacheOffline.dispatch('/missing.js'); } catch {}
  ok(resp8 instanceof Response && resp8.type === 'error', '缓存存储不可用且断网时仍返回 Response.error');
  const brokenCacheHttp = setup({ offline: false, status: 502, cacheFailure: true });
  let resp9;
  try { resp9 = await brokenCacheHttp.dispatch('/missing.js'); } catch {}
  ok(resp9 instanceof Response && resp9.status === 502 && await resp9.text() === 'ERROR_BODY',
    '缓存存储不可用时仍保留原始 HTTP 错误响应');
} catch (e) {
  fails.push('exception: ' + e.message);
  console.log('  \u2717 exception:', e.message);
}

console.log('[P0-4 sw_match] ' + pass + ' 通过, ' + fails.length + ' 失败');
process.exit(fails.length ? 1 : 0);
