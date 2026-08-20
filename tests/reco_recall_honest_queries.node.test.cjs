'use strict';

// The step-aware recall pack was anchored on a SYNTHESIZED role id: recoRecallPlanner builds
// `${targetStepFamily}_primary` when no framework role aligns, and normalizeSemanticQueryLabel turns
// that identifier into query TEXT — "cleanser primary". That token is 7 characters and is not a search
// stopword, so it is a first-class significant token:
//
//   * the phrase arm is `LOWER(title) LIKE $2` with $2 = the WHOLE query -> no title contains
//     "cleanser primary", so the arm is dead, and with it the +400 browse and +120 title dominance arms
//   * the all-token coverage arm ANDs every significant token -> now requires "%primary%" in the title
//     or brand, so it is guaranteed 0
//   * the token-overlap threshold is ceil(n*0.5), so a junk token RAISES the bar for real tokens, and
//     it eats one of the six token slots
//
// ...while paying the full union scan cost. Worse, the pack's substring dedupe then deleted the honest
// bare "cleanser", because "cleanser primary" contains it.
//
// These tests pin the three fixes: role ids never become query text, the anchor and a decorated query
// coexist, and a caller's DECLARED step family survives the HTTP boundary.

// Env must be set BEFORE `require('../src/server')` below — it freezes flags at module load. The
// server module does NOT boot: everything behind `if (require.main === module)` is skipped.
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.API_MODE = 'REAL';
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:4599';
process.env.PIVOTA_API_KEY = `ak_${'a'.repeat(64)}`;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBeautyDiscoveryQueryPackFromContract,
  normalizeSemanticRoleQueryLabel,
  resolveStepFamilyQueryAnchor,
  STEP_FAMILY_QUERY_ANCHORS,
} = require('../src/findProductsMulti/policy');
const {
  buildSearchQualityContract,
  resolveBeautyCategoryPathPrefixFromDeclaredStepFamily,
} = require('../src/findProductsMulti/queryUnderstanding');
const { STEP_QUERY_ALIASES } = require('../src/auroraBff/recommendationSharedStack');

function stepAwareContract(targetStepFamily, overrides = {}) {
  return {
    version: 'beauty_semantic_contract_v1',
    owner: 'aurora_reco_planner',
    planner_mode: 'step_aware',
    request_class: targetStepFamily === 'sunscreen' ? 'sunscreen' : 'routine_followup',
    target_step_family: targetStepFamily,
    primary_role_id: `${targetStepFamily}_primary`,
    support_role_ids: [],
    semantic_family: targetStepFamily,
    allowed_step_families: [targetStepFamily],
    blocked_step_families: [],
    ingredient_hypotheses: [],
    source_surface: 'aurora_beauty_strict',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Role ids never become query text
// ---------------------------------------------------------------------------

test('a synthesized role id never reaches the query pack as text', () => {
  for (const family of ['cleanser', 'toner', 'essence', 'serum', 'moisturizer', 'treatment', 'mask']) {
    const pack = buildBeautyDiscoveryQueryPackFromContract({
      rawQuery: '',
      semanticContract: stepAwareContract(family),
    });
    // Mutant killed: reverting `primaryRoleLabel` to normalizeSemanticQueryLabel(primary_role_id).
    for (const query of pack) {
      assert.ok(
        !/\b(primary|secondary|tertiary|support|supporting|core|main|slot|role|rank)\b/.test(query),
        `structural role token leaked into "${query}" for family ${family}`,
      );
    }
    assert.ok(pack.length > 0, `pack must not be empty for ${family}`);
  }
});

test('the honest bare-family anchor survives the substring dedupe', () => {
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'gentle cleanser for sensitive skin',
    semanticContract: stepAwareContract('cleanser'),
  });
  // Mutant killed: reverting the push() anchor exemption. Before the fix the pack was
  // ["cleanser primary", "gentle cleanser for sensitive skin"] and the honest "cleanser" was deleted
  // as a substring of the junk anchor.
  assert.ok(pack.includes('cleanser'), `expected the bare anchor, got ${JSON.stringify(pack)}`);
  assert.ok(
    pack.includes('gentle cleanser for sensitive skin'),
    `the specific query must survive too, got ${JSON.stringify(pack)}`,
  );
});

