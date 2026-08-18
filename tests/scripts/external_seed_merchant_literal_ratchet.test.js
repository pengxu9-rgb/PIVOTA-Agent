// ADR-009 — ratchet on sentinel-MERCHANT literals (founder directive,
// 2026-08-06: "we have experienced so many trouble due to hardcode").
//
// The defect class: code that branches, joins, or filters on the merchant
// identity `external_seed`. Every such literal encodes "the world has one
// shared seller" and goes silently blind (or silently wrong) as rows migrate
// to their observed sellers — dead prunes, skipped PDP hydration, lost
// identity joins, duplicate inserts were all this one class. The fix pattern
// is always derive-from-the-row or key-on-what-survives-migration; see
// docs and pdpIdentityGraph.js:4960 for the model.
//
// This test is a SHRINK-ONLY ratchet against a checked-in baseline:
//   - a file may not GAIN matches, and new files must have zero;
//   - when your change removes matches, lower the baseline in the same PR
//     (regenerate: node tests/scripts/external_seed_merchant_literal_ratchet.test.js --regen);
//   - if you believe a new literal is genuinely required, that is an ADR-009
//     conversation, not a routine edit — the allowed shapes are a documented
//     COALESCE(<row value>, sentinel) fallback or the legacy-bucket branch of
//     a serving predicate, and both already exist.
//
// platform='external_seed' and source_system literals are deliberately NOT
// matched: those name the lane, not the seller, and stay valid after the
// re-key retires the merchant bucket.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../..');
const ROOTS = ['src', 'scripts', 'mcp-server/src'];
const BASELINE_PATH = path.join(REPO_ROOT, 'tests/fixtures/external_seed_merchant_literal_baseline.json');

const PATTERNS = [
  /merchant_id\s*[=:]\s*['"]external_seed['"]/g,
  /merchant_id\s*(?:==|!=|===|!==)\s*['"]external_seed['"]/g,
  /(?:===|!==|==|!=)\s*EXTERNAL_SEED_MERCHANT_ID\b/g,
  /\bEXTERNAL_SEED_MERCHANT_ID\s*(?:===|!==|==|!=)/g,
  /merchantId:\s*EXTERNAL_SEED_MERCHANT_ID\b/g,
  // ADR-009 WRITER side. Everything above this line watches code that COMPARES
  // against the sentinel seller — readers. None of them can see the sentinel
  // being BORN: a snake_case object-literal mint spelled with the constant
  // matched no pattern at all, which is why the two files that mint it for the
  // seed lane were not even in the baseline. Reaching zero on a reader-only
  // ratchet would not have meant the sentinel stopped being produced. This
  // pattern closes that blind spot; the camelCase twin two lines up already
  // watched the same shape under the other spelling.
  /merchant_id:\s*EXTERNAL_SEED_MERCHANT_ID\b/g,
  // ADR-009 follow-on: the re-key moved seed supply onto `merch_obs_` sellers,
  // so a hardcoded observed-seller PREFIX is the same defect class in its next
  // costume — and nothing above matches it. Review 2026-08-17 caught the
  // convergence work itself introducing a second copy of one. Watched now, so
  // the next re-key cannot silently blind these readers.
  /startsWith\(\s*['"]merch_obs_['"]\s*\)/g,
];

function countFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let n = 0;
  for (const pattern of PATTERNS) {
    const matches = text.match(pattern);
    n += matches ? matches.length : 0;
  }
  return n;
}

function scan() {
  const counts = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(js|cjs|mjs|ts)$/.test(entry.name)) {
        const n = countFile(full);
        if (n > 0) counts[path.relative(REPO_ROOT, full)] = n;
      }
    }
  };
  for (const root of ROOTS) {
    const full = path.join(REPO_ROOT, root);
    if (fs.existsSync(full)) walk(full);
  }
  return counts;
}

if (require.main === module && process.argv.includes('--regen')) {
  const counts = scan();
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 1)}\n`);
  console.log(`baseline regenerated: ${Object.keys(counts).length} files, ${Object.values(counts).reduce((a, b) => a + b, 0)} matches`);
} else if (typeof describe === 'function') {
  describe('external_seed merchant-literal ratchet', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const current = scan();

    test('no file gains sentinel-merchant literals, and new files have none', () => {
      const regressions = [];
      for (const [file, count] of Object.entries(current)) {
        const allowed = baseline[file] || 0;
        if (count > allowed) {
          regressions.push(`${file}: ${count} matches (baseline ${allowed})`);
        }
      }
      expect(regressions).toEqual([]);
    });

    test('the baseline ratchets down: shrunken files are reflected in the same PR', () => {
      const stale = [];
      for (const [file, allowed] of Object.entries(baseline)) {
        const count = current[file] || 0;
        if (count < allowed) stale.push(`${file}: baseline ${allowed} but only ${count} remain — lower it`);
      }
      expect(stale).toEqual([]);
    });

    test('the ratchet itself still bites (a synthetic literal is counted)', () => {
      // Guard-of-the-guard: if the patterns rot, both tests above pass forever
      // on empty scans. This proves a canonical offending line still matches.
      const synthetic = "WHERE cp.merchant_id = 'external_seed' AND x !== EXTERNAL_SEED_MERCHANT_ID";
      let n = 0;
      for (const pattern of PATTERNS) {
        const matches = synthetic.match(pattern);
        n += matches ? matches.length : 0;
      }
      expect(n).toBeGreaterThanOrEqual(2);
    });

    test('the ratchet bites on a WRITE, not just a comparison', () => {
      // Guard-of-the-guard for the writer pattern specifically. Asserted apart
      // from the reader synthetic above because that one already scores >= 2
      // from the reader patterns alone: folding a mint into it would let the
      // writer pattern rot away with the combined test still green.
      const mint = '  merchant_id: EXTERNAL_SEED_MERCHANT_ID,';
      const countMatches = (text) =>
        PATTERNS.reduce((total, pattern) => total + (text.match(pattern)?.length || 0), 0);

      expect(countMatches(mint)).toBe(1);

      // CONTROL: the seller axis is what is watched, not the word. The sourcing
      // axes travel beside the mint on the very same objects and must stay
      // invisible to the ratchet, or every honest lane label reads as a defect.
      expect(countMatches("  source: 'external_seed',")).toBe(0);
      expect(countMatches("  platform: 'external_seed',")).toBe(0);
      expect(countMatches("  source_system: 'external_product_seeds_mirror_v1',")).toBe(0);
    });
  });
}
