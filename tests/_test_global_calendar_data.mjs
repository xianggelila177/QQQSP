import assert from 'node:assert/strict';
import {marketStateFor,marketCalendarCoverage,timezoneOffsetFor,calendarCoverageStatus} from '../mkt.mjs';
const at=(symbol,date,h,m=0)=>{const noon=Date.parse(date+'T12:00:00Z');return Date.parse(date+'T00:00:00Z')+(h*60+m)*60000-timezoneOffsetFor(symbol,noon)*1000;};
const state=(s,date,h,m=0,type)=>marketStateFor(s,null,at(s,date,h,m),type?{instrumentType:type}:'');
for(const s of ['AAPL','600519.SS','0700.HK','7203.T','005930.KS','VOD.L','SAP.DE','MC.PA','NESN.SW','ASML.AS','ENI.MI','SAN.MC','RY.TO','BHP.AX','RELIANCE.NS','D05.SI','2330.TW','PETR4.SA','WALMEX.MX','NPN.JO'])assert.equal(state(s,'2026-09-08',10),'REGULAR',s);
assert.equal(state('VOD.L','2026-12-28',10),'CLOSED');assert.equal(state('VOD.L','2026-12-24',12,31),'AUCTION');assert.equal(state('VOD.L','2026-12-24',12,36),'CLOSED');
assert.equal(state('SAP.DE','2026-05-25',10),'REGULAR','German public holiday is a Xetra trading day');
assert.equal(state('SAP.DE','2026-12-30',10),'UNKNOWN');
for(const s of ['MC.PA','ASML.AS'])assert.equal(state(s,'2026-12-24',10),'UNKNOWN','unpublished Euronext half-day timetable');
for(const s of ['CAC.PA','IAEX.AS','CSSPX.MI']){assert.equal(state(s,'2026-09-08',9,2,'ETF'),'CLOSED');assert.equal(state(s,'2026-09-08',9,5,'ETF'),'REGULAR');}
assert.equal(state('NESN.SW','2026-09-08',17,25),'AUCTION');assert.equal(state('CSSMI.SW','2026-09-08',17,25),'REGULAR');
assert.equal(state('SAN.MC','2026-09-08',17,36),'POST');assert.equal(state('BBVAI.MC','2026-09-08',17,36),'REGULAR');assert.equal(state('SAN.MC','2026-12-24',14,1),'CLOSED');
assert.equal(state('RY.TO','2026-12-24',13,1),'CLOSED');assert.equal(state('BHP.AX','2026-12-24',14,11),'CLOSED');
assert.equal(state('RELIANCE.NS','2026-11-08',18),'UNKNOWN');assert.equal(state('D05.SI','2026-09-08',12,30),'BREAK');assert.equal(state('D05.SI','2026-02-16',12,20),'CLOSED');
assert.equal(state('2330.TW','2026-02-12',10),'CLOSED','settlement-only day is not a trading day');
assert.equal(state('PETR4.SA','2026-03-06',17),'REGULAR');assert.equal(state('PETR4.SA','2026-03-10',17),'CLOSED');assert.equal(state('BOVA11.SA','2026-03-10',17),'AUCTION');
assert.equal(state('PETR4.SA','2026-02-18',12),'CLOSED');assert.equal(state('PETR4.SA','2026-02-18',13,1),'REGULAR');
assert.equal(state('WALMEX.MX','2026-03-06',7,59),'CLOSED');assert.equal(state('WALMEX.MX','2026-03-06',8),'AUCTION');assert.equal(state('WALMEX.MX','2026-03-10',8),'REGULAR');assert.equal(state('WALMEX.MX','2026-11-03',8),'AUCTION');
assert.equal(state('NPN.JO','2026-09-08',12,5),'UNKNOWN');assert.equal(state('STX40.JO','2026-09-08',12,5),'REGULAR');
for(const date of ['2026-11-04','2026-12-24','2026-12-31']){assert.equal(state('NPN.JO',date,10),'UNKNOWN');const coverage=marketCalendarCoverage('NPN.JO',at('NPN.JO',date,10));assert.equal(coverage.pending,true);assert.ok(coverage.note);}
assert.equal(calendarCoverageStatus(Date.parse('2026-09-06T00:00:00Z'),90).ok,true);assert.equal(calendarCoverageStatus(Date.parse('2026-10-05T00:00:00Z'),90).ok,false);
console.log('PASS all20 official market calendars, instrument-specific sessions and documented exceptions');
