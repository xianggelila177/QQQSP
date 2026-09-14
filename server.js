import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {createApplication} from './app.js';
export {createApplication};
// Importing this file creates no application, sockets, agents or timers.
const direct=()=>{try{return !!process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url);}catch{return false;}};
if(direct()){
  if((Number(process.versions.node.split('.')[0])<22 || Number(process.versions.node.split('.')[0])===22 && Number(process.versions.node.split('.')[1])<16))throw new Error('需要 Node.js 22.16 或更新版本（推荐 24）');
  const app=createApplication({env:process.env});
  app.start();
  process.on('uncaughtExceptionMonitor',error=>app.telemetry.log.error('[uncaught]',{error:String(error.message)}));
  let stopping=false;
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
    if(stopping)return;stopping=true;
    const deadline=setTimeout(()=>process.exit(1),10000);deadline.unref();
    app.stop().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
  });
}
