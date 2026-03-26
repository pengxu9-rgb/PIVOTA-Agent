const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function collectJsFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
      continue;
    }
    if (/\.(js|cjs|mjs|ts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function findForbiddenImports(rootDir, forbiddenPattern) {
  const violations = [];
  for (const filePath of collectJsFiles(rootDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!forbiddenPattern.test(lines[index])) continue;
      violations.push(`${path.relative(rootDir, filePath)}:${index + 1}`);
    }
  }
  return violations;
}

const repoRoot = path.join(__dirname, '..');
const auroraRoot = path.join(repoRoot, 'src', 'auroraBff');
const lookReplicatorRoot = path.join(repoRoot, 'src', 'lookReplicator');

test('auroraBff does not directly import lookReplicator modules', () => {
  const violations = findForbiddenImports(auroraRoot, /\.\.\/lookReplicator\//);
  assert.deepEqual(violations, []);
});

test('lookReplicator does not directly import auroraBff modules', () => {
  const violations = findForbiddenImports(lookReplicatorRoot, /\.\.\/auroraBff\//);
  assert.deepEqual(violations, []);
});
