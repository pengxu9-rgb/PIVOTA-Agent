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

// READERS — code that COMPARES against the sentinel seller.
//
// KNOWN GAP, deliberately left open here: these name `merchant_id` in
// snake_case only, so a camelCase comparison (`merchantId === 'external_seed'`)
// is still invisible. It is a reader defect, not a mint, so closing it is
// outside this change's mandate and would move the baseline a third time; the
// control at the bottom of this file pins the gap so it stays a documented
// hole rather than a silent one.
const READER_PATTERNS = [
  /merchant_id\s*[=:]\s*['"]external_seed['"]/g,
  /merchant_id\s*(?:==|!=|===|!==)\s*['"]external_seed['"]/g,
  /(?:===|!==|==|!=)\s*EXTERNAL_SEED_MERCHANT_ID\b/g,
  /\bEXTERNAL_SEED_MERCHANT_ID\s*(?:===|!==|==|!=)/g,
  /merchantId:\s*EXTERNAL_SEED_MERCHANT_ID\b/g,
];

// WRITERS — code that MINTS the sentinel seller.
//
// No reader pattern can see the sentinel being BORN, which is why the two files
// that mint it for the seed lane were not even in the baseline. Reaching zero on
// a reader-only ratchet would not have meant the sentinel stopped being
// produced.
//
// The mint has four shapes and each needs its own pattern, because a PARTIAL
// writer guard is worse than none: it reads as "writes are watched" while
// leaving the specific line someone is about to fix invisible, so fixing that
// line and later regressing it both land green. Split out as its own array so
// the guard tests below can assert that the mint patterns did not quietly widen
// into counting comparisons — a ratchet that grows on its own is one nobody can
// lower.
//
// The plain snake_case object literal spelled as a raw string is already caught
// by the first reader pattern (its `[=:]` covers the colon), so only these four
// are new.
const WRITER_MINT_PATTERNS = [
  // 1. Object literal spelled with the CONSTANT. The camelCase twin is the last
  //    reader pattern above, which already watched this shape under the other
  //    spelling — the snake_case one simply had no counterpart.
  /merchant_id:\s*EXTERNAL_SEED_MERCHANT_ID\b/g,
  // 2. The DEFAULT mint — a real seller is looked up and the sentinel is
  //    substituted when the lookup comes back empty. This is the most costly
  //    shape and the last to be noticed, because the line reads as if it
  //    honours the row: the fabrication happens only on the rows that had no
  //    seller, which are exactly the rows a migration is trying to fix. It is
  //    also the only shape that spans lines in the wild, so it is matched
  //    against whole file text and not line by line.
  /\|\|\s*EXTERNAL_SEED_MERCHANT_ID\b/g,
  // 3. The same default written with the raw string instead of the constant.
  //    Anchored on a merchant token EARLIER ON THE SAME LINE rather than on the
  //    bare fallback, because `source`/`platform`/`source_system` defaults to
  //    the same word are SOURCING labels — honest, deliberately kept, and not
  //    this defect. The controls below pin that distinction.
  /merchant_?[Ii]d[^;\n]*\|\|\s*['"]external_seed['"]/g,
  // 4. camelCase spelled as a raw string. `[=:]` and never `==`, so this stays
  //    a mint pattern: an equality comparison is a reader and belongs above.
  /merchantId\s*[=:]\s*['"]external_seed['"]/g,
];

const PATTERNS = [
  ...READER_PATTERNS,
  ...WRITER_MINT_PATTERNS,
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

    // Guard-of-the-guard for the WRITER patterns. One test per mint shape, not
    // one test per writer pattern set: a combined synthetic scores > 0 from
    // whichever pattern still works, so any single pattern could rot away with
    // the combined test still green — the same reason the reader synthetic
    // above gets its own test. Each asserts an EXACT count, so a pattern that
    // grows to swallow another shape is caught as well as one that stops
    // matching.
    const countMatches = (text) =>
      PATTERNS.reduce((total, pattern) => total + (text.match(pattern)?.length || 0), 0);

    test('mint shape 1: object literal spelled with the constant', () => {
      expect(countMatches('  merchant_id: EXTERNAL_SEED_MERCHANT_ID,')).toBe(1);
      expect(countMatches('  merchantId: EXTERNAL_SEED_MERCHANT_ID,')).toBe(1);
    });

    test('mint shape 2: the DEFAULT mint spelled with the constant', () => {
      // The shape that made this extension necessary: it was invisible even
      // after the writer patterns landed, including at the exact site the seed
      // builders are proposed to fix next. Had it stayed invisible, fixing that
      // site and later regressing it would both have left the ratchet green.
      expect(
        countMatches('  const merchantId = normalizeNonEmptyString(item.merchant_id) || EXTERNAL_SEED_MERCHANT_ID;'),
      ).toBe(1);
      expect(countMatches('  const entryMerchantId = requestedMerchantId || EXTERNAL_SEED_MERCHANT_ID;')).toBe(1);
    });

    test('mint shape 3: the DEFAULT mint spelled as a raw string', () => {
      expect(countMatches("  merchant_id: normalizeText(product.merchant_id, 80) || 'external_seed',")).toBe(1);
      expect(countMatches("  merchant_id: item.merchant_id || 'external_seed',")).toBe(1);
    });

    test('mint shape 4: camelCase spelled as a raw string', () => {
      expect(countMatches("  merchantId: 'external_seed',")).toBe(1);
      // The snake_case twin is owned by the very first pattern, not by this
      // one. Pinned here so a future tidy-up cannot delete that pattern on the
      // belief the writer set replaced it.
      expect(countMatches("  merchant_id: 'external_seed',")).toBe(1);
    });

    test('CONTROL: the seller axis is watched, the SOURCING axes are not', () => {
      // The seller axis is what is watched, not the word. The sourcing axes
      // travel beside the mint on the very same objects and must stay invisible
      // to the ratchet, or every honest lane label reads as a defect. This
      // matters most for the two default patterns above, whose fallback value
      // is spelled identically to these.
      expect(countMatches("  source: 'external_seed',")).toBe(0);
      expect(countMatches("  platform: 'external_seed',")).toBe(0);
      expect(countMatches("  source_system: 'external_product_seeds_mirror_v1',")).toBe(0);
      expect(countMatches("  source: normalizedPayload.source || seedData.source || 'external_seed',")).toBe(0);
      expect(countMatches("  retrieval_source: String(sourceTag || '').trim() || 'external_seed',")).toBe(0);
      expect(countMatches("  source_kind: item.source_kind || 'external_seed',")).toBe(0);
    });

    test('CONTROL: the mint patterns do not widen into counting comparisons', () => {
      // The mint patterns use `[=:]`, never `==`, so a reader stays a reader
      // and is counted once by the reader set rather than twice. Without this,
      // a mint pattern could quietly widen and inflate every count in the
      // baseline — a ratchet that grows on its own is one nobody can lower.
      const mintMatches = (text) =>
        WRITER_MINT_PATTERNS.reduce((total, pattern) => total + (text.match(pattern)?.length || 0), 0);

      const snakeComparison = "  if (merchant_id === 'external_seed') return true;";
      expect(mintMatches(snakeComparison)).toBe(0);
      // CONTROL for that zero: the line is not invisible, it is simply owned by
      // the reader set. An absence with no counterpart would also pass if the
      // whole scan had gone dark.
      expect(countMatches(snakeComparison)).toBe(1);
    });

    test('KNOWN GAP: a camelCase comparison is still unwatched', () => {
      // Not an endorsement — a record. `merchantId === 'external_seed'` is a
      // reader defect of exactly the class this file exists to catch, and no
      // pattern sees it, because every reader pattern names the snake_case
      // spelling. It is left open here because this change's mandate is the
      // MINT forms and closing it moves the baseline again.
      //
      // Pinned at 0 so the hole is documented rather than silent: whoever
      // closes it has to delete this test on purpose, which is the moment to
      // regenerate the baseline. Contrast with its snake_case twin above,
      // which proves the gap is a spelling gap and not a dead scan.
      expect(countMatches("  if (merchantId === 'external_seed') return true;")).toBe(0);
      expect(countMatches("  if (merchant_id === 'external_seed') return true;")).toBe(1);
    });
  });
}
