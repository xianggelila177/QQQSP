import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sourceFiles } from './files.mjs';
import { scanTree } from './secret-scan.mjs';
import { checkVersion } from './version.mjs';
import { clearStage, recordStage } from './gate-state.mjs';

export function checkSyntax(root) {
  for (const file of sourceFiles(root)) {
    let command; let args;
    if (/\.[cm]?js$/.test(file)) { command = process.execPath; args = ['--check', file]; }
    else if (file.endsWith('.sh')) { command = '/bin/bash'; args = ['-n', file]; }
    else if (file.endsWith('.py')) { command = 'python3'; args = ['-c', 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(), filename=sys.argv[1])', file]; }
    else continue;
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0 || result.error) throw new Error(`Syntax check failed: ${file}\n${result.stderr || result.error?.message || ''}`);
  }
}
export function checkServices(root, native = process.platform === 'linux') {
  const units = sourceFiles(root).filter(file => /\.(service|timer)$/.test(file));
  for (const unit of units) {
    const content = fs.readFileSync(path.join(root, unit), 'utf8');
    if (!content.includes('[Unit]') || !content.includes(unit.endsWith('.timer') ? '[Timer]' : '[Service]')) throw new Error(`Invalid systemd sections: ${unit}`);
    if (unit.endsWith('.service') && !/^ExecStart=\//m.test(content)) throw new Error(`Service lacks absolute executable: ${unit}`);
  }
  if (native) {
    const result = spawnSync('systemd-analyze', ['verify', ...units], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0 || result.error) throw new Error(`systemd-analyze verify failed\n${result.stderr || result.error?.message || ''}`);
    console.log(`systemd-analyze: ${units.length} units validated`);
  } else console.log('Native systemd verification requires Linux and is mandatory before deployment. Portable unit checks passed.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const recording = process.argv.includes('--record');
    if (process.argv.includes('--native')) {
      if (recording) clearStage(root, 'linux');
      if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Native release validation requires Linux and Node 24; completed source-matched local evidence is preserved in .verification.');
      checkServices(root, true);
      if (recording) recordStage(root, 'linux', { nativeSystemd: true });
    } else if (process.argv.includes('--deterministic')) {
      if (recording) clearStage(root, 'deterministic');
      const result = spawnSync(process.execPath, ['tests/_run_all.mjs'], { cwd: root, stdio: 'inherit' });
      if (result.status !== 0 || result.error) throw new Error('Deterministic suite failed: ' + (result.error?.message || result.status));
      if (recording) recordStage(root, 'deterministic', { command: 'tests/_run_all.mjs' });
    } else {
      if (recording) clearStage(root, 'syntax');
      checkSyntax(root); console.log('Syntax: all JavaScript, shell and Python files passed');
      checkVersion(root); console.log('Version and static resources: passed');
      const bundle = spawnSync(process.execPath, ['scripts/build-static.mjs', '--check'], { cwd: root, encoding: 'utf8' });
      if (bundle.status !== 0 || bundle.error) throw new Error('Deterministic static asset check failed: ' + (bundle.stderr || bundle.error?.message || ''));
      checkServices(root, false);
      const findings = scanTree(root);
      for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
      if (findings.length) throw new Error(`Secret scan failed: ${findings.length} findings (values suppressed)`);
      console.log('Source secret scan: passed');
      if (recording) recordStage(root, 'syntax', { syntax: true, version: true, assets: true, secrets: true });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
