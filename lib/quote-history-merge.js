import {isUsableChartFamily} from './quote-contract.js';
import {chartRevision} from './chart-revision.js';
import {validDate,localDateAt} from './history-contract.js';
import {knownCoverageRegressed} from './history-state-contract.js';
import {timezoneForSymbol} from '../mkt.mjs';
import {validPrice} from './price-values.js';
import {isDeepStrictEqual} from 'node:util';

const immutableRegularBars=new WeakSet();
function sameRegularChart(old,chart){
 const bars=chart.bars;
 if(!old||old.bars!==bars||!Array.isArray(bars)||!Object.isFrozen(bars))return false;
 if(!immutableRegularBars.has(bars)){
  if(!bars.every(bar=>bar&&typeof bar==='object'&&Object.isFrozen(bar)))return false;
  immutableRegularBars.add(bars);
 }
 const {bars:previousBars,...previousMeta}=old,{bars:nextBars,...nextMeta}=chart;
 return isDeepStrictEqual(previousMeta,nextMeta);
}

function mayAdvanceRegular(previous,next,at){
 const chart=next.regularChart,old=previous.regularChart;
 if(!chart||chart.stale||chart.error||
  !['ready','partial'].includes(chart.status)||!chart.source||!validDate(chart.targetDate)||chart.tradeDate!==chart.targetDate||
  !Number.isFinite(chart.sourceCheckedAt)||chart.sourceCheckedAt<=0||chart.sourceCheckedAt>at+5000||
  chart.symbol&&chart.symbol!==previous.symbol||chart.currency&&chart.currency!==previous.currency||
  previous.instrumentType&&next.instrumentType&&previous.instrumentType!==next.instrumentType)return false;
 // A lagging price source can return the already retained chart every second.
 // Retaining identical published data needs no per-bar calendar/coverage work.
 // Time/identity/status checks stay above; any metadata change or mutable input
 // still takes the full validation path below. Only immutability is memoized.
 if(sameRegularChart(old,chart))return false;
 if(!isUsableChartFamily(chart.bars,previous.instrumentType))return false;
 if(!chart.regularSessions?.length||chart.bars.some((bar,i)=>bar.t*1000>chart.sourceCheckedAt+5000||
  localDateAt(bar.t*1000,timezoneForSymbol(previous.symbol))!==chart.tradeDate||
  ['o','h','l'].some(key=>bar[key]!=null&&!validPrice(bar[key],previous.instrumentType))||
  bar.h!=null&&(bar.h<bar.c||bar.o!=null&&bar.h<bar.o)||bar.l!=null&&(bar.l>bar.c||bar.o!=null&&bar.l>bar.o)||
  i&&bar.t<=chart.bars[i-1].t||!chart.regularSessions.some(s=>bar.t*1000>=s.open_at_ms&&bar.t*1000<=s.close_at_ms)))return false;
 if(!old?.bars?.length)return true;
 if(chart.sourceCheckedAt<(old.sourceCheckedAt||0)||chart.targetDate<old.targetDate||chart.tradeDate<old.tradeDate)return false;
 if(old.adjustmentBasis&&chart.adjustmentBasis&&old.adjustmentBasis!==chart.adjustmentBasis)return false;
 return chart.tradeDate!==old.tradeDate||!knownCoverageRegressed(old,chart);
}

// Price identity and source-check time remain attached to the winning quote.
// Independently verified chart families may advance even when a price cannot.
export function mergeQuoteHistory(previous,next,at=Date.now()) {
  if(!previous||previous.symbol!==next?.symbol||!previous.currency||previous.currency!==next.currency)return previous;
  let out=previous;
  for(const key of ['intraday','daily30','daily','weekly','monthly']) {
    const bars=next.charts?.[key],info=next.slowFields?.[key];
    if(!isUsableChartFamily(bars,previous.instrumentType)||!info?.source||info.stale||info.error||!Number.isFinite(info.updatedAt)||info.updatedAt<=0)continue;
    const old=previous.charts?.[key],prior=previous.slowFields?.[key];
    if(isUsableChartFamily(old,previous.instrumentType)&&(info.updatedAt<(prior?.updatedAt||0)||bars.at(-1).t<old.at(-1).t))continue;
    if(old===bars&&prior===info||prior&&JSON.stringify(prior)===JSON.stringify(info)&&chartRevision(old)===chartRevision(bars))continue;
    out={...out,charts:{...out.charts,[key]:bars},slowFields:{...out.slowFields,[key]:{...info}}};
    if(key==='daily30')out.daily30Version=next.daily30Version??bars.at(-1).t;
  }
  if(out!==previous) {
    const fields=['intraday','daily30','daily','weekly','monthly'].map(key=>out.slowFields?.[key]).filter(Boolean);
    out.slowFields.charts={source:fields.map(f=>f.source).join('/'),updatedAt:Math.min(...fields.map(f=>f.updatedAt||0))||null,stale:fields.some(f=>f.stale)};
  }
  if(mayAdvanceRegular(previous,next,at))out={...out,regularChart:next.regularChart};
  return out;
}
