// ===== app.js IIFE 测试沙箱基建 (无第三方依赖) =====
// 用 vm.runInNewContext 在受控 DOM 桩中执行 public/app.js;
// 通过 window.__PANEL_TEST_HOOK__(app.js 末尾, 浏览器无副作用) 提取内部函数。
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_SRC = path.join(ROOT, 'public', 'app.js');

// ---- canvas 2d context 桩 ----
function makeCtxStub() {
  const grad = { addColorStop() {} };
  return {
    font: '', textAlign: '', textBaseline: '', lineWidth: 1, strokeStyle: '', fillStyle: '', globalAlpha: 1,
    setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillText() {}, save() {}, restore() {},
    translate() {}, scale() {}, arc() {}, rect() {}, clip() {}, setLineDash() {}, drawImage() {}, roundRect() {},
    createLinearGradient: () => grad, createRadialGradient: () => grad,
  };
}

// ---- 元素桩: classList/innerHTML 写入计数/handler 记录/querySelector 备忘录子桩 ----
export function makeEl(key = 'el') {
  const cls = new Set();
  const handlers = {};
  const qcache = new Map();
  const el = {
    __key: key, hidden: false, value: '', textContent: '',
    scrollTop: 0, scrollHeight: 600, offsetWidth: 0,
    dataset: {}, style: {}, children: [], parentNode: null,
    width: 0, height: 0,
    _handlers: handlers, _insertedHTML: [], _htmlWrites: 0, _attrs: {},
    addEventListener(t, fn) { (handlers[t] ||= []).push(fn); },
    removeEventListener() {},
    appendChild(c) { if(c.parentNode && c.parentNode !== el) c.remove(); const i=el.children.indexOf(c); if(i>=0) el.children.splice(i,1); el.children.push(c); c.parentNode = el; c.ownerDocument = el.ownerDocument; return c; },
    replaceChildren(...nodes) { for(const child of [...el.children])child.remove();for(const node of nodes)el.appendChild(node); },
    remove() { if (el.parentNode) { const i = el.parentNode.children.indexOf(el); if (i >= 0) el.parentNode.children.splice(i, 1); el.parentNode = null; } },
    insertAdjacentHTML(pos, html) {
      el._insertedHTML.push(String(html));
      // beforeend: 追加一个通用根元素, 让 lastElementChild / querySelector 可用
      if (/beforeend|afterbegin/.test(pos)) {
        const child = makeEl(el.__key + '\u00bb' + el._insertedHTML.length);
        child.parentNode = el; child.ownerDocument=el.ownerDocument; el.children.push(child);
      }
    },
    querySelector(sel) {
      if (!qcache.has(sel)) { const c = makeEl(key + '>' + sel); c.parentNode = el; c.ownerDocument=el.ownerDocument; qcache.set(sel, c); }
      return qcache.get(sel);
    },
    querySelectorAll(sel) {
      if (sel === '[data-ccy]') {
        if (!el._ccy) { const a = makeEl(key + '>ccy-usd'), b = makeEl(key + '>ccy-cny'), c = makeEl(key + '>ccy-native'); a.dataset.ccy = 'USD'; b.dataset.ccy = 'CNY'; c.dataset.ccy = 'NATIVE'; el._ccy = [a, b, c]; }
        return el._ccy;
      }
      if(sel === '.tfbtn') { const a=el.querySelector(sel), b=el.querySelector(sel+':nth2'); a.dataset.tf='intraday'; b.dataset.tf='daily30'; return [a,b]; }
      return [el.querySelector(sel), el.querySelector(sel + ':nth2')];
    },
    contains(node) { for(let current=node;current;current=current.parentNode)if(current===el)return true;return false; },
    closest() { return null; },
    focus() { if (el.ownerDocument) el.ownerDocument.activeElement = el; }, select() {}, click() { for (const fn of handlers.click || []) fn({target:el}); }, scrollIntoView() {},
    getContext() { return (el._ctx ||= makeCtxStub()); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 240 }; },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._innerHTML || '',
    set(v) { el._htmlWrites++; el._innerHTML = String(v); },
  });
  Object.defineProperty(el, 'className', {
    get: () => [...cls].join(' '),
    set(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => cls.add(c)); },
  });
  Object.defineProperty(el, 'classList', { value: {
    add: (...cs) => cs.forEach(c => cls.add(c)),
    remove: (...cs) => cs.forEach(c => cls.delete(c)),
    toggle(c, f) { const on = f === undefined ? !cls.has(c) : !!f; on ? cls.add(c) : cls.delete(c); return on; },
    contains: (c) => cls.has(c),
  }});
  Object.defineProperty(el, 'lastElementChild', { get: () => el.children[el.children.length - 1] || null });
  for(const dimension of ['width','height']) { let value=0; Object.defineProperty(el, dimension, {get:()=>value,set(v){value=Math.trunc(Number(v));el._sizeWrites=(el._sizeWrites||0)+1;}}); }
  return el;
}

