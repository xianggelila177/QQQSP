(() => {
  const MAX_KEYS=30,MAX_DRAWINGS=50,STORAGE_VERSION=1;
  const validPoint=p=>p&&Number.isFinite(p.t)&&p.t>0&&p.t<=8.64e12&&Number.isFinite(p.price)&&Math.abs(p.price)<=1e15;
  function normalizeDrawing(value,{partial=false}={}){
    if(!value||!['horizontal','trend','measure'].includes(value.type)||!Array.isArray(value.points))return null;
    const count=value.type==='horizontal'?1:2;
    if(value.points.length!==count&&!(partial&&count===2&&value.points.length===1))return null;
    if(!value.points.every(validPoint))return null;
    return {type:value.type,points:value.points.map(p=>({t:p.t,price:p.price}))};
  }
  const copy=drawings=>drawings.map(d=>normalizeDrawing(d));
  // One bounded document avoids orphaned per-symbol storage entries. Reads do
  // not write localStorage on every animation frame; mutations persist the LRU.
  function createDrawingStore({storage,keyPrefix='qqqsp:chart-drawings'}={}){
    if(storage===undefined){try{storage=window.localStorage;}catch{storage=null;}}
    const storeKey=String(keyPrefix)+':v1',entries=new Map();
    const validKey=key=>typeof key==='string'&&key.length>0&&key.length<=2048;
    const trim=()=>{while(entries.size>MAX_KEYS)entries.delete(entries.keys().next().value);};
    try{
      const raw=storage?.getItem(storeKey);
      const saved=typeof raw==='string'&&raw.length<=1048576?JSON.parse(raw):null;
      if(saved?.version===STORAGE_VERSION&&Array.isArray(saved.entries)){
        for(const entry of saved.entries.slice(-MAX_KEYS)){
          if(!Array.isArray(entry)||!validKey(entry[0])||!Array.isArray(entry[1]))continue;
          const drawings=entry[1].slice(-MAX_DRAWINGS).map(d=>normalizeDrawing(d)).filter(Boolean);
          if(drawings.length){entries.delete(entry[0]);entries.set(entry[0],drawings);}
        }
      }
    }catch{} // Corruption, blocked storage, and quota errors leave an in-memory store.
    function persist(){try{storage?.setItem(storeKey,JSON.stringify({version:STORAGE_VERSION,entries:[...entries]}));}catch{}}
    function get(key){
      if(!validKey(key)||!entries.has(key))return [];
      const drawings=entries.get(key);entries.delete(key);entries.set(key,drawings);
      return copy(drawings);
    }
    function add(key,value){
      const drawing=normalizeDrawing(value);
      if(!validKey(key)||!drawing)return get(key);
      const drawings=entries.get(key)||[];
      entries.delete(key);entries.set(key,drawings.concat(drawing).slice(-MAX_DRAWINGS));trim();persist();
      return get(key);
    }
    function undo(key){
      if(!validKey(key)||!entries.has(key))return [];
      const drawings=entries.get(key).slice(0,-1);entries.delete(key);
      if(drawings.length)entries.set(key,drawings);persist();return copy(drawings);
    }
    function clear(key){if(validKey(key)&&entries.delete(key))persist();return [];}
    return Object.freeze({get,add,undo,clear});
  }
  function bounds(p){
    const left=p?.L,right=p?.W-p?.R,top=p?.yTop,bottom=p?.yTop+p?.chartH;
    return [left,right,top,bottom].every(Number.isFinite)&&right>left&&bottom>top?{left,right,top,bottom}:null;
  }
  const realBar=b=>b&&!b._live&&Number.isFinite(b.t)&&b.t>0&&Number.isFinite(b.c);
  function pointFromPlot(p,x,y){
    const area=bounds(p),bars=p?.bars;
    if(!area||!Array.isArray(bars)||!bars.length||typeof p.x!=='function'||typeof p.priceAt!=='function'||
      !Number.isFinite(x)||!Number.isFinite(y)||x<area.left||x>area.right||y<area.top||y>area.bottom)return null;
    let lo=0,hi=bars.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(p.x(mid)<x)lo=mid+1;else hi=mid;}
    let left=lo-1,right=lo;
    while(left>=0&&!realBar(bars[left]))left--;
    while(right<bars.length&&!realBar(bars[right]))right++;
    const index=left<0?right:right>=bars.length?left:Math.abs(p.x(left)-x)<Math.abs(p.x(right)-x)?left:right;
    if(index<0||index>=bars.length)return null;
    const point={t:bars[index].t,price:p.priceAt(y)};
    return validPoint(point)?point:null;
  }
  function lowerBound(bars,t){let lo=0,hi=bars.length;while(lo<hi){const mid=(lo+hi)>>>1;if(bars[mid].t<t)lo=mid+1;else hi=mid;}return lo;}
  function projectPoint(p,point){
    const all=p?.all||p?.bars;
    if(!validPoint(point)||!Array.isArray(all)||typeof p?.y!=='function')return null;
    const index=lowerBound(all,point.t);
    // Do not silently attach a removed/corrected bar to a different date.
    if(index>=all.length||all[index].t!==point.t||!realBar(all[index]))return null;
    let x;const local=index-(p.a||0);
    if(local>=0&&local<p.bars.length)x=p.x(local);
    else if(typeof p.xForTime==='function')x=p.xForTime(point.t);
    else{
      if(!p.timeline&&p.bars.length)x=p.x(0)+local*p.slot;
      // A clamped timeline cannot represent offscreen anchors faithfully.
      else return null;
    }
    const y=p.y(point.price);
    return Number.isFinite(x)&&Number.isFinite(y)?{x,y}:null;
  }
  function measurement(p,drawing){
    const d=normalizeDrawing(drawing);if(!d||d.points.length!==2)return null;
    const [a,b]=d.points,from=Math.min(a.t,b.t),to=Math.max(a.t,b.t),all=p?.all||p?.bars||[];
    let observations=0,ohlc=true;
    for(let i=lowerBound(all,from);i<all.length&&all[i].t<=to;i++)if(realBar(all[i])){
      observations++;if(!['o','h','l','c'].every(k=>Number.isFinite(all[i][k])))ohlc=false;
    }
    const change=b.price-a.price;
    return {change,percent:a.price===0?null:change/Math.abs(a.price)*100,seconds:Math.abs(b.t-a.t),observations,kind:ohlc&&observations?'bars':'points'};
  }
  function durationLabel(seconds){
    const whole=Math.max(0,Math.round(seconds)),days=Math.floor(whole/86400),hours=Math.floor(whole%86400/3600),minutes=Math.floor(whole%3600/60),rest=whole%60;
    return [days&&days+'天',hours&&hours+'小时',minutes&&minutes+'分',rest&&rest+'秒'].filter(Boolean).slice(0,2).join(' ')||'0秒';
  }
  function measurementLabel(value,formatter){
    if(!value)return '';
    const money=typeof formatter==='function'?formatter:n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:4});
    const change=(value.change>0?'+':'')+money(value.change);
    const percent=value.percent===null?'—':(value.percent>0?'+':'')+value.percent.toFixed(2)+'%';
    return change+' ('+percent+') · '+value.observations+(value.kind==='bars'?' 根已加载K线':' 个已加载观测')+' · '+durationLabel(value.seconds);
  }
  function draw(ctx,p,drawings,{draft,formatter}={}){
    const area=bounds(p);if(!ctx||!area)return;
    const label=(text,x,y)=>{
      text=String(text).slice(0,180);ctx.font='11px sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
      const width=Math.min(area.right-area.left,ctx.measureText(text).width+12),height=Math.min(22,area.bottom-area.top);
      x=Math.max(area.left,Math.min(area.right-width,x));y=Math.max(area.top+height/2,Math.min(area.bottom-height/2,y));
      ctx.fillStyle='rgba(255,255,255,.94)';ctx.fillRect(x,y-height/2,width,height);
      ctx.fillStyle='#315f8b';ctx.fillText(text,x+6,y,Math.max(1,width-12));
    };
    const marker=point=>{if(point.x<area.left||point.x>area.right||point.y<area.top||point.y>area.bottom)return;ctx.beginPath();ctx.arc(point.x,point.y,3,0,Math.PI*2);ctx.fill();};
    function render(input,isDraft){
      const d=normalizeDrawing(input,{partial:isDraft});if(!d)return;
      ctx.strokeStyle=isDraft?'#66819b':'#3778ad';ctx.fillStyle='#3778ad';ctx.lineWidth=1.5;ctx.setLineDash(isDraft?[4,3]:[]);
      const first=projectPoint(p,d.points[0]);
      if(d.type==='horizontal'){
        const y=p.y(d.points[0].price);if(!Number.isFinite(y)||y<area.top||y>area.bottom)return;
        ctx.beginPath();ctx.moveTo(area.left,y);ctx.lineTo(area.right,y);ctx.stroke();
        if(first)marker(first);
        const text=typeof formatter==='function'?formatter(d.points[0].price):String(d.points[0].price);
        label(text,area.left+6,y-13);return;
      }
      if(!first)return;
      if(d.points.length===1){marker(first);return;}
      const second=projectPoint(p,d.points[1]);if(!second)return;
      const left=Math.min(first.x,second.x),right=Math.max(first.x,second.x),top=Math.min(first.y,second.y),bottom=Math.max(first.y,second.y);
      if(right<area.left||left>area.right||bottom<area.top||top>area.bottom)return;
      if(d.type==='measure'){
        ctx.fillStyle='rgba(55,120,173,.09)';ctx.fillRect(left,top,right-left,bottom-top);
        ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.stroke();
        label(measurementLabel(measurement(p,d),formatter),Math.max(left,area.left)+5,Math.max(top,area.top)+13);
      }else{ctx.beginPath();ctx.moveTo(first.x,first.y);ctx.lineTo(second.x,second.y);ctx.stroke();}
      ctx.fillStyle='#3778ad';marker(first);marker(second);
    }
    ctx.save();
    try{
      ctx.beginPath();ctx.rect(area.left,area.top,area.right-area.left,area.bottom-area.top);ctx.clip();
      for(const d of (Array.isArray(drawings)?drawings:[]).slice(-MAX_DRAWINGS))render(d,false);
      if(draft)render(draft,true);
    }finally{ctx.restore();}
  }
  window.PANEL_CHART_DRAWINGS=Object.freeze({createDrawingStore,pointFromPlot,projectPoint,normalizeDrawing,measurement,measurementLabel,draw});
})();
