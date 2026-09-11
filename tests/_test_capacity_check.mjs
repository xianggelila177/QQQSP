import assert from 'node:assert/strict';
const {assessCapacity}=await import('../ops/capacity-check.mjs');
assert.equal(assessCapacity({blocks:100,bavail:10,bsize:1024**3}).warning,true);
assert.equal(assessCapacity({blocks:100,bavail:20,bsize:1024**3}).warning,false);
assert.equal(assessCapacity({blocks:10,bavail:8,bsize:1024**3}).warning,true,'minimum free bytes protects small filesystems');
assert.equal(assessCapacity({blocks:0,bavail:0,bsize:1024}).warning,true,'unknown capacity cannot report healthy');
console.log('PASS capacity warning and minimum free space thresholds');
