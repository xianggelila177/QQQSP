import { totalVolume } from './quote-contract.js';
import { sessionFor, timezoneOffsetFor } from '../mkt.mjs';
export function extSessions(obars, meta, prevClose) {
  const empty = { pre: null, post: null, regClose: null, preOpen: null };
  if (!obars || !obars.length) return empty;
  const off = meta.gmtoffset ?? timezoneOffsetFor(meta.symbol,obars.at(-1).t*1000) ?? 0;
  const keyOf = t => { const d = new Date((t + off) * 1000); return d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDate(); };
  const minOf = t => { const d = new Date((t + off) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const dayKey = keyOf(obars[obars.length - 1].t);
  const seg = f => obars.filter(b => keyOf(b.t) === dayKey && f(minOf(b.t)));
  const latestBarMs = obars[obars.length - 1].t * 1000;
  const venue = {venue:meta.exchangeName || meta.fullExchangeName || '',instrumentType:meta.instrumentType || meta.quoteType};
  const { session } = sessionFor(meta.symbol || 'QQQ', off, latestBarMs, venue);
  const pre = seg(m => session.pre?.some(([a, b]) => m >= a && m < b)), reg = seg(m => session.reg?.some(([a, b]) => m >= a && m < b)), post = seg(m => session.post?.some(([a, b]) => m >= a && m < b));
  const pack = (arr, base) => {
    if (!arr.length) return null;
    const price = arr[arr.length - 1].c;
    // Preserve provider high/low when structurally valid; only fall back to
    // closes for malformed points so a real wick is never erased.
    const hi = Math.max.apply(null, arr.map(b => Number.isFinite(b.h) ? b.h : b.c));
    const lo = Math.min.apply(null, arr.map(b => Number.isFinite(b.l) ? b.l : b.c));
    const vol = totalVolume(arr);
    const chg = base != null ? price - base : null;
    return { price, open: arr[0].o ?? null, change: chg, changePct: base ? (chg / base) * 100 : null, high: hi, low: lo, volume: vol };
  };
  const regClose = reg.length ? reg[reg.length - 1].c : null;
  const regInfo = reg.length ? { n: reg.length, open: reg[0].o,
    high: Math.max.apply(null, reg.map(b => Number.isFinite(b.h) ? b.h : b.c)),
    low: Math.min.apply(null, reg.map(b => Number.isFinite(b.l) ? b.l : b.c)) } : null;
  return { pre: pack(pre, prevClose), post: pack(post, regClose ?? prevClose), regClose, preOpen: pre.length ? pre[0].o : null, reg: regInfo };
}

// Quote session comes from the quote's own exchange timestamp. Include closing
// prints exactly at an endpoint; unknown calendars/times stay unspecified.
export function priceSessionFor(symbol,quoteAt,gmtoffset=null,venue='') {
  if(!Number.isFinite(quoteAt)||quoteAt<=0)return null;
  const {session,calendar}=sessionFor(symbol,gmtoffset,quoteAt,venue);
  if(!calendar.known||calendar.closed)return null;
  const offset=gmtoffset ?? timezoneOffsetFor(symbol,quoteAt);
  if(offset==null)return null;
  const d=new Date(quoteAt+offset*1000);
  if((d.getUTCDay()===0||d.getUTCDay()===6)&&!calendar.specialOpen)return null;
  const minutes=d.getUTCHours()*60+d.getUTCMinutes();
  if(session.reg?.some(([a,b])=>minutes>=a&&minutes<=b))return 'REGULAR';
  if(session.pre?.some(([a,b])=>minutes>=a&&minutes<b))return 'PRE';
  if(session.post?.some(([a,b])=>minutes>=a&&minutes<=b))return 'POST';
  return null;
}
