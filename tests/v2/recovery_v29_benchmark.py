"""Compare the supplied 2.8 recovery module with this source. Synthetic data only."""
from pathlib import Path
import json, subprocess, sys, tempfile, zipfile
ROOT = Path(__file__).resolve().parents[2]
if len(sys.argv) != 2:
    raise SystemExit('usage: python3 tests/v2/recovery_v29_benchmark.py /path/to/qqqsp-v2.8-source.zip')
program = r'''
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [baseline,current,working]=process.argv.slice(2);
const clock=Date.parse('2026-09-10T16:00:00Z');
const symbols=['NVDA','MRVL','LITE','AAOI','QQQ','SPY','AAPL','MSFT','AMD','AVGO','AMZN','GOOG'];
const bars=step=>Array.from({length:1500},(_,i)=>({t:clock/1000-(1499-i)*step,o:100+i*.01,h:102+i*.01,l:99+i*.01,c:101+i*.01,v:1000+i}));
const input=symbols.map(symbol=>({symbol,price:116,quoteAt:clock,sourceCheckedAt:clock,fetchedAt:clock,currency:'USD',src:'synthetic',charts:{intraday:bars(60),daily30:bars(86400)}}));
const percentile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(q*values.length)-1];
const results={node:process.version,platform:process.platform,arch:process.arch,scope:'same process, synthetic recovery.get only; not production latency or RSS capacity',securities:12,barsPerFamily:1500,familiesPerSecurity:2,rounds:25};
for(const [name,file] of [['before',baseline],['after',current]]){
 const {createRecoveryStore}=await import(pathToFileURL(file));
 const store=createRecoveryStore({filePath:path.join(working,name+'.json'),now:()=>clock});store.load();
 for(const q of input)assert.equal(store.remember(q),true);
 let result;
 for(let i=0;i<5;i++)for(const s of symbols)result=store.get(s);
 const durations=[];
 for(let i=0;i<25;i++){const at=performance.now();for(const s of symbols)result=store.get(s);durations.push(performance.now()-at);}
 assert.equal(result.charts.intraday.length,1500);assert.equal(result.charts.daily30.length,1500);
 const first=store.get(symbols[0]),second=store.get(symbols[0]);
 results[name]={medianMs:percentile(durations,.5),p95Ms:percentile(durations,.95),minMs:Math.min(...durations),maxMs:Math.max(...durations),barsIdentityStable:first.charts.daily30===second.charts.daily30,barsFrozen:Object.isFrozen(first.charts.daily30[0]),durationsMs:durations};
}
results.ratio=results.before.medianMs/results.after.medianMs;
console.log(JSON.stringify(results,null,2));
'''
with tempfile.TemporaryDirectory(prefix='qqqsp-recovery-benchmark-') as work:
    old = Path(work)/'baseline'; (old/'lib').mkdir(parents=True)
    (old/'package.json').write_text('{"type":"module"}')
    with zipfile.ZipFile(sys.argv[1]) as archive:
        for relative in ('lib/recovery-store.js', 'lib/quote-contract.js'):
            (old/relative).write_bytes(archive.read('qqqsp-v2.8/'+relative))
    result = subprocess.run(['node','--input-type=module','-',str(old/'lib/recovery-store.js'),str(ROOT/'lib/recovery-store.js'),work],input=program,text=True,capture_output=True,check=True,timeout=30)
    data = json.loads(result.stdout)
    output=ROOT/'docs/evidence/v2.9-release/recovery-benchmark.json'; output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    print(result.stdout)
