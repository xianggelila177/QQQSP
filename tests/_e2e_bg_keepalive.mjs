// Compatibility entry point: real Chromium with a SIMULATED visibility/throttling
// model. It does not prove actual OS background execution or contact production.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/e2e.mjs', import.meta.url)), '--grep', 'simulated background'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
