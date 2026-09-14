import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'qqqsp-tooling-regression-'));
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS:', name); }
  catch (error) { failures.push(name); console.error('FAIL:', name, error.message); }
}
try {
  await check('retired cleanup preserves logs and monitor data even if backup command fails', () => {
    const panel = path.join(temp, 'panel'); const monitor = path.join(temp, 'qqq_monitor');
    mkdirSync(panel); mkdirSync(monitor); mkdirSync(path.join(temp, 'bin'));
    cpSync(path.join(root, 'cleanup.sh'), path.join(panel, 'cleanup.sh'));
    writeFileSync(path.join(temp, 'bin/cp'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    const originals = new Map([
      [path.join(panel, 'server.out'), 'valuable server log\n'],
      [path.join(panel, 'tunnel.out'), 'valuable tunnel log\n'],
      [path.join(panel, 'supervisor.out'), 'valuable supervisor log\n'],
      [path.join(monitor, 'qqq_prices.csv'), 'columns\nvaluable historical row\n'],
      [path.join(monitor, 'fetch.log'), 'valuable monitor log\n'],
    ]);
    for (const [file, body] of originals) writeFileSync(file, body);
    const result = spawnSync('/bin/bash', [path.join(panel, 'cleanup.sh')], { env: { PATH: `${temp}/bin:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const [file, body] of originals) assert.equal(readFileSync(file, 'utf8'), body, path.basename(file));
  });
  await check('each shell file and each JS file fails syntax gate independently', async () => {
    const { checkSyntax } = await import('../scripts/check.mjs');
    const fixture = path.join(temp, 'syntax'); mkdirSync(fixture);
    writeFileSync(path.join(fixture, 'a.sh'), '#!/bin/bash\ntrue\n');
    writeFileSync(path.join(fixture, 'z.sh'), '#!/bin/bash\nif then\n');
    assert.throws(() => checkSyntax(fixture), /z\.sh/);
    writeFileSync(path.join(fixture, 'z.sh'), '#!/bin/bash\ntrue\n');
    writeFileSync(path.join(fixture, 'broken.mjs'), 'export const = ;');
    assert.throws(() => checkSyntax(fixture), /broken\.mjs/);
    writeFileSync(path.join(fixture, 'broken.mjs'), 'export const value = 1;');
    assert.doesNotThrow(() => checkSyntax(fixture));
  });
  await check('version preflight failure preserves every original frontend file', async () => {
    const { syncVersion } = await import('../scripts/version.mjs');
    const fixture = path.join(temp, 'version'); mkdirSync(fixture);
    cpSync(path.join(root, 'public'), path.join(fixture, 'public'), { recursive: true });
    writeFileSync(path.join(fixture, 'VERSION'), '987\n');
    const appPath = path.join(fixture, 'public', 'app.js');
    writeFileSync(appPath, readFileSync(appPath, 'utf8').replace(/sw\.js\?v=\d+/, 'worker-without-version.js'));
    const before = ['app.js', 'index.html', 'sw.js'].map(file => readFileSync(path.join(fixture, 'public', file), 'utf8'));
    assert.throws(() => syncVersion(fixture), /version marker missing/);
    assert.deepEqual(['app.js', 'index.html', 'sw.js'].map(file => readFileSync(path.join(fixture, 'public', file), 'utf8')), before);
  });
  await check('test environment strips production settings and creates removable private paths', async () => {
    const { createTestSandbox } = await import('./support/isolation.mjs');
    const sandbox = createTestSandbox(root, { PATH: process.env.PATH, YAHOO_RELAY_TOKEN: 'sentinel-do-not-inherit', PORT: '8567', LIVE_URL: 'https://production.invalid', NODE_OPTIONS: '--inspect', STATS_TOKEN: 'sentinel-do-not-inherit' });
    try {
      assert.equal(sandbox.env.YAHOO_RELAY_TOKEN, undefined);
      assert.equal(sandbox.env.STATS_TOKEN, undefined);
      assert.equal(sandbox.env.LIVE_URL, undefined);
      assert.equal(sandbox.env.NODE_OPTIONS, undefined);
      assert.equal(sandbox.env.PORT, '0');
      assert.ok(sandbox.env.LOG_FILE.startsWith(sandbox.path + path.sep));
      assert.equal(sandbox.env.HOME, undefined);
      assert.ok(existsSync(sandbox.env.TMPDIR));
    } finally { sandbox.cleanup(); }
    assert.equal(existsSync(sandbox.path), false);
  });
  await check('test network guard blocks an unstubbed external request without connecting', () => {
    const guard = path.join(root, 'tests', 'support', 'no-network.mjs');
    const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', "try { await fetch('https://example.invalid/test'); } catch (error) { if (error.code !== 'ERR_TEST_EXTERNAL_NETWORK_BLOCKED') process.exit(2); }"], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /blocked 1 unexpected external network/);
  });
  await check('secret scanner rejects generic credential fixtures without emitting matched values', async () => {
    const { scanText, scanTree } = await import('../scripts/secret-scan.mjs');
    const credential = ['sk', 'proj', 'A4b6C8d0E2f4G6h8I0j2K4l6M8n0P2q4R6s8'].join('-');
    assert.ok(scanText(`API_KEY='${credential}'`).length > 0);
    assert.ok(scanText("token='" + credential.slice(8) + "'").length > 0);
    const fixture = path.join(temp, 'secrets'); mkdirSync(fixture);
    writeFileSync(path.join(fixture, 'unsafe.js'), `const API_KEY='${credential}';`);
    const found = scanTree(fixture);
    assert.ok(found.length >= 1);
    assert.equal(JSON.stringify(found).includes(credential), false);
    assert.deepEqual(scanText('const token = process.env.STATS_TOKEN;'), []);
  });
  await check('coverage fingerprint rejects concurrent source edits', async () => {
    const { snapshotSources, assertSameSources } = await import('../scripts/gate-state.mjs');
    const fixture = path.join(temp, 'source-epoch'); mkdirSync(fixture);
    writeFileSync(path.join(fixture, 'app.js'), 'let value = 1;');
    const snapshot = snapshotSources(fixture);
    assert.doesNotThrow(() => assertSameSources(fixture, snapshot));
    writeFileSync(path.join(fixture, 'app.js'), 'let value = 2;');
    assert.throws(() => assertSameSources(fixture, snapshot), /Source changed/);
  });
  await check('archive creation refuses failed tests or unmet coverage threshold', async () => {
    const { createRelease } = await import('../scripts/release.mjs');
    const fixture = path.join(temp, 'unverified-release'); mkdirSync(fixture);
    cpSync(path.join(root, 'public'), path.join(fixture, 'public'), { recursive: true });
    cpSync(path.join(root, 'VERSION'), path.join(fixture, 'VERSION'));
    mkdirSync(path.join(fixture, 'coverage'));
    for (const gate of [{ testsPassed: false, failed: [] }, { testsPassed: true, failed: ['branches'] }]) {
      writeFileSync(path.join(fixture, 'coverage', 'gate.json'), JSON.stringify(gate));
      await assert.rejects(() => createRelease(fixture, path.join(fixture, 'dist')), /verification|ENOENT|Full release gate/);
    }
    assert.equal(existsSync(path.join(fixture, 'dist')), false);
  });
  await check('release file allowlist includes required sources and rejects symlinks', async () => {
    const { releaseFiles } = await import('../scripts/release.mjs');
    const fixture = path.join(temp, 'linked-source'); mkdirSync(fixture);
    symlinkSync(path.join(root, 'server.js'), path.join(fixture, 'server.js'));
    assert.throws(() => releaseFiles(fixture), /symlink rejected/);
    const files = releaseFiles(root);
    assert.ok(files.includes('server.js')); assert.ok(files.includes('public/app.js'));
    assert.ok(files.includes('package-lock.json'));
    assert.equal(files.some(file => /(^|\/)(?:\.git|node_modules|test-results|coverage|archive)(\/|$)|\.token$|\.env(?:\.|$)/.test(file)), false);
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
assert.equal(failures.length, 0, failures.join('; '));
