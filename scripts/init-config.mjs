import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {loadConfig} from '../config.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
/** First install only. Refuses an existing file or symlink; never logs credentials. */
export async function initializeConfig(output=path.resolve('.env')){
 const template=await readFile(path.join(root,'.env.example'),'utf8');
 const keys={STATS_TOKEN:randomBytes(32).toString('base64url'),LLM_API_KEY:randomBytes(32).toString('base64url')};
 let body=template;
 for(const [key,value] of Object.entries(keys))body=new RegExp('^'+key+'=.*$','m').test(body)?body.replace(new RegExp('^'+key+'=.*$','m'),key+'='+value):body+'\n'+key+'='+value+'\n';
 loadConfig(parseEnv(body));let handle,created=false;
 try{handle=await open(output,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);created=true;await handle.writeFile(body);await handle.sync();}
 catch(error){if(created)await unlink(output).catch(()=>{});throw Object.assign(new Error(['EEXIST','ELOOP'].includes(error.code)?'配置已存在，未修改。升级请保留现有配置。':'无法创建配置文件。'),{code:error.code});}
 finally{await handle?.close();}
 return path.resolve(output);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const args=process.argv.slice(2);if(args.length&&!((args.length===2)&&args[0]==='--output'))throw new Error('用法：node scripts/init-config.mjs [--output 私有配置路径]');const dest=await initializeConfig(args[1]);console.log('首次配置已创建：'+dest+'\n两种独立密钥已写入文件，未输出到终端。请妥善保护配置；生产无需 npm install。');}
 catch(error){console.error(error.message);process.exitCode=1;}
}
