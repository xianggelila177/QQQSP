import path from 'node:path';import {fileURLToPath} from 'node:url';
import {syncVersion} from './version.mjs';import {buildStatic} from './build-static.mjs';import {precompress} from './precompress.mjs';import {syncExample} from './env-example.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
syncVersion(root);syncExample(root);console.log(JSON.stringify({bundle:buildStatic(root),compression:precompress(root)},null,2));
