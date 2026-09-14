// Public daily reference series. They are NOT replacements for futures, DXY,
// intraday yields, or a same-window market reaction. Names/units remain explicit.
export const DAILY_MACRO_SERIES=Object.freeze({
 DCOILBRENTEU:{name:'布伦特现货（日度参考，非期货）',unit:'美元/桶',coverage:'EIA欧洲布伦特现货日度；不是BZ期货，不参与分钟比较'},
 DCOILWTICO:{name:'WTI现货（日度参考，非期货）',unit:'美元/桶',coverage:'EIA库欣WTI现货日度；不是CL期货，不参与分钟比较'},
 DGS10:{name:'美国10年恒定期限收益率（日度）',unit:'%',coverage:'美联储H.15日度恒定期限收益率；不是逐笔成交收益率'},
 DTWEXBGS:{name:'广义美元指数（日度参考，非DXY）',unit:'指数（2006年=100）',coverage:'美联储H.10名义广义贸易加权美元指数；不是DXY，币种篮子与基期不同'},
});
const number=value=>value?.trim()&&value.trim()!=='.'&&Number.isFinite(Number(value))?Number(value):null;
export function parseMacroDailyCsv(body,checkedAt){
 const lines=String(body).replace(/^\uFEFF/,'').trim().split(/\r?\n/);
 const cells=line=>line.split(',').map(x=>x.trim().replace(/^"|"$/g,''));
 const header=cells(lines.shift()||'');
 if(!/^(?:observation_date|date)$/i.test(header[0]))throw Object.assign(new Error('日度来源未返回CSV日期表头'),{code:'MACRO_DAILY_FORMAT'});
 const today=new Date(checkedAt).toISOString().slice(0,10),result=new Map();
 for(const line of lines){const row=cells(line),date=row[0];
  const day=Date.parse(date+'T00:00:00Z');
  if(!/^\d{4}-\d\d-\d\d$/.test(date)||!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==date||date>today||checkedAt-day>14*864e5)continue;
  for(let i=1;i<header.length;i++){const symbol=header[i],def=DAILY_MACRO_SERIES[symbol],price=number(row[i]);
   if(!def||price===null||price<=0||result.get(symbol)?.observationDate>date)continue;
   result.set(symbol,{symbol,providerSymbol:symbol,displayName:def.name,price,unit:def.unit,src:'FRED日度参考',daily:true,proxy:true,
    observationDate:date,quoteAt:null,sourceCheckedAt:checkedAt,feedDelayMinutes:null,sourceUrl:'https://fred.stlouisfed.org/series/'+symbol,
    priceBasis:'独立日度参考；不回填期货/指数报价，不生成分时K线',feedCoverage:def.coverage,pollAfterMs:900000});
  }
 }
 if(!result.size)throw Object.assign(new Error('日度CSV没有近14天的有效参考值'),{code:'MACRO_DAILY_EMPTY'});
 return result;
}
