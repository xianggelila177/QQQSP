import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Whitelist, not blacklist: new production variables cannot become test inputs.
export function createTestSandbox(root, source = process.env) {
  const directory = mkdtempSync(path.join(tmpdir(), 'qqqsp-test-'));
  const tempDirectory = path.join(directory, 'tmp');
  mkdirSync(tempDirectory, { mode: 0o700 });
  const env = {
    PATH: [path.dirname(process.execPath), source.PATH || '/usr/bin:/bin'].join(path.delimiter),
    TMPDIR: tempDirectory, TMP: tempDirectory, TEMP: tempDirectory,
    LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test', NO_COLOR: '1',
    PANEL: root, PANEL_TEST_AUTOSTART: '1', PORT: '0',
    LOG_FILE: path.join(directory, 'panel.log'),
    QQQ_RELAY_LOG: path.join(directory, 'relay.log'),
  };
  return { path: directory, env, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
