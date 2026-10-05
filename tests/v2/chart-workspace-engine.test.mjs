import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function setup(){
  const box={window:{},Date};
  for(const name of ['panel-timeframes','panel-chart','panel-chart-studies','panel-chart-engine'])
    vm.runInNewContext(fs.readFileSync(new URL('../../public/modules/'+name+'.js',import.meta.url),'utf8'),box);
  const engine=box.window.PANEL_CHART_ENGINE.createChartEngine({UP:'red',DOWN:'green',
    fmtDate:t=>new Date(t*1000).toISOString().slice(0,16).replace('T',' '),formatterFor:()=>({money:v=>Number(v).toFixed(2)}),maSeries:box.window.PANEL_CHART.maSeries});
  return {engine,calculate:box.window.PANEL_CHART_STUDIES.createCalculator()};
}
const options={sma5:true,sma10:true,sma20:true,ema20:true,boll20:true,rsi14:true};
const closeTo=(actual,expected,tolerance=1e-9)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const rows=closes=>closes.map((c,i)=>({t:Date.parse('2025-01-01')/1000+i*86400,o:c,h:c+1,l:c-1,c,v:100+i}));
function model(bars,settings={}){
  let revision='1';return {tf:'daily30',_chartWidth:700,followEnd:true,chartStyle:'candle',visN:{daily30:5},
    d:{charts:{daily30:bars},currency:'USD'},chartSettings:{scale:'linear',volume:true,studies:options,...settings},
    historyStore:{getSeries:()=>bars,getRevision:()=>revision,getMeta:()=>({meta:{volumeUnit:'shares'}})},rev:value=>revision=value};
}
function canvas(){
  const paths=[],rects=[],labels=[];let path=[];
  const cx=new Proxy({beginPath(){path=[];},moveTo(x,y){path.push(['move',x,y]);},lineTo(x,y){path.push(['line',x,y]);},
    stroke(){paths.push({color:this.strokeStyle,path:[...path]});},fillRect(x,y,w,h){rects.push({x,y,w,h,color:this.fillStyle});},
    fillText(text,x,y){labels.push({text,x,y});},measureText:text=>({width:String(text).length*6}),
    createLinearGradient:()=>({addColorStop(){}})},{get:(target,key)=>key in target?target[key]:()=>{}});
  return {cx,paths,rects,labels};
}

test('study definitions have explicit warmup, SMA-seeded EMA, population Bollinger bands and Wilder RSI',()=>{
  const {calculate}=setup(),bars=rows(Array.from({length:40},(_,i)=>i+1)),p=calculate(bars,'1',options);
  assert.equal(p.sma20[18],null);closeTo(p.sma20[19],10.5);closeTo(p.sma20[39],30.5);
  assert.equal(p.ema20[18],null);closeTo(p.ema20[19],10.5);closeTo(p.ema20[39],30.5);
  closeTo(p.boll20.middle[39],30.5);closeTo(p.boll20.upper[39],30.5+2*Math.sqrt(33.25));
  closeTo(p.boll20.lower[39],30.5-2*Math.sqrt(33.25));
  assert.equal(p.rsi14[13],null);assert.equal(p.rsi14[14],100);
  const prices=[44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00];
  const r=calculate(rows(prices),'rsi',options).rsi14;
  closeTo(r[14],70.46413502109705);closeTo(r[15],66.24961855355505);
  assert.equal(calculate(rows(new Array(20).fill(10)),'flat',options).rsi14[14],50);
  assert.equal(calculate(rows(Array.from({length:20},(_,i)=>20-i)),'down',options).rsi14[14],0);
});

test('missing closes restart indicator warmup without converting null or strings to prices',()=>{
  const {calculate}=setup();
  for(const missing of [null,undefined,NaN,'100']){
    const bars=rows([...new Array(25).fill(100),missing,...new Array(20).fill(110)]),p=calculate(bars,'1',options);
    for(const values of [p.sma20,p.ema20,p.boll20.middle,p.rsi14])assert.equal(values[25],null);
    for(const values of [p.sma20,p.ema20,p.boll20.upper]){assert.equal(values[44],null);closeTo(values[45],110);}
    assert.equal(p.rsi14[39],null);assert.equal(p.rsi14[40],50);
  }
});

