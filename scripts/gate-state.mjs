import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './files.mjs';

export const REQUIRED_STAGES = ['syntax', 'calendar', 'deterministic', 'browser', 'coverage', 'linux'];
export const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = root => path.join(root, '.verification');
export function snapshotSources(root) {
  return sourceFiles(root).filter(file => file === 'VERSION' || /\.(?:[cm]?js|json|html|css|svg|webmanifest|sh|py|md|service|timer|conf)$/.test(file) || /^tests\/fixtures\/[A-Za-z0-9_-]+\.xml$/.test(file)).map(file => ({
    path: file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
  }));
}
export function assertSameSources(root, expected) {
  if (JSON.stringify(snapshotSources(root)) !== JSON.stringify(expected)) throw new Error('Source changed during or after verification; run the full release gate again on a stable checkout.');
}
function write(root, evidence) {
  fs.mkdirSync(directory(root), { recursive: true });
  const target = path.join(directory(root), 'stages.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(evidence, null, 2) + '\n');
  fs.renameSync(target + '.tmp', target);
  return evidence;
}
export function beginVerification(root, { synthetic = false, now = Date.now() } = {}) {
  const sources = snapshotSources(root);
  fs.mkdirSync(directory(root), { recursive: true });
  fs.writeFileSync(path.join(directory(root), 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
  return write(root, { format: 2, runId: randomUUID(), sourceDigest: digest(sources), startedAt: now, synthetic, stages: {} });
}
export function readEvidence(root, { now = Date.now(), allowSynthetic = false } = {}) {
  const sources = JSON.parse(fs.readFileSync(path.join(directory(root), 'sources.json'), 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(path.join(directory(root), 'stages.json'), 'utf8'));
  assertSameSources(root, sources);
  if (evidence.format !== 2 || evidence.sourceDigest !== digest(sources) || !evidence.runId || !evidence.stages) throw new Error('Invalid verification evidence');
  if (evidence.synthetic && !allowSynthetic) throw new Error('Synthetic fixture evidence cannot authorize a production release');
  if (!Number.isFinite(evidence.startedAt) || now < evidence.startedAt || now - evidence.startedAt > MAX_EVIDENCE_AGE_MS) throw new Error('Verification evidence expired; run the full release gate again');
  return { sources, evidence };
}
export function clearStage(root, stage) {
  const { evidence } = readEvidence(root, { allowSynthetic: true });
  delete evidence.stages[stage]; write(root, evidence);
}
export function recordStage(root, stage, details = {}, { synthetic = false } = {}) {
  if (!REQUIRED_STAGES.includes(stage)) throw new Error(`Unknown verification stage: ${stage}`);
  const { evidence } = readEvidence(root, { allowSynthetic: synthetic });
  if (stage === 'linux' && !synthetic && (process.platform !== 'linux' || details.nativeSystemd !== true)) throw new Error('Linux stage requires successful native systemd validation on Linux');
  const at = Date.now();
  evidence.stages[stage] = { ...details, passed: true, runId: evidence.runId, sourceDigest: evidence.sourceDigest, at, platform: process.platform, node: process.version, synthetic };
  return write(root, evidence);
}
export function requireCompleteVerification(root, options = {}) {
  const { sources, evidence } = readEvidence(root, options);
  for (const stage of REQUIRED_STAGES) {
    const result = evidence.stages[stage];
    if (!result || result.passed !== true || result.runId !== evidence.runId || result.sourceDigest !== evidence.sourceDigest || !Number.isFinite(result.at) || result.at < evidence.startedAt || result.at > (options.now ?? Date.now())) throw new Error(`Full release gate requires current ${stage} evidence`);
    if (result.synthetic && !options.allowSynthetic) throw new Error('Synthetic stage cannot authorize a production release');
    if (stage === 'linux' && !options.allowSynthetic && (result.platform !== 'linux' || result.nativeSystemd !== true)) throw new Error('Native Linux service validation required');
  }
  const coverage = evidence.stages.coverage;
  if (!Array.isArray(coverage.failed) || coverage.failed.length || coverage.testsPassed !== true) throw new Error('Complete passing coverage evidence required');
  return { sources, evidence };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (process.argv.includes('--begin')) console.log(JSON.stringify(beginVerification(root)));
    else console.log(JSON.stringify(requireCompleteVerification(root).evidence, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
