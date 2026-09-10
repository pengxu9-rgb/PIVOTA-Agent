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

// Generous next to today's 1.3MB, but see the ENOBUFS branch in checkJs: the point is to
// FAIL on truncation, not to hope the limit is high enough.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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
      { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
    );
    return '';
  } catch (err) {
    // ENOBUFS is the one failure that would read as SUCCESS here: execFileSync throws,
    // err.stdout is truncated, the filter finds nothing, and the assertion passes. It is
    // not a random slice either — tsc groups diagnostics by path, and src/server.js sorts
    // near the END of the output, so a truncation eats exactly the lines this guard looks
    // for. Refuse to interpret a truncated read at all.
    if (err && (err.code === 'ENOBUFS' || err.code === 'ETIMEDOUT')) {
      throw new Error(
        `the type checker's output was truncated (${err.code}); this guard cannot tell a clean ` +
          `file from a cut-off one, so it is failing rather than reporting green`,
      );
    }
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
    // `startsWith(filePrefix)` alone would also admit a hypothetical src/server.jsx.
    // tsc's format is `<path>(<line>,<col>): error …`, so require the paren.
    .filter((line) => line.startsWith(`${filePrefix}(`));
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

    // tsc relativizes every diagnostic path to its cwd, so a bare filename with cwd set
    // to the scratch dir comes back spelled 'probe.js'. Deliberately the SAME invocation
    // form as the real assertion below — relative path argument, matched on that same
    // relative spelling — so this control exercises the dimension that could make the
    // assertion inert, rather than a differently-shaped call that happens to work.
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
  const relative = path.join('src', 'server.js');
  assert.equal(fs.existsSync(path.join(repoRoot, relative)), true);

  // A RELATIVE argument, not an absolute one. tsc relativizes diagnostics to cwd, and if
  // cwd is reached through a symlink an absolute argument comes back spelled '../<link>/…'
  // — which this filter would drop, passing the test vacuously. A relative argument is
  // spelled 'src/server.js' either way. Node realpaths __dirname so repoRoot is already
  // resolved today, but that is a property of the loader, not of this assertion.
  const found = unresolvedNamesIn(checkJs(relative), relative);
  assert.deepEqual(
    found,
    [],
    'src/server.js references a name that is not in scope — at runtime that is a ReferenceError',
  );
});