test('the dedupe still drops a raw query that merely decorates a non-anchor entry', () => {
  const contract = stepAwareContract('treatment', {
    primary_role_id: 'oil_control_treatment',
    semantic_family: 'oil_control',
    concern_class: 'oil_control',
    allowed_step_families: ['treatment'],
  });
  for (const rawQuery of ['oil control treatment for oily skin', 'gentle oil control treatment']) {
    const pack = buildBeautyDiscoveryQueryPackFromContract({ rawQuery, semanticContract: contract });
    // "oil control treatment" is NOT the bare family anchor ("treatment" is), so it gets no exemption
    // and a raw query that merely wraps it is still redundant.
    // Mutant killed: "delete the substring dedupe entirely" / "exempt every entry" — the 3-query
    // budget would be spent on near-duplicate union scans instead of on coverage.
    assert.deepEqual(pack, ['oil control treatment'], `got ${JSON.stringify(pack)} for "${rawQuery}"`);
  }
});

test('the dedupe still suppresses genuinely redundant NON-anchor pairs', () => {
  // Two decorated queries where one contains the other are still redundant: only the anchor is
  // exempt. Mutant killed: "exempt everything" / "delete the substring dedupe outright", which would
  // spend the 3-query budget on near-duplicates.
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'barrier moisturizer',
    semanticContract: stepAwareContract('moisturizer', {
      primary_role_id: 'barrier_repair_moisturizer',
      concern_class: 'barrier_repair',
    }),
  });
  const decorated = pack.filter((q) => q !== 'moisturizer');
  assert.equal(
    new Set(decorated).size,
    decorated.length,
    `no duplicates expected in ${JSON.stringify(pack)}`,
  );
  for (let i = 0; i < decorated.length; i += 1) {
    for (let j = 0; j < decorated.length; j += 1) {
      if (i === j) continue;
      assert.ok(
        !decorated[j].includes(decorated[i]),
        `"${decorated[j]}" redundantly contains "${decorated[i]}" in ${JSON.stringify(pack)}`,
      );
    }
  }
});

test('a role id richer than its family is kept verbatim, not flattened to the family', () => {
  // Mutant killed: "always return the family anchor" — that would delete real framework role queries
  // like "barrier repair moisturizer" and "daily sunscreen", collapsing every pack to one bare noun.
  assert.equal(
    normalizeSemanticRoleQueryLabel('barrier_repair_moisturizer', 'moisturizer'),
    'barrier repair moisturizer',
  );
  assert.equal(normalizeSemanticRoleQueryLabel('daily_sunscreen', 'sunscreen'), 'daily sunscreen');
  assert.equal(normalizeSemanticRoleQueryLabel('oil_control_treatment', 'treatment'), 'oil control treatment');
});

test('a role id that is only its family + a structural token collapses to the family anchor', () => {
  assert.equal(normalizeSemanticRoleQueryLabel('cleanser_primary', 'cleanser'), 'cleanser');
  assert.equal(normalizeSemanticRoleQueryLabel('serum_support', 'serum'), 'serum');
  // Mutant killed: "strip structural tokens but skip the anchor upgrade" — for oil the bare family
  // token is a SUBSTRING of ordinary words ("oily"), which the substring dedupe then uses to delete
  // real queries.
  assert.equal(normalizeSemanticRoleQueryLabel('oil_primary', 'oil'), 'face oil');
  // Mutant killed: "return '' when nothing survives" — the pack would lose its anchor entirely.
  assert.equal(normalizeSemanticRoleQueryLabel('primary', 'cleanser'), 'cleanser');
  assert.equal(normalizeSemanticRoleQueryLabel('', 'cleanser'), 'cleanser');
  assert.equal(normalizeSemanticRoleQueryLabel(null, 'moisturizer'), 'moisturizer');
});

test('"first essence" is not treated as a structural token', () => {
  // Mutant killed: adding 'first' to SEMANTIC_ROLE_STRUCTURAL_TOKENS. "first essence" is a real
  // product noun and a real STEP_QUERY_ALIASES.essence entry.
  assert.equal(normalizeSemanticRoleQueryLabel('first_essence', 'essence'), 'first essence');
});