// ---- 手动定时器(不真实计时): setTimeout/setInterval 注册表, 测试按需触发 ----
function makeTimers() {
  let seq = 0;
  const all = new Map();
  const api = {
    all,
    setTimeout(fn, ms = 0) { const id = ++seq; all.set(id, { fn, ms, kind: 'timeout', cleared: false, ran: 0 }); return id; },
    clearTimeout(id) { const t = all.get(id); if (t) t.cleared = true; },
    setInterval(fn, ms = 0) { const id = ++seq; all.set(id, { fn, ms, kind: 'interval', cleared: false }); return id; },
    clearInterval(id) { const t = all.get(id); if (t) t.cleared = true; },
    intervals(ms) { return [...all.values()].filter(t => t.kind === 'interval' && !t.cleared && (ms == null || t.ms === ms)); },
    runTimeouts(filterMs) {
      let n = 0;
      for (const t of [...all.values()]) {
        if (t.kind !== 'timeout' || t.cleared || t.ran || filterMs != null && t.ms !== filterMs) continue;
        t.ran++;t.fn(); n++;
      }
      return n;
    },
  };
  return api;
}

// ---- fetch 桩: 按 URL 路由到各端点队列; 支持 defer(手动放行)以模拟慢响应 ----
function makeFetch(log) {
  const queues = { search: [], news: [], macro: [], market: [], other: [] };
  function route(u) {
    const s = String(u);
    if (s.includes('/api/search')) return queues.search;
    if (s.includes('/api/news')) return queues.news;
    if (s.includes('/api/macro')) return queues.macro;
    if (s.includes('/api/market')) return queues.market;
    return queues.other;
  }
  async function fetch(url) {
    log.push(String(url));
    const q = route(url);
    let body, status = 200, headers={};
    if (q.length) {
      const item = q.shift();
      if (item.deferred) await item.deferred.promise;
      body = item.body; status = item.status ?? 200; headers=item.headers||{};
    } else {
      body = String(url).includes('/api/news') ? Object.fromEntries((new URL(String(url),'http://fixture.test').searchParams.get('symbols')||'').split(',').filter(Boolean).map(sym=>[sym,[]]))
           : String(url).includes('/api/macro') ? { items: [] }
           : [];
    }
    return { ok: status < 400, status, headers:{get:key=>headers[key]??headers[key.toLowerCase()]??null}, json: async () => JSON.parse(JSON.stringify(body)) };
  }
  fetch.queues = queues;
  fetch.push = (name, item) => {
    if (item.defer) { const d = {}; d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); item.deferred = d; }
    queues[name].push(item);
    return item.deferred || item;
  };
  return fetch;
}

// ---- FakeWorker: 记录实例, 测试用 emit() 手动发消息(模拟心跳节拍) ----
function makeFakeWorkerClass(registry) {
  return class FakeWorker {
    constructor(url) { this.url = String(url); this._onm = null; registry.push(this); }
    set onmessage(fn) { this._onm = fn; }
    get onmessage() { return this._onm; }
    emit(data) { if (this._onm) this._onm({ data }); }
    terminate() { this._dead = true; }
  };
}

