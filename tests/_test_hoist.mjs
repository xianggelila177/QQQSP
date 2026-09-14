// Construction behavior protects against initialization-order regressions.
import assert from 'node:assert/strict';
import {createNewsService} from '../lib/news.js';
const a=createNewsService({newsLoader:async()=>[]}),b=createNewsService({newsLoader:async()=>[]});
assert.equal(a.newsCache.size,0);
assert.equal((await a.requestNews('QQQ')).stale,false);
assert.equal(a.newsCache.size,1);assert.equal(b.newsCache.size,0);
console.log('PASS news cache exists before first use and is instance-owned');
