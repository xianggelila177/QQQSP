// Narrow, auditable event identity. A household survey is not an official CPI release.
export function macroRegion(text){
 const matches=[['UK',/英国|英格兰银行|英国央行|\bUK\b|United Kingdom|Bank of England/i],['US',/美国|美联储|密歇根|\bU\.?S\.?\b|United States|Federal Reserve|Michigan/i],['EU',/欧元区|欧洲央行|Eurozone|ECB/i],['CN',/中国|中国人民银行|\bChina\b/i],['JP',/日本|日本央行|\bJapan\b/i],['KR',/韩国|\bKorea\b/i]].filter(([,re])=>re.test(text)).map(([id])=>id);
 return matches.length===1?matches[0]:matches.length>1?'MULTI':'UNKNOWN';
}
export const regionNames={UK:'英国',US:'美国',EU:'欧元区',CN:'中国',JP:'日本',KR:'韩国',MULTI:'多地区',UNKNOWN:'地区未确认'};
export function isInflationSurvey(text){return /通胀预期|inflation expectations?/i.test(text)&&/调查|民调|受访|消费者|公众|民众|survey|respondent|household|Michigan|Savanta|Ipsos/i.test(text);}
export function surveyReadings(text){
 const out=[];
 for(const sentence of text.split(/[。；;\n]/)){
  const horizon=/(?:未来|对|in|next|coming)\s*(?:1\s*[-–～至]\s*2|一至两)年|1\s*[-–]\s*2.year/i.test(sentence)?'1-2年':/五年|5年|five.year|five years/i.test(sentence)?'5年':/未来一年|未来1年|一年后|1年后|coming year|next year|one.year|year.ahead/i.test(sentence)?'1年':/两年|2年|two.year/i.test(sentence)?'2年':null;
  const value=sentence.match(/(?:通胀预期|inflation expectations?)[^%\d]{0,24}(\d+(?:\.\d+)?)\s*%/i);
  if(horizon&&value){const n=Number(value[1]);if(n<=100&&!out.some(r=>r.horizon===horizon&&r.value===n))out.push({horizon,value:n,unit:'%'});}
 }
 return out;
}
export function surveyKey(item){
 const text=String(item.title||'')+' '+String(item.sourceText||'');if(!isInflationSurvey(text))return null;
 const region=macroRegion(text),institution=text.match(/Savanta|Ipsos|YouGov|Michigan|密歇根/gi)?.[0]?.toLowerCase(),month=text.match(/(?:\d{4}年)?(?:1[0-2]|[1-9])月|January|February|March|April|May|June|July|August|September|October|November|December/i)?.[0];
 if(region==='UNKNOWN'||region==='MULTI'||!institution||!month||!Number.isFinite(item.t))return null;
 return ['survey',region,institution,month,Math.floor(item.t/864e5)].join('|');
}
