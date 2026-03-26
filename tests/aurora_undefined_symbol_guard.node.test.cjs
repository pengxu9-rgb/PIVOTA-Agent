const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tscEntrypoint = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
const guardedFiles = [
  path.join(repoRoot, 'src', 'auroraBff', 'routes.js'),
  path.join(repoRoot, 'src', 'auroraBff', 'skinLlmGateway.js'),
  path.join(repoRoot, 'src', 'server.js'),
];

test('aurora undefined symbol guard: high-risk js entrypoints have no unresolved names', () => {
  assert.equal(fs.existsSync(tscEntrypoint), true, 'typescript compiler entrypoint must exist');

  let output = '';
  try {
    execFileSync(
      process.execPath,
      [
        tscEntrypoint,
        '--allowJs',
        '--checkJs',
        '--noEmit',
        '--pretty',
        'false',
        '--skipLibCheck',
        '--target',
        'es2022',
        ...guardedFiles,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (err) {
    output = `${err.stdout || ''}\n${err.stderr || ''}`;
  }

  const relevant = String(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /TS2552|TS2304|Cannot find name/.test(line));

  assert.deepEqual(relevant, []);
});
