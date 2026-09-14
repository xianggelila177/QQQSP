import {futureInstrumentFor,isFutureSymbol} from './lib/futures-instruments.js';
// 交易时段判定 —— 以「当前时间」换算交易所本地墙钟, 按各市场时段表判定
// (旧实现用 meta.regularMarketTime/最后bar时间: 盘前会滞后、周末会误判成周五盘中)
export const SESSIONS = {   // 单一事实源: server.js extSessions 与 marketStateFor 共用此表
  cn: { reg: [[570, 690], [780, 900]], brk: [[690, 780]], auc: [[555, 570]] },  // 沪深A/科创: 集合竞价9:15-9:25, 盘中9:30-11:30/13:00-15:00
  hk: { reg: [[570, 720], [780, 960]], brk: [[720, 780]], auc: [[540, 570]] },  // 港股: 竞价9:00-9:30, 盘中9:30-12:00/13:00-16:00
  jp: { reg: [[540, 690], [750, 930]], brk: [[690, 750]] },          // JPX: 9:00-11:30, 12:30-15:30
  kr: { reg: [[540, 930]] },                                          // 韩股: 9:00-15:30
  us: { reg: [[570, 960]], pre: [[240, 570]], post: [[960, 1200]] }, // 美股: 盘前4:00 盘中9:30-16:00 盘后-20:00
};

import { readFileSync } from 'node:fs';
import { marketKeyFor, MARKET_TIMEZONES, instrumentTypeFor } from './lib/instruments.js';
import { MARKET_REGISTRY } from './lib/market-registry.js';
export const calendarRegistry = JSON.parse(readFileSync(new URL('./data/market-calendars.json',import.meta.url),'utf8'));
for(const [key,profile] of Object.entries(calendarRegistry.profiles||{}))if(profile.sessions)SESSIONS[key]=profile.sessions;
const calendarKey = marketKeyFor;
export function sessionContext(symbol,value='') {
  return typeof value==='object'&&value?{venue:String(value.venue||value.exchangeName||''),instrumentType:instrumentTypeFor(symbol,value.instrumentType)}:{venue:String(value||''),instrumentType:instrumentTypeFor(symbol)};
}

function localDate(symbol, gmtoffset, nowMs) {
  const off = gmtoffset != null ? gmtoffset : timezoneOffsetFor(symbol, nowMs);
  const d = new Date(nowMs + off * 1000);
  return { year: d.getUTCFullYear(), md: String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0') };
}

export function marketCalendarInfo(symbol, nowMs = Date.now(), gmtoffset = null) {
  const key = calendarKey(symbol);
  const { year, md } = localDate(symbol, gmtoffset, nowMs);
  const entry=calendarRegistry.markets[key]?.[String(year)];
  const date=year+'-'+md;
  const covered=!!entry?.sources?.length&&!!entry.validFrom&&!!entry.validThrough&&date>=entry.validFrom&&date<=entry.validThrough;
  if (!covered) return { key, year, date: md, known: false, source: null, closed: false, earlyCloseMin: null, halfDay: false,reason:'outside-coverage',pending:false };
  const override=entry.overrides?.[md];
  const closed=override?.closed??entry.closed.includes(md),halfDay=entry.halfDays.includes(md);
  const pendingNote=entry.unknownSessions?.[md] || (halfDay&&!['us','hk'].includes(key)&&!override?'Half-day trading times unverified':null);
  return {key,year,date:md,known:!pendingNote,source:entry.sources.join(', '),version:calendarRegistry.version,closed,earlyCloseMin:key==='us'&&halfDay?780:key==='hk'&&halfDay?720:null,halfDay,specialOpen:!!override||entry.open?.includes(md)||false,pending:!!pendingNote,...(pendingNote?{reason:'session-pending',note:String(pendingNote)}:{})};
}

export function timezoneForSymbol(symbol) { return futureInstrumentFor(symbol)?.timezone || MARKET_TIMEZONES[marketKeyFor(symbol)] || null; }
const offsetFormatters=new Map();

export function timezoneOffsetFor(symbol, nowMs = Date.now()) {
  const tz = timezoneForSymbol(symbol);
  if (!tz) return null;
  if(!offsetFormatters.has(tz))offsetFormatters.set(tz,new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }));
  const parts = offsetFormatters.get(tz).formatToParts(new Date(nowMs));
  const part = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +(m[3] || 0) * 60);
}

// Official holiday and special-session data is intentionally not synthesized
// here. Callers can distinguish weekends from an unknown exchange calendar.
export function marketCalendarCoverage(symbol, nowMs = Date.now(), gmtoffset = null, context = '') {
  const c = marketCalendarInfo(symbol, nowMs, gmtoffset);
  const {session}=sessionFor(symbol,gmtoffset,nowMs,context),off=gmtoffset??timezoneOffsetFor(symbol,nowMs)??0;
  const local=new Date(nowMs+off*1000),minute=local.getUTCHours()*60+local.getUTCMinutes();
  const unknownWindow=!c.closed&&session.unknown?.some(([a,b])=>minute>=a&&minute<b);
  return { known: c.known&&!unknownWindow, source: c.source || 'weekends-only', year: c.year, date: c.date, closed: c.closed, halfDay: c.halfDay,pending:c.pending,...(c.reason?{reason:c.reason}:{}),...(c.note?{note:c.note}:{}),...(unknownWindow?{reason:'session-window-unverified',note:'此证券的细分交易时段尚未核验'}:{}) };
}

