// Test-only process. Business logic and all HTTP routes are the real application;
// only upstream network responses and time are injected. Never imported at runtime.
import readline from 'node:readline';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';import {createMacroFixture} from './macro-fixture.mjs';
const f=createMacroFixture({survey:true});const app=createApplication({env:{PORT:0,MACRO_STATE_PATH:'',TE_API_KEY:'fixture-key',PUBLIC_SOURCE_REDUNDANCY:'1',LOG_FILE:''},now:f.now,upstream:f.upstream,telemetry:createTelemetry()});
app.start();await once(app.httpServer,'listening');await app.services.macroMonitor.settled();console.log(JSON.stringify({port:app.httpServer.address().port,bootRuns:app.services.macroMonitor.status().lanes}));
const input=readline.createInterface({input:process.stdin});
input.on('line',async line=>{try{
 if(line==='advance'||line==='fail'){
  if(line==='fail'){f.advance(5*60000);f.fail();}else f.advance();
  app.services.macroMonitor.runDue();await app.services.macroMonitor.settled();
 }
 console.log(JSON.stringify({ok:true,command:line,calls:f.calls.length,snapshot:app.services.macroMonitor.snapshot()}));
}catch(e){console.log(JSON.stringify({error:e.message}));}});
const stop=()=>app.stop().then(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);
