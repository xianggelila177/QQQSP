import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assessCapacity} from '../lib/http-capacity.js';
export {assessCapacity};

function readRecord(file,fallback) {
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|(fs.constants.O_NOFOLLOW||0));
    const stat=fs.fstatSync(fd);
    if(!stat.isFile())throw new Error('capacity state must be a regular file');
    if(stat.size>1024*1024)throw new Error('capacity state exceeds size limit');
    try{return JSON.parse(fs.readFileSync(fd,'utf8'));}catch{return fallback;}
  } catch(error) {
    if(error.code==='ENOENT')return fallback;
    if(error.code==='ELOOP')throw new Error('capacity state symlink rejected');
    throw error;
  } finally {if(fd!=null)fs.closeSync(fd);}
}
function writeRecord(file,value) {
  let stat;
  try{stat=fs.lstatSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()))throw new Error('capacity state must be a regular file');
  const temporary=file+'.'+process.pid+'.tmp';
  let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o640);
    fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(temporary,file);
  } finally {if(fd!=null)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

export function checkCapacity({target='/',stateFile='/var/lib/qqqsp/health/capacity.json',now=Date.now,statfs=fs.statfsSync,historyLimit=1344}={}) {
  let result;
  const checkedAt=new Date(now()).toISOString();
  try {result={...assessCapacity(statfs(target)),target,checkedAt};}
  catch(error) {result={target,checkedAt,warning:true,critical:true,error:error.code||'UNAVAILABLE',owner:'server administrator'};}
  result.alertState=result.critical?'critical':result.warning?'warning':'ok';
  if(stateFile) {
    fs.mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o750});
    const previous=readRecord(stateFile,null);
    result.previousAlertState=previous?.alertState??null;
    const historyFile=path.join(path.dirname(stateFile),'capacity-history.json');
    const prior=readRecord(historyFile,[]);
    const limit=Number.isInteger(historyLimit)&&historyLimit>=1&&historyLimit<=1344?historyLimit:1344;
    const history=(Array.isArray(prior)?prior:[]).filter(row=>row&&typeof row.checkedAt==='string').slice(-(limit-1||0));
    if(limit===1)history.length=0;
    history.push(result);
    writeRecord(historyFile,history);
    writeRecord(stateFile,result);
  }
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const result=checkCapacity();
    (result.warning?console.error:console.log)(JSON.stringify(result));
    process.exitCode=result.warning?2:0;
  } catch(error) {console.error(JSON.stringify({warning:true,error:error.code||'CAPACITY_CHECK_FAILED'}));process.exitCode=3;}
}
