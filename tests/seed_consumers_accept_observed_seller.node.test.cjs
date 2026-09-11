// ADR-009 phase 3, consumer half: which round-trip gates may treat the observed seller
// (merch_obs_*) like the legacy sentinel, and which may NOT.
//
// This is deliberately NOT a blanket rule. An earlier version of this change converted all twelve
// gates on `requestedMerchantId`/`callerRequestedMerchantId` and broke three pinned suites. The
// split was then measured gate-by-gate against those suites (2026-09-11): apply ONE conversion,
// run the oracle, revert, repeat. Eight widened green; four are pinned sentinel-only, each for a
// stated reason recorded beside it in src/server.js.
//
// The distinction the four protect: `merch_obs_*` is external-seed SUPPLY, but it is also a
// SPECIFIC seller. Gates asking "is this row seed supply?" may widen. Gates asking "did the caller
// name the legacy bucket rather than pin a seller?" may not — for those, an observed seller is a
// pinned seller, and the sharpest case is documented in the repo already:
// tests/integration/get_pdp_v2_caller_requested_merchant.test.js:423 explains that one conjunct is
// what holds the identity-graph skip CLOSED for merch_obs_ rows, and that pdpIdentityGraph's
// catalog-entity-group branch exists FOR those rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isExternalSeedSupplyMerchantId,
  EXTERNAL_SEED_MERCHANT_ID,
} = require('../src/services/externalSeedLane');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// Every line where a REQUESTED merchant id is compared to the sentinel. `x || SENTINEL` is a
// DEFAULT, not a gate — the COALESCE(row value, sentinel) shape ADR-009 permits — so only
// comparisons count.
function sentinelOnlyGates() {
  return src.split('\n').reduce((acc, line, i) => {
    if (!/EXTERNAL_SEED_MERCHANT_ID/.test(line)) return acc;
    if (!/\b(requestedMerchantId|callerRequestedMerchantId)\b/.test(line)) return acc;
    if (/(===|!==)\s*EXTERNAL_SEED_MERCHANT_ID/.test(line)) acc.push({ line: i + 1, text: line.trim() });
    return acc;
  }, []);
}

test('the predicate accepts both spellings, and nothing else', () => {
  assert.equal(isExternalSeedSupplyMerchantId(EXTERNAL_SEED_MERCHANT_ID), true);
  assert.equal(isExternalSeedSupplyMerchantId('merch_obs_9ab12cd34ef56789'), true);
  // Connected merchants must STAY merchant-scoped and keep reaching the upstream catalog.
  for (const connected of ['merch_efbc46b4619cfbdf', 'merch_shopify_0584b37f7a8be00a5223', 'stylekorean_global']) {
    assert.equal(isExternalSeedSupplyMerchantId(connected), false, `${connected} must stay merchant-scoped`);
  }
  for (const empty of ['', null, undefined, '   ']) assert.equal(isExternalSeedSupplyMerchantId(empty), false);
});

test('exactly the four measured gates remain sentinel-only', () => {
  // A COUNT, not a floor. If it drops, someone widened a gate the pinned suites forbid and the
  // oracle should have caught them — if it rises, a new gate was written in the old idiom and
  // needs the same gate-by-gate measurement rather than a guess either way.
  const gates = sentinelOnlyGates();
  assert.equal(
    gates.length,
    4,
    `expected the 4 measured sentinel-only gates, saw ${gates.length}:\n${gates
      .map((g) => `  ${g.line}: ${g.text}`)
      .join('\n')}`,
  );
});

test('each sentinel-only gate says WHY it is one', () => {
  // The thing that makes this survivable for the next person. A bare exclusion invites a retry;
  // an exclusion carrying its failing test does not.
  const lines = src.split('\n');
  for (const gate of sentinelOnlyGates()) {
    const preamble = lines.slice(Math.max(0, gate.line - 9), gate.line - 1).join('\n');
    assert.match(
      preamble,
      /SENTINEL-ONLY, DELIBERATELY/,
      `the gate at line ${gate.line} is sentinel-only with no recorded reason:\n  ${gate.text}`,
    );
  }
});

test('the widened gates delegate to the one watched predicate', () => {
  const decl = src.slice(src.indexOf('function isExternalSeedListingMerchantId('));
  const body = decl.slice(0, decl.indexOf('\n}') + 2);
  assert.match(body, /return isExternalSeedSupplyMerchantId\(merchantId\);/);
  // The prefix lives in externalSeedLane; a twin here "is how the class regressed in the first
  // place", per that module's own header.
  assert.equal(/merch_obs_/.test(body), false);
  assert.ok(src.split('isExternalSeedListingMerchantId(requestedMerchantId)').length - 1 >= 8);
});
