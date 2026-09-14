(() => {
  const withDeadline = (promise, ms, onTimeout, message = '请求超时') => {
    let timer = 0;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { try { onTimeout && onTimeout(); } catch {} reject(Object.assign(new Error(message), {code:'REQUEST_TIMEOUT'})); }, ms); });
    return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); });
  };
  // Presentation time must never depend on an upstream request or Worker health.
  // A recursive timeout avoids accumulated drift; no missed ticks are replayed.
  function createDisplayTicker(callback, { now=Date.now, schedule=setTimeout, cancel=clearTimeout } = {}) {
    let timer=null, running=false;
    function tick() {
      if (!running) return;
      try { callback(); }
      finally { if (running) timer=schedule(tick, Math.max(1, 1000 - (now() % 1000))); }
    }
    return Object.freeze({
      start() { if (running) return; running=true; tick(); },
      stop() { running=false; if (timer!==null) cancel(timer); timer=null; },
      running: () => running
    });
  }
  window.PANEL_SCHEDULER = Object.freeze({ withDeadline, createDisplayTicker });
})();
