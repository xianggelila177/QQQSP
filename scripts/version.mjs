import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function syncReadmeVersion(root,{check=false}={}) {
  const file=path.join(root,'README.md'),text=fs.readFileSync(file,'utf8');
  const version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
  const marker=/静态资源版本 \*\*\d+\*\*/g;
  if((text.match(marker)||[]).length!==1)throw new Error('README resource version marker missing or ambiguous');
  const updated=text.replace(marker,'静态资源版本 **'+version+'**');
  if(check&&updated!==text)throw new Error('README resource version is stale; run npm run build');
  if(!check&&updated!==text)fs.writeFileSync(file,updated);
}

function inputs(root) {
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+$/.test(version) || !Number.isSafeInteger(Number(version))) throw new Error('VERSION must be an integer');
  const files = ['public/sw.js', 'public/index.html', 'public/app.js'];
  const content = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  if ((content[0].match(/const VERSION = 'v\d+';/g) || []).length !== 1) throw new Error('Service Worker version marker missing or ambiguous');
  if ((content[1].match(/\?v=\d+/g) || []).length < 4) throw new Error('HTML version markers missing');
  if ((content[2].match(/sw\.js\?v=\d+/g) || []).length !== 1) throw new Error('Service Worker registration version marker missing or ambiguous');
  return { version, files, content };
}
export function checkVersion(root) {
  const { version, content } = inputs(root);
  const references = [content[0].match(/const VERSION = 'v(\d+)';/)[1], ...[...content[1].matchAll(/\?v=(\d+)/g)].map(match => match[1]), content[2].match(/sw\.js\?v=(\d+)/)[1]];
  if (references.some(value => value !== version)) throw new Error('VERSION and frontend resources differ; run bash build_version.sh');
  const core = content[0].match(/const CORE = \[([\s\S]*?)\];/);
  if (!core) throw new Error('Service Worker CORE declaration missing');
  const resources = [...core[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  for (const resource of resources) {
    const local = path.resolve(root, 'public', resource === '/' ? 'index.html' : resource.replace(/^\//, '').split('?')[0]);
    if (!local.startsWith(path.resolve(root, 'public') + path.sep) || !fs.statSync(local).isFile()) throw new Error(`Missing or invalid SW resource: ${resource}`);
  }
  for (const match of content[1].matchAll(/(?:src|href)=["']([^"']+\?v=\d+)["']/g)) {
    const relative = match[1].replace(/^\//, '').split('?')[0];
    const local = path.resolve(root, 'public', relative);
    if (!local.startsWith(path.resolve(root, 'public') + path.sep) || !fs.statSync(local).isFile()) throw new Error(`Missing HTML asset: ${relative}`);
  }
  return version;
}
export function syncVersion(root) {
  const { version, files, content } = inputs(root);
  const updated = [
    content[0].replace(/const VERSION = 'v\d+';/, `const VERSION = 'v${version}';`),
    content[1].replace(/(\?v=)\d+/g, (_, prefix) => prefix + version),
    content[2].replace(/(sw\.js\?v=)\d+/, (_, prefix) => prefix + version),
  ];
  // Validate all markers before any write; stage complete files with original mode.
  const temporary = fs.mkdtempSync(path.join(root, '.version-stage-'));
  const replaced = [];
  try {
    files.forEach((file, index) => fs.writeFileSync(path.join(temporary, String(index)), updated[index], { mode: fs.statSync(path.join(root, file)).mode & 0o777 }));
    files.forEach((file, index) => { fs.renameSync(path.join(temporary, String(index)), path.join(root, file)); replaced.push(index); });
    checkVersion(root);
  } catch (error) {
    for (const index of replaced) fs.writeFileSync(path.join(root, files[index]), content[index]);
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return version;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log(`Version ${process.argv.includes('--check') ? 'verified' : 'synced'}: v${process.argv.includes('--check') ? checkVersion(root) : syncVersion(root)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
