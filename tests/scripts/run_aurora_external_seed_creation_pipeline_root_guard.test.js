const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  checkCorrectionRootHasMainListFreeze,
  resolveCorrectionRoot,
} = require('../../scripts/run_aurora_external_seed_creation_pipeline.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'run_aurora_external_seed_creation_pipeline.cjs');

// A checkout from before the freeze: same files, unguarded canonicalize call.
function writeStaleCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-gw-checkout-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('src/services/externalSeedProducts.js', 'module.exports = {\n  canonicalizeExternalSeedSnapshot,\n};\n');
  write(
    'src/services/externalSeedCorrection.js',
    "nextRow.seed_data = canonicalizeExternalSeedSnapshot(nextRow.seed_data, nextRow, { stripLegacy: false });\n",
  );
  write('scripts/backfill-external-product-seeds-catalog.js', 'const persistedSnapshotVariants = [];\n');
  write('scripts/correct-external-product-seeds.js', '');
  return root;
}

describe('seed creation pipeline: correction root guard', () => {
  test('--pivota-agent-root has no default', () => {
    expect(parseArgs([]).pivotaAgentRoot).toBe('');
  });

  test('--run-correction without --pivota-agent-root is refused', () => {
    expect(() => resolveCorrectionRoot(parseArgs(['--run-correction']), REPO_ROOT)).toThrow(
      /--run-correction requires --pivota-agent-root/,
    );
  });

  test('--run-correction against a checkout without the freeze is refused', () => {
    const stale = writeStaleCheckout();
    expect(checkCorrectionRootHasMainListFreeze(stale).ok).toBe(false);
    expect(() =>
      resolveCorrectionRoot(parseArgs(['--run-correction', '--pivota-agent-root', stale]), REPO_ROOT),
    ).toThrow(/lacks the seed main-list freeze/);
  });

  test('--run-correction against this checkout (which has the freeze) is allowed', () => {
    expect(checkCorrectionRootHasMainListFreeze(REPO_ROOT)).toEqual({ ok: true, missing: [] });
    expect(resolveCorrectionRoot(parseArgs(['--run-correction', '--pivota-agent-root', REPO_ROOT]), REPO_ROOT)).toBe(
      REPO_ROOT,
    );
  });

  test('without --run-correction the plans resolve to the current repo, not a hard-coded checkout', () => {
    expect(resolveCorrectionRoot(parseArgs([]), REPO_ROOT)).toBe(REPO_ROOT);
  });

  test('the CLI exits non-zero before applying anything when the root is stale', () => {
    const stale = writeStaleCheckout();
    const manifest = path.join(stale, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ items: [] }));
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--manifest', manifest, '--run-correction', '--pivota-agent-root', stale],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lacks the seed main-list freeze/);
    expect(result.stdout).toBe('');
  });

  describe('each freeze marker is required on its own', () => {
    const MARKER_FILES = [
      ['src/services/externalSeedProducts.js', 'canonicalizeExternalSeedSnapshotForPersistence,', 'canonicalizeExternalSeedSnapshot,'],
      ['src/services/externalSeedCorrection.js', 'nextRow.seed_data = canonicalizeExternalSeedSnapshotForPersistence(', 'nextRow.seed_data = canonicalizeExternalSeedSnapshot('],
      ['scripts/backfill-external-product-seeds-catalog.js', 'const freshMainListVariants =', 'const unusedMainListVariants ='],
    ];

    // A copy of this checkout's three marker files, with one marker removed.
    function writeCheckoutMissing(brokenFile) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-marker-checkout-'));
      for (const [rel, marker, replacement] of MARKER_FILES) {
        let body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        expect(body.includes(marker)).toBe(true);
        if (rel === brokenFile) body = body.split(marker).join(replacement);
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
      }
      return root;
    }

    test('an intact copy of the three files passes', () => {
      expect(checkCorrectionRootHasMainListFreeze(writeCheckoutMissing(null))).toEqual({ ok: true, missing: [] });
    });

    test.each(MARKER_FILES.map(([rel]) => [rel]))('missing only the marker in %s is refused', (rel) => {
      const check = checkCorrectionRootHasMainListFreeze(writeCheckoutMissing(rel));
      expect(check.ok).toBe(false);
      expect(check.missing).toHaveLength(1);
      expect(check.missing[0]).toMatch(new RegExp(`^${rel.replace(/[.]/g, '\\.')}:`));
    });

    test('a root that does not exist is refused', () => {
      const missingRoot = path.join(os.tmpdir(), `gw-no-such-checkout-${process.pid}-${Date.now()}`);
      expect(checkCorrectionRootHasMainListFreeze(missingRoot).ok).toBe(false);
      expect(() =>
        resolveCorrectionRoot(parseArgs(['--run-correction', '--pivota-agent-root', missingRoot]), REPO_ROOT),
      ).toThrow(/lacks the seed main-list freeze/);
    });

    const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    (runningAsRoot ? test.skip : test)('an unreadable marker file is refused (fails closed)', () => {
      const root = writeCheckoutMissing(null);
      const target = path.join(root, 'src/services/externalSeedCorrection.js');
      fs.chmodSync(target, 0o000);
      try {
        const check = checkCorrectionRootHasMainListFreeze(root);
        expect(check.ok).toBe(false);
        expect(check.missing).toEqual([expect.stringMatching(/^src\/services\/externalSeedCorrection\.js:/)]);
      } finally {
        fs.chmodSync(target, 0o644);
      }
    });
  });
});
