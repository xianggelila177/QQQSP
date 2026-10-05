(() => {
  const KEY='qqqsp:chart-workspace:v1';
  const defaults=Object.freeze({scale:'linear',volume:true,studies:Object.freeze({sma5:true,sma10:true,sma20:true,ema20:false,boll20:false,rsi14:false})});
  const studies=[['sma5','MA 5'],['sma10','MA 10'],['sma20','MA 20'],['ema20','EMA 20'],['boll20','布林带 20 / 2'],['rsi14','RSI 14']];
  const listeners=new Set();let memory=defaults,memoryAuthoritative=false;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function normalizeSettings(value){
    const input=value&&typeof value==='object'?value:{};
    return {scale:['linear','percent','log'].includes(input.scale)?input.scale:defaults.scale,
      volume:typeof input.volume==='boolean'?input.volume:defaults.volume,
      studies:Object.fromEntries(studies.map(([name])=>[name,typeof input.studies?.[name]==='boolean'?input.studies[name]:defaults.studies[name]]))};
  }
  function loadSettings(){
    if(memoryAuthoritative)return normalizeSettings(memory);
    try{const raw=window.localStorage?.getItem(KEY);if(raw==null)return normalizeSettings(memory);const saved=JSON.parse(raw);memory=normalizeSettings(saved?.version===1?saved.settings:null);return normalizeSettings(memory);}catch{return normalizeSettings(memory);}
  }
  function saveSettings(value){
    const settings=normalizeSettings(value);memory=settings;
    try{window.localStorage?.setItem(KEY,JSON.stringify({version:1,settings}));memoryAuthoritative=false;}catch{memoryAuthoritative=true;}
    for(const listener of [...listeners])listener(normalizeSettings(settings));
    return settings;
  }
  function settingsMarkup(id='chart'){
    return '<details class="chart-settings"><summary aria-label="图表设置">图表设置</summary><div class="chart-settings-grid" role="group" aria-label="图表偏好">'+
      '<label class="chart-setting-row" for="'+esc(id)+'-scale"><span>价格刻度</span><select id="'+esc(id)+'-scale" data-chart-setting="scale"><option value="linear">线性价格</option><option value="percent">区间百分比</option><option value="log">对数价格</option></select></label>'+
      '<label class="chart-setting-row"><span>成交量副图</span><input type="checkbox" data-chart-setting="volume"></label>'+
      '<fieldset class="chart-study-options"><legend>技术指标</legend>'+studies.map(([key,label])=>'<label><input type="checkbox" data-chart-study="'+key+'"><span>'+label+'</span></label>').join('')+'</fieldset>'+
      '<p class="chart-settings-hint">按当前周期可用收盘 / 报价点计算，样本不足留空。百分比以可见首根收盘为基准。</p><button type="button" data-chart-reset>恢复默认</button></div></details>';
  }
  function bindSettings(container,{settings=loadSettings(),onChange=()=>{}}={}){
    let current=normalizeSettings(settings);
    function update(value){
      current=normalizeSettings(value);
      for(const input of container.querySelectorAll('[data-chart-setting]')){
        const key=input.dataset.chartSetting;if(key==='scale')input.value=current.scale;else if(key==='volume')input.checked=current.volume;
      }
      for(const input of container.querySelectorAll('[data-chart-study]'))input.checked=!!current.studies[input.dataset.chartStudy];
    }
    const change=event=>{
      const input=event.target,key=input?.dataset?.chartSetting,study=input?.dataset?.chartStudy;
      if(key==='scale')saveSettings({...current,scale:input.value});
      else if(key==='volume')saveSettings({...current,volume:input.checked});
      else if(Object.hasOwn(defaults.studies,study||''))saveSettings({...current,studies:{...current.studies,[study]:input.checked}});
    };
    const reset=event=>{if(event.target?.closest?.('[data-chart-reset]'))saveSettings(defaults);};
    const notify=value=>{update(value);onChange(normalizeSettings(value));};
    listeners.add(notify);container.addEventListener('change',change);container.addEventListener('click',reset);update(current);
    return {update,destroy(){listeners.delete(notify);container.removeEventListener('change',change);container.removeEventListener('click',reset);}};
  }
  function studyReadout(plot,index,money=String){
    const at=plot.a+index,values=plot.studies||{},items=[];
    const value=(series,formatter=money)=>Number.isFinite(series?.[at])?formatter(series[at]):'—';
    for(const [key,label] of [['sma5','MA5'],['sma10','MA10'],['sma20','MA20'],['ema20','EMA20']])if(values[key])items.push(label+' '+value(values[key]));
    if(values.boll20)items.push('BOLL20 上 '+value(values.boll20.upper)+' 中 '+value(values.boll20.middle)+' 下 '+value(values.boll20.lower));
    if(values.rsi14)items.push('RSI14 '+value(values.rsi14,v=>v.toFixed(2)));
    return items.join(' · ');
  }
  window.addEventListener?.('storage',event=>{if(event.key===KEY){memoryAuthoritative=false;if(event.newValue==null)memory=defaults;for(const listener of [...listeners])listener(loadSettings());}});
  window.PANEL_CHART_WORKSPACE=Object.freeze({defaults,normalizeSettings,loadSettings,saveSettings,settingsMarkup,bindSettings,studyReadout});
})();