// ---- 加载 app.js 到沙箱并返回测试环境 ----
export async function loadApp({ hidden = false, fakeWorker = false, watchlist = null, dpr = 1, fakeObservers = false, refreshMode = null, initialMarket } = {}) {
  const els = new Map();
  const byId = (id) => { if (!els.has(id)){const el=makeEl('#' + id);el.ownerDocument=doc;els.set(id,el);} return els.get(id); };
  const docL = {};
  const winL = {};
  const doc = {
    hidden,
    body: makeEl('body'),
    addEventListener(t, fn) { (docL[t] ||= []).push(fn); },
    removeEventListener() {},
    getElementById: byId,
    querySelector: selector=>byId(selector),
    createElement(tag) { const el=makeEl('<' + tag + '>'); el.ownerDocument=doc; return el; },
  };
  const win = {
    addEventListener(t, fn) { (winL[t] ||= []).push(fn); },
    removeEventListener() {},
  };
  let hooks = null;
  win.__PANEL_TEST_HOOK__ = (h) => { hooks = h; };

  const timers = makeTimers();
  const fetchLog = [];
  const fetchStub = makeFetch(fetchLog);
  if(initialMarket!==undefined)fetchStub.push('market',{body:initialMarket});
  const store = {};
  if (Array.isArray(watchlist)) store['qqq-watchlist'] = JSON.stringify(watchlist);
  if(refreshMode!=null)store['qqq-refresh-mode']=refreshMode;
  const workers = [], intersections = [], resizes = [];
  const sandbox = {
    document: doc, window: win, navigator: {}, console,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: fetchStub,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    requestAnimationFrame: fn => timers.setTimeout(fn,16),
    devicePixelRatio: dpr,
  };
  if (fakeObservers) {
    const observerClass = registry => class {
      constructor(callback) {this.callback=callback;this.targets=new Set();registry.push(this);}
      observe(target){this.targets.add(target);}
      unobserve(target){this.targets.delete(target);}
      emit(entries){this.callback(entries);}
    };
    sandbox.IntersectionObserver=observerClass(intersections);
    sandbox.ResizeObserver=observerClass(resizes);
  }
  if (fakeWorker) {
    sandbox.Worker = makeFakeWorkerClass(workers);
    sandbox.Blob = class FakeBlob { constructor(parts) { this.parts = parts; } };
    sandbox.URL = { createObjectURL: () => 'blob:fake-heartbeat' };
  }
  if (!fakeWorker) sandbox.URL = URL;
  sandbox.AbortController = AbortController;
  sandbox.atob = atob; sandbox.TextDecoder = TextDecoder;
  sandbox.globalThis = sandbox;
  sandbox.queueMicrotask=queueMicrotask;win.localStorage=sandbox.localStorage;
  const searchWrap=makeEl('.searchwrap');searchWrap.ownerDocument=doc;searchWrap.appendChild(byId('q'));searchWrap.appendChild(byId('sr'));
  for (const mod of ['panel-client.js', 'panel-currency.js', 'panel-chart.js', 'panel-chart-engine.js', 'panel-scheduler.js', 'panel-network.js', 'panel-watchlist-sync.js', 'panel-admin.js', 'panel-state.js', 'panel-utils.js', 'panel-format.js', 'panel-chart-controller.js', 'panel-fundamentals.js', 'panel-detail.js', 'panel-card-view.js', 'panel-search-controller.js', 'panel-market-directory.js', 'panel-news-controller.js', 'panel-macro-controller.js', 'panel-market-store.js','panel-live-store.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'modules', mod), 'utf8'), sandbox, { filename: path.join(ROOT,'public','modules',mod) });
  }
  vm.runInNewContext(fs.readFileSync(APP_SRC, 'utf8'), sandbox, { filename: APP_SRC });
  timers.runTimeouts(0); // Browser event loop starts immediate fallback reads before the test drains microtasks.

  return {
    sandbox, doc, win, byId, els, timers, fetchLog, fetch: fetchStub, workers, intersections, resizes,
    hooks: () => hooks,
    fireDoc(type, ev = {}) { ev.type = type; ev.preventDefault ||= () => {}; [...(docL[type] || [])].forEach(fn => fn(ev)); },
    fireWin(type, ev = {}) { ev.type = type; ev.preventDefault ||= () => {}; [...(winL[type] || [])].forEach(fn => fn(ev)); },
    countFetch(sub) { return fetchLog.filter(u => u.includes(sub)).length; },
    drain: () => new Promise(r => setImmediate(r)),
  };
}