test('STEP_FAMILY_QUERY_ANCHORS agrees with STEP_QUERY_ALIASES for every family', () => {
  // The anchors live in policy.js (search side) and the aliases in recommendationSharedStack.js
  // (planner side). This test is the contract that keeps a one-file rename from silently degrading
  // recall — the exact failure class that motivated this PR.
  const families = Object.keys(STEP_QUERY_ALIASES);
  assert.ok(families.length >= 9, `expected the full family set, got ${families.length}`);
  for (const family of families) {
    assert.equal(
      resolveStepFamilyQueryAnchor(family),
      STEP_QUERY_ALIASES[family][0],
      `anchor for "${family}" diverged from STEP_QUERY_ALIASES[${family}][0]`,
    );
  }
  // Mutant killed: "drop the oil override" — resolveStepFamilyQueryAnchor('oil') would return 'oil'
  // while the alias table says 'face oil'.
  assert.equal(STEP_FAMILY_QUERY_ANCHORS.oil, 'face oil');
});

test('an unknown family falls through to itself and an empty one yields nothing', () => {
  assert.equal(resolveStepFamilyQueryAnchor('cleanser'), 'cleanser');
  assert.equal(resolveStepFamilyQueryAnchor('shampoo'), 'shampoo');
  assert.equal(resolveStepFamilyQueryAnchor(''), '');
  assert.equal(resolveStepFamilyQueryAnchor(null), '');
});

// ---------------------------------------------------------------------------
// 2. A declared step family fills in the category prefix (never overrides text)
// ---------------------------------------------------------------------------

test('a declared step family fills in a category prefix the text could not produce', () => {
  const textOnly = buildSearchQualityContract({ rawQuery: 'something gentle' });
  assert.equal(textOnly.hard_constraints.category_path_prefix, null);

  const declared = buildSearchQualityContract({
    rawQuery: 'something gentle',
    declaredTargetStepFamily: 'cleanser',
  });
  // Mutant killed: "ignore declaredTargetStepFamily" — the declared family was carried on `search`
  // and then dropped; the prefix was a function of query text alone.
  assert.equal(declared.hard_constraints.category_path_prefix, 'beauty/skincare/cleanse/');
});

test('a declared step family NEVER overrides a prefix the text already produced', () => {
  const contract = buildSearchQualityContract({
    rawQuery: 'sunscreen spf 50',
    declaredTargetStepFamily: 'cleanser',
  });
  // Mutant killed: putting the declared family FIRST in the || chain — a stale or mis-declared family
  // would then move a search out of the category its own words asked for.
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/skincare/sun/');
});

test('the declared family resolves through the shipped text rules, so a bogus one yields nothing', () => {
  // Mutant killed: introducing a second, hand-written family->prefix map. Reusing
  // resolveBeautyCategoryPathPrefixFromText means the two paths cannot disagree.
  assert.equal(resolveBeautyCategoryPathPrefixFromDeclaredStepFamily('cleanser'), 'beauty/skincare/cleanse/');
  assert.equal(resolveBeautyCategoryPathPrefixFromDeclaredStepFamily('moisturizer'), 'beauty/skincare/moisturize/');
  assert.equal(resolveBeautyCategoryPathPrefixFromDeclaredStepFamily('sunscreen'), 'beauty/skincare/sun/');
  assert.equal(resolveBeautyCategoryPathPrefixFromDeclaredStepFamily('nonsense_family'), '');
  assert.equal(resolveBeautyCategoryPathPrefixFromDeclaredStepFamily(''), '');
  assert.equal(resolveBeautyCategoryPathPrefixFromDeclaredStepFamily(null), '');
});

// ---------------------------------------------------------------------------
// 3. The GET /agent products search boundary honours the structured params
// ---------------------------------------------------------------------------

// `require('../src/server')` does not boot: `app.listen` lives behind `if (require.main === module)`.
const { buildFindProductsMultiPayloadFromQuery } = require('../src/server')._debug;

