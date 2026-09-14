(() => {
  const createMarketStore = () => {
  const intradayCache={};  // T1: sym -> {ver,bars} — 分时K线条件传输客户端缓存(配合请求 &cv=, 服务端版本一致时回 'same' 不重传数组)
  const daily30Cache={};   // P1-P1: sym -> {ver,bars} — daily30Version 未变时复用旧日K数组(服务端SLOW_TTL内数据不变, 不再每2s重处理16KB日K)
  // T1: 请求携带客户端已知图表版本号 — 每符号 SYM:iVer:dVer, 无缓存/版本无效用 0
  function chartVersions(symbols){
    return symbols.map(sym => {
      const ic=intradayCache[sym], dc=daily30Cache[sym];
      return sym+':'+((ic && ic.ver>0 && ic.bars) ? ic.ver : 0)+':'+((dc && dc.ver>0 && dc.bars) ? dc.ver : 0);
    }).join(';');
  }
  // T1: 响应图表字段落位 — 'same' 复用本地缓存(畸形: 本地无缓存/ver为0 → 按空数组防御); 全量数组入库带版本(旧后端同版本重发仍复用旧引用)
  function resolveCharts(d){
    if(!d || !d.charts) return;
    if(d.charts.intraday === 'same'){
      const c=intradayCache[d.symbol];
      if(c && c.ver>0 && c.bars){ patchLastBar(c.bars, d.intradayLast); d.charts.intraday=c.bars; }   // 原位补最后一根 t/c(intradayLast 增量)
      else d.charts.intraday=[];   // 防御: 'same' 但本地无缓存 → 空数组, 不发崩溃
    } else if(Array.isArray(d.charts.intraday) && d.intradayVer != null && d.intradayVer > 0){
      const c=intradayCache[d.symbol];
      if(c && d.intradayVer===c.ver) d.charts.intraday=c.bars;
      else intradayCache[d.symbol]={ver:d.intradayVer,bars:d.charts.intraday};
    }
    if(d.charts.daily30 === 'same'){
      const c=daily30Cache[d.symbol];
      if(c && c.ver>0 && c.bars) d.charts.daily30=c.bars;   // 替换原"全量重发再比对版本"逻辑: 服务端一致时只回字符串
      else d.charts.daily30=[];    // 防御: 同上
    } else if(Array.isArray(d.charts.daily30) && (d.daily30Ver ?? d.daily30Version) > 0){
      const c=daily30Cache[d.symbol];
      if(c && (d.daily30Ver ?? d.daily30Version)===c.ver) d.charts.daily30=c.bars;
      else daily30Cache[d.symbol]={ver:d.daily30Ver ?? d.daily30Version,bars:d.charts.daily30};
    }
  }
  // T1: 'same' 复用时按 intradayLast [t,c] 原位更新缓存最后一根(不重建数组, 保持引用稳定 → drawChart 增量签名可见)
  function patchLastBar(bars, last){
    if(!Array.isArray(bars) || !bars.length || !Array.isArray(last) || last.length<2) return;
    const b=bars[bars.length-1];
    if(!b || typeof b!=='object') return;
    if(last[0]!=null) b.t=last[0];
    if(last[1]!=null) b.c=last[1];
  }
    const quotes=new Map();
    function prepareQuote(data) {
      const previous=quotes.get(data.symbol);
      if(!data.charts && previous?.charts)data.charts=previous.charts;
      resolveCharts(data);quotes.set(data.symbol,data);return data;
    }
    function remove(symbol) {quotes.delete(symbol);delete intradayCache[symbol];delete daily30Cache[symbol];}
    return Object.freeze({prepareQuote,chartVersions,remove,intradayCache,daily30Cache});
  };
  window.PANEL_MARKET_STORE=Object.freeze({createMarketStore});
})();
