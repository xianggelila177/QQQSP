import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';

export class Element{
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.fields=new Map();this.listeners={};this.attrs={};this.dataset={};this.style={setProperty(){}};this._text='';this.hidden=false;this.open=false;this.buttons=[];this.mutations=0;const classes=new Set();this.classList={contains:x=>classes.has(x),toggle:(x,on)=>{on?classes.add(x):classes.delete(x);}};}
  set textContent(value){const next=String(value);if(next!==this._text||this.children.length)this.mutations++;this._text=next;this.children=[];}
  get textContent(){return this._text+this.children.map(x=>x.textContent).join(' ');}
  set innerHTML(value){this.html=value;this.buttons=[];for(const match of value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)){const b=new Element('button');b.textContent=match[2];for(const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)){if(attr[1].startsWith('data-'))b.dataset[attr[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=attr[2];else if(attr[1]==='class')b.className=attr[2];else b.setAttribute(attr[1],attr[2]);}this.buttons.push(b);}}
  get innerHTML(){return this.html||'';}
  querySelector(selector){const m=/^\[data-([\w-]+)="([^"]+)"\]$/.exec(selector);if(m)return this.querySelectorAll('[data-'+m[1]+']').find(b=>b.dataset[m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]===m[2])||null;const button=this.buttons.find(b=>selector==='.'+b.className);if(button)return button;if(!this.fields.has(selector))this.fields.set(selector,new Element(selector.includes('canvas')?'canvas':'div'));return this.fields.get(selector);}
  querySelectorAll(selector){const m=/^\[data-([\w-]+)\]$/.exec(selector);if(m){const key=m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return [...this.buttons,...[...this.fields.values()].flatMap(e=>e.children)].filter(x=>key in x.dataset);}return selector==='.cd-book-row'?[this.querySelector('.row1'),this.querySelector('.row2')]:[];}
  appendChild(child){this.children.push(child);this.mutations++;return child;}
  replaceChildren(...children){this.children=children;this._text='';this.mutations++;}
  setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}removeEventListener(type,fn){this.listeners[type]=(this.listeners[type]||[]).filter(x=>x!==fn);}
  dispatch(type,event={}){for(const fn of this.listeners[type]||[])fn({target:this,preventDefault(){},...event});}
  click(){this.dispatch('click');}focus(){this.focused=true;}showModal(){this.open=true;}close(){this.open=false;}
  getBoundingClientRect(){return {width:1000,height:500,left:0,right:1000,top:0};}
  getContext(){return new Proxy({},{get:(_,key)=>key==='measureText'?()=>({width:10}):()=>{}});}
  setPointerCapture(){}
}
export const bar=(day,price=100)=>{const at=Date.parse('2026-01-01T00:00:00Z')+day*86400000,date=new Date(at).toISOString().slice(0,10);return {t:at/1000,periodStart:date,periodEndExclusive:new Date(at+86400000).toISOString().slice(0,10),o:price,h:price+1,l:price-1,c:price,v:10};};
export const trade={at:Date.parse('2026-09-25T20:02:03Z'),price:110,size:1499,source:'nasdaq-public-trades',reportState:'reported',eventId:null};
export const tape=(events=[{...trade}])=>({session:'post',tradeDate:'2026-09-25',source:'nasdaq-public-trades',sourceLabel:'Nasdaq 公开成交',asOf:trade.at,sourceCheckedAt:trade.at+30000,status:'partial',coverage:{scope:'public-trade-window',complete:false},delayMinutes:null,quality:['NO_TRADE_IDS','CORRECTIONS_UNAVAILABLE','DELAY_UNVERIFIED'],events});
export function detailHarness({clockNow=trade.at+10000,pageCount=1,historyNetwork,moduleRoot=new URL('../../public/modules/',import.meta.url)}={}){
  const created=[],pending=[],frames=new Map(),timers=new Map(),loads=[];let seq=0,lastPlot=null,formats=0,now=clockNow;
  const document=new Element('document');document.hidden=false;document.body=new Element('body');document.createElement=tag=>{const el=new Element(tag);created.push(el);return el;};
  const data={daily30:Array.from({length:60},(_,i)=>bar(i)),weekly:Array.from({length:30},(_,i)=>bar(i*7)),yearly:[bar(0)]};
  let hasMore=true,loading=false,resolvePage=null,completedPages=0;const listeners=new Set();
  const replaceSeries=(tf,bars)=>{const previous=data[tf];for(const listener of listeners)listener({phase:'before',tf,previous,bars,entry:store.getMeta(tf)});data[tf]=bars;for(const listener of listeners)listener({phase:'after',tf,previous,bars,entry:store.getMeta(tf)});};
  let store={getSeries:tf=>data[tf]||[],getRevision:()=>1,getMeta:()=>({status:loading?'loading':'ready',loadedDirect:true,meta:{hasMore,currency:'USD',source:'fixture',historyAsOf:'2026-02-28',adjustmentBasis:'source-default-unverified'}}),needsLoad:()=>false,
    load:async(tf,options={})=>{loads.push({tf,...options});if(options.before&&!options.limit){loading=true;await new Promise(resolve=>resolvePage=()=>{const step=tf==='weekly'?7:tf==='yearly'?365:1,first=(data[tf][0].t*1000-Date.parse('2026-01-01T00:00:00Z'))/86400000;replaceSeries(tf,[...Array.from({length:10},(_,i)=>bar(first-(10-i)*step)),...data[tf]]);hasMore=++completedPages<pageCount;loading=false;resolvePage=null;resolve();});}},abort(){},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
  const panel={innerWidth:1100,innerHeight:700,devicePixelRatio:1,addEventListener(){},removeEventListener(){},PANEL_CHART:{maSeries:()=>[]},PANEL_CHART_ENGINE:{createChartEngine:()=>({computePlot(q){const all=q.tf==='intraday'?q._displayIntraday:store.getSeries(q.tf),vis=Math.min(all.length,q.visN[q.tf]||20),a=q.followEnd!==false?Math.max(0,all.length-vis):Math.min(Math.max(0,q.winStart||0),Math.max(0,all.length-vis));q.winStart=a;lastPlot={W:1000,H:500,all,bars:all.slice(a,a+vis),n:vis,vis,a,slot:1000/Math.max(1,vis),x:i=>i*50,intraday:q.tf==='intraday',candle:q.chartStyle!=='line',candleAvailable:true,intervalSeconds:300};return lastPlot;},drawPlot(){},drawCursor(){}})}};
  const context={window:panel,document,Date,Intl:{...Intl,NumberFormat:Intl.NumberFormat,DateTimeFormat:class extends Intl.DateTimeFormat{constructor(...args){super(...args);formats++;}}},URL,URLSearchParams,AbortController,location:{href:'https://panel.test/'},history:{pushState(){},back(){}},
    requestAnimationFrame:fn=>{frames.set(++seq,fn);return seq;},cancelAnimationFrame:id=>frames.delete(id),setInterval:fn=>{timers.set(++seq,{fn,interval:true});return seq;},clearInterval:id=>timers.delete(id),setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)};
  for(const name of [...(historyNetwork?['panel-chart','panel-chart-engine','panel-history-store']:[]),'panel-scheduler','panel-timeframes','panel-state','panel-format','panel-trade-direction','panel-chart-viewport','panel-market-detail-model','panel-market-detail-view','panel-detail-dialog','panel-chart-detail']){const url=new URL(name+'.js',moduleRoot);if(existsSync(url))vm.runInNewContext(readFileSync(url,'utf8'),context);}
  const network={request:(key,url,{signal})=>new Promise((resolve,reject)=>{pending.push({key,url,signal,resolve,reject});signal?.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{code:'ABORTED'})));})};
  if(historyNetwork){store=panel.PANEL_HISTORY_STORE.createHistoryStore({symbol:'NVDA',fetchImpl:async()=>{},network:historyNetwork});
    const engine=panel.PANEL_CHART_ENGINE;panel.PANEL_CHART_ENGINE={...engine,createChartEngine:options=>{const actual=engine.createChartEngine(options);return {...actual,computePlot(q){lastPlot=actual.computePlot(q);return lastPlot;}}}};}
  const quote={symbol:'NVDA',currency:'USD',price:110,quoteAt:trade.at,regularChart:{exchangeZone:'America/New_York',tradeDate:'2026-09-25',bars:Array.from({length:30},(_,i)=>({...bar(i),t:trade.at/1000-i*60})).reverse()}};
  const card={symbol:'NVDA',d:quote,el:new Element(),cv:new Element('canvas'),historyStore:store};
  const view=panel.PANEL_CHART_DETAIL.createChartDetailView({document,network,quoteClock:{now:()=>now},formatterFor:()=>({money:v=>'$'+v}),UP:'red',DOWN:'green'});
  view.mount(card);card.el.querySelector('.chart-expand').click();const dialog=created.find(e=>e.tagName==='DIALOG');
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
  const respond=async(index,value)=>{const item=pending[index];item.resolve({ok:true,json:async()=>({symbol:'NVDA',range:new URL(item.url,'https://panel.test').searchParams.get('range'),...value})});await flush();};
  return {panel,view,dialog,card,pending,loads,data,timers,document,flush,respond,replaceSeries,field:s=>dialog.querySelector(s),plot:()=>lastPlot,formats:()=>formats,
    select:async tf=>{dialog.querySelector('[data-tf="'+tf+'"]').click();await flush();},completePage:async()=>{resolvePage?.();await flush();},setNow:value=>now=value,
    tick:async()=>{for(const [id,t] of [...timers])if(!t.interval&&t.ms<=1000){timers.delete(id);t.fn();}await flush();}};
}
