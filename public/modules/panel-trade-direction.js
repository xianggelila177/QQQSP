(() => {
  const text=value=>typeof value==='string'&&value.trim()?value.trim():null;
  const unknown=reason=>({direction:'unknown',label:'未知',basis:'unavailable',inferred:false,reason});
  const labels={buy:'主动买入',sell:'主动卖出',up:'涨价',down:'跌价',flat:'平价'};
  // Price ticks are not aggressor sides. Only an explicitly verified source
  // aggressor field may produce a buy/sell label; a generic `side` is ambiguous.
  function verifiedSide(event,source){
    const side=event?.aggressorSide;
    return source&&event?.aggressorSideVerified===true&&(side==='buy'||side==='sell')?
      {direction:side,label:labels[side],basis:'source-reported-aggressor',inferred:false,reason:null}:null;
  }
  function describe(events,context={}){
    if(!Array.isArray(events))return [];
    const output=events.map(()=>unknown('IDENTITY_UNVERIFIED')),groups=new Map();
    events.forEach((event,index)=>{
      const symbol=text(event?.symbol)||text(context.symbol),source=text(event?.source)||text(context.source),
        session=text(event?.session)||text(context.session),tradeDate=text(event?.tradeDate)||text(context.tradeDate);
      if(!event||event.reportState!=='reported'){
        output[index]=unknown('INVALIDATED_TRADE');return;
      }
      if(typeof event.at!=='number'||!Number.isFinite(event.at)||event.at<=0||
        typeof event.price!=='number'||!Number.isFinite(event.price)||event.price<=0){
        output[index]=unknown('INVALID_TRADE');return;
      }
      const verified=verifiedSide(event,source);
      if(verified)output[index]=verified;
      if(!symbol||!source||!session||!tradeDate)return;
      const key=JSON.stringify([symbol,source,session,tradeDate]);
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({event,index,verified});
    });
    for(const rows of groups.values()){
      rows.sort((a,b)=>a.event.at-b.event.at||a.index-b.index);
      let previous=null;
      for(let i=0;i<rows.length;){
        let end=i+1;while(end<rows.length&&rows[end].event.at===rows[i].event.at)end++;
        const ambiguous=end-i>1;
        for(let j=i;j<end;j++){
          const {event,index,verified}=rows[j];
          if(verified)continue;
          if(ambiguous){output[index]=unknown('SAME_TIMESTAMP_ORDER_UNKNOWN');continue;}
          if(!previous){output[index]=unknown('NO_PREVIOUS_TRADE');continue;}
          const direction=event.price>previous.price?'up':event.price<previous.price?'down':'flat';
          output[index]={direction,label:labels[direction],basis:'adjacent-price',inferred:true,reason:null};
        }
        // With no exchange sequence, the final print within an equal-time
        // group is unknowable, so it cannot anchor the next price comparison.
        previous=ambiguous?null:rows[i].event;i=end;
      }
    }
    return output;
  }
  window.PANEL_TRADE_DIRECTION=Object.freeze({describe});
})();
