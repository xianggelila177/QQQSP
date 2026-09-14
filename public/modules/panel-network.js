(() => {
  // A logical request owns its socket and deadline until JSON has been read.
  const createNetwork = ({ fetchImpl = fetch, timeoutMs = 20000, now = Date.now } = {}) => {
    const inFlight = new Map();
    const active = new Map();
    const retryAt = new Map();
    const retryDelay = value => {
      const seconds=Number(value); if(value != null && String(value).trim() && Number.isFinite(seconds))return Math.max(0,seconds*1000);
      const at=Date.parse(value); return Number.isFinite(at)?Math.max(0,at-now()):60000;
    };
    const request = (kind, url, options = {}) => {
      const until=retryAt.get(kind)||0;
      if(until>now())return Promise.resolve({ok:false,status:429,retryAt:until,deferred:true,headers:null,json:async()=>null});
      if (inFlight.has(kind) && !options.replace) return inFlight.get(kind);
      if (options.replace) active.get(kind)?.cancel();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const external = options.signal;
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
      const entry = { cancel() {
        controller?.abort();
        rejectAbort(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
      } };
      active.set(kind, entry);
      const abort = () => entry.cancel();
      if (external?.aborted) abort();
      else external?.addEventListener('abort', abort, { once: true });
      const { replace, timeoutMs: requestTimeout = timeoutMs, readErrorJson = false, ...fetchOptions } = options;
      const work = async () => {
        if (controller?.signal.aborted || external?.aborted) throw Object.assign(new Error('请求已取消'), {name:'AbortError'});
        const response = await fetchImpl(url, { ...fetchOptions, signal: controller?.signal || external });
        if(response.status===429 || response.status===503){const header=response.headers?.get?.('Retry-After');if(response.status===429 || header != null)retryAt.set(kind,now()+Math.max(1000,retryDelay(header)));}
        const payload = response.ok ? await response.json() : readErrorJson ? await response.json().catch(()=>null) : null;
        if (!response.ok) { try { await response.body?.cancel(); } catch {} }
        return { retryAt:retryAt.get(kind)||0, ok: response.ok, status: response.status, headers: response.headers, json: async () => payload };
      };
      const promise = window.PANEL_SCHEDULER.withDeadline(
        Promise.race([work(), cancelled]), Math.max(1, requestTimeout), () => controller?.abort()
      ).finally(() => {
        external?.removeEventListener('abort', abort);
        if (active.get(kind) === entry) active.delete(kind);
        if (inFlight.get(kind) === promise) inFlight.delete(kind);
      });
      inFlight.set(kind, promise);
      return promise;
    };
    const abortAll = () => {
      for (const entry of active.values()) entry.cancel();
      active.clear(); inFlight.clear();
    };
    const abort = kind => active.get(kind)?.cancel();
    return Object.freeze({ request, abort, abortAll, inFlight, retryAt:kind=>retryAt.get(kind)||0 });
  };
  window.PANEL_NETWORK = Object.freeze({ createNetwork });
})();
