(() => {
  const TIMEFRAMES = Object.freeze([
    Object.freeze({key:'intraday', label:'分时', kind:'quote', visible:80, prewarm:0, minVisible:1}),
    Object.freeze({key:'daily30', label:'日K', kind:'history', apiPeriod:'daily', visible:60, prewarm:19, minVisible:1}),
    Object.freeze({key:'weekly', label:'周K', kind:'history', apiPeriod:'weekly', visible:60, prewarm:19, minVisible:1}),
    Object.freeze({key:'monthly', label:'月K', kind:'history', apiPeriod:'monthly', visible:60, prewarm:19, minVisible:1}),
    Object.freeze({key:'yearly', label:'年K', kind:'history', apiPeriod:'yearly', visible:20, prewarm:19, minVisible:1})
  ]);
  const byKey = Object.freeze(Object.fromEntries(TIMEFRAMES.map(x => [x.key,x])));
  window.PANEL_TIMEFRAMES = Object.freeze({all:TIMEFRAMES, byKey, get:key=>byKey[key] || byKey.daily30});
})();
