#!/usr/bin/env node
/* eslint-disable no-console */

const { execSync } = require('node:child_process');

function sh(cmd) {
  return execSync(cmd, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trimEnd();
}

function resolveDiffRange() {
  const againstMain = sh('git diff --name-only origin/main...HEAD || true');
  if (againstMain.trim()) return 'origin/main...HEAD';
  try {
    sh('git rev-parse --verify HEAD^');
    return 'HEAD^..HEAD';
  } catch (_err) {
    return '';
  }
}

function listChangedFiles(range) {
  if (!range) return [];
  return sh(`git diff --name-only ${range} || true`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function diffAddedLines(range, filePath) {
  if (!range) return [];
  return sh(`git diff --unified=0 ${range} -- ${filePath} || true`)
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
}

function isTargetBoundaryFile(filePath) {
  return (
    filePath === 'src/server.js' ||
    filePath === 'src/auroraBff/routes.js' ||
    filePath.startsWith('src/auroraBff/routes/')
  );
}

function isForbiddenBusinessAddition(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  return (
    /^(async\s+)?function\s+[A-Za-z0-9_]+/.test(trimmed) ||
    /^const\s+[A-Za-z0-9_]+\s*=\s*(async\s*)?\([^)]*\)\s*=>/.test(trimmed) ||
    /^const\s+[A-Za-z0-9_]+\s*=\s*function\b/.test(trimmed) ||
    /^class\s+[A-Za-z0-9_]+/.test(trimmed)
  );
}

function main() {
  const range = resolveDiffRange();
  if (!range) {
    console.log('BOUNDARY_OK range=none checked=0');
    return;
  }

  const changed = listChangedFiles(range).filter(isTargetBoundaryFile);
  const violations = [];
  for (const filePath of changed) {
    const addedLines = diffAddedLines(range, filePath);
    for (const line of addedLines) {
      if (isForbiddenBusinessAddition(line)) {
        violations.push({ file: filePath, line: line.trim() });
      }
    }
  }

  if (violations.length) {
    console.error('[FAIL] commerce-core boundary freeze violated.');
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.line}`);
    }
    process.exit(1);
  }

  console.log(`BOUNDARY_OK range=${range} checked=${changed.length}`);
}

main();