export function sessionFor(symbol, gmtoffset = null, nowMs = Date.now(), venue = '') {
  const s = String(symbol || '').toUpperCase();
  const cal = marketCalendarInfo(s, nowMs, gmtoffset);
  const context=sessionContext(s,venue),profile=calendarRegistry.profiles?.[cal.key]||{};
  const entry=calendarRegistry.markets[cal.key]?.[String(cal.year)],date=cal.year+'-'+cal.date;
  const period=profile.sessionPeriods?.find(p=>date>=p.validFrom&&date<=p.validThrough);
  let session=period?.sessionsByType?.[context.instrumentType]||period?.sessions||profile.sessionsByType?.[context.instrumentType]||SESSIONS[cal.key]||{reg:[]};
  const override=entry?.overrides?.[cal.date];
  if(override)session=override.sessionsByType?.[context.instrumentType]||override.sessions||override;
  if(cal.pending)session={reg:[]};
  if (cal.earlyCloseMin && session.reg?.[0]?.[1] > cal.earlyCloseMin) {
    const regEnd = cal.earlyCloseMin;
    const late = cal.key === 'us' && /ARCA|AMEX|PCX/i.test(context.venue) ? [[regEnd, 1020]] : [];
    session = { ...session, reg: [[session.reg[0][0], regEnd]], post: late };
  }
  if (cal.halfDay && cal.key === 'hk') session = { ...session, reg: [session.reg[0]], brk: [], auc: [...(session.auc || []), [720, 730]], post: [] };
  return { session, calendar: cal };
}

export function marketStateFor(symbol, gmtoffset, nowMs = Date.now(), venue = '') {
  if(isFutureSymbol(symbol))return 'UNKNOWN'; // Never apply US cash hours to a Globex future.
  const s = String(symbol || '').toUpperCase();
  if (!calendarKey(s)) return 'UNKNOWN';
  const off = gmtoffset != null ? gmtoffset : timezoneOffsetFor(s, nowMs);
  const local = new Date(nowMs + off * 1000);                          // 交易所本地墙钟(按UTC读)
  const day = local.getUTCDay();
  const hm = local.getUTCHours() * 60 + local.getUTCMinutes();
  const { session: calendarSession, calendar: cal } = sessionFor(s, gmtoffset, nowMs, venue);
  // Explicit special dates precede ordinary weekend rules. An announced
  // Sunday with unpublished times cannot be mistaken for a normal closure.
  if(cal.pending)return 'UNKNOWN';
  if ((day === 0 || day === 6)&&!cal.specialOpen) return 'CLOSED';
  if (cal.closed) return 'CLOSED';
  if(!cal.known||!calendarSession.reg?.length)return 'UNKNOWN';
  const sess = calendarSession;
  const inR = (rs) => rs?.some(([a, b]) => hm >= a && hm < b);
  if(inR(sess.unknown))return 'UNKNOWN';
  if (sess.pre && inR(sess.pre)) return 'PRE';
  if (sess.auc && inR(sess.auc)) return 'AUCTION';                     // 集合竞价
  if (inR(sess.reg)) return 'REGULAR';
  if (sess.brk && inR(sess.brk)) return 'BREAK';                       // 午间休市
  if (sess.post && inR(sess.post)) return 'POST';
  if (cal.key === 'us' && cal.earlyCloseMin && hm >= cal.earlyCloseMin && hm < 960 && !sess.post?.length) return 'UNKNOWN';
  return 'CLOSED';
}

// Release gate: every supported calendar must cover the complete operating
// horizon. New years are data updates with primary-source review, never guesses.
export function calendarCoverageStatus(nowMs=Date.now(),horizonDays=90) {
  const end=nowMs+horizonDays*86400000;
  const startYear=new Date(nowMs).getUTCFullYear(),endYear=new Date(end).getUTCFullYear();
  const missing=[],pending=[];
  for (const market of Object.keys(MARKET_REGISTRY)) for (let year=startYear;year<=endYear;year++) {
    const entry=calendarRegistry.markets[market]?.[String(year)];
    const from=new Date(Math.max(nowMs,Date.UTC(year,0,1))).toISOString().slice(0,10);
    const through=new Date(Math.min(end,Date.UTC(year,11,31,23,59,59))).toISOString().slice(0,10);
    if (!entry?.sources?.length||!entry.validFrom||!entry.validThrough||entry.validFrom>from||entry.validThrough<through||!SESSIONS[market]?.reg?.length) {missing.push({market,year});continue;}
    for(const [md,note] of Object.entries(entry.unknownSessions||{}))if(year+'-'+md>=from&&year+'-'+md<=through)pending.push({market,date:year+'-'+md,note});
    for(const md of entry.halfDays||[])if(!['us','hk'].includes(market)&&year+'-'+md>=from&&year+'-'+md<=through&&!entry.overrides?.[md]&&!entry.unknownSessions?.[md])missing.push({market,year,date:md,reason:'half-day-hours-missing'});
  }
  return {ok:missing.length===0,version:calendarRegistry.version,owner:calendarRegistry.owner,horizonDays,through:new Date(end).toISOString().slice(0,10),missing,pending};
}
