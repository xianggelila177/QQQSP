(() => {
  const {esc,fmtTime8}=window.PANEL_FORMAT;
  // Stable positions: the first sixteen cells are always present. Optional
  // fields expand as one panel-wide preference, never as unequal card heights.
  const definitions=Object.freeze([
    ['open','今开','price','常规交易时段开盘价；随卡片币种切换。'],
    ['prev','昨收','price','股票为来源昨收；期货按来源标注前结算或前值。'],
    ['high','最高','price','来源行情中对应统计时段的最高价。'],
    ['low','最低','price','来源行情中对应统计时段的最低价。'],
    ['volume','成交量','quantity','来源返回的累计成交数量；股、份或合约单位分别处理。'],
    ['turnoverAmount','成交额','money','仅使用来源直接提供的累计成交金额，不以最新价乘成交量替代。'],
    ['turnoverRate','换手率','percent','常规时段累计成交量÷流通股数×100%；只有总股本时改用总股本，并在标签注明。不同分母不可直接比较。'],
    ['amplitude','振幅','percent','（常规时段最高价－最低价）÷昨收×100%。统计时段未核验时不计算。'],
    ['priceToBook','市净率','ratio','来源市净率，即价格相对于每股净资产的倍数；非正净资产不显示为正常估值倍数。'],
    ['peTTM','市盈率·滚动','ratio','最近十二个月盈利口径的市盈率，不是预测市盈率。只有明确负盈利或负市盈率才标为亏损。'],
    ['marketCap','总市值','money','来源提供的公司总市值，不把基金净资产当作公司市值。'],
    ['floatMarketCap','流通市值','money','优先采用来源数据；最新报价×流通股数的计算结果带“≈”，股本与报价可能不是同一时点。'],
    ['w52h','52周最高','price','来源提供的最近五十二周最高价，不由当前可见图表截取计算。'],
    ['w52l','52周最低','price','来源提供的最近五十二周最低价，不由当前可见图表截取计算。'],
    ['sharesOutstanding','总股本','shares','最近取得的已发行股份数；基金为已发行份额。来源未给出股本日期时明确注明。'],
    ['floatShares','流通股','shares','来源定义的可流通股份数；大于总股本时视为数据冲突并停止相关估算。'],
    ['volumeRatio','量比','ratio','须有同口径的当前每分钟成交量与前五个交易日每分钟均量。不能用全天成交量÷十日均量代替。'],
    ['orderImbalance','委比','percent','须有明确档位范围的委托买卖盘及时间。不能用成交方向或一档买卖数量冒充完整委比。'],
    ['peLYR','市盈率·年度','ratio','最近完整财年的盈利口径，不以预测盈利或最近十二个月盈利替代。'],
    ['psTTM','市销率·滚动','ratio','来源提供的最近十二个月营业收入口径的市销率。'],
    ['dividendTTM','股息·滚动','dividend','最近十二个月每股已派股息，不等同预期年度股息；来源明确为零时显示零。'],
    ['dividendYieldTTM','股息率·滚动','percent','最近十二个月股息率；接口中的小数比例已换算为百分数，不以远期股息率替代。'],
    ['lotSize','每手股数','shares','须由可靠来源明确给出。交易所整手、券商最小下单数量和碎股规则不混用，不统一硬编码为一股。'],
    ['exch','交易所','text','以行情来源的交易所字段为准；缺失时不使用公司名称替代。']
  ].map(([key,label,type,description],index)=>Object.freeze({key,label,type,description,extra:index>=16})));
  const sourceNames={'naver-financial':'Naver 财务指标','naver-company':'Naver 公司资料','naver-financial+naver-company':'Naver 财务指标 / 公司资料','tencent-financial':'腾讯基础指标','naver-us':'Naver 美股','naver-kr':'Naver 韩股','yahoo-summary':'Yahoo 财务摘要','finnhub-metric':'Finnhub 基础财务','yahoo-summary+finnhub-metric':'Yahoo / Finnhub','sina-batch':'新浪行情','tx-batch':'腾讯行情','tx-cn':'腾讯行情','tx-us':'腾讯行情',fixture:'离线测试数据'};
  const reasonNames={disabled:'财务资料功能已关闭',expired:'资料已超过最长保留期',loading:'财务资料后台读取中','source-missing':'来源未提供该字段','instrument-type':'当前品种不适用该公司指标','no-trade-amount':'来源未提供累计成交金额','no-regular-volume':'缺少已核验的常规时段成交量','no-shares':'缺少同一证券的可靠股本分母','no-regular-range':'缺少常规时段高低价或有效昨收','float-exceeds-total':'流通股大于总股本，停止相关计算','no-five-day-minute-baseline':'尚无前五个交易日的每分钟均量基准','no-order-book':'尚无明确范围的委托买卖盘','negative-earnings':'来源确认盈利为负','zero-earnings':'盈利口径无有效正值','nonpositive-book':'净资产口径不是有效正值','nonpositive-denominator':'分母不是有效正值','nonpositive-revenue':'营业收入口径不是有效正值'};
  const states={'ready':'财务资料已取得','stale':'财务缓存待更新','expired':'财务资料已过期','disabled':'财务资料已关闭','loading':'财务资料后台读取中','unavailable':'财务资料暂缺','not-applicable':'按品种显示适用指标'};
  Object.assign(sourceNames,{'naver-basic':'Naver 基础资料','naver-statements':'Naver 财报','nasdaq-summary':'Nasdaq 基础资料','nasdaq-dividends':'Nasdaq 实际派息','nasdaq-statements':'Nasdaq 财报','naver-realtime':'Naver 行情统计'});
  Object.assign(states,{complete:'基础资料完整',partial:'基础资料部分取得'});
  const sourceName=value=>String(value||'').split('+').map(v=>sourceNames[v]||v).join(' / ');
  const failureNames={FUNDAMENTALS_IDENTITY:'证券身份不符',FUNDAMENTALS_EMPTY:'未提供有效字段',FUNDAMENTALS_CURRENCY:'币种不符',FUNDAMENTALS_INCOMPLETE:'历史资料不完整',FUNDAMENTALS_UNSUPPORTED:'不支持该证券',RATE_LIMITED:'来源限流',SOURCE_COOLDOWN:'来源冷却中',DEADLINE_EXCEEDED:'来源超时',FUNDAMENTALS_SOURCE:'来源暂不可用'};
  const formulas={'regular-price / trailing-EPS':'常规报价 ÷ 最近十二个月每股收益','regular-price / fiscal-year-EPS':'常规报价 ÷ 最近完整财年每股收益','regular-price / book-value-per-share':'常规报价 ÷ 每股净资产','market-cap / trailing-revenue':'总市值 ÷ 最近十二个月营业收入','paid-dividends-12m / regular-price * 100':'过去十二个月已派股息 ÷ 常规报价 × 100%','sum of cash payments in the past 12 months':'合计过去十二个月已实际支付的现金股息','regular-volume / shares * 100':'常规时段成交量 ÷ 股数或份额 × 100%'};
  const numeric=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
  Object.assign(formulas,{'(five-level bids - asks) / (bids + asks) * 100':'（五档买量－五档卖量）÷五档买卖总量×100%', 'market-cap / trailing-common-income':'总市值 ÷ 最近四季度归属普通股股东净利润','market-cap / annual-common-income':'总市值 ÷ 最近完整财年归属普通股股东净利润'});
  const setText=(node,text)=>{if(node.textContent!==text)node.textContent=text;};
  function compact(value){
    if(value>=1e12)return (value/1e12).toFixed(2)+'万亿';
    if(value>=1e8)return (value/1e8).toFixed(2)+'亿';
    if(value>=1e4)return (value/1e4).toFixed(2)+'万';
    return value.toLocaleString('zh-CN',{maximumFractionDigits:2});
  }
  function markup(){
    return '<section class="statistics" aria-label="基础信息"><div class="statistics-head"><h3>基础信息</h3><div class="statistics-actions"><button type="button" class="statistics-toggle" aria-expanded="false">全部指标</button><button type="button" class="statistics-help">口径与来源</button><button type="button" class="market-detail-open">完整数据</button></div></div><div class="grid">'+definitions.map(d=>'<div class="cell" data-metric="'+d.key+'"'+(d.extra?' data-metric-extra hidden':'')+'><label>'+d.label+'</label><b class="'+d.key+'">—</b></div>').join('')+'</div><div class="statistics-status">财务资料等待报价</div></section>';
  }
  function formatMetric(def,quote,formatter){
    const fund=['ETF','MUTUALFUND'].includes(quote.instrumentType),fields=quote.fundamentals?.fields||{};
    const simple={open:'open',prev:'prevClose',high:'dayHigh',low:'dayLow',volume:'volume',w52h:'week52High',w52l:'week52Low',exch:'exchangeName'};
    const statKey={open:'open',prev:'prevClose',high:'high',low:'low',volume:'volume'}[def.key],stats=quote.tradingStats;
    const rangeKey={w52h:'week52High',w52l:'week52Low'}[def.key];
    const field=rangeKey&&fields[rangeKey]?fields[rangeKey]:statKey&&stats?.session==='REGULAR'?{value:stats[statKey],source:stats.source,asOf:stats.asOf,tradeDate:stats.tradeDate}:simple[def.key]?{value:quote[simple[def.key]],source:quote.src,asOf:quote.quoteAt??null}:fields[def.key]||{status:'unavailable',reason:'source-missing'};
    let label=def.label,text='—',full='',value=numeric(field.value);
    if(def.key==='prev'&&quote.instrumentType==='FUTURE')label=quote.changeBasis==='previous-settlement'?'前结算':'来源前值';
    if(def.key==='turnoverRate'&&field.basis==='total-shares')label=fund?'换手率·总份额':'换手率·总股本';
    if(def.key==='peLYR'&&field.historical)label='市盈率·财年末';
    if(def.key==='orderImbalance'&&field.depth)label='委比·'+field.depth+'档';
    if(def.key==='sharesOutstanding'&&fund)label='总份额';
    if(def.key==='floatShares'&&fund)label='流通份额';
    if(def.key==='lotSize'&&fund)label='每手份数';
    const unit=fund?'份':quote.instrumentType==='FUTURE'?'张':'股';
    if(field.status==='not-applicable')text='不适用';
    else if(field.status==='loss')text='亏损';
    else if(field.status==='nonpositive-book')text='非正净资产';
    else if(field.status==='conflict')text='数据冲突';
    else if(def.type==='text'){text=typeof field.value==='string'&&field.value.trim()?field.value:'—';full=text;}
    else if(value!=null){
      if(def.type==='price'){text=formatter.money(value);full=text+' '+formatter.unit;}
      else if(def.type==='quantity'||def.type==='shares'){
        const suffix=def.type==='quantity'&&quote.volumeUnit&&quote.volumeUnit!=='shares'?(quote.volumeUnit==='contracts'?'张':quote.volumeUnit==='lots'?'手':''):unit;
        text=compact(value)+suffix;full=value.toLocaleString('zh-CN',{maximumFractionDigits:6})+suffix;
      }else if(def.type==='money'||def.type==='dividend'){
        // Financial statements use currency base units, not necessarily the
        // quote's pence/cents. Each monetary field retains its own source unit.
        if(field.currency){
          const target=window.PANEL_CURRENCY.currencyUnit(formatter.unit).base;
          const converted=formatter.convert(value,field.currency,target),amount=converted==null?value:converted,currency=converted==null?field.currency:target;
          const reference=converted!=null&&field.currency!==target&&quote.fxKind==='reference';
          const prefix=field.estimated||reference?'≈':'';
          text=prefix+(def.type==='money'?compact(amount):amount.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:4}))+' '+currency;
          full=prefix+amount.toLocaleString('zh-CN',{maximumFractionDigits:6})+' '+currency+(reference?'（参考汇率换算）':'')+(converted==null&&field.currency!==target?'（汇率暂缺，保留原币）':'');
        }else full='来源没有给出金额币种，暂不展示数值';
      }else {text=(field.estimated?'≈':'')+value.toFixed(2)+(def.type==='percent'?'%':'');full=text;}
    }
    const pending=field.attempts?.some(a=>a.state==='loading');
    if(text==='—'&&quote.fundamentals?.coverage)text=pending?'补充中':'暂无';
    const attempts=(field.attempts||[]).map(a=>sourceName(a.source)+'：'+(a.state==='loading'?'补充中':failureNames[a.code]||'未提供该字段')+(a.retryAt?'，下次检查 '+fmtTime8(a.retryAt):'')).join('；');
    const details=[def.description,full&&'显示值：'+full,reasonNames[pending?'loading':field.reason],field.source&&'字段来源：'+sourceName(field.source),field.backup&&'由补充信源提供',field.asOf?'字段时点（北京时间）：'+fmtTime8(field.asOf):!simple[def.key]?'字段时点：来源未提供':null,field.fetchedAt&&'取得时间：'+fmtTime8(field.fetchedAt),field.tradeDate&&'统计交易日：'+field.tradeDate,field.financialPeriod&&'财报期间：'+field.financialPeriod,field.historical&&'来源财年末估值，不是按当前价重算',field.formula&&'计算口径：'+(formulas[field.formula]||field.formula),field.quoteReferenceAt&&'参考报价时点（非财务日期）：'+fmtTime8(field.quoteReferenceAt),field.shareSource&&'股本来源：'+sourceName(field.shareSource),field.denominator!=null&&'计算分母：'+field.denominator.toLocaleString('zh-CN')+unit,field.shareSource&&!field.shareAsOf&&'股本日期：来源未提供',field.estimated&&'估算值，非来源直接报告值',field.stale&&'缓存资料待更新，不代表新报价',attempts];
    return {label,text,detail:details.filter(Boolean).join('；'),status:pending?'loading':field.status||(value!=null||def.type==='text'&&typeof field.value==='string'&&field.value.trim()?'available':'unavailable'),stale:!!field.stale};
  }
  function createView({document,cards,formatterFor,onLayout=()=>{}}){
    let expanded=false,dialog=null,dialogOwner=null,opener=null;
    try{expanded=window.localStorage.getItem('qqqsp.basicMetrics.expanded')==='1';}catch{}
    function expansion(q){
      q.statistics.classList.toggle('is-expanded',expanded);
      for(const d of definitions)if(d.extra)q.metricNodes.get(d.key).cell.hidden=!expanded;
      q.statisticsToggle.setAttribute('aria-expanded',String(expanded));
      q.statisticsToggle.setAttribute('aria-label',expanded?'收起所有卡片的扩展基础指标':'展开所有卡片的完整基础指标');
      q.statisticsToggle.title='所有卡片同步展开或收起，保持面板排列整齐';
      setText(q.statisticsToggle,expanded?'精简指标':'全部指标');
    }
    function mount(q){
      q.statistics=q.el.querySelector('.statistics');
      q.statisticsToggle=q.el.querySelector('.statistics-toggle');q.statisticsHelp=q.el.querySelector('.statistics-help');q.statisticsStatus=q.el.querySelector('.statistics-status');
      q.metricNodes=new Map(definitions.map(d=>{const cell=q.statistics.querySelector('[data-metric="'+d.key+'"]');return [d.key,{cell,label:cell.querySelector('label'),value:cell.querySelector('b')}];}));
      q.statisticsToggle.addEventListener('click',()=>{expanded=!expanded;try{window.localStorage.setItem('qqqsp.basicMetrics.expanded',expanded?'1':'0');}catch{}for(const card of cards.values())expansion(card);onLayout();});
      q.statisticsHelp.setAttribute('aria-label',q.symbol+' 基础指标口径与来源');q.statisticsHelp.addEventListener('click',()=>open(q));
      expansion(q);
    }
    function render(q){
      if(!q.metricNodes||!q.d)return;
      const formatter=formatterFor(q.d);
      for(const def of definitions){const item=formatMetric(def,q.d,formatter),node=q.metricNodes.get(def.key);setText(node.label,item.label);setText(node.value,item.text);node.cell.title=item.detail;node.cell.dataset.status=item.status;node.cell.classList.toggle('metric-stale',item.stale);}
      const f=q.d.fundamentals,parts=[states[f?.status]||'财务资料暂缺'];
      if(f?.coverage)parts.push(f.coverage.available+'/'+f.coverage.applicable+' 项已取得');
      if(f?.loading&&f.status!=='loading')parts.push('后台补充中');
      if(f?.statisticsDate)parts.push((f.retainedStatistics?'保留上一交易日统计 ':'统计交易日 ')+f.statisticsDate);
      if(f?.fetchedAt)parts.push('取得 '+fmtTime8(f.fetchedAt));
      setText(q.statisticsStatus,parts.join(' · ')+'；金额标注币种，≈为估算或参考换汇。');
    }
    function open(q){
      if(!dialog){
        dialog=document.createElement('dialog');dialog.className='metrics-dialog';dialog.setAttribute('aria-labelledby','metrics-dialog-title');
        dialog.innerHTML='<div class="metrics-dialog-head"><h2 id="metrics-dialog-title"></h2><button type="button" aria-label="关闭指标说明">关闭</button></div><p class="metrics-dialog-intro"></p><dl class="metrics-definitions"></dl>';
        document.body.appendChild(dialog);
        dialog.querySelector('button').addEventListener('click',()=>dialog.close());
        dialog.addEventListener('close',()=>{opener?.focus();dialogOwner=null;});
      }
      dialogOwner=q.symbol;opener=q.statisticsHelp;
      setText(dialog.querySelector('h2'),q.symbol+' · 基础信息');
      const f=q.d?.fundamentals;
      setText(dialog.querySelector('.metrics-dialog-intro'),'以下是打开说明时的快照。'+(f?.fetchedAt?'资料取得时间（北京时间）：'+new Date(f.fetchedAt+8*3600000).toISOString().replace('T',' ').slice(0,19)+'。':'资料取得时间：尚无成功记录。')+(f?.source?'资料来源：'+sourceName(f.source)+'。':'')+'成交统计随行情刷新；公开基础指标每分钟检查，财报摘要最多缓存六小时。失败后保留未过期旧值并退避重试。取得时间不等于财报或股本日期。'+(f?.financialPeriod?'来源最近财报季度：'+f.financialPeriod+'。':'来源未提供最近财报季度。'));
      const formatter=formatterFor(q.d||{});
      dialog.querySelector('dl').innerHTML=definitions.map(def=>{const item=formatMetric(def,q.d||{},formatter);return '<div><dt>'+esc(item.label)+' <strong>'+esc(item.text)+'</strong></dt><dd>'+esc(item.detail)+'</dd></div>';}).join('');
      dialog.showModal();
    }
    function remove(q){if(dialogOwner===q.symbol&&dialog?.open)dialog.close();}
    return Object.freeze({mount,render,remove});
  }
  window.PANEL_FUNDAMENTALS=Object.freeze({definitions,markup,formatMetric,createView});
})();
