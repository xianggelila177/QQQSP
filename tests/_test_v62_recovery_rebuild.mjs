import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRecoveryStore} from '../lib/recovery-store.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-rebuild-'));
const at=Date.now(),quote={symbol:'AAPL',price:100,quoteAt:at,ts:at,currency:'USD',fetchedAt:at,src:'fixture'};
try {
 const filePath=path.join(dir,'last-good.json');
 await fs.writeFile(filePath,'{truncated',{mode:0o600});
 const store=createRecoveryStore({filePath,now:()=>at});
 assert.equal(store.load(),false);
 assert.equal(store.remember(quote),true);
 assert.equal(await store.flush(),true,'valid new quote rebuilds safely after corrupt recovery file');
 assert.equal(await fs.readFile(filePath+'.corrupt','utf8'),'{truncated','retain original failure evidence');
 assert.equal((await fs.stat(filePath+'.corrupt')).mode&0o777,0o600);
 const reload=createRecoveryStore({filePath,now:()=>at});
 assert.equal(reload.load(),true);assert.equal(reload.get('AAPL').price,100);
 await fs.writeFile(filePath,JSON.stringify({version:0,old:true}));
 const old=createRecoveryStore({filePath,now:()=>at});old.load();old.remember(quote);
 assert.equal(await old.flush(),true,'unsupported ordinary schema is quarantined and rebuilt');
 assert.deepEqual((await fs.readdir(dir)).sort(),['last-good.json','last-good.json.corrupt'],'quarantine storage is bounded to one prior file');
 const external=path.join(dir,'do-not-overwrite');await fs.writeFile(external,'valuable');
 await fs.unlink(filePath+'.corrupt');await fs.symlink(external,filePath+'.corrupt');
 await fs.writeFile(filePath,'{bad-again');
 const linkedBackup=createRecoveryStore({filePath,now:()=>at});linkedBackup.load();linkedBackup.remember(quote);
 assert.equal(await linkedBackup.flush(),false,'symlink quarantine path remains fail closed');
 assert.equal(await fs.readFile(external,'utf8'),'valuable');
 assert.equal(await fs.readFile(filePath,'utf8'),'{bad-again');
 await fs.unlink(filePath);await fs.symlink(external,filePath);
 const linked=createRecoveryStore({filePath,now:()=>at});linked.load();linked.remember(quote);
 assert.equal(await linked.flush(),false,'symlink recovery target is never repaired by overwrite');
 assert.equal(await fs.readFile(external,'utf8'),'valuable');
 console.log('PASS safe bounded corrupt-file rebuild and symlink boundaries');
}finally{await fs.rm(dir,{recursive:true,force:true});}

// Exact binary evidence stays within the configured byte budget.
const binaryDir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-binary-rebuild-'));
try {
 const filePath=path.join(binaryDir,'state.json'),bad=Buffer.alloc(1024,255);
 await fs.writeFile(filePath,bad);
 const store=createRecoveryStore({filePath,now:()=>at,maxBytes:1024});store.load();store.remember(quote);
 assert.equal(await store.flush(),true);
 assert.deepEqual(await fs.readFile(filePath+'.corrupt'),bad);
 assert.equal((await fs.stat(filePath+'.corrupt')).size,1024);
}finally{await fs.rm(binaryDir,{recursive:true,force:true});}

// A cooperating external writer can publish a valid replacement while the
// quarantine fs operation awaits. Re-read and merge it instead of overwriting.
const raceDir=await fs.mkdtemp(path.join(os.tmpdir(),'qqqsp-race-rebuild-'));
const rename=fs.rename;
try {
 const filePath=path.join(raceDir,'state.json'),externalPath=path.join(raceDir,'external.json');
 const writer=createRecoveryStore({filePath:externalPath,now:()=>at});writer.load();writer.remember({...quote,symbol:'MSFT'});await writer.flush();
 await fs.writeFile(filePath,'{broken');
 const store=createRecoveryStore({filePath,now:()=>at});store.load();store.remember(quote);
 let replaced=false;
 fs.rename=async(from,to)=>{await rename(from,to);if(to===filePath+'.corrupt'&&!replaced){replaced=true;await rename(externalPath,filePath);}};
 assert.equal(await store.flush(),true);
 assert.deepEqual(JSON.parse(await fs.readFile(filePath,'utf8')).entries.map(x=>x.symbol).sort(),['AAPL','MSFT']);
 console.log('PASS corrupt binary size and concurrent replacement retention');
}finally{fs.rename=rename;await fs.rm(raceDir,{recursive:true,force:true});}
