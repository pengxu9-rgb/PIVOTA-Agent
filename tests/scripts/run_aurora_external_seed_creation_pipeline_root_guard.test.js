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
});
