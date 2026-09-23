(() => {
  // A quote endpoint is a separate display observation, never a historical bar.
  function livePointFor(d) {
    const point=d?.intradayLivePoint,history=d?.regularChart?.bars,last=Array.isArray(history)?history.at(-1):null;
    if(d?.intradayLiveStatus!=='ready'||!point||!last||d.error||d.pending||d.stale||d.staleInfo||d.recovery)return null;
    if(d.marketState!=='REGULAR'||d.priceSession!=='REGULAR'||d.regularChart?.source!==d.src)return null;
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
    if(d.regularChart?.tradeDate!==point.sessionDate||
      !d.regularChart?.regularSessions?.some(s=>point.t*1000>=s.open_at_ms&&point.t*1000<=s.close_at_ms))return null;
    return {...point,_live:true};
  }
  // Selection only. All sample records originate in the durable server store.
  function createObservationSeries({now=()=>Date.now()}={}) {
    const filtered=new WeakMap();
    return function select(d,mode='history',samples){
      const history=Array.isArray(d?.regularChart?.bars)?d.regularChart.bars:[];
      if(mode==='samples'){
        let points=Array.isArray(samples?.points)?samples.points:[];
        if(d?.currency&&points.some(p=>p.currency!==d.currency)){
          let cached=filtered.get(points);if(!cached||cached.currency!==d.currency){cached={currency:d.currency,points:points.filter(p=>p.currency===d.currency)};filtered.set(points,cached);}points=cached.points;
        }
        if(d?.regularChart){const sessions=d.regularChart.recentSessions||[];
          points=points.filter(p=>sessions.some(day=>day.date===p.tradingDate&&
            day.sessions.some(s=>p.t*1000>=s.open_at_ms&&p.t*1000<s.close_at_ms)));}
        const coverage='已覆盖 '+new Set(points.map(p=>p.tradingDate)).size+'/3 个交易日常规时段';
        const note=samples?.status==='loading'?'正在读取服务器采样…':samples?.supported===false?samples.reason||'暂不支持三交易日采样':samples?.enabled===false?'服务器后台采样尚未启用':
          samples?.status==='paused'?(points.length?'后台已停止采集 · '+coverage:'该标的未在后台自选中，更新自选后同步'):
          samples?.error||samples?.persistenceError?(samples.error||'采样保存异常，已有记录仍可查看'):
          !points.length?'后台采集中，等待新的有效报价；启用前的数据不会补造':coverage+' · 每分钟末次有效报价 · 非完整成交历史';
        return {bars:points,sampled:true,note};
      }
      const tail=history.at(-1),off=d?.gmtoff,active=d?.marketState==='REGULAR';
      const date=tail&&Number.isFinite(off)?new Date(tail.t*1000+off*1000).toISOString().slice(0,10):'';
      const today=Number.isFinite(off)?new Date(now()+off*1000).toISOString().slice(0,10):'';
      const chart=d?.regularChart,chartDate=chart?.tradeDate||date;
      return {bars:history,sampled:false,note:!history.length?'常规分时暂不可用：'+(chart?.missingReason||'等待后台更新'):
        chart?.missingReason?'图表日期 '+chartDate+' · '+chart.missingReason:
        '图表日期 '+chartDate+' · 常规时段'+(chart?.volumeQuality?.status==='missing'?' · 区间成交量暂缺':'')+
        (active&&d.quoteAt-tail.t*1000>600000?' · 来源历史较最新报价滞后':'')};
    };
  }
  const sampleGap=(a,b)=>!a||a.tradingDate!==b.tradingDate||a.source!==b.source||a.currency!==b.currency||Math.floor(b.t/60)-Math.floor(a.t/60)>1;
  const CHART_THEME=Object.freeze({axisText:'#596574',ma:Object.freeze({5:Object.freeze({line:'#e0a13c',text:'#875706'}),10:Object.freeze({line:'#3d8bd6',text:'#2265a3'}),20:Object.freeze({line:'#9b59b6',text:'#82409b'})})});
  // Canvas geometry and rendering have one implementation. Application state
  // supplies formatting and series helpers explicitly at construction time.
  const createChartEngine = ({ UP, DOWN, fmtDate, formatterFor, maSeries }) => {
  const seriesCache = new WeakMap();
  const localClock=(at,zone)=>{
    if(!zone)return fmtDate(at/1000,true).slice(11,16);
    try{return new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at));}
    catch{return fmtDate(at/1000,true).slice(11,16);}
  };
  const localDay=(at,zone)=>{
    try{return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}
    catch{return new Date(at).toISOString().slice(0,10);}
  };
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
    let vwapSeries=null;
    if(q._estimatedVwap&&q.tf==='intraday'&&!q._sampled){
      vwapSeries=[];let day=null,weighted=0,volume=0,broken=false;
      for(const b of all){
        const key=localDay(b.t*1000,d?.regularChart?.exchangeZone||q._displayZone||'America/New_York');
        if(key!==day){day=key;weighted=0;volume=0;broken=false;}
        if(!Number.isFinite(b.v)||b.v<0||![b.h,b.l,b.c].every(Number.isFinite)){broken=true;vwapSeries.push(null);continue;}
        if(broken){vwapSeries.push(null);continue;}
        weighted+=(b.h+b.l+b.c)/3*b.v;volume+=b.v;
        vwapSeries.push(volume>0?weighted/volume:null);
      }
    }
    q._vwapSeries=vwapSeries;
    const periods=[5,10,20].filter(period=>q.maEnabled?.[period]!==false);
    let maxH = -Infinity, minL = Infinity;
    for (const b of bars) { const h = hi(b), l = lo(b); if (h > maxH) maxH = h; if (l < minL) minL = l; }
    for(const period of periods)for(const value of (ma[period]||[]).slice(a,a+bars.length))if(value!=null&&Number.isFinite(value)){maxH=Math.max(maxH,value);minL=Math.min(minL,value);}
    for(const value of (vwapSeries||[]).slice(a,a+bars.length))if(value!=null&&Number.isFinite(value)){maxH=Math.max(maxH,value);minL=Math.min(minL,value);}
    const reference=q.tf==='intraday'&&!q._sampled&&d?.regularChart?.previousCloseReference?.value>0?
      d.regularChart.previousCloseReference:null;
    if(reference){maxH=Math.max(maxH,reference.value);minL=Math.min(minL,reference.value);}
    if (!isFinite(maxH)) { maxH = 1; minL = 0; }
    const rect = q._chartWidth ? {width:q._chartWidth} : q.cv?.getBoundingClientRect?.();
    q._chartWidth = rect?.width || 1000;
    const W = Math.max(1, Number(rect?.width) || 1000), H = q._chartHeight || (W < 420 ? 220 : 240), padT = 8, padB = 24;
    const span = Math.max((maxH - minL) || 0, (maxH || 1) * 0.0005);
    const top = maxH + span * 0.08, bot = minL - span * 0.08;
    const axisFont=(W<420?12:11)+'px sans-serif', measure=q.cv?.getContext?.('2d');
    if(measure)measure.font=axisFont;
    const money=formatterFor(displayData).money;
    const labels=Array.from({length:5},(_,g)=>money(top-(top-bot)*g/4)).concat(bars.map(b=>money(b.c)));
    const textWidth=Math.max(0,...labels.map(text=>measure?.measureText?.(text).width??String(text).length*7));
    const intraday=q.tf==='intraday';
    const L=intraday?Math.min(92,Math.max(54,Math.ceil(textWidth)+12)):8;
    const R=intraday?Math.min(68,Math.max(50,W-L-80)):Math.min(Math.max(40,W-L-100),Math.max(56,Math.ceil(textWidth)+18));
    const plotW = Math.max(1,W - L - R), n = bars.length;
    const slot = plotW / Math.max(n, 1);
    const hVol = q._chartHeight ? Math.max(56,Math.round(H*.2)) : 56, chartH = H - padT - hVol - padB - 8, yTop = padT;
    const y = v => yTop + ((top - v) / (top - bot)) * chartH;
    const sessions=intraday&&!q._sampled?d?.regularChart?.regularSessions||[]:[];
    const full=vis>=all.length&&q.followEnd;
    const start=full?sessions[0]?.open_at_ms:bars[0]?.t*1000;
    const now=Date.now(),activeSession=sessions.find(s=>now>=s.open_at_ms&&now<s.close_at_ms);
    const latestBarAt=bars.at(-1)?.t*1000;
    const progressive=full&&!q.fullSession&&!q._fiveDay&&d?.marketState==='REGULAR'&&activeSession&&
      Number.isFinite(d?.quoteAt)&&d.quoteAt>=start&&d.quoteAt<=activeSession.close_at_ms&&
      Number.isFinite(latestBarAt)&&latestBarAt>=start&&latestBarAt<=activeSession.close_at_ms;
    const end=progressive?Math.min(activeSession.close_at_ms,
      Math.max(start+30*60000,now+5*60000,d.quoteAt+5*60000,latestBarAt+5*60000)):
      full?sessions.at(-1)?.close_at_ms:latestBarAt;
    const visibleSessions=sessions.map(s=>({open:Math.max(start,s.open_at_ms),close:Math.min(end,s.close_at_ms)}))
      .filter(s=>Number.isFinite(s.open)&&Number.isFinite(s.close)&&s.close>s.open);
    const duration=visibleSessions.reduce((sum,s)=>sum+s.close-s.open,0);
    const timeline=intraday&&!q._sampled&&duration>0;
    const xAtTime=ms=>{
      let elapsed=0;
      for(const s of visibleSessions){if(ms>=s.close)elapsed+=s.close-s.open;
        else if(ms>s.open){elapsed+=ms-s.open;break;}else break;}
      return L+Math.max(0,Math.min(1,elapsed/duration))*plotW;
    };
    const x = i => timeline?xAtTime(bars[i].t*1000):L+(i+.5)*slot;
    const deltas=bars.slice(1).map((b,i)=>b.t-bars[i].t).filter(v=>v>0&&v<3600).sort((a,b)=>a-b);
    const gapSeconds=Math.max(600,(deltas[Math.floor(deltas.length/2)]||300)*3);
    return { ma, vwapSeries, periods, axisFont, intraday, history, live, W, H, L, R, top, bot, n, slot, hVol, chartH,
      yTop, y, x, xAtTime, timeline, visibleSessions, gapSeconds, reference,bars, all, candle, a, vis };
  }

  function pTicks(q, p) {
    const money = formatterFor(q._chartData||q.d).money;
    const cx = p.ctx; cx.font = p.axisFont; cx.textAlign = 'left'; cx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const v = p.top - (p.top - p.bot) * g / 4;
      cx.fillStyle = CHART_THEME.axisText;
      const yy=p.yTop+p.chartH*g/4;
      if(p.intraday){
        cx.textAlign='right';cx.fillText(money(v),p.L-6,yy,p.L-8);
        if(p.reference){const pct=(v/p.reference.value-1)*100;
          cx.textAlign='left';cx.fillText((pct>=0?'+':'')+pct.toFixed(2)+'%',p.W-p.R+5,yy,p.R-7);}
      }else cx.fillText(money(v), p.W - p.R + 8, yy,p.R-10);
    }
    cx.textBaseline = 'alphabetic';
  }
  // 右轴价签(圆角小牌, 交易所式)
  function priceTag(cx, p, yy, text, bg) {
    const w = p.intraday ? p.L-8 : p.R-10, h = 16, x0 = p.intraday ? 2 : p.W-p.R+5;
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
    if(p.timeline){
      const first=p.visibleSessions[0].open,last=p.visibleSessions.at(-1).close;
      if(q._fiveDay){
        const dates=new Set();
        for(const s of p.visibleSessions){const date=localDay(s.open,q._displayZone||'America/New_York');
          if(dates.has(date))continue;dates.add(date);
          cx.fillText(date.slice(5),p.xAtTime(s.open)+15,H-7,44);
        }
      }else for(const at of [first,first+(last-first)/2,last]){
        const label=localClock(at,q._displayZone);
        cx.fillText(label,p.xAtTime(at),H-7,52);
      }
      cx.textAlign='left';cx.fillText(q._zoneLabel||'北京时间',L,H-18,85);
    }else{
      const tickCount=Math.min(n,Math.max(2,Math.floor((W-L-R)/90)));
      let previousDate=null;
      for (let tick=0;tick<tickCount;tick++) {
        const i=tickCount===1?0:Math.round(tick*(n-1)/(tickCount-1));
        const ds = fmtDate(bars[i].t, true);
        const date=bars[i].periodStart||ds.slice(0,10),label=p.intraday?((q._sampled||previousDate&&date!==previousDate?ds.slice(5,10)+' ':'')+ds.slice(11)):q.tf==='yearly'?date.slice(0,4):q.tf==='monthly'?date.slice(0,7):q.tf==='weekly'?date:ds.slice(5,10);
        const maxWidth=Math.min(100,W-L-R),width=Math.min(maxWidth,cx.measureText?.(label).width??label.length*7);
        cx.fillText(label,Math.max(L+width/2,Math.min(W-R-width/2,p.x(i))),H-7,maxWidth);previousDate=date;
      }
    }
    if(p.reference){const yy=Math.round(p.y(p.reference.value))+.5;
      cx.strokeStyle='rgba(96,105,115,.6)';cx.setLineDash([4,4]);cx.beginPath();cx.moveTo(L,yy);cx.lineTo(W-R,yy);cx.stroke();cx.setLineDash([]);
    }
    if(q._fiveDay&&p.timeline){let lastDay=null;for(const s of p.visibleSessions){const day=localDay(s.open,q._displayZone||'America/New_York');
      if(day===lastDay)continue;lastDay=day;const xx=p.xAtTime(s.open);
      cx.strokeStyle='rgba(31,30,29,.12)';cx.beginPath();cx.moveTo(xx,yTop);cx.lineTo(xx,yTop+chartH);cx.stroke();}}
    // 成交量: 仅已核验的区间量进入尺度。null 保持缺失语义。
    const col = b => b.c >= b.o ? UP : DOWN;
    const volumes=bars.map(b=>b.v).filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0);
    const maxV = volumes.length?Math.max(1,...volumes):1;
    cx.globalAlpha = 0.45;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      if(b._live||!Number.isFinite(b.v)||b.v<=0)continue;
      const vh=Math.max(1,b.v/maxV*hVol);
      const prior=bars[i-1],sameSession=prior&&(!p.timeline||p.visibleSessions.some(s=>
        prior.t*1000>=s.open&&b.t*1000<s.close));
      cx.fillStyle = candle ? col(b) : !sameSession?'#808b99':b.c>prior.c?UP:b.c<prior.c?DOWN:'#808b99';
      cx.fillRect(Math.round(p.x(i) - bw / 2), vtop + (hVol - vh), Math.max(1, Math.round(bw)), vh);
    }
    cx.globalAlpha = 1;
    cx.fillStyle=CHART_THEME.axisText;cx.font=p.axisFont;cx.textAlign='left';
    const unit=q.tf==='intraday'?q.d?.regularChart?.volumeUnit:q.historyStore?.getMeta(q.tf)?.meta?.volumeUnit;
    const unitText=unit==='shares'?'股':unit==='lots'?'手':unit==='contracts'?'张':'';
    cx.fillText(volumes.length?'量'+(unitText?'('+unitText+')':'')+' '+(window.PANEL_FORMAT?.fmtVol?.(maxV)||maxV):'区间成交量暂缺',L,vtop+10,Math.max(70,W-L-R));
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
      const g = cx.createLinearGradient(0, yTop, 0, yTop + chartH); g.addColorStop(0, up ? 'rgba(214,59,59,.13)' : 'rgba(26,143,78,.13)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      const segments=[];let segment=[];
      lineBars.forEach((b,i)=>{
        const prior=lineBars[i-1],sameSession=!p.timeline||p.visibleSessions.some(s=>
          prior?.t*1000>=s.open&&b.t*1000<=s.close);
        if(prior&&(q._sampled?sampleGap(prior,b):b.t-prior.t>p.gapSeconds||!sameSession||
          prior.source&&b.source&&prior.source!==b.source)){
          if(segment.length)segments.push(segment);segment=[];
        }
        segment.push(i);
      });if(segment.length)segments.push(segment);
      for(const indices of segments){
        cx.beginPath();indices.forEach((i,j)=>{const yy=p.y(lineBars[i].c);if(j)cx.lineTo(p.x(i),yy);else cx.moveTo(p.x(i),yy);});
        cx.strokeStyle=lc;cx.lineWidth=1.6;cx.lineJoin='round';cx.stroke();
        if(!q._sampled){const first=indices[0],last=indices.at(-1);
          cx.lineTo(p.x(last),yTop+chartH);cx.lineTo(p.x(first),yTop+chartH);cx.closePath();cx.fillStyle=g;cx.fill();}
      }
      if(q._sampled||lineBars.length===1){cx.fillStyle=lc;lineBars.forEach((b,i)=>{cx.beginPath();cx.arc(p.x(i),p.y(b.c),2.5,0,Math.PI*2);cx.fill();});}
      if(p.vwapSeries){const values=p.vwapSeries.slice(p.a,p.a+n);let drawing=false;
        cx.beginPath();for(let i=0;i<values.length;i++){const value=values[i],b=bars[i],prior=bars[i-1];
          const joined=prior&&b.t-prior.t<=p.gapSeconds&&(!p.timeline||p.visibleSessions.some(s=>
            prior.t*1000>=s.open&&b.t*1000<=s.close));
          if(value==null){drawing=false;continue;}
          if(!drawing||!joined){cx.moveTo(p.x(i),p.y(value));drawing=true;}else cx.lineTo(p.x(i),p.y(value));
        }cx.strokeStyle='#e0a13c';cx.lineWidth=1.5;cx.stroke();}
    }
    const liveIndex=bars.findIndex(b=>b._live);
    if(liveIndex>=0){
      const live=bars[liveIndex],previous=bars[liveIndex-1];
      cx.strokeStyle=previous&&live.c<previous.c?DOWN:UP;cx.lineWidth=1.6;cx.setLineDash([3,3]);
      if(previous){cx.beginPath();cx.moveTo(p.x(liveIndex-1),p.y(previous.c));cx.lineTo(p.x(liveIndex),p.y(live.c));cx.stroke();}
      cx.setLineDash([]);cx.fillStyle=cx.strokeStyle;cx.beginPath();cx.arc(p.x(liveIndex),p.y(live.c),3,0,Math.PI*2);cx.fill();
    }
    cx.restore();
    if(q._detail&&n>1){
      const valueHigh=b=>candle?b.h:b.c,valueLow=b=>candle?b.l:b.c;
      let high=0,low=0;for(let i=1;i<n;i++){
        if(valueHigh(bars[i])>valueHigh(bars[high]))high=i;
        if(valueLow(bars[i])<valueLow(bars[low]))low=i;
      }
      cx.font=p.axisFont;cx.textAlign='center';cx.fillStyle='#475569';
      const xLabel=i=>Math.max(L+44,Math.min(W-R-44,p.x(i)));
      cx.fillText('高 '+money(valueHigh(bars[high])),xLabel(high),Math.max(yTop+11,p.y(valueHigh(bars[high]))-7),88);
      if(low!==high)cx.fillText('低 '+money(valueLow(bars[low])),xLabel(low),
        Math.min(yTop+chartH-2,p.y(valueLow(bars[low]))+14),88);
      cx.textAlign='left';
    }
    // 最新价虚线 + 右轴价签(红/绿底白字)
    const last = bars[n - 1];
    const lyp = Math.round(p.y(last.c)) + 0.5;
    cx.strokeStyle = 'rgba(31,30,29,.35)'; cx.setLineDash([4, 4]); cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(L, lyp); cx.lineTo(W - R, lyp); cx.stroke(); cx.setLineDash([]);
    priceTag(cx, p, lyp, money(last.c), candle&&!last._live ? (last.c >= last.o ? UP : DOWN) :
      (last.c >= (p.reference?.value||bars[0].c) ? UP : DOWN));
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
  window.PANEL_CHART_ENGINE = Object.freeze({ createChartEngine, CHART_THEME, livePointFor, createObservationSeries, sampleGap });
})();