test('the payload builder parses target_step_family / semantic_family / query_step_strength', () => {
  const payload = buildFindProductsMultiPayloadFromQuery({
    q: 'gentle cleanser',
    target_step_family: 'cleanser',
    semantic_family: 'barrier_repair',
    query_step_strength: 'strong_goal_family',
  });
  // Mutant killed: reverting the parsing hunk. The Aurora recall client SENDS all three on every
  // catalog search and this builder dropped every one of them at the HTTP boundary.
  assert.equal(payload.search.target_step_family, 'cleanser');
  assert.equal(payload.search.semantic_family, 'barrier_repair');
  assert.equal(payload.search.query_step_strength, 'strong_goal_family');
});

test('camelCase aliases are accepted, matching every other param on this route', () => {
  const payload = buildFindProductsMultiPayloadFromQuery({
    q: 'gentle cleanser',
    targetStepFamily: 'MOISTURIZER',
    semanticFamily: 'Hydration',
    queryStepStrength: 'Supportive_Family',
  });
  // Mutant killed: "snake_case only" / "no lowercasing" — the route accepts camelCase for
  // merchant_id, search_all_merchants, fast_mode and the rest; these must not be the odd ones out.
  assert.equal(payload.search.target_step_family, 'moisturizer');
  assert.equal(payload.search.semantic_family, 'hydration');
  assert.equal(payload.search.query_step_strength, 'supportive_family');
});

test('unknown or malformed values are DROPPED, never forwarded', () => {
  const payload = buildFindProductsMultiPayloadFromQuery({
    q: 'gentle cleanser',
    target_step_family: 'shampoo',
    semantic_family: 'DROP TABLE products;--',
    query_step_strength: 'very_strong',
  });
  // Mutant killed: "coerce instead of allowlist" (e.g. reusing normalizeBeautyStepFamily, which
  // returns unknown input unchanged) and "denylist instead of allowlist". A caller must not be able
  // to widen the step vocabulary, or inject free text, from the query string.
  assert.equal(payload.search.target_step_family, undefined);
  assert.equal(payload.search.semantic_family, undefined);
  assert.equal(payload.search.query_step_strength, undefined);
});

test('the three params are OPTIONAL: an existing caller gets a byte-identical payload', () => {
  const before = buildFindProductsMultiPayloadFromQuery({ q: 'gentle cleanser', limit: '5' });
  // Mutant killed: "always set the keys (to null/'')" — this is a shared REST route with existing
  // callers, and a new always-present key changes the request contract for all of them.
  assert.ok(!('target_step_family' in before.search));
  assert.ok(!('semantic_family' in before.search));
  assert.ok(!('query_step_strength' in before.search));
  assert.equal(before.search.query, 'gentle cleanser');
  assert.equal(before.search.limit, 5);
});

test('every canonical step family is accepted by the allowlist', () => {
  for (const family of Object.keys(STEP_QUERY_ALIASES)) {
    const payload = buildFindProductsMultiPayloadFromQuery({ q: 'x', target_step_family: family });
    // Mutant killed: hard-coding a partial family list in server.js instead of deriving it from
    // CANONICAL_STEP_FAMILY_MAP — a family added to the planner would then be silently rejected here.
    assert.equal(
      payload.search.target_step_family,
      family,
      `canonical family "${family}" was rejected by the route allowlist`,
    );
  }
});

test('query_step_strength accepts exactly the three canonical values', () => {
  for (const value of ['strong_goal_family', 'supportive_family', 'generic_family']) {
    const payload = buildFindProductsMultiPayloadFromQuery({ q: 'x', query_step_strength: value });
    assert.equal(payload.search.query_step_strength, value);
  }
  // Mutant killed: accepting 'exact_step' / 'focused', which look like step strengths in fixtures but
  // normalize to null in the shared normalizer — they are step_success_class values.
  for (const value of ['exact_step', 'focused', '']) {
    const payload = buildFindProductsMultiPayloadFromQuery({ q: 'x', query_step_strength: value });
    assert.equal(payload.search.query_step_strength, undefined, `"${value}" must be rejected`);
  }
});
