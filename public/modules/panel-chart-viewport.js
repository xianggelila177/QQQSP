(() => {
  // Shared by cards and detail charts. Counts express user intent, not canvas width.
  function zoomCount(current,direction,total,{factor=1.4,min=1}={}){
    const maximum=Math.max(min,Math.floor(total)||min),count=Math.max(min,Math.min(maximum,Math.round(current)||min));
    const next=direction==='out'?Math.max(count+1,Math.round(count*factor)):
      direction==='in'?Math.min(count-1,Math.round(count/factor)):maximum;
    return Math.max(min,Math.min(maximum,next));
  }
  const createView=()=>({winStart:null,followEnd:true,hoverIdx:null,keyboardSelection:false,fullSession:false,chartStyle:'candle'});
  function captureAnchor(bars,view){
    if(!view||view.followEnd||view.winStart==null||!bars.length)return null;
    const index=Math.max(0,Math.min(bars.length-1,Math.floor(view.winStart))),bar=bars[index];
    return {periodStart:bar.periodStart,t:bar.t,offset:view.winStart-index};
  }
  function restoreAnchor(bars,anchor,{visible=1}={}){
    if(!anchor||!bars.length)return null;
    let index=bars.findIndex(b=>anchor.periodStart!=null?b.periodStart===anchor.periodStart:b.t===anchor.t);
    if(index<0){
      // Corrections may remove a period. Nearest date wins; ties prefer the later one.
      index=0;for(let i=1;i<bars.length;i++)if(Math.abs(bars[i].t-anchor.t)<=Math.abs(bars[index].t-anchor.t))index=i;
    }
    return Math.max(0,Math.min(Math.max(0,bars.length-visible),index+(anchor.offset||0)));
  }
  window.PANEL_CHART_VIEWPORT=Object.freeze({zoomCount,createView,captureAnchor,restoreAnchor});
})();