test('rolling Bollinger variance remains usable with large price offsets',()=>{
  const {calculate}=setup(),closes=Array.from({length:120},(_,i)=>1e9+(i%13)*.01),p=calculate(rows(closes),'1',options);
  for(let i=19;i<closes.length;i++){
    const window=closes.slice(i-19,i+1),mean=window.reduce((a,b)=>a+(b-1e9),0)/20+1e9;
    const sd=Math.sqrt(window.reduce((sum,value)=>sum+(value-mean)**2,0)/20);
    closeTo(p.boll20.upper[i],mean+2*sd,1e-5);closeTo(p.boll20.lower[i],mean-2*sd,1e-5);
  }
});

test('engine computes studies from loaded history, exposes enabled values in line mode and reuses them across viewport changes',()=>{
  const {engine}=setup(),bars=rows(Array.from({length:40},(_,i)=>100+i)),q=model(bars);q.chartStyle='line';
  const p=engine.computePlot(q);assert.equal(p.a,35);closeTo(p.ma[20][p.a],125.5);assert.ok(p.studies.ema20[p.a]);
  assert.equal(p.studyOptions.rsi14,true);q.followEnd=false;q.winStart=30;q.chartSettings.scale='percent';
  const pan=engine.computePlot(q);assert.equal(pan.studies,p.studies,'scale/pan do not recompute studies');
  const context=canvas();engine.drawCursor(q,pan,2,context.cx);assert.equal(engine.computePlot(q).studies,p.studies);
  bars[10].c+=10;q.rev('2');const changed=engine.computePlot(q);assert.notEqual(changed.studies,p.studies);
  assert.notEqual(changed.studies.ema20[35],p.studies.ema20[35]);
  q.chartSettings.studies={sma5:false,sma10:false,sma20:false,rsi14:true};
  const onlyRsi=engine.computePlot(q);assert.equal(onlyRsi.periods.length,0);assert.equal(onlyRsi.studies.ema20,undefined);
  assert.equal(onlyRsi.studies.boll20,undefined);assert.ok(onlyRsi.rsiPane);
});

test('price scales round trip in raw price units and percent anchors to the visible first close',()=>{
  const {engine}=setup(),bars=rows([100,120,160,200,240,280]),q=model(bars,{studies:{sma5:false,sma10:false,sma20:false}});
  for(const scale of ['linear','percent','log']){
    q.chartSettings.scale=scale;const p=engine.computePlot(q);assert.equal(p.scale,scale);assert.equal(p.scaleNotice,'');
    for(const price of [p.bot,25,100,p.top])closeTo(p.priceAt(p.y(price)),price,1e-8);
    if(scale==='log')closeTo(p.priceAt(p.yTop+p.chartH/2),Math.sqrt(p.top*p.bot));
    if(scale==='percent'){assert.equal(p.scaleBase,120);assert.equal(p.axisLabel(120),'+0.00%');assert.equal(p.axisLabel(240),'+100.00%');}
  }
  q.followEnd=false;q.winStart=0;const p=engine.computePlot({...q,chartSettings:{...q.chartSettings,scale:'percent'}});assert.equal(p.scaleBase,100);
});

test('nonpositive prices or log padding and invalid percent references fall back with an explicit notice',()=>{
  const {engine}=setup();
  for(const prices of [[-3,-2,-1],[0,1,2],[1,100,200]]){
    const q=model(rows(prices),{scale:'log'}),p=engine.computePlot(q);assert.equal(p.scale,'linear');assert.ok(p.scaleNotice);
    closeTo(p.priceAt(p.y(prices[0])),prices[0]);
  }
  const p=engine.computePlot(model(rows([-3,-2,-1]),{scale:'percent'}));
  assert.equal(p.scale,'linear');assert.equal(p.scaleBase,null);assert.ok(p.scaleNotice);
  const mixed=engine.computePlot(model(rows([-1,10,20]),{scale:'percent'}));
  assert.equal(mixed.scale,'linear');assert.equal(mixed.scaleBase,null);assert.match(mixed.scaleNotice,/首根/);
});

