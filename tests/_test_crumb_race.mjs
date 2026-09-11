// Yahoo credential behavior: each returned crumb remains paired with its cookie
// under concurrent calls, and invalid credentials enter cooldown.
import assert from 'node:assert/strict';
import { __upstream } from '../lib/transport.js';
import { createYahooAuth } from '../lib/yahoo-auth.js';

let n = 0;
__upstream.impl = async url => {
  n++;
  if (String(url).includes('fc.yahoo.com')) return { status: 200, headers: { 'set-cookie': [`sid=${n}; Path=/`] }, body: '' };
  return { status: 200, headers: {}, body: `crumb-${n}` };
};
const auth = createYahooAuth({ onRateLimit() {} });
const pairs = await Promise.all(Array.from({ length: 8 }, () => auth.getCrumb()));
assert.equal(pairs.every(x => x.crumb && x.cookie && x.cookie.includes('sid=')), true);
auth.clearCrumb();
__upstream.impl = async url => String(url).includes('getcrumb') ? { status: 429, headers: {}, body: 'Edge: Too Many Requests' } : { status: 200, headers: { 'set-cookie': ['sid=x'] }, body: '' };
await assert.rejects(auth.getCrumb(), /crumb fetch failed/);
await assert.rejects(auth.getCrumb(), /crumb cooldown/);
__upstream.impl = null;
console.log('RESULT: PASS');
process.exit(0);
