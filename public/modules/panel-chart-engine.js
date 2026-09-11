(() => {
  // A quote endpoint is a separate display observation, never a historical bar.
  function livePointFor(d) {
    const point=d?.intradayLivePoint,history=d?.charts?.intraday,last=Array.isArray(history)?history.at(-1):null;
    if(d?.intradayLiveStatus!=='ready'||!point||!last||d.error||d.pending||d.stale||d.staleInfo||d.recovery)return null;
    if(!['REGULAR','PRE','POST','AUCTION'].includes(d.marketState))return null;
    if(!Number.isFinite(point.t)||point.t<=0||!Number.isFinite(point.c)||point.c<=0||point.v!==null||point.c!==d.price)return null;
    if(!Number.isFinite(last.t)||last.t<=0||!Number.isFinite(last.c)||last.c<=0||point.t<last.t||!Number.isFinite(d.quoteAt)||Math.abs(point.t-d.quoteAt/1000)>.001||d.quoteAt>Date.now()+5000)return null;
    if(typeof point.currency!=='string'||point.currency!==d.currency||typeof point.source!=='string'||!point.source||point.source!==d.src)return null;
    if(typeof point.sessionDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(point.sessionDate)||point.sessionDate!==point.historyDate)return null;
    const dateAt=Date.parse(point.sessionDate+'T00:00:00Z');
    if(!Number.isFinite(dateAt)||new Date(dateAt).toISOString().slice(0,10)!==point.sessionDate)return null;
    if(Number.isFinite(d.gmtoff)){
      const localDate=t=>new Date(t*1000+d.gmtoff*1000).toISOString().slice(0,10);
      if(Math.abs(d.gmtoff)>86400||localDate(point.t)!==point.sessionDate||localDate(last.t)!==point.historyDate)return null;
    }
    return {...point,_live:true};
  }
  // Only observations actually received by this browser. A minute retains its
  // last observed trade (the current minute changes each second). Missing
  // minutes remain gaps; no invented OHLC, zero volume, or historical candles.
  function createObservationSeries({now=()=>Date.now(),maxPoints=960}={}) {
    let identity='',points=[],lastAt=0;
    return function select(d,mode='auto'){
      const history=Array.isArray(d?.charts?.intraday)?d.charts.intraday:[];
      const t=d?.quoteAt,off=d?.gmtoff;
      const valid=Number.isFinite(t)&&t>0&&t<=now()+5000&&d?.price>0&&Number.isFinite(off)&&!!d.currency;
      const date=valid?new Date(t+off*1000).toISOString().slice(0,10):'';
      const today=Number.isFinite(off)?new Date(now()+off*1000).toISOString().slice(0,10):'';
      const active=['REGULAR','PRE','POST','AUCTION'].includes(d?.marketState);
      const fresh=valid&&!d.stale&&!d.staleInfo&&!d.recovery&&!d.error&&date===today&&now()-t<=Math.max(120000,(d.feedDelayMinutes||0)*60000+60000);
      const id=[d?.symbol,d?.currency,d?.src,date,d?.priceSession].join('|');
      if(fresh){
        if(id!==identity){identity=id;points=[];lastAt=0;}
        if(t>lastAt || t===lastAt&&points.at(-1)?.c!==d.price){
          const point=Object.freeze({t:t/1000,c:d.price,v:null,_sample:true,source:d.src});
          const bucket=Math.floor(t/60000),previous=points.at(-1);
          points=Object.freeze((previous&&Math.floor(previous.t/60)===bucket?points.slice(0,-1):points).concat(point).slice(-maxPoints));lastAt=t;
        }
      }
      const tail=history.at(-1),historyDate=tail&&Number.isFinite(off)?new Date(tail.t*1000+off*1000).toISOString().slice(0,10):'';
      // Never silently show yesterday's line as today's premarket chart.
      const behind=active&&valid&&historyDate!==date;
      if((mode==='samples'||mode!=='history'&&(!history.length||behind))&&points.length&&identity===id){
        return {bars:points,sampled:true,note:'本次打开后的报价采样 · 非完整历史 · 每分钟末次实价'};
      }
      if(history.length&&mode!=='samples')return {bars:history,sampled:false,note:historyDate&&active&&historyDate!==today?'历史分时日期 '+historyDate+' · 当日历史尚未到达':active&&valid&&t-tail.t*1000>600000?'来源历史较最新报价滞后 · 可切换报价采样':''};
      if(mode==='history')return {bars:[],sampled:false,note:'历史来源暂不可用；可切换报价采样'};
      if(valid){
        const point=Object.freeze({t:t/1000,c:d.price,v:null,_sample:true,source:d.src});
        return {bars:[point],sampled:true,note:'仅最新已知报价点 · 暂无历史分时'};
      }
      return {bars:history,sampled:false,note:'历史来源暂不可用；正在等待有效报价'};
    };
  }
  const CHART_THEME=Object.freeze({axisText:'#596574',ma:Object.freeze({5:Object.freeze({line:'#e0a13c',text:'#875706'}),10:Object.freeze({line:'#3d8bd6',text:'#2265a3'}),20:Object.freeze({line:'#9b59b6',text:'#82409b'})})});
  // Canvas geometry and rendering have one implementation. Application state
  // supplies formatting and series helpers explicitly at construction time.
  const createChartEngine = ({ UP, DOWN, fmtDate, formatterFor, maSeries }) => {
  const seriesCache = new WeakMap();
  function movingAverages(all, revision) {
    const tail = all[all.length - 1];
    const key = [revision, all.length, tail?.t, tail?.c].join(':');
    const cached = seriesCache.get(all);
    if (cached?.key === key) return cached.values;
    const values = Object.fromEntries([5, 10, 20].map(period => [period, maSeries(all, period)]));
    seriesCache.set(all, { key, values });
    return values;
  }
  function computePlot(q) {
    const d = q.d; const displayData=q._chartData||d; const stored=q.tf!=='intraday'?q.historyStore?.getSeries(q.tf):null; const history = q.tf==='intraday'&&q._displayIntraday?q._displayIntraday:stored!=null?stored:((d && d.charts) && d.charts[q.tf]) || (q.tf==='daily30' ? d?.charts?.daily : []) || [];
    const live=q.tf==='intraday'&&!q._sampled?livePointFor(d):null;
    const all=live?history.concat(live):history;
    const candle = q.tf !== 'intraday' && all.length > 0 && all.every(b=>['o','h','l','c'].every(k=>Number.isFinite(b[k]))&&b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c));
    if (!q.visN) q.visN = {};
    let vis = q.visN[q.tf] || window.PANEL_TIMEFRAMES?.get(q.tf)?.visible || (candle ? 60 : 80);
    vis = Math.max(window.PANEL_TIMEFRAMES?.get(q.tf)?.minVisible || 1, Math.min(Math.max(all.length, 1), vis));
    const maxStart = Math.max(0, all.length - vis);
    if (q.followEnd || q.winStart == null || q.winStart > maxStart) q.winStart = maxStart;
    const a = q.winStart;
    const bars = all.slice(a, a + vis);
    const hi = b => candle ? b.h : (b.c != null ? b.c : 0);
    const lo = b => candle ? b.l : (b.c != null ? b.c : 0);
    const revision = q.tf === 'intraday' ? d?.intradayVer : q.historyStore?.getRevision(q.tf) ?? d?.daily30Ver ?? d?.daily30Version;
    const ma = candle ? movingAverages(history, revision) : {};
    const periods=[5,10,20].filter(period=>q.maEnabled?.[period]!==false);
    let maxH = -Infinity, minL = Infinity;
    for (const b of bars) { const h = hi(b), l = lo(b); if (h > maxH) maxH = h; if (l < minL) minL = l; }
    for(const period of periods)for(const value of (ma[period]||[]).slice(a,a+bars.length))if(value!=null&&Number.isFinite(value)){maxH=Math.max(maxH,value);minL=Math.min(minL,value);}
    if (!isFinite(maxH)) { maxH = 1; minL = 0; }
    const rect = q._chartWidth ? {width:q._chartWidth} : q.cv?.getBoundingClientRect?.();
    q._chartWidth = rect?.width || 1000;
    const W = Math.max(1, Number(rect?.width) || 1000), H = W < 420 ? 220 : 240, L = 8, padT = 8, padB = 24;
    const span = Math.max((maxH - minL) || 0, (maxH || 1) * 0.0005);
    const top = maxH + span * 0.08, bot = minL - span * 0.08;
    const axisFont=(W<420?12:11)+'px sans-serif', measure=q.cv?.getContext?.('2d');
    if(measure)measure.font=axisFont;
    const money=formatterFor(displayData).money;
    const labels=Array.from({length:5},(_,g)=>money(top-(top-bot)*g/4)).concat(bars.map(b=>money(b.c)));
    const textWidth=Math.max(0,...labels.map(text=>measure?.measureText?.(text).width??String(text).length*7));
    const R=Math.min(Math.max(40,W-L-100),Math.max(56,Math.ceil(textWidth)+18));
    const plotW = Math.max(1,W - L - R), n = bars.length;
    const slot = plotW / Math.max(n, 1);
    const hVol = 46, chartH = H - padT - hVol - padB, yTop = padT;
    const y = v => yTop + ((top - v) / (top - bot)) * chartH;
    const x = i => L + (i + 0.5) * slot;   // 蜡烛居中于槽位, 实体留间隙
    return { ma, periods, axisFont, intraday:q.tf==='intraday', history, live, W, H, L, R, top, bot, n, slot, hVol, chartH, yTop, y, x, bars, all, candle, a, vis };
  }

  function pTicks(q, p) {
    const money = formatterFor(q._chartData||q.d).money;
    const cx = p.ctx; cx.font = p.axisFont; cx.textAlign = 'left'; cx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const v = p.top - (p.top - p.bot) * g / 4;
      cx.fillStyle = CHART_THEME.axisText;
      cx.fillText(money(v), p.W - p.R + 8, p.yTop + p.chartH * g / 4,p.R-10);
    }
    cx.textBaseline = 'alphabetic';
  }
  // 右轴价签(圆角小牌, 交易所式)
  function priceTag(cx, p, yy, text, bg) {
    const w = p.R - 10, h = 16, x0 = p.W - p.R + 5;
    cx.fillStyle = bg;
    if (cx.roundRect) { cx.beginPath(); cx.roundRect(x0, yy - h / 2, w, h, 3); cx.fill(); }
    else cx.fillRect(x0, yy - h / 2, w, h);
    cx.fillStyle = '#fff'; cx.font = p.axisFont; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(text, x0 + w / 2, yy,w-4);
    cx.textBaseline = 'alphabetic'; cx.textAlign = 'left';
  }

  function drawPlot(q, p, hover) {
    const money = formatterFor(q._chartData||q.d).money;
    const cx = p.ctx; const { W, H, L, R, yTop, chartH, n, slot, hVol, bars, candle } = p;
    cx.clearRect(0, 0, W, H);
    if(!n)return;
    const bw = Math.max(1.5, Math.min(slot * 0.66, 13));            // 实体宽=槽位66%, 间隙34%
    const vtop = yTop + chartH + 8;
    // 横向网格 + 右侧价格轴
    cx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const yy = Math.round(yTop + chartH * g / 4) + 0.5;
      cx.strokeStyle = 'rgba(31,30,29,.08)';
      cx.beginPath(); cx.moveTo(L, yy); cx.lineTo(W - R, yy); cx.stroke();
    }
    pTicks(q, p);
    // 底部时间刻度
    cx.fillStyle = CHART_THEME.axisText; cx.font = p.axisFont; cx.textAlign = 'center';
    const tstep = Math.max(1, Math.ceil(n / Math.max(2,Math.floor((W-L-R)/75))));
    let previousDate=null;
    for (let i = 0; i < n; i += tstep) {
      const ds = fmtDate(bars[i].t, true);
      const date=bars[i].periodStart||ds.slice(0,10),label=p.intraday?((previousDate&&date!==previousDate?ds.slice(5,10)+' ':'')+ds.slice(11)):q.tf==='yearly'?date.slice(0,4):q.tf==='monthly'?date.slice(0,7):q.tf==='weekly'?date:ds.slice(5,10);
      const maxWidth=Math.min(100,W-L-R),width=Math.min(maxWidth,cx.measureText?.(label).width??label.length*7);
      cx.fillText(label,Math.max(L+width/2,Math.min(W-R-width/2,p.x(i))),H-7,maxWidth);previousDate=date;
    }
    // 成交量: 与蜡烛同宽同色
    const col = b => b.c >= b.o ? UP : DOWN;
    const maxV = Math.max.apply(null, bars.map(b => b.v || 0)) || 1;
    cx.globalAlpha = 0.45;
    for (let i = 0; i < n; i++) {
      const b = bars[i]; const vh = Math.max(1, (b.v || 0) / maxV * hVol);
      if(b._live||!Number.isFinite(b.v)||b.v<=0)continue;
      cx.fillStyle = candle ? col(b) : (b.c >= bars[0].c ? UP : DOWN);
      cx.fillRect(Math.round(p.x(i) - bw / 2), vtop + (hVol - vh), Math.max(1, Math.round(bw)), vh);
    }
    cx.globalAlpha = 1;
    cx.save();cx.beginPath();cx.rect(L,yTop,Math.max(1,W-L-R),chartH);cx.clip();
    if (candle) {
      for (let i = 0; i < n; i++) {
        const b = bars[i], c2 = col(b);
        if(b._live)continue;
        const xc = Math.round(p.x(i)) + 0.5;                        // 影线对齐像素, 清晰
        cx.strokeStyle = c2; cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(xc, Math.round(p.y(b.h))); cx.lineTo(xc, Math.round(p.y(b.l))); cx.stroke();
        const ybT = Math.round(Math.min(p.y(b.o), p.y(b.c)));
        const bh = Math.max(1, Math.round(Math.abs(p.y(b.o) - p.y(b.c))));
        cx.fillStyle = c2; cx.fillRect(Math.round(p.x(i) - bw / 2), ybT, Math.max(1, Math.round(bw)), bh);
      }
      p.periods.forEach(per => {const mcol=CHART_THEME.ma[per].line;
        const ms = p.ma[per].slice(p.a, p.a + n); cx.strokeStyle = mcol; cx.lineWidth = 1.2; cx.lineJoin = 'round';
        cx.beginPath(); let st = false;
        ms.forEach((v, i) => { if (v == null) return; const yy = p.y(v); if (!st) { cx.moveTo(p.x(i), yy); st = true; } else cx.lineTo(p.x(i), yy); });
        cx.stroke();
      });
    } else {
      const lineBars=bars.filter(b=>!b._live),closes=lineBars.map(b=>b.c);
      const up = closes[closes.length - 1] >= closes[0]; const lc = up ? UP : DOWN;
      cx.beginPath(); closes.forEach((v, i) => { const yy = p.y(v); if (i === 0 || lineBars[i]._sample&&lineBars[i].t-lineBars[i-1].t>120) cx.moveTo(p.x(i), yy); else cx.lineTo(p.x(i), yy); });
      cx.strokeStyle = lc; cx.lineWidth = 1.6; cx.lineJoin = 'round'; cx.stroke();
      cx.lineTo(p.x(closes.length - 1), yTop + chartH); cx.lineTo(p.x(0), yTop + chartH); cx.closePath();
      const g = cx.createLinearGradient(0, yTop, 0, yTop + chartH); g.addColorStop(0, up ? 'rgba(214,59,59,.13)' : 'rgba(26,143,78,.13)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      cx.fillStyle = g; if(!q._sampled)cx.fill();
      if(q._sampled||lineBars.length===1){cx.fillStyle=lc;lineBars.forEach((b,i)=>{cx.beginPath();cx.arc(p.x(i),p.y(b.c),2.5,0,Math.PI*2);cx.fill();});}
    }
    const liveIndex=bars.findIndex(b=>b._live);
    if(liveIndex>=0){
      const live=bars[liveIndex],previous=bars[liveIndex-1];
      cx.strokeStyle=previous&&live.c<previous.c?DOWN:UP;cx.lineWidth=1.6;cx.setLineDash([3,3]);
      if(previous){cx.beginPath();cx.moveTo(p.x(liveIndex-1),p.y(previous.c));cx.lineTo(p.x(liveIndex),p.y(live.c));cx.stroke();}
      cx.setLineDash([]);cx.fillStyle=cx.strokeStyle;cx.beginPath();cx.arc(p.x(liveIndex),p.y(live.c),3,0,Math.PI*2);cx.fill();
    }
    cx.restore();
    // 最新价虚线 + 右轴价签(红/绿底白字)
    const last = bars[n - 1];
    const lyp = Math.round(p.y(last.c)) + 0.5;
    cx.strokeStyle = 'rgba(31,30,29,.35)'; cx.setLineDash([4, 4]); cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(L, lyp); cx.lineTo(W - R, lyp); cx.stroke(); cx.setLineDash([]);
    priceTag(cx, p, lyp, money(last.c), candle&&!last._live ? (last.c >= last.o ? UP : DOWN) : (last.c >= bars[0].c ? UP : DOWN));
  }
  function drawCursor(q, p, hover, cx) {
    const money = formatterFor(q._chartData||q.d).money;
    const { W, H, L, R, yTop, chartH, hVol, bars, n } = p;
    const vtop = yTop + chartH + 8;
    cx.clearRect(0, 0, W, H);
    // 十字光标 + 光标价签
    if (hover != null && hover >= 0 && hover < n) {
      const hiX = Math.round(p.x(hover)) + 0.5, hiY = Math.round(p.y(bars[hover].c)) + 0.5;
      cx.strokeStyle = 'rgba(31,30,29,.4)'; cx.setLineDash([3, 3]); cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(hiX, yTop); cx.lineTo(hiX, vtop + hVol); cx.stroke();
      cx.beginPath(); cx.moveTo(L, hiY); cx.lineTo(W - R, hiY); cx.stroke(); cx.setLineDash([]);
      priceTag(cx, p, hiY, money(bars[hover].c), '#6b6967');
    }
  }
    return Object.freeze({ computePlot, drawPlot, drawCursor });
  };
  window.PANEL_CHART_ENGINE = Object.freeze({ createChartEngine, CHART_THEME, livePointFor, createObservationSeries });
})();
