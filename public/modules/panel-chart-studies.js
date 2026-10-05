(() => {
  // Indicators use observed closes only. Missing values restart the warmup;
  // a quote displayed after the history is never an extra indicator bar.
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function rolling(bars, period, bands = false) {
    const middle = new Array(bars.length).fill(null), upper = middle.slice(), lower = middle.slice();
    const ring = new Array(period); let count = 0, next = 0, mean = 0, m2 = 0;
    for (let i = 0; i < bars.length; i++) {
      const value = bars[i]?.c;
      if (!finite(value)) { count = 0; next = 0; mean = 0; m2 = 0; continue; }
      if (count === period) {
        const old = ring[next], nextMean = (period * mean - old) / (period - 1);
        m2 -= (old - mean) * (old - nextMean); mean = nextMean; count--;
      }
      ring[next] = value; next = (next + 1) % period; count++;
      const delta = value - mean; mean += delta / count; m2 += delta * (value - mean);
      // Recenter once per window: bounded work and no accumulating cancellation.
      if (count === period && next === 0) {
        mean = ring.reduce((sum, v) => sum + (v - value), 0) / period + value;
        m2 = ring.reduce((sum, v) => sum + (v - mean) ** 2, 0);
      }
      if (count === period) {
        middle[i] = mean;
        if (bands) { const sd = Math.sqrt(Math.max(0, m2) / period); upper[i] = mean + 2 * sd; lower[i] = mean - 2 * sd; }
      }
    }
    return bands ? {middle, upper, lower} : middle;
  }
  function ema(bars, period) {
    const values = new Array(bars.length).fill(null), alpha = 2 / (period + 1);
    let count = 0, seed = 0, previous = null;
    for (let i = 0; i < bars.length; i++) {
      const value = bars[i]?.c;
      if (!finite(value)) { count = 0; seed = 0; previous = null; continue; }
      if (previous === null) { seed += value; if (++count < period) continue; previous = seed / period; }
      else previous += alpha * (value - previous);
      values[i] = previous;
    }
    return values;
  }
  function rsi(bars, period) {
    const values = new Array(bars.length).fill(null); let previous = null, count = 0, gain = 0, loss = 0;
    for (let i = 0; i < bars.length; i++) {
      const value = bars[i]?.c;
      if (!finite(value)) { previous = null; count = 0; gain = 0; loss = 0; continue; }
      if (previous === null) { previous = value; continue; }
      const delta = value - previous; previous = value;
      if (count < period) { gain += Math.max(0, delta); loss += Math.max(0, -delta); if (++count < period) continue; gain /= period; loss /= period; }
      else { gain = (gain * (period - 1) + Math.max(0, delta)) / period; loss = (loss * (period - 1) + Math.max(0, -delta)) / period; }
      values[i] = loss === 0 ? gain === 0 ? 50 : 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
    }
    return values;
  }
  function createCalculator() {
    const cache = new WeakMap();
    return function calculate(bars, revision, enabled) {
      const tail = bars.at(-1), key = JSON.stringify([revision, bars.length, tail?.t, tail?.c,
        ...['sma5','sma10','sma20','ema20','boll20','rsi14'].map(name => !!enabled[name])]);
      const cached = cache.get(bars); if (cached?.key === key) return cached.values;
      const values = {};
      for (const period of [5,10,20]) if (enabled['sma' + period]) values['sma' + period] = rolling(bars, period);
      if (enabled.ema20) values.ema20 = ema(bars, 20);
      if (enabled.boll20) values.boll20 = rolling(bars, 20, true);
      if (enabled.rsi14) values.rsi14 = rsi(bars, 14);
      cache.set(bars, {key, values}); return values;
    };
  }
  window.PANEL_CHART_STUDIES = Object.freeze({createCalculator});
})();