test('volume can be hidden and RSI owns a separate fixed domain without changing price range',()=>{
  const {engine}=setup(),bars=rows(Array.from({length:40},(_,i)=>1000+i)),q=model(bars),p=engine.computePlot(q);
  assert.ok(p.rsiPane.top>p.yTop+p.chartH+p.hVol);closeTo(p.rsiPane.y(100),p.rsiPane.top);closeTo(p.rsiPane.y(0),p.rsiPane.bottom);
  closeTo(p.rsiPane.valueAt(p.rsiPane.y(70)),70);assert.ok(p.bot>1000,'RSI 0-100 never pollutes price domain');
  q.chartSettings.volume=false;const hidden=engine.computePlot(q);assert.equal(hidden.hVol,0);assert.ok(hidden.chartH>p.chartH);
  assert.equal(hidden.top,p.top);assert.equal(hidden.bot,p.bot);
  const context=canvas();hidden.ctx=context.cx;engine.drawPlot(q,hidden);
  assert.ok(!context.labels.some(item=>String(item.text).startsWith('量')||String(item.text).includes('区间成交量')));
  assert.ok(context.labels.some(item=>item.text==='RSI 14'));
  assert.ok(context.paths.some(item=>item.color==='#82409b'));
});

test('renderer draws EMA and bands on closing lines and uses scaled labels for axis and cursor',()=>{
  const {engine}=setup(),q=model(rows(Array.from({length:40},(_,i)=>100+i)),{scale:'percent',volume:false});q.chartStyle='line';
  const p=engine.computePlot(q),context=canvas();p.ctx=context.cx;engine.drawPlot(q,p);engine.drawCursor(q,p,3,context.cx);
  for(const color of ['#c46b30','#468296','#749ca8','#e0a13c','#82409b'])assert.ok(context.paths.some(item=>item.color===color),color);
  assert.ok(context.labels.some(item=>item.text===p.axisLabel(p.bars[3].c)));
  assert.ok(context.paths.some(item=>item.path.some(point=>point[0]==='line'&&point[2]===p.plotBottom)),'cursor spans RSI');
});

test('indicator lines break across missing warmup windows instead of connecting fabricated values',()=>{
  const {engine}=setup(),bars=rows([...new Array(25).fill(100),null,...new Array(25).fill(110)]),q=model(bars,{volume:false});
  q.visN.daily30=bars.length;q.chartStyle='line';const p=engine.computePlot(q),context=canvas();p.ctx=context.cx;engine.drawPlot(q,p);
  const ema=context.paths.find(item=>item.color==='#c46b30');
  assert.equal(ema.path.filter(point=>point[0]==='move').length,2);
  for(const path of context.paths)for(const point of path.path)assert.ok(Number.isFinite(point[1])&&Number.isFinite(point[2]));
  assert.ok(p.bot>90,'null does not become zero in autoscale');
});

test('indicator cache uses O(n) close reads, does not mutate bars and invalidates settings or revisions',()=>{
  const {calculate}=setup();let reads=0;
  const make=n=>Object.freeze(Array.from({length:n},(_,i)=>Object.freeze({t:i,get c(){reads++;return 100+i%11;}})));
  const a=make(1000);calculate(a,'1',options);const small=reads;reads=0;
  const b=make(2000),first=calculate(b,'1',options),large=reads;assert.ok(large<small*2.01);
  reads=0;assert.equal(calculate(b,'1',options),first);assert.ok(reads<=1,'cached call only inspects the tail');
  assert.notEqual(calculate(b,'2',options),first);assert.notEqual(calculate(b,'2',{rsi14:true}),first);
});

test('default settings preserve SMA 5/10/20 and volume without enabling extra panes',()=>{
  const {engine}=setup(),q=model(rows(Array.from({length:40},(_,i)=>100+i)));delete q.chartSettings;
  const p=engine.computePlot(q);assert.deepEqual(Array.from(p.periods),[5,10,20]);assert.equal(p.hVol,56);
  assert.equal(p.rsiPane,null);assert.equal(p.scale,'linear');assert.equal(p.studies.ema20,undefined);
});

