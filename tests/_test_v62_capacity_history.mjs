import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkCapacity} from '../ops/capacity-check.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqqsp-capacity-'));
try {
 const stateFile=path.join(dir,'capacity.json');let at=Date.parse('2026-09-06T00:00:00Z');
 const stats={blocks:100,bavail:20,bsize:1024**3};
 for(let i=0;i<8;i++){checkCapacity({stateFile,now:()=>at+i*900000,statfs:()=>stats,historyLimit:4});}
 let history=JSON.parse(fs.readFileSync(path.join(dir,'capacity-history.json')));
 assert.equal(history.length,4);assert.equal(history[0].checkedAt,new Date(at+4*900000).toISOString());
 const alarm=checkCapacity({stateFile,now:()=>at+8*900000,statfs:()=>({...stats,bavail:8}),historyLimit:4});
 assert.equal(alarm.warning,true);assert.equal(alarm.alertState,'warning');
 assert.equal(alarm.previousAlertState,'ok');
 const next=checkCapacity({stateFile,now:()=>at+9*900000,statfs:()=>stats,historyLimit:4});
 assert.equal(next.alertState,'ok');assert.equal(next.previousAlertState,'warning');
 assert.equal(JSON.parse(fs.readFileSync(stateFile)).alertState,'ok');
 const outside=path.join(dir,'do-not-write');fs.writeFileSync(outside,'valuable');
 fs.unlinkSync(path.join(dir,'capacity-history.json'));fs.symlinkSync(outside,path.join(dir,'capacity-history.json'));
 assert.throws(()=>checkCapacity({stateFile,statfs:()=>stats}),/regular|symlink/);
 assert.equal(fs.readFileSync(outside,'utf8'),'valuable');
 console.log('PASS bounded capacity history, warning/recovery transitions and protected paths');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
