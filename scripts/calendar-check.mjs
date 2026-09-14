import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearStage, recordStage } from './gate-state.mjs';
export async function checkCalendar(root, now = Date.now()) {
  const { calendarCoverageStatus } = await import(pathToFileURL(path.join(root, 'mkt.mjs')).href);
  const status = calendarCoverageStatus(now, 90);
  if (!status.ok) throw new Error('Calendar coverage does not extend 90 days for every market: ' + JSON.stringify(status));
  return status;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    if (process.argv.includes('--record')) clearStage(root, 'calendar');
    const status = await checkCalendar(root);
    if (process.argv.includes('--record')) recordStage(root, 'calendar', { status });
    console.log('Calendar coverage passed: ' + JSON.stringify(status));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
