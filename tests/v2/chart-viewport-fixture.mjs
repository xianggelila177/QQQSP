import fs from 'node:fs';
import vm from 'node:vm';
function context(){
 const cx={strokes:[],path:[],fills:[],clipped:false,font:'',globalAlpha:1,measureText:s=>({width:String(s).length*6}),
   beginPath(){this.path=[]},moveTo(x,y){this.path.push(['M',x,y])},lineTo(x,y){this.path.push(['L',x,y])},
   stroke(){this.strokes.push({style:this.strokeStyle,path:[...this.path],clipped:this.clipped})},
   fillRect(...a){this.fills.push({style:this.fillStyle,a,clipped:this.clipped})},
   clip(){this.clipped=true},restore(){this.clipped=false},save(){},rect(){},fill(){},fillText(){},clearRect(){},
   setLineDash(){},setTransform(){},closePath(){},arc(){},roundRect(){},createLinearGradient:()=>({addColorStop(){}})};
 return cx;
}
class Element{
 constructor(cls='',width=400){this.className=cls;this.children=[];this.listeners={};this.style={};this.dataset={};this.width=width;this.hidden=false;this.classList={add(){},toggle(){}};this.cx=context();}
 set innerHTML(html){this.html=html;if(this.className==='zoombar')for(const m of html.matchAll(/<button data-z="([^"]+)"[^>]*>([^<]+)<\/button>/g)){const b=new Element();b.dataset.z=m[1];b.textContent=m[2];this.appendChild(b)}}
 get innerHTML(){return this.html||''} appendChild(e){this.children.push(e);return e}
 querySelector(s){const m=/^\[data-z="([^"]+)"\]$/.exec(s);return m?this.children.find(e=>e.dataset.z===m[1]):null}
 querySelectorAll(){return []} setAttribute(){} addEventListener(k,fn){(this.listeners[k]||=[]).push(fn)}
 dispatch(k,e){return Promise.all((this.listeners[k]||[]).map(fn=>fn(e)))}
 getBoundingClientRect(){return {width:this.width,height:300,left:0,top:0,right:this.width}} getContext(){return this.cx} setPointerCapture(){}
}
const bars=(n,seconds=86400,start=Date.parse('2020-01-01T00:00Z')/1000)=>Array.from({length:n},(_,i)=>{
 const t=start+i*seconds,date=new Date(t*1000).toISOString().slice(0,10),c=100+i/10;
 return {t,o:c-.4,h:c+1,l:c-1,c,v:100,periodStart:date,periodEndExclusive:new Date((t+seconds)*1000).toISOString().slice(0,10),periodState:'closed'};
});
function modules(){
 const window={PANEL_FORMAT:{fmtDate:(t,time)=>new Date(t*1000).toISOString().replace('T',' ').slice(0,time?16:10),fmtVol:String,esc:String},fetch:async()=>{},addEventListener(){}};
 const document={hidden:false,createElement:()=>new Element(),addEventListener(){}};const frames=[];
 const sandbox={window,document,Date,Intl,URLSearchParams,AbortController,IntersectionObserver:undefined,ResizeObserver:undefined,
  requestAnimationFrame:fn=>{frames.push(fn);return frames.length},setInterval:()=>1,clearInterval(){}};
 for(const name of ['panel-timeframes','panel-chart-viewport','panel-chart','panel-chart-engine','panel-history-store','panel-chart-controller']){const file=new URL('../../public/modules/'+name+'.js',import.meta.url);if(fs.existsSync(file))vm.runInNewContext(fs.readFileSync(file,'utf8'),sandbox);}
 const client={...window.PANEL_CHART_ENGINE,...window.PANEL_CHART};
 const engine=client.createChartEngine({UP:'red',DOWN:'green',fmtDate:window.PANEL_FORMAT.fmtDate,formatterFor:()=>({money:x=>Number(x).toFixed(2)}),maSeries:client.maSeries});
 return {window,document,client,engine,frames,flush(){for(let i=0;frames.length&&i<100;i++)frames.shift()()}};
}
function simple(m,history,tf='daily30',width=400,extra={}){return {d:{symbol:'NVDA',currency:'USD',charts:{[tf]:history}},tf,cv:new Element('',width),_chartWidth:width,historyStore:{getSeries:()=>history,getRevision:()=>1,getMeta:()=>({meta:{}})},visN:{},followEnd:true,winStart:null,maEnabled:{5:false,10:false,20:false},...extra}}
function mounted(m,history,tf='daily30',vis=20,providedStore){
 let series=history,revision=1;const loads=[];const meta={status:'ready',meta:{hasMore:true,currency:'USD',source:'fixture'}};
 const store=providedStore||{getSeries:()=>series,getRevision:()=>revision,getMeta:()=>meta,load:async(tf,o)=>{loads.push({tf,...o})},abort(){},needsLoad:()=>false};
 m.window.PANEL_HISTORY_STORE={createHistoryStore:()=>store};
 const meter=new Element(),cv=new Element(),point=new Element(),els={'.meter':meter,'.chart-summary':new Element(),'.chart-cursor':new Element(),'.chart-point':point,'.chart-state':new Element(),'.chart-retry':new Element(),'.chartframe':new Element()};
 const styles=['candle','line'].map(style=>{const b=new Element();b.dataset.chartStyle=style;return b});
 const q={symbol:'NVDA',tf,d:{symbol:'NVDA',currency:'USD',charts:{}},el:{querySelector:s=>els[s]||null,querySelectorAll:selector=>selector==='[data-chart-style]'?styles:[]},cv,point,ohlc:new Element(),tabs:['intraday','daily30','weekly','monthly','yearly'].map(tf=>{const b=new Element();b.dataset.tf=tf;return b}),visN:{[tf]:vis},maEnabled:{},_chartWidth:400};
 const controller=m.window.PANEL_CHART_CONTROLLER.createChartController({document:m.document,client:m.client,formatterFor:()=>({money:String}),formatKey:()=>'',flash(){},UP:'red',DOWN:'green'});
 controller.mount(q);controller.drawChart(q,true);
 return {q,controller,store,loads,meter,styles,update(next){series=next;revision++}};
}


export {context,Element,bars,modules,simple,mounted};
