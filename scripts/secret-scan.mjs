import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './files.mjs';

// Findings contain only file/line/rule, never source snippets or secret values.
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider-token', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{28,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
  ['signed-token', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ['embedded-credential', /(?:password|passwd|api[_-]?key|access[_-]?token|token|secret|relay[_-]?token|stats[_-]?token)\s*[:=]\s*['"][A-Za-z0-9+/_=-]{28,}['"]/i],
];
function entropy(value) {
  const counts = new Map(); for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => { const p = count / value.length; return sum - p * Math.log2(p); }, 0);
}
export function scanText(text) {
  const result = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const [rule, pattern] of rules) if (pattern.test(line)) result.push({ line: index + 1, rule });
    if (!/\"integrity\"\s*:/.test(line)) for (const match of line.matchAll(/['\"]([A-Za-z0-9+/_=-]{40,})['\"]/g)) {
      if (entropy(match[1]) >= 4.5) { result.push({ line: index + 1, rule: 'high-entropy-literal' }); break; }
    }
  }
  return result;
}
export function scanTree(root) {
  return sourceFiles(root).flatMap(file => {
    if (!/\.(?:[cm]?js|json|html|css|md|sh|py|service|timer|conf|txt|toml|ya?ml)$/.test(file)) return [];
    return scanText(fs.readFileSync(path.join(root, file), 'utf8')).map(finding => ({ file, ...finding }));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanTree(path.resolve(process.argv[2] || '.'));
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
  console.log(`Secret scan: ${findings.length} findings (values suppressed)`);
  process.exitCode = findings.length ? 1 : 0;
}
