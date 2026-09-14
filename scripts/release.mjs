import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { sourceFiles } from './files.mjs';
import { scanTree } from './secret-scan.mjs';
import { assertSameSources, requireCompleteVerification } from './gate-state.mjs';
import { checkCalendar } from './calendar-check.mjs';
import { checkVersion } from './version.mjs';

const sourceExtension = /\.(?:[cm]?js|json|html|css|svg|webmanifest|sh|py|md|service|timer|conf)$/;
const sourceDirectories = new Set(['public', 'lib', 'data', 'ops', 'docs', 'scripts', 'tests']);
export function releaseFiles(root) {
  function checkLinks(directory = '') {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.name.startsWith('.') || /(?:token|credential|secret)(?:[.]|$)/.test(entry.name)) continue;
      if (!directory && entry.isDirectory() && !sourceDirectories.has(entry.name)) continue;
      if (entry.isSymbolicLink() && (directory || sourceExtension.test(entry.name) || sourceDirectories.has(entry.name))) throw new Error(`Release source symlink rejected: ${relative}`);
      if (entry.isDirectory()) checkLinks(relative);
    }
  }
  checkLinks();
  return sourceFiles(root).filter(file => {
    if (/(^|\/)[.]|(?:token|credential|secret)(?:[.]|$)|[.](?:log|out|bak|pem|key)$/.test(file)) return false;
    const parts = file.split('/');
    if (parts.length > 1 && !sourceDirectories.has(parts[0])) return false;
    return file === 'VERSION' || file === 'package-lock.json' || sourceExtension.test(file) || /^tests\/fixtures\/[A-Za-z0-9_-]+\.xml$/.test(file);
  });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function createRelease(root, outputDirectory, options = {}) {
  const version = checkVersion(root);
  const { sources: expectedSources } = requireCompleteVerification(root, options);
  await checkCalendar(root, options.now ?? Date.now());
  const expectedDigests = new Map(expectedSources.map(entry => [entry.path, entry.sha256]));
  const findings = scanTree(root);
  if (findings.length) throw new Error(`Release source secret scan failed (${findings.length} findings; values suppressed)`);
  const files = releaseFiles(root);
  for (const required of ['server.js', 'package.json', 'package-lock.json', 'VERSION', 'public/app.js', 'public/sw.js', 'data/market-calendars.json']) if (!files.includes(required)) throw new Error(`Missing required release file: ${required}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qqqsp-release-'));
  const manifest = { format: 1, version, files: [] };
  try {
    for (const file of files) {
      const input = path.join(root, file); const target = path.join(temporary, file);
      const stat = fs.lstatSync(input);
      if (!stat.isFile()) throw new Error(`Release entry is not a regular file: ${file}`);
      const descriptor = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let bytes;
      try { if (!fs.fstatSync(descriptor).isFile()) throw new Error(`Release entry changed type: ${file}`); bytes = fs.readFileSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      if (hash(bytes) !== expectedDigests.get(file)) throw new Error(`Source changed while packaging: ${file}`);
      const mode = file.endsWith('.sh') ? 0o755 : 0o644;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { mode });
      manifest.files.push({ path: file, size: bytes.length, mode: mode.toString(8), sha256: hash(bytes) });
    }
    assertSameSources(root, expectedSources);
    fs.writeFileSync(path.join(temporary, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, `qqqsp-v${version}.tar.gz`);
    await tar.create({ cwd: temporary, file: output, portable: true, noMtime: true, gzip: { mtime: 0 }, prefix: `qqqsp-v${version}`, follow: false }, [...files, 'release-manifest.json'].sort());
    await verifyArchive(output, manifest);
    const digest = hash(fs.readFileSync(output));
    fs.writeFileSync(output + '.sha256', `${digest}  ${path.basename(output)}\n`);
    fs.writeFileSync(path.join(outputDirectory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { output, digest, files: files.length };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
export async function verifyArchive(archive, expectedManifest) {
  const entries = [];
  await tar.list({ file: archive, onReadEntry: entry => {
    if (!['File', 'OldFile'].includes(entry.type)) throw new Error(`Archive entry is not a regular file: ${entry.path}`);
    if (entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || entry.path.includes('\\')) throw new Error(`Unsafe archive path: ${entry.path}`);
    entries.push(entry.path);
  } });
  if (new Set(entries).size !== entries.length) throw new Error('Duplicate archive path');
  const manifestEntries = entries.filter(entry => entry.endsWith('/release-manifest.json'));
  if (manifestEntries.length !== 1) throw new Error('Archive must contain exactly one root manifest');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qqqsp-unpack-'));
  try {
    await tar.extract({ file: archive, cwd: temporary, strict: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(temporary, manifestEntries[0]), 'utf8'));
    if (manifest.format !== 1 || !/^\d+$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest');
    const prefix = `qqqsp-v${manifest.version}/`;
    const paths = manifest.files.map(entry => entry.path);
    if (new Set(paths).size !== paths.length || paths.includes('release-manifest.json')) throw new Error('Manifest paths must be unique and exclude itself');
    const expected = [...paths.map(file => prefix + file), prefix + 'release-manifest.json'].sort();
    if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) throw new Error('Archive file set differs from manifest');
    if (expectedManifest && JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) throw new Error('Archive manifest differs from packaged source');
    for (const entry of manifest.files) {
      const bytes = fs.readFileSync(path.join(temporary, prefix, entry.path));
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`Archive bytes differ from manifest: ${entry.path}`);
    }
    return { version: manifest.version, files: paths.length };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    if (process.argv.includes('--check')) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qqqsp-artifact-check-'));
      try {
        const first = await createRelease(root, path.join(temporary, 'one'));
        const second = await createRelease(root, path.join(temporary, 'two'));
        if (first.digest !== second.digest) throw new Error('Release archives are not reproducible');
        console.log(`Release artifact: ${first.files} files, reproducible SHA256 ${first.digest}`);
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    } else console.log(JSON.stringify(await createRelease(root, path.resolve(root, 'dist')), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
