import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const env = { ...process.env, PORT: '0', LOG_LEVEL: 'error' };
delete env.PANEL_TEST_AUTOSTART;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  const initialHandlers = ['SIGINT','SIGTERM','uncaughtException','unhandledRejection'].map(event => process.listenerCount(event));
  const intervals = new Set();
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  globalThis.setInterval = (...args) => { const timer = originalSet(...args); intervals.add(timer); return timer; };
  globalThis.clearInterval = timer => { intervals.delete(timer); originalClear(timer); };
  const app = await import('./server.js');
  assert.equal(app.httpServer.listening, false);
  assert.equal(intervals.size, 0, 'import must not start background timers');
  assert.deepEqual(['SIGINT','SIGTERM','uncaughtException','unhandledRejection'].map(event => process.listenerCount(event)), initialHandlers);
  for (let cycle = 0; cycle < 2; cycle++) {
    app.start(); app.start();
    await new Promise(resolve => app.httpServer.once('listening', resolve));
    assert.equal(intervals.size, 3, 'start is idempotent');
    const response = await fetch('http://127.0.0.1:' + app.httpServer.address().port + '/healthz');
    assert.equal(response.status, 200);
    await response.text();
    await app.stop();
    assert.equal(app.httpServer.listening, false);
    assert.equal(intervals.size, 0, 'stop clears every background interval');
  }
  assert.deepEqual(['SIGINT','SIGTERM','uncaughtException','unhandledRejection'].map(event => process.listenerCount(event)), initialHandlers);
  console.log('PASS side-effect-free import and two start/stop cycles');
`], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10000 });
assert.equal(child.status, 0, child.stdout + child.stderr + (child.error || ''));
console.log(child.stdout.trim());

// Atomic deployments use a symlinked release directory; direct CLI startup
// must still recognize its entry file after Node resolves that symlink.
const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { spawn } = await import('node:child_process');
const dir = mkdtempSync(join(tmpdir(), 'panel-lifecycle-'));
try {
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(dir, 'current'), 'dir');
  const cli = spawn(process.execPath, [join(dir, 'current', 'server.js')], { env: { ...env, SYMBOLS: '!', LOG_LEVEL: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const timeout = setTimeout(() => cli.kill('SIGKILL'), 5000);
  cli.stdout.on('data', data => {
    output += data;
    if (output.includes('Market panel on')) cli.kill('SIGTERM');
  });
  const code = await new Promise((resolve, reject) => { cli.once('exit', resolve); cli.once('error', reject); });
  clearTimeout(timeout);
  assert.ok(output.includes('Market panel on'), 'symlink CLI must listen');
  assert.equal(code, 0, 'SIGTERM must shut the direct CLI down cleanly');
  console.log('PASS symlinked release CLI startup and shutdown');
} finally { rmSync(dir, { recursive: true, force: true }); }
