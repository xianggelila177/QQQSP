import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(className=''){
    this.className=className;this.children=[];this.listeners={};this.dataset={};this.style={};this.hidden=false;
    this.classList={add(){},toggle(){}};
  }
  set innerHTML(html){
    this.html=html;
    if(this.className==='zoombar')for(const match of html.matchAll(/<button data-z="([^"]+)"[^>]*>([^<]+)<\/button>/g)){
      const child=new Element();child.dataset.z=match[1];child.textContent=match[2];child.hidden=/ hidden>/.test(match[0]);this.appendChild(child);
    }
  }
  get innerHTML(){return this.html||'';}
  appendChild(child){this.children.push(child);return child;}
  querySelector(selector){
    const match=/^\[data-z="([^"]+)"\]$/.exec(selector);
    return match?this.children.find(child=>child.dataset.z===match[1])||null:null;
  }
  querySelectorAll(){return [];}
  addEventListener(type,listener){(this.listeners[type]||=[]).push(listener);}
  dispatch(type,event){for(const listener of this.listeners[type]||[])listener(event);}
  setAttribute(){}
  getBoundingClientRect(){return {width:450,height:240,left:0};}
  getContext(){return {setTransform(){},clearRect(){}};}
}
const bar=(date,price)=>({periodStart:date,periodEndExclusive:date,t:Date.parse(date+'T00:00:00Z')/1000,
  o:price,h:price+1,l:price-1,c:price,v:null,periodState:'closed'});

test('one yearly bar with hasMore exposes 加载更早 even when slider is hidden',async()=>{
  let bars=[bar('2026-01-01',100)],revision=1,hasMore=true;
  const loads=[],store={
    getSeries:()=>bars,getRevision:()=>revision,
    getMeta:()=>({status:'ready',meta:{hasMore,currency:'TWD',source:'twse-stock-day',volumeUnit:'source-unit-unverified'}}),
    async load(tf,options){loads.push({tf,...options});bars=[bar('2025-01-01',90),...bars];revision++;hasMore=false;},
    abort(){}
  };
  const engine={createObservationSeries:()=>()=>({bars:[],sampled:false,note:''}),livePointFor:()=>null,
    createChartEngine:()=>({computePlot(q){
      const all=store.getSeries(),vis=Math.min(all.length,q.visN[q.tf]||20),a=q.winStart==null?Math.max(0,all.length-vis):Math.min(q.winStart,all.length-vis);
      return {W:450,H:240,vis,a,n:vis,all,history:all,bars:all.slice(a,a+vis),candle:true,periods:[],ma:{},x:()=>0};
    },drawPlot(){},drawCursor(){}})};
  const panel={PANEL_FORMAT:{fmtDate:()=>'',fmtVol:()=> '—',esc:String},PANEL_CHART_ENGINE:engine,
    PANEL_HISTORY_STORE:{createHistoryStore:()=>store},PANEL_TIMEFRAMES:{get:tf=>({kind:tf==='intraday'?'quote':'history',label:'年K',visible:20})},
    fetch:async()=>{},addEventListener(){}};
  const document={hidden:false,createElement:()=>new Element(),addEventListener(){}};
  const sandbox={window:panel,document,Date,setInterval:()=>1,clearInterval(){},requestAnimationFrame:fn=>fn(),
    IntersectionObserver:undefined,ResizeObserver:undefined};
  vm.runInNewContext(readFileSync(new URL('../../public/modules/panel-chart-controller.js',import.meta.url),'utf8'),sandbox);
  const controller=panel.PANEL_CHART_CONTROLLER.createChartController({document,client:engine,
    formatterFor:()=>({money:String}),formatKey:()=> 'TWD',flash(){},UP:'red',DOWN:'green'});
  const meter=new Element(),summary=new Element(),canvas=new Element(),cursor=new Element(),point=new Element();
  const elements={'.meter':meter,'.chart-summary':summary,'.chart-cursor':cursor,'.chart-point':point,
    '.chart-state':new Element(),'.chart-retry':new Element(),'.chart-modes':null,'.chartframe':new Element()};
  const q={symbol:'2330.TW',tf:'yearly',d:{symbol:'2330.TW',currency:'TWD',charts:{}},
    el:{querySelector:selector=>elements[selector]||null,querySelectorAll:()=>[]},cv:canvas,cursor,point,ohlc:new Element(),
    tabs:[new Element()],visN:{yearly:20},maEnabled:{},_chartWidth:450};
  q.tabs[0].dataset.tf='yearly';
  controller.mount(q);controller.drawChart(q,true);
  const older=q.loadOlderButton;
  assert.equal(q.slider.hidden,true);
  assert.equal(older.hidden,false);assert.equal(older.textContent,'加载更早');
  meter.children.find(child=>child.className==='zoombar').dispatch('click',{target:older});
  for(let i=0;i<5&&!loads.length;i++)await Promise.resolve();
  for(let i=0;i<5&&q._loadingBefore;i++)await Promise.resolve();
  assert.deepEqual(loads,[{tf:'yearly',before:'2026-01-01'}]);
  assert.equal(q.plot.all.length,2);assert.equal(older.hidden,true,'hasMore=false hides the action after paging');
  hasMore=true;bars=[];revision++;controller.drawChart(q,true);
  assert.equal(older.hidden,true,'hasMore alone cannot paginate without an earliest dated bar');
  controller.unmount(q);
});
