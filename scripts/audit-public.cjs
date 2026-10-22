'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the intended source files before running the public-source audit.');
const blockedPaths = /(^|\/)(?:\.local|\.runtime|node_modules|msal-cache\.json|secrets\.json|gateway-key\.txt|upstream-key\.txt)(\/|$)/;
const patterns = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
  ['credential in URL', /https?:\/\/[^/\s:@]+:[^/\s@]+@/],
  ['personal Windows path', /[A-Za-z]:[\\/]Users[\\/][^<>\\/\s]+[\\/]/],
];
const failures = [];
for (const file of files) {
  if (blockedPaths.test(file)) { failures.push(file + ': private/generated path'); continue; }
  const text = execFileSync('git', ['show', ':' + file], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  for (const [kind, pattern] of patterns) if (pattern.test(text)) failures.push(file + ': ' + kind);
  if (file === 'package-lock.json') {
    const lock = JSON.parse(text);
    for (const entry of Object.values(lock.packages ?? {})) {
      if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
        failures.push(file + ': non-public-registry dependency URL');
      }
    }
  }
}
if (failures.length) {
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else console.log('Public-source audit passed for ' + files.length + ' tracked files. Review the diff before publishing.');
