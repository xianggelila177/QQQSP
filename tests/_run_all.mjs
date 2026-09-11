import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTestSandbox } from './support/isolation.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..');
const files = fs.readdirSync(dir).filter(file => /^_test_.*\.(mjs|sh)$/.test(file) && file !== '_test_log_rotate_child.mjs').sort();
const failed = [];
console.log(`Deterministic suite: ${files.length} files; real-browser acceptance: npm run test:e2e`);
for (const file of files) {
  const sandbox = createTestSandbox(root);
  try {
    sandbox.env.NODE_OPTIONS = '--import=' + pathToFileURL(path.join(dir, 'support', 'no-network.mjs')).href;
    if (process.env.QQQSP_COVERAGE_DIR) sandbox.env.NODE_V8_COVERAGE = path.resolve(process.env.QQQSP_COVERAGE_DIR);
    const result = spawnSync(file.endsWith('.sh') ? '/bin/bash' : process.execPath, [path.join(dir, file)], {
      cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      env: sandbox.env, stdio: 'pipe',
    });
    const successful = result.status === 0 && !result.error;
    console.log(`${successful ? 'PASS' : 'FAIL'} ${file}`);
    if (!successful) {
      failed.push(file);
      console.error([result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').slice(-12000));
    }
  } finally { sandbox.cleanup(); }
}
console.log(`PASS_FILES: ${files.length - failed.length}\nFAIL_FILES: ${failed.length}`);
if (failed.length) console.error('Failed: ' + failed.join(', '));
process.exitCode = failed.length ? 1 : 0;
