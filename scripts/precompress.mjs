import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';import {fileURLToPath} from 'node:url';
export function precompress(root){let bytes=0,compressed=0;for(const name of ['index.html','panel.bundle.js','style.css','sw.js','manifest.webmanifest','icon.svg']){
 const file=path.join(root,'public',name),raw=fs.readFileSync(file);const br=zlib.brotliCompressSync(raw,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:9}}),gz=zlib.gzipSync(raw,{level:9});fs.writeFileSync(file+'.br',br);fs.writeFileSync(file+'.gz',gz);bytes+=raw.length;compressed+=br.length;
 }return {rawBytes:bytes,brotliBytes:compressed};}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))console.log(precompress(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')));
