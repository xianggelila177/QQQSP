// Failure cooldown providers stay bounded through their injected cache writer.
import assert from 'node:assert/strict';
import { __upstream } from '../lib/transport.js';
import { getSinaDaily, initSina, resetSina, sinaFailAt } from '../lib/providers/sina.js';

const boundedSet = (map, key, value, max = 300) => {
  if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value);
  map.set(key, value);
};
resetSina();
initSina({ cacheSet: boundedSet });
__upstream.impl = async () => { throw new Error('offline'); };
for (let i = 0; i < 500; i++) await getSinaDaily(String(i).padStart(6, '0') + '.SS');
__upstream.impl = null;
assert.equal(sinaFailAt.size <= 300, true);
console.log('---- _test_failat_cap: PASS ----');
process.exit(0);
