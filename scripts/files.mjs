import fs from 'node:fs';
import path from 'node:path';
export const ignoredDirectories = new Set(['.git', '.verification', 'node_modules', 'coverage', 'test-results', 'playwright-report', 'dist', 'archive', '.devdeps', '__pycache__', 'work', 'outputs']);
export function sourceFiles(root, directory = '') {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(directory, entry.name);
    if (!directory && entry.name === 'release-manifest.json') return [];
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : sourceFiles(root, relative);
    return entry.isFile() ? [relative] : [];
  }).sort();
}
