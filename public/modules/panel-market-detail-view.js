(() => {
  const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const unitLabel=unit=>({shares:'股',lots:'手',round_lots:'整手',contracts:'张'})[unit]||'单位未核验';
  const sourceLabel=value=>({'nasdaq-public-book':'Nasdaq 公开盘口','nasdaq-public-trades':'Nasdaq 公开成交','finnhub':'Finnhub','alpaca':'Alpaca','twse-stock-day':'TWSE 日线','yahoo-tw-chart':'Yahoo 台股分时'})[value]||value||'来源未提供';
  const coverageLabel=value=>({'source-website-top-of-book-unverified':'来源网站一档报价，市场覆盖未核验','provider-top-of-book':'来源一档报价','single-exchange':'单交易所覆盖','us-sip':'美国综合行情覆盖','regular-intervals-excluding-unverified-close':'常规时段区间，未核验收盘成交已排除','source-mixed-sessions':'来源合并交易时段'})[value]||(typeof value==='string'&&value.endsWith('-chart-source')?'来源历史图表范围':'来源覆盖未核验');
  const reasons={SOURCE_HAS_NO_BOOK:'来源未提供盘口',INSTRUMENT_TYPE:'该品种无盘口',RETAINED_BOOK:'盘口已过期',BOOK_TIME_UNAVAILABLE:'盘口时间未提供',PUBLIC_BOOK_EMPTY:'休市或来源暂无买卖报价',PUBLIC_BOOK_UNAVAILABLE:'盘口来源暂不可用',INCOMPLETE_BOOK:'部分盘口',CROSSED_BOOK:'买卖价冲突',DETAIL_LOADING:'盘口加载中',DETAIL_REQUEST_FAILED:'详情刷新失败，盘口暂不可用',DETAIL_PAUSED:'后台已暂停，盘口待重新检查',TAPE_LOADING:'逐笔加载中',PUBLIC_TRADES_EMPTY:'该时段暂无公开逐笔',SOURCE_DATE_MISSING:'来源未提供可核验交易日',SOURCE_DATE_MISMATCH:'来源交易日与所选日期不符',PUBLIC_TRADES_UNSUPPORTED:'该证券暂无适用的公开逐笔来源',PUBLIC_TRADES_UNAVAILABLE:'公开逐笔来源暂不可用',SOURCE_COOLDOWN:'逐笔来源限流冷却中',NO_RECEIVED_TRADES:'该时段尚未收到逐笔',TRADE_STREAM_NOT_CONFIGURED:'逐笔源未配置',FIVE_DAY_SOURCE_GAPS:'五日历史覆盖不足',FIVE_DAY_SOURCE_UNAVAILABLE:'五日历史来源不可用',FIVE_DAY_INTERVAL_COVERAGE_UNVERIFIED:'日内覆盖待核验',FIVE_DAY_COVERAGE_REGRESSION:'来源覆盖缩减，保留旧图',CLOSING_PRINT_COVERAGE_UNVERIFIED:'收盘成交覆盖待核验',CHART_SOURCE_STALE:'历史刷新失败，保留旧图',TARGET_DAY_HISTORY_PENDING:'目标交易日历史尚未就绪',HISTORY_CLOSE_CONFLICT:'收盘价冲突，相关数据已隔离'};
  const reasonLabel=code=>code==='source-invalid-ohlc'?'来源数据异常，已排除异常日线':reasons[code]||'来源质量待核验';
  function chartQuality(chart={},meta={},entry={}){
    const date=meta.historyAsOf||chart.tradeDates?.at(-1)||chart.tradeDate;
    const conflict=meta.closeConsistency?.status==='conflict';
    const partial=chart.status==='partial'||chart.intervalCoverage?.status==='partial'||chart.coveredDays<5||meta.coverageStatus==='partial'||meta.coverage?.status==='partial';
    const missing=window.PANEL_FORMAT.historyGapNote?.(meta.historyQuality?meta:chart);
    const warnings=[chart.stale||entry.status==='stale'?'缓存待更新':null,conflict?'收盘价冲突':null,partial?'覆盖不完整':null,missing?'来源数据异常，已排除异常日线':null,
      chart.refreshError?reasonLabel(chart.refreshError):chart.missingReason||chart.reason?reasonLabel(chart.missingReason||chart.reason):null];
    const adjustment=meta.adjustmentBasis||chart.adjustment;
    const intervals=chart.intervalCoverage,missingSlots=intervals?.days?.reduce((sum,day)=>sum+(number(day.missingSlots)||0),0);
    const intervalDetail=intervals?.status==='partial'?['日内区间覆盖未齐',number(intervals.observedBars)!=null?'收到 '+intervals.observedBars+' 根':null,missingSlots>0?'未覆盖 '+missingSlots+' 个预期时段（可能含停牌或无成交时段）':null].filter(Boolean).join('，'):null;
    return {short:[date?'数据截至 '+date:null,...new Set(warnings.filter(Boolean))].filter(Boolean).join(' · '),
      detail:[sourceLabel(meta.source||chart.source),meta.currency||chart.currency,coverageLabel(chart.coverage||meta.coverage?.scope),
        adjustment?/unverified|unconfirmed/.test(adjustment)?'来源复权口径未核验':adjustment==='raw'?'未复权':adjustment==='split'?'拆股复权':adjustment==='split_dividend'?'拆股及股息复权':'复权口径待核验':'复权口径未提供',
        chart.volumeQuality?.status==='missing'?'成交量暂缺':null,intervalDetail,missing,chart.intervalCoverage?.status==='unknown'?'价格点不代表完整分钟覆盖':null,
        ...new Set(warnings.filter(Boolean))].filter(x=>typeof x==='string'&&x).join(' · ')};
  }
  function createMarketDetailView({document,root}){
    const fmt=window.PANEL_FORMAT,formats=new Map(),usd=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:8});
    let rowKey=null,last=null,side='tape';
    const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;};
    const set=(selector,value)=>{const el=root.querySelector(selector);if(el&&el.textContent!==value)el.textContent=value;return el;};
    function time(at,zone,clock=false){
      if(number(at)==null)return '时间未提供';
      const key=zone+':'+clock;
      try{if(!formats.has(key))formats.set(key,new Intl.DateTimeFormat('zh-CN',{timeZone:zone,...(!clock?{month:'2-digit',day:'2-digit'}:{}),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}));
        return formats.get(key).format(new Date(at));}catch{return '时间未提供';}
    }
    function renderBook(book={},context){
      const b=book||{},money=context.money,usable=number(b.ask?.price)!=null||number(b.bid?.price)!=null;
      set('.cd-book-status',b.reason==='CROSSED_BOOK'?'买卖价冲突':b.stale?'保留上次盘口':usable?'买一 / 卖一快照':reasons[b.reason]||'暂无买卖报价');
      root.querySelectorAll('.cd-book-row').forEach(row=>row.hidden=!usable);
      set('.cd-ask',number(b.ask?.price)==null?'—':money(b.ask.price));set('.cd-bid',number(b.bid?.price)==null?'—':money(b.bid.price));
      for(const name of ['ask','bid'])set('.cd-'+name+'-size',number(b[name]?.size)==null?'—':fmt.fmtSize(b[name].size)+' '+unitLabel(b.sizeUnit));
      set('.cd-book-meta',usable?[sourceLabel(b.source),b.asOf?time(b.asOf,context.zone):'时间未提供',b.stale?'旧快照':b.delayMinutes>0?'延迟 '+b.delayMinutes+' 分钟':null].filter(Boolean).join(' · '):'');
      set('.cd-book-quality',[coverageLabel(b.coverage),b.sizeUnit==='round_lots'?'每整手股数未核验':null,b.delayMinutes==null?'延迟未核验':null,b.checkedAt?'来源检查 '+time(b.checkedAt,context.zone):null].filter(Boolean).join(' · '));
    }
    function renderTape(tape={},context){
      const t=tape||{},events=t.events||[],isPublic=t.source==='nasdaq-public-trades'||t.coverage?.scope==='public-trade-window',zone=isPublic?'America/New_York':context.zone;
      const money=isPublic?v=>number(v)==null?'—':usd.format(v):context.money;
      const session=({auto:'最近时段',regular:'常规',pre:'盘前',post:'盘后'})[t.session||context.session]||'时段待核验';
      set('.cd-tape-status',events.length?[session,t.tradeDate,'最近 '+events.length+' 笔',t.stale?'缓存待更新':null].filter(Boolean).join(' · '):reasons[t.reason]||'逐笔暂无数据');
      const quality=[t.sourceLabel||sourceLabel(t.source),'非完整逐笔',t.delayMinutes==null?'延迟未核验':'延迟 '+t.delayMinutes+' 分钟',t.asOf?'截至 '+time(t.asOf,zone):null,
        t.quality?.includes('NO_TRADE_IDS')?'来源无唯一成交标识，保留可能重复的记录':null,t.quality?.includes('CORRECTIONS_UNAVAILABLE')?'来源不提供更正与撤销记录':null,
        events.some(e=>e.quality==='CONNECTION_CURSOR_UNVERIFIED_ACROSS_RECONNECT')?'重连后可能重复':'',
        '成交统计仅为当前窗口，不是全天成交量。'].filter(Boolean).join(' · ');
      set('.cd-tape-quality',quality);root.querySelector('.cd-tape-status').title=quality;
      const rowUnit=e=>e.sizeUnit||t.sizeUnit||(isPublic?'shares':null);
      const valid=events.filter(e=>(!e.reportState||e.reportState==='reported')&&number(e.price)!=null&&number(e.size)!=null&&e.size>=0),units=new Set(valid.map(rowUnit));
      const prices=valid.map(e=>e.price),total=valid.reduce((sum,e)=>sum+e.size,0);
      const stats=set('.cd-tape-stats',valid.length?'当前窗口 '+valid.length+' 笔 · '+(units.size===1?fmt.fmtSize(total)+' '+unitLabel([...units][0]):'数量单位不同，不合计')+' · 最低 '+money(Math.min(...prices))+' / 最高 '+money(Math.max(...prices)):'暂无成交统计');
      stats.title='仅统计当前收到的成交窗口，不是全天成交量。';
      if(side!=='tape')return;
      const key=JSON.stringify([context.symbol,context.formatKey,zone,isPublic,t.source,t.session,t.tradeDate,t.sizeUnit,events.map(e=>[e.at,e.price,e.size,e.sizeUnit,e.symbol,e.source,e.session,e.tradeDate,e.reportState,e.aggressorSide,e.aggressorSideVerified])]);
      if(key===rowKey)return;rowKey=key;
      const list=root.querySelector('.cd-tape-list');list.replaceChildren();if(!events.length)return;
      const directions=window.PANEL_TRADE_DIRECTION.describe(events,{symbol:context.symbol,source:t.source,session:t.session,tradeDate:t.tradeDate});
      const table=make('table','cd-tape-table'),head=make('thead'),header=make('tr');
      for(const text of ['时间 '+(zone==='America/New_York'?'美东':zone),'价格','数量','方向']){const th=make('th','',text);th.setAttribute('scope','col');header.appendChild(th);}head.appendChild(header);table.appendChild(head);
      const body=make('tbody');
      events.slice(-200).map((event,i)=>({event,direction:directions[Math.max(0,events.length-200)+i]})).reverse().forEach(({event:e,direction:d})=>{
        const row=make('tr','cd-trade-row cd-trade-'+(d?.direction||'unknown'));
        const label=e.reportState==='corrected'?'已更正':e.reportState&&e.reportState!=='reported'?'已撤销':d?.label||'未提供';
        for(const text of [time(e.at,zone,true),money(e.price),fmt.fmtSize(e.size)+' '+unitLabel(rowUnit(e)),label])row.appendChild(make('td','',text));body.appendChild(row);
      });table.appendChild(body);list.appendChild(table);list.appendChild(make('small','cd-direction-note','涨跌方向为推断；主动买卖仅按来源标记。'));
    }
    function render(value,context){last={value,context};renderBook(value?.book,context);renderTape(value?.tape,context);}
    return Object.freeze({render,selectSide(value){side=value;root.querySelector('.cd-tape-list').hidden=value!=='tape';root.querySelector('.cd-tape-stats').hidden=value!=='stats';if(last)renderTape(last.value?.tape,last.context);},reset(){rowKey=null;last=null;side='tape';}});
  }
  window.PANEL_MARKET_DETAIL_VIEW=Object.freeze({createMarketDetailView,chartQuality,reasonLabel});
})();
