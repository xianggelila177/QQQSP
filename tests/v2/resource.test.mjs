import test from 'node:test';import assert from 'node:assert/strict';
import {createCachedResource} from '../../lib/cached-resource.js';
test('SWR starts at TTL, not after the old maximum quote age',async()=>{
 let now=1000,n=0,release;const r=createCachedResource({now:()=>now,ttlMs:2000,loader:async()=>{n++;if(n===2)await new Promise(r=>release=r);return n;}});
 assert.equal(await r.get('x'),1);now=3001;assert.equal(await r.get('x',{swr:true}),1);await Promise.resolve();assert.equal(n,2);release();await r.inflight.get('x');assert.equal(await r.get('x'),2);r.close();
});
test('cold failure is cached and not retried by every display tick',async()=>{
 let now=1000,n=0;const r=createCachedResource({now:()=>now,retryMs:60000,loader:()=>{n++;throw Object.assign(new Error('429'),{retryAt:121000});}});
 for(let i=0;i<12;i++)await assert.rejects(r.get('x'));assert.equal(n,1);now=121000;await assert.rejects(r.get('x'));assert.equal(n,2);r.close();
});
