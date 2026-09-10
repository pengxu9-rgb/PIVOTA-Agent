// src/server.js must contain no unresolved names.
//
// WHY THIS EXISTS AS ITS OWN FILE. tests/aurora_undefined_symbol_guard.node.test.cjs
// already checks this property, but over three entrypoints at once, so it also inherits
// every unresolved name reachable through their imports — today 7 of them, in
// src/auroraBff/ and src/services/categories.js. That suite is therefore red on main and
// quarantined, which means it cannot gate anything. A guard that is red for reasons
// unrelated to your change is a guard nobody can act on.
//
// So this file asserts the same property narrowed to src/server.js, where it is TRUE and
// can hold. Findings in imported modules are deliberately filtered out: they belong to
// their own owners, and inheriting them here would reproduce exactly the situation that
// made the broader guard unusable.
//
// The defect it was written for: `crossMerchantCacheRouteDebug` was declared with `let`
// inside the `try` that opens at src/server.js:46798, and read twice from the `catch` at
// :53113 — a SIBLING block, not a nested one. Both reads were ReferenceErrors, so the
// handler for an upstream find_products failure threw on its own way out and the throw
// landed in the outer catch, converting a reportable upstream error into a generic one
// with none of the cache diagnostics that branch exists to emit. Nothing in CI could see
// it: the only suite that checks for this had never run in any CI job.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tscEntrypoint = path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');

const UNRESOLVED_NAME = /TS2552|TS2304|Cannot find name/;

function checkJs(file, cwd = repoRoot) {
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
        file,
      ],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    return '';
  } catch (err) {
    // tsc exits non-zero when it reports anything; the diagnostics are on stdout.
    return `${err.stdout || ''}\n${err.stderr || ''}`;
  }
}

function unresolvedNamesIn(output, filePrefix) {
  return String(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => UNRESOLVED_NAME.test(line))
    .filter((line) => line.startsWith(filePrefix));
}

// THE CONTROL. The assertion below is an absence assertion, and an absence assertion
// passes just as happily when the mechanism is broken — a renamed tsc entrypoint, a flag
// tsc stopped accepting, a cwd that resolves nothing — as when the code is correct. This
// runs the same checker over a file with a deliberately undefined name and requires it to
// be reported. If this fails, the assertion below proves nothing and you should not trust
// a green run.
test('control: the checker actually reports an unresolved name', () => {
  assert.equal(fs.existsSync(tscEntrypoint), true, 'typescript compiler entrypoint must exist');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-guard-control-'));
  try {
    const probe = path.join(dir, 'probe.js');
    // Same shape as the real defect: declared inside try, read from the sibling catch.
    fs.writeFileSync(
      probe,
      ['function f() {', '  try {', '    let onlyInTry = 1;', '    return onlyInTry;', '  } catch (e) {', '    return onlyInTry;', '  }', '}', 'module.exports = { f };', ''].join('\n'),
    );

    // tsc echoes each path exactly as it was given, so pass the bare filename with cwd
    // set to the scratch dir and match on that same spelling.
    const found = unresolvedNamesIn(checkJs('probe.js', dir), 'probe.js');
    assert.ok(
      found.length > 0,
      'the checker did not report a name that is definitely unresolved — the guard below is inert',
    );
    assert.match(found.join('\n'), /onlyInTry/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('src/server.js has no unresolved names', () => {
  const serverJs = path.join(repoRoot, 'src', 'server.js');
  assert.equal(fs.existsSync(serverJs), true);

  const found = unresolvedNamesIn(checkJs(serverJs), 'src/server.js');
  assert.deepEqual(
    found,
    [],
    'src/server.js references a name that is not in scope — at runtime that is a ReferenceError',
  );
});
