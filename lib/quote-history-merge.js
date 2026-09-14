import {isUsableChartFamily} from './quote-contract.js';
import {chartRevision} from './http-charts.js';

// Price identity and source-check time remain attached to the winning quote.
// Independently verified chart families may advance even when a price cannot.
export function mergeQuoteHistory(previous,next) {
  if(!previous||previous.symbol!==next?.symbol||!previous.currency||previous.currency!==next.currency)return previous;
  let out=previous;
  for(const key of ['intraday','daily30','daily','weekly','monthly']) {
    const bars=next.charts?.[key],info=next.slowFields?.[key];
    if(!isUsableChartFamily(bars)||!info?.source||info.stale||info.error||!Number.isFinite(info.updatedAt)||info.updatedAt<=0)continue;
    const old=previous.charts?.[key],prior=previous.slowFields?.[key];
    if(isUsableChartFamily(old)&&(info.updatedAt<(prior?.updatedAt||0)||bars.at(-1).t<old.at(-1).t))continue;
    if(old===bars&&prior===info||prior&&JSON.stringify(prior)===JSON.stringify(info)&&chartRevision(old)===chartRevision(bars))continue;
    out={...out,charts:{...out.charts,[key]:bars},slowFields:{...out.slowFields,[key]:{...info}}};
    if(key==='daily30')out.daily30Version=next.daily30Version??bars.at(-1).t;
  }
  if(out!==previous) {
    const fields=['intraday','daily30','daily','weekly','monthly'].map(key=>out.slowFields?.[key]).filter(Boolean);
    out.slowFields.charts={source:fields.map(f=>f.source).join('/'),updatedAt:Math.min(...fields.map(f=>f.updatedAt||0))||null,stale:fields.some(f=>f.stale)};
  }
  return out;
}
