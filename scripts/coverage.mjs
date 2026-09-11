import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import v8ToIstanbul from 'v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { sourceFiles } from './files.mjs';
import { snapshotSources, assertSameSources, clearStage, recordStage } from './gate-state.mjs';
import { createTestSandbox } from '../tests/support/isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'coverage');
const nativeDirectory = path.join(directory, 'native');
const browserDirectory = path.join(directory, 'browser');
export function maintainedFiles(base) {
  return sourceFiles(base).filter(file => file !== 'public/panel.bundle.js' && /\.[cm]?js$/.test(file) && (['server.js', 'mkt.mjs', 'sent.mjs', 'log.mjs'].includes(file) || file.startsWith('lib/') || file.startsWith('public/')));
}
export const CRITICAL_FILES = ['lib/http-admission.js', 'lib/quote-contract.js', 'lib/recovery-store.js', 'public/modules/panel-market-store.js'];
export function coverageFailures(summary, sections, critical) {
  const failures = [];
  for (const [name, result] of [['overall', summary], ['backend', sections.backend], ['browser', sections.browser], ...CRITICAL_FILES.map(file => [file, critical[file]])]) {
    for (const key of ['lines', 'functions', 'branches']) if (!result || !Number.isFinite(result[key]?.pct) || result[key].pct < 80) failures.push(`${name}.${key}`);
  }
  return failures;
}
export async function mergeCoverage(base, output) {
  const expected = JSON.parse(fs.readFileSync(path.join(output, 'sources.json'), 'utf8'));
  assertSameSources(base, expected);
  const files = maintainedFiles(base);
  const allowed = new Set(files.map(file => path.join(base, file)));
  const map = libCoverage.createCoverageMap({});
  const visited = new Set();
  async function add(file, functions, source) {
    if (!allowed.has(file)) return;
    const converter = v8ToIstanbul(file, 0, { source: source || fs.readFileSync(file, 'utf8') });
    await converter.load(); converter.applyCoverage(functions); map.merge(converter.toIstanbul()); visited.add(file);
  }
  const native = path.join(output, 'native');
  for (const file of fs.existsSync(native) ? fs.readdirSync(native).filter(name => name.endsWith('.json')) : []) {
    const coverage = JSON.parse(fs.readFileSync(path.join(native, file), 'utf8'));
    for (const entry of coverage.result || []) {
      let resolved;
      try { resolved = entry.url.startsWith('file:') ? fileURLToPath(entry.url) : path.isAbsolute(entry.url) ? entry.url : null; } catch { continue; }
      if (resolved && allowed.has(resolved)) {
        if(coverage['source-map-cache']?.[entry.url]?.data) throw new Error('Transformed maintained Node source cannot use raw offsets: '+resolved+'; keep production ESM external in Playwright build config');
        await add(resolved, entry.functions);
      }
    }
  }
  const browser = path.join(output, 'browser');
  for (const file of fs.existsSync(browser) ? fs.readdirSync(browser).filter(name => name.endsWith('.json')) : []) {
    const coverage = JSON.parse(fs.readFileSync(path.join(browser, file), 'utf8'));
    for (const entry of coverage) {
      let url; try { url = new URL(entry.url); } catch { continue; }
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) continue;
      if (url.pathname === '/panel.bundle.js') {
        const layout = JSON.parse(fs.readFileSync(path.join(base, 'public/panel.bundle.layout.json'), 'utf8'));
        for (const segment of layout.files) {
          const file = path.resolve(base, segment.path), source = fs.readFileSync(file, 'utf8');
          if (!allowed.has(file) || entry.source.slice(segment.startOffset, segment.endOffset) !== source) throw new Error('Bundle coverage layout/source mismatch: ' + segment.path);
          const functions = entry.functions.flatMap(fn => {
            const ranges = fn.ranges.flatMap(range => {
              const start = Math.max(range.startOffset, segment.startOffset), end = Math.min(range.endOffset, segment.endOffset);
              return start < end ? [{ ...range, startOffset: start - segment.startOffset, endOffset: end - segment.startOffset }] : [];
            });
            return ranges.length ? [{ ...fn, ranges }] : [];
          });
          await add(file, functions, source);
        }
      } else await add(path.resolve(base, 'public', url.pathname.replace(/^\//, '')), entry.functions, entry.source);
    }
  }
  // Include every maintained application source. Unexecuted files get zero-hit
  // source ranges and remain visible in both the report and its denominator.
  const unexecutedFiles = files.filter(file => !visited.has(path.join(base, file)));
  for (const file of allowed) if (!visited.has(file)) {
    const source = fs.readFileSync(file, 'utf8');
    await add(file, [{ functionName: '(unexecuted)', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }], source);
  }
  const context = libReport.createContext({ dir: output, coverageMap: map });
  for (const type of ['text', 'html', 'json', 'json-summary', 'lcovonly']) reports.create(type).execute(context);
  const summary = map.getCoverageSummary().toJSON();
  const sections = {};
  for (const [name, predicate] of [['backend', file => !file.startsWith('public/')], ['browser', file => file.startsWith('public/')]]) {
    const subset = libCoverage.createCoverageMap({});
    for (const file of files.filter(predicate)) subset.addFileCoverage(map.fileCoverageFor(path.join(base, file)));
    sections[name] = subset.getCoverageSummary().toJSON();
  }
  const critical = Object.fromEntries(CRITICAL_FILES.map(file => [file, map.files().includes(path.join(base, file)) ? map.fileCoverageFor(path.join(base, file)).toSummary().toJSON() : null]));
  const detail = { scope: files, summary, sections, critical, threshold: 80, failed: coverageFailures(summary, sections, critical), unexecutedFiles };
  fs.writeFileSync(path.join(output, 'gate.json'), JSON.stringify(detail, null, 2) + '\n');
  console.log('Coverage scope: ' + files.length + ' maintained application files; backend + real Chromium V8 coverage.');
  console.log(JSON.stringify({ summary, sections, critical, failed: detail.failed }, null, 2));
  return detail;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = false;
  const recording = process.argv.includes('--record');
  if (recording) for (const stage of ['deterministic', 'browser', 'coverage']) clearStage(root, stage);
  if (!process.argv.includes('--report-only')) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(nativeDirectory, { recursive: true }); fs.mkdirSync(browserDirectory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'sources.json'), JSON.stringify(snapshotSources(root), null, 2) + '\n');
    for (const script of ['tests/_run_all.mjs', 'scripts/e2e.mjs']) {
      const sandbox = createTestSandbox(root);
      try {
        sandbox.env.QQQSP_COVERAGE_DIR = nativeDirectory;
        if (process.env.PLAYWRIGHT_BROWSERS_PATH) sandbox.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH);
        const result = spawnSync(process.execPath, [script], { cwd: root, env: sandbox.env, stdio: 'inherit' });
        if (result.error || result.status !== 0) failed = true;
        else if (recording) recordStage(root, script.startsWith('tests/') ? 'deterministic' : 'browser', { command: script });
      } finally { sandbox.cleanup(); }
    }
  }
  try {
    const result = await mergeCoverage(root, directory);
    result.testsPassed = !failed && !process.argv.includes('--report-only');
    if (process.argv.includes('--report-only')) result.testsPassed = false;
    fs.writeFileSync(path.join(directory, 'gate.json'), JSON.stringify(result, null, 2) + '\n');
    if (recording && result.testsPassed && !result.failed.length) recordStage(root, 'coverage', { testsPassed: true, failed: result.failed, summary: result.summary, sections: result.sections, critical: result.critical });
    process.exitCode = failed || result.failed.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
