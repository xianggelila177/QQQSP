(() => {
  const maSeries = (bars, period) => {
    const out = new Array(bars.length).fill(null); let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      const close = Number(bars[i] && bars[i].c); if (!Number.isFinite(close)) continue;
      sum += close;
      if (i >= period) sum -= Number(bars[i - period] && bars[i - period].c) || 0;
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  };
  window.PANEL_CHART = Object.freeze({ maSeries });
})();
