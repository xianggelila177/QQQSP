import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createTestSandbox } from '../tests/support/isolation.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const sandbox = createTestSandbox(root);
try {
  sandbox.env.PANEL_TEST_AUTOSTART = '0';
  sandbox.env.NODE_OPTIONS = '--import=' + pathToFileURL(path.join(root, 'tests/support/no-network.mjs')).href;
  if (process.env.QQQSP_COVERAGE_DIR) sandbox.env.NODE_V8_COVERAGE = path.resolve(process.env.QQQSP_COVERAGE_DIR);
  if (process.env.QQQSP_COVERAGE_DIR) sandbox.env.QQQSP_COVERAGE_DIR = path.resolve(process.env.QQQSP_COVERAGE_DIR);
  // Browser location is discovery/configuration, never a machine-specific executable.
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) sandbox.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH);
  const report = path.join(root, 'test-results', 'results.json');
  fs.rmSync(report, { force: true });
  const result = spawnSync(process.execPath, [cli, 'test', ...process.argv.slice(2)], { cwd: root, env: sandbox.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  const stats = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')).stats : null;
  if (!stats || stats.expected < 1 || stats.skipped > 0 || stats.unexpected > 0 || stats.flaky > 0) { console.error('Browser acceptance incomplete: missing, skipped, failed or flaky tests.'); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
} finally { sandbox.cleanup(); }
