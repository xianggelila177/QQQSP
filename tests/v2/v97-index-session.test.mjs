import test from 'node:test';
import assert from 'node:assert/strict';
import {marketStateFor,marketCalendarCoverage} from '../../mkt.mjs';
import {nextMarketTransitionAt,refreshIndexSession} from '../../lib/session-policy.js';
import {parseNaverIndexQuote} from '../../lib/providers/naver-index.js';
import {quoteStatus} from '../../lib/http-diagnostics.js';
import {soxRow} from './semiconductor-fixture.mjs';

const at=value=>Date.parse(value);
const closeRow={...soxRow,marketStatus:'CLOSE',localTradedAt:'2026-09-18T17:16:00-04:00'};
const parse=(now,row=closeRow)=>parseNaverIndexQuote(row,'^SOX',{now:at(now),pollAfterMs:7000});

test('SOX pre-publication retains Friday close without a false quote-age alarm',()=>{
  const now=at('2026-09-21T11:56:00Z'),q=parse('2026-09-21T11:56:00Z');
  assert.equal(marketStateFor('^SOX',null,now),'CLOSED');
  assert.equal(q.marketState,'CLOSED');assert.equal(quoteStatus(q,now).status,'ok');
  assert.equal(q.quoteAt,at(closeRow.localTradedAt));assert.equal(q.sourceCheckedAt,now);
  assert.deepEqual(q.publicationSession,{kind:'index-publication',verified:true,phase:'waiting',timeZone:'America/New_York',
    source:'https://indexes.nasdaq.com/docs/methodology_SOX.pdf',nextPublishAt:at('2026-09-21T13:30:01Z')});
  assert.equal(marketStateFor('^GSPC',null,now),'PRE','the index-specific rule must not change other US indexes');
});

test('SOX starts at the published second and still warns about an old close once publishing begins',()=>{
  assert.equal(marketStateFor('^SOX',null,at('2026-09-21T13:30:00.999Z')),'CLOSED');
  assert.equal(marketStateFor('^SOX',null,at('2026-09-21T13:30:01Z')),'REGULAR');
  const q=parse('2026-09-21T13:35:01Z');
  assert.equal(q.publicationSession.phase,'publishing');assert.equal(q.publicationSession.nextPublishAt,null);
  assert.equal(quoteStatus(q,at('2026-09-21T13:35:01Z')).status,'stale');
  assert.equal(marketStateFor('^SOX',null,at('2026-09-21T21:15:59Z')),'REGULAR','closing corrections remain part of index publication');
  assert.equal(marketStateFor('^SOX',null,at('2026-09-21T21:16:00Z')),'CLOSED');
});

test('SOX skips known holidays and uses the next day DST offset',()=>{
  assert.equal(marketStateFor('^SOX',null,at('2026-09-07T14:00:00Z')),'CLOSED');
  assert.equal(nextMarketTransitionAt('^SOX',at('2026-09-07T11:56:00Z')),at('2026-09-08T13:30:01Z'));
  assert.equal(nextMarketTransitionAt('^SOX',at('2026-11-01T00:00:00Z')),at('2026-11-02T14:30:01Z'));
  assert.equal(marketStateFor('^SOX',null,at('2026-01-15T14:30:00Z')),'CLOSED');
  assert.equal(marketStateFor('^SOX',null,at('2026-01-15T14:30:01Z')),'REGULAR');
});

test('SOX early-close correction hours remain unknown instead of inventing an adjusted schedule',()=>{
  assert.equal(marketStateFor('^SOX',null,at('2026-11-27T17:30:00Z')),'REGULAR');
  assert.equal(marketStateFor('^SOX',null,at('2026-11-27T18:00:00Z')),'UNKNOWN');
  const now='2026-11-27T19:00:00Z',q=parse(now,{...soxRow,localTradedAt:'2026-11-27T13:00:00-05:00'});
  assert.equal(q.publicationSession.verified,false);assert.equal(q.publicationSession.phase,'unknown');
  assert.equal(q.publicationSession.nextPublishAt,null);assert.equal(marketCalendarCoverage('^SOX',at(now)).known,false);
});

test('SOX never guesses unknown-year reopening or labels an unverified schedule as normal',()=>{
  const now='2027-01-04T15:00:00Z',q=parse(now,{...soxRow,localTradedAt:'2026-12-31T17:16:00-05:00'});
  assert.equal(q.marketState,'UNKNOWN');assert.equal(q.publicationSession.verified,false);
  assert.equal(q.publicationSession.phase,'unknown');assert.equal(nextMarketTransitionAt('^SOX',at(now)),null);
});

test('transition cache distinguishes SOX from another index in both access orders',()=>{
  const first=at('2026-09-22T07:55:00Z');
  assert.equal(nextMarketTransitionAt('^GSPC',first),at('2026-09-22T08:00:00Z'));
  assert.equal(nextMarketTransitionAt('^SOX',first),at('2026-09-22T13:30:01Z'));
  const second=at('2026-09-23T07:55:00Z');
  assert.equal(nextMarketTransitionAt('^SOX',second),at('2026-09-23T13:30:01Z'));
  assert.equal(nextMarketTransitionAt('^GSPC',second),at('2026-09-23T08:00:00Z'));
});

test('the application boundary advances a cached SOX session without refreshing quote clocks',()=>{
  const cached=parse('2026-09-21T11:56:00Z'),now=at('2026-09-21T13:30:01Z');
  const current=refreshIndexSession(cached,now);
  assert.equal(cached.marketState,'CLOSED');assert.equal(current.marketState,'REGULAR');
  assert.equal(current.publicationSession.phase,'publishing');assert.equal(current.publicationSession.nextPublishAt,null);
  assert.equal(current.quoteAt,cached.quoteAt);assert.equal(current.sourceCheckedAt,cached.sourceCheckedAt);
  assert.equal(current.fetchedAt,cached.fetchedAt);assert.equal(quoteStatus(current,now).status,'stale');
  const ordinary={...cached,symbol:'^GSPC'};assert.equal(refreshIndexSession(ordinary,now),ordinary);
});

test('recovery cache remains stale after the SOX session metadata is updated',()=>{
  const cached={...parse('2026-09-21T11:56:00Z'),recovery:true,stale:true,staleInfo:{reason:'offline-cache'},src:'offline-cache'};
  const current=refreshIndexSession(cached,at('2026-09-21T13:30:01Z'));
  assert.equal(current.marketState,'REGULAR');assert.equal(current.publicationSession.phase,'publishing');
  for(const field of ['recovery','stale','staleInfo','src','quoteAt','ts','sourceCheckedAt','fetchedAt'])assert.equal(current[field],cached[field],field);
});
