import readline from 'node:readline';import {once} from 'node:events';
import {createApplication} from '../../app.js';import {createTelemetry} from '../../log.mjs';import {createMacroFixture} from './macro-fixture.mjs';
const f=createMacroFixture();const app=createApplication({env:{PORT:0,TE_API_KEY:'fixture-key',PUBLIC_SOURCE_REDUNDANCY:'1',LOG_FILE:''},now:f.now,upstream:f.upstream,telemetry:createTelemetry()});
app.start();await once(app.httpServer,'listening');console.log(JSON.stringify({port:app.httpServer.address().port}));
const input=readline.createInterface({input:process.stdin});input.on('line',async line=>{try{if(line==='advance'){f.advance();await app.services.macroContext.getContext();await app.services.macroCalendar.getCalendar();}if(line==='fail'){f.advance(5*60000);f.fail();await app.services.macroContext.getContext();await app.services.macroCalendar.getCalendar();}console.log(JSON.stringify({ok:true,command:line,calls:f.calls.length}));}catch(e){console.log(JSON.stringify({error:e.message}));}});
const stop=()=>app.stop().then(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);