test('drawing time projection matches visible candle centers and leaves historical anchors outside the viewport',()=>{
  const {engine}=setup(),bars=rows(Array.from({length:40},(_,i)=>100+i)),q=model(bars),p=engine.computePlot(q);
  for(let i=0;i<p.n;i++)closeTo(p.xForTime(p.bars[i].t),p.x(i));
  assert.ok(p.xForTime(bars[0].t)<p.L);assert.ok(p.xForTime(bars.at(-1).t+86400)>p.W-p.R);
  const open=Date.parse('2026-10-05T13:30:00Z'),sessions=[{open_at_ms:open,close_at_ms:open+3600000},
    {open_at_ms:open+7200000,close_at_ms:open+10800000}];
  const intraday=Array.from({length:24},(_,i)=>({t:(open+(i<12?i:i+12)*300000)/1000,o:100,h:101,l:99,c:100,v:10}));
  for(const kind of ['bar-start','bar-close']){
    const history=intraday.map(b=>({...b,t:b.t+(kind==='bar-close'?300:0)}));
    const q={tf:'intraday',_chartWidth:700,followEnd:false,winStart:14,visN:{intraday:5},_displayIntraday:history,
      d:{regularChart:{bars:history,pointKind:kind,intervalSeconds:300,regularSessions:sessions}}};
    const p=engine.computePlot(q);assert.ok(p.timeline);
    for(let i=0;i<p.n;i++)closeTo(p.xForTime(p.bars[i].t),p.x(i));
    assert.ok(p.xForTime(history[0].t)<p.L,kind);assert.ok(p.xForTime(history.at(-1).t)>p.W-p.R,kind);
  }
});

test('a real candle remains the time anchor when a separate live quote has its exact timestamp',()=>{
  const {engine}=setup(),open=Date.parse('2026-10-01T13:30:00Z');
  const history=[0,300].map(offset=>({t:open/1000+offset,o:100,h:105,l:99,c:103,v:50}));
  const q={tf:'intraday',_chartWidth:700,followEnd:true,_displayIntraday:history,d:{marketState:'REGULAR',priceSession:'REGULAR',
    price:104,quoteAt:open+300000,currency:'USD',src:'yahoo',gmtoff:-14400,intradayLiveStatus:'ready',
    intradayLivePoint:{t:open/1000+300,c:104,v:null,currency:'USD',source:'yahoo',sessionDate:'2026-10-01',historyDate:'2026-10-01'},
    regularChart:{source:'yahoo',tradeDate:'2026-10-01',bars:history,pointKind:'bar-start',intervalSeconds:300,
      regularSessions:[{open_at_ms:open,close_at_ms:open+390*60000}]}}};
  const p=engine.computePlot(q);assert.ok(p.live);assert.equal(p.live.t,history.at(-1).t);
  closeTo(p.xForTime(history.at(-1).t),p.x(1));
});

test('explicitly unknown five-day intervals show an explained closing line without a guessed candle duration',()=>{
  const {engine}=setup(),open=Date.parse('2026-10-01T13:30:00Z');
  for(const count of [1,2]){
    const history=Array.from({length:count},(_,i)=>({t:open/1000+i*300,o:100,h:102,l:99,c:101,v:10}));
    const q={tf:'intraday',_fiveDay:true,_intervalUnknown:true,_chartWidth:700,followEnd:true,_displayIntraday:history,
      d:{regularChart:{bars:history,pointKind:'bar-start',intervalSeconds:300,resolution:null,
        regularSessions:[{open_at_ms:open,close_at_ms:open+1800000}]}}};
    const p=engine.computePlot(q);assert.equal(p.candle,false);assert.equal(p.candleAvailable,false);
    assert.equal(p.intervalSeconds,null);assert.match(p.candleUnavailableReason,/未声明.*周期/);
    for(let i=0;i<p.n;i++){closeTo(p.x(i),p.xAtTime(history[i].t*1000));closeTo(p.xForTime(history[i].t),p.x(i));}
    delete q._intervalUnknown;const ordinary=engine.computePlot(q);assert.equal(ordinary.candle,true);assert.equal(ordinary.intervalSeconds,300);
  }
});
