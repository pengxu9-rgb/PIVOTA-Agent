'use strict';

// Unit tests for name-evidence admission (src/services/searchNameEvidence.js).
//
// The canonical SQL is the only authority on WHICH rows are admitted, and marks them
// `name_evidence_admitted` (carried in-process as NAME_EVIDENCE_ADMITTED);
// tests/integration/search_name_evidence_admission_postgres.test.js
// runs that SQL on real PostgreSQL. These tests cover what the JS layers do with the mark, and
// the query-token contract both sides share.

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const test = require('node:test');

const ne = require('../src/services/searchNameEvidence');
const { brandIdentityKey, buildCanonicalSearchQualitySql } = require('../src/services/canonicalSearchQualitySql');
const app = require('../src/server');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const { getSearchQualityContractHardConstraintResult: gate, scoreBeautyExternalSeedProduct, inferBeautyMainlineIntent,
  isBeautyProductContraindicatedForQuery } = app._debug;

const JSM = {
  product_id: 'jsm', title: 'LIP-PRESSION Metal Serum Gloss', brand: 'JUNGSAEMMOOL', product_type: 'makeup',
  category: 'makeup', category_path: ['beauty', 'makeup'], catalog_category_path: 'beauty/makeup', price: 28.8,
  currency: 'SGD', image_url: 'https://cdn.example.com/j.jpg', source: 'canonical_chain', search_recall_source: 'canonical_chain',
};
const ADMITTED = { ...JSM, [ne.NAME_EVIDENCE_ADMITTED]: true };

function withFlag(value, fn) {
  const prior = process.env[ne.FLAG];
  if (value == null) delete process.env[ne.FLAG]; else process.env[ne.FLAG] = value;
  try { return fn(); } finally { if (prior == null) delete process.env[ne.FLAG]; else process.env[ne.FLAG] = prior; }
}

// --- the query-token contract ---------------------------------------------------

test('the admitted mark never serialises: it cannot leak into a public response', () => {
  const marked = { ...ADMITTED };
  assert.equal(marked[ne.NAME_EVIDENCE_ADMITTED], true, 'spreads carry it');
  assert.equal(JSON.stringify(marked).includes('admitted'), false);
  assert.equal(Object.keys(marked).includes('name_evidence_admitted'), false);
});

test('the flag is off unless explicitly on', () => {
  assert.equal(ne.nameEvidenceAdmissionEnabled({}), false);
  for (const v of ['off', 'shadow', '0']) assert.equal(ne.nameEvidenceAdmissionEnabled({ [ne.FLAG]: v }), false, v);
  for (const v of ['on', 'true', '1', 'ON']) assert.equal(ne.nameEvidenceAdmissionEnabled({ [ne.FLAG]: v }), true, v);
});

test('tokens: two or more distinctive words; no vocabulary judgement (the catalog count makes that call)', () => {
  assert.deepEqual(ne.queryDistinctiveTokens('LIP-PRESSION Metal Serum Gloss'), ['lip', 'pression', 'metal', 'serum', 'gloss']);
  // Category words are NOT excluded any more: whether "nail polish" names a product is
  // decided by how many catalog rows carry it, in SQL.
  assert.deepEqual(ne.queryDistinctiveTokens('nail polish'), ['nail', 'polish']);
  assert.equal(ne.queryDistinctiveTokens('serum'), null, 'one token is not a name');
  assert.equal(ne.queryDistinctiveTokens('best serum for skin'), null, 'filler carries no identity');
  assert.equal(ne.queryDistinctiveTokens('spf 50'), null, 'tokens under three characters do not count');
});

test('tokens: brand words excluded in both the spaced and the joined spelling', () => {
  // The REAL contract's brand object -- it carries only the spaced canonical/alias, so the joined
  // spelling a shopper types ("JUNGSAEMMOOL") is excluded only by joining those words.
  const hard = buildSearchQualityContract({ rawQuery: 'JUNGSAEMMOOL Metal Serum Gloss', market: 'SG' }).hard_constraints;
  assert.equal(hard.brand.brand, undefined, 'premise: no solid-spelling field to lean on');
  assert.deepEqual(ne.queryDistinctiveTokens('jung saem mool metal gloss', hard), ['metal', 'gloss']);
  assert.deepEqual(ne.queryDistinctiveTokens('JUNGSAEMMOOL Metal Serum Gloss', hard), ['metal', 'serum', 'gloss']);
});

test('token normalisation is the Postgres identity fold, character for character', () => {
  // Review of #2230: NFKD made "Metal™" the token "metaltm" and "Gloss²" "gloss2"; Postgres
  // folds them to "metal" and "gloss", so the row was recalled and then rejected.
  for (const x of ['Metal™ Serum Gloss', 'Gloss²', 'MÉTAL SÉRUM', 'M·A·C', 'Niño Señora', 'ＭＥＴＡＬ', '50㎖', 'Ørkin', 'ño']) {
    assert.equal(ne.sqlIdentityValue(x).replace(/ /g, ''), brandIdentityKey(x), x);
  }
  assert.equal(ne.sqlIdentityValue('Metal™ Serum Gloss²'), 'metal serum gloss');
  assert.equal(ne.IDENTITY_ACCENTED.length, ne.IDENTITY_FOLDED.length);
});

// --- the SQL arm: flag read per call, and present on every category branch ------------------

function renderScope(query, flag) {
  const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
  const params = ['q', '%q%', 48, 72];
  return withFlag(flag, () => buildCanonicalSearchQualitySql({
    contract, params, categoryPredicate: "p.category_path LIKE 'x%'", defaultWhere: 'TRUE', defaultBrandWhere: '',
  }));
}

test('SQL: the flag is read per call, not at module load', () => {
  assert.equal(renderScope('Metal Serum Gloss', null).nameEvidence, null);
  assert.ok(renderScope('Metal Serum Gloss', 'on').nameEvidence);
  assert.equal(renderScope('Metal Serum Gloss', 'off').nameEvidence, null);
});

test('SQL: the arm is built on BOTH category branches -- with a product-form rule and without one', () => {
  // `Metal Serum Gloss` matches a FORM_RULE (gloss); `Egg Vita Peeling Gel` routes to a prefix
  // with no form rule. A version that only built the arm inside the form branch passed every
  // other test.
  for (const query of ['Metal Serum Gloss', 'Egg Vita Peeling Gel']) {
    const scope = renderScope(query, 'on');
    assert.ok(scope.nameEvidence, query);
    assert.match(scope.nameEvidence.cteSql, /count\(\*\)/);
    assert.equal(scope.nameEvidence.extraCandidates, ne.MAX_CARRIERS);
    assert.match(scope.nameEvidence.rankSql, /THEN 95 ELSE 0 END/, 'below an exact title (100) and source id (105)');
  }
});

// --- the gate reads the mark ---------------------------------------------------------------

const q = 'Metal Serum Gloss';
const contractFor = (query) => buildSearchQualityContract({ rawQuery: query, market: 'SG' });

test('gate: waives category_mismatch only for a MARKED row, only with the flag on, and says so', () => {
  const contract = contractFor(q);
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/skincare/treat/', 'premise: the guess is skincare');
  assert.deepEqual(withFlag('on', () => gate({ ...JSM }, contract, q)).reasons, ['category_mismatch'],
    'an unmarked row whose name carries the query is NOT waived: the JS never re-derives admission');
  assert.deepEqual(withFlag(null, () => gate({ ...ADMITTED }, contract, q)).reasons, ['category_mismatch'], 'flag off');
  const on = withFlag('on', () => gate({ ...ADMITTED }, contract, q));
  assert.equal(on.eligible, true);
  assert.equal(on.category_waived_by_name_evidence, true);
});

test('gate: brand_mismatch stands for a marked row', () => {
  const query = 'jung saem mool lip gloss';
  const contract = contractFor(query);
  assert.ok(contract.hard_constraints.brand, 'premise: a brand constraint');
  const r = withFlag('on', () => gate({ ...ADMITTED, product_id: 'o', brand: 'Other Brand' }, contract, query));
  assert.ok(r.reasons.includes('brand_mismatch'), JSON.stringify(r.reasons));
  assert.equal(r.reasons.includes('category_mismatch'), false, 'the category is the only thing waived');
});

test('gate: accessory, strict-lipstick and fragrance-free rejections stand for a marked row', () => {
  const brush = withFlag('on', () => gate({ ...ADMITTED, product_id: 'b', title: 'Metal Serum Gloss Brush', product_type: 'Brush' }, contractFor(q), q));
  assert.ok(brush.reasons.includes('accessory_for_product_query'), JSON.stringify(brush.reasons));

  const lipstickQuery = 'matte lipstick';
  const lipstickContract = contractFor(lipstickQuery);
  assert.equal(lipstickContract.hard_constraints.strict_lipstick, true, 'premise');
  // Filed OUTSIDE the lip tree, so its category IS rejected and IS waived -- the only case in
  // which a waiver could leak into the strict-lipstick check.
  const gloss = withFlag('on', () => gate({ ...ADMITTED, product_id: 'g', title: 'Matte Lip Gloss', product_type: 'Lip Gloss',
    category_path: ['beauty', 'skincare', 'treat'], catalog_category_path: 'beauty/skincare/treat' }, lipstickContract, lipstickQuery));
  assert.equal(gloss.category_waived_by_name_evidence, true, 'premise: the category was waived');
  assert.ok(gloss.reasons.includes('strict_lipstick_mismatch'), JSON.stringify(gloss.reasons));

  const ffQuery = 'fragrance free moisturizer';
  const ffContract = contractFor(ffQuery);
  assert.equal(ffContract.hard_constraints.fragrance_free_skincare, true, 'premise');
  const perfume = withFlag('on', () => gate({ ...ADMITTED, product_id: 'p', title: 'Rose Eau de Parfum', product_type: 'Fragrance' }, ffContract, ffQuery));
  assert.ok(perfume.reasons.includes('fragrance_product_for_fragrance_free_query'), JSON.stringify(perfume.reasons));
});

// --- ranker ----------------------------------------------------------------------------------

function score(product, query) {
  const contract = contractFor(query);
  const intent = inferBeautyMainlineIntent(query);
  return scoreBeautyExternalSeedProduct({ product, queryText: query, intent, normalizedQuery: query.toLowerCase(),
    queryTokens: query.toLowerCase().split(' '), searchQualityContract: contract });
}

test('ranker: a marked row is relevant and outranks a bare category match; an unmarked one is not', () => {
  const serum = { ...JSM, product_id: 'h', title: 'Hydrating Serum', brand: 'Other', product_type: 'Serum',
    category_path: ['beauty', 'skincare', 'treat', 'serum'], catalog_category_path: 'beauty/skincare/treat/serum' };
  assert.equal(withFlag('on', () => score({ ...JSM }, q)).relevant, false);
  const [jsm, other] = withFlag('on', () => [score({ ...ADMITTED }, q), score(serum, q)]);
  assert.equal(jsm.relevant, true);
  assert.equal(other.relevant, true);
  assert.ok(jsm.score > other.score, `${jsm.score} > ${other.score}`);
});

test('ranker: an admitted row scores the same in any spelling the SQL fold admits', () => {
  // Review of #2230 v3: the lexical arms compared unfolded text, so the accent- and dot-folded
  // carriers scored 35 below the plain spelling and were served behind in-category serums.
  const plain = withFlag('on', () => score({ ...ADMITTED }, q));
  for (const title of ['LIP-PRESSION MÉTAL SERUM GLOSS', 'LIP-PRESSION M·E·T·A·L Serum Gloss']) {
    const folded = withFlag('on', () => score({ ...ADMITTED, product_id: title, title }, q));
    assert.equal(folded.relevant, true, title);
    assert.equal(folded.score, plain.score, title);
  }
  // The fold reads the NAME, as the SQL does -- never the description, which the SQL never admits
  // on. The description arms that already exist are unfolded, so an ACCENTED description isolates
  // the fold: it must add nothing that a description with no query words does not.
  const described = { ...ADMITTED, product_id: 'd', title: 'Sheer Tint', product_type: 'makeup',
    description: 'Pairs with MÉTAL SÉRUM' };  // accented only: the unfolded arms match none of it
  const bare = { ...ADMITTED, product_id: 'n', title: 'Sheer Tint', product_type: 'makeup',
    description: 'Pairs with nothing in particular' };
  assert.equal(withFlag('on', () => score(described, q)).score, withFlag('on', () => score(bare, q)).score,
    'an accented description earns no fold credit');
  // WHOLE WORDS, like the SQL's regex that admitted the row: "metallic" does not carry "metal".
  // The rows are ACCENTED because that is the only place this can be measured -- the pre-existing
  // unfolded arm is a plain substring test, so it already credits "metal" inside "Metallic", and
  // the fold must not add a second, equally loose match. The control carries exactly the same
  // query words ("serum", "gloss") with no near-miss, so only that credit can separate them.
  const metallic = { ...ADMITTED, product_id: 'x', title: 'MÉTALLIC Serum Gloss' };
  const control = { ...ADMITTED, product_id: 'c', title: 'RÁDIANT Serum Gloss' };
  assert.equal(withFlag('on', () => score(metallic, q)).score, withFlag('on', () => score(control, q)).score,
    'a substring is not a token');

  // An UNMARKED row gets no fold credit: only what the SQL admitted is read folded.
  const serum = { ...JSM, product_id: 'm', title: 'MÉTAL SERUM GLOSS Serum', product_type: 'Serum',
    category_path: ['beauty', 'skincare', 'treat', 'serum'], catalog_category_path: 'beauty/skincare/treat/serum' };
  const plainSerum = { ...serum, product_id: 'p', title: 'METAL SERUM GLOSS Serum' };
  assert.ok(withFlag('on', () => score(serum, q)).score < withFlag('on', () => score(plainSerum, q)).score,
    'premise: unfolded arms still treat the accented in-category title as a different word');
});

test('ranker: in-category scores do not change with the flag', () => {
  const inCategory = { ...JSM, product_id: 's', title: 'Metal Serum Gloss', product_type: 'Serum',
    category_path: ['beauty', 'skincare', 'treat', 'serum'], catalog_category_path: 'beauty/skincare/treat/serum' };
  assert.equal(withFlag('on', () => score(inCategory, q)).score, withFlag(null, () => score(inCategory, q)).score);
});

// NOT TESTED, deliberately: the ranker's own strict-lipstick check ignoring a marked row. It is
// unreachable -- a marked row only reaches the ranker after the gate, and the gate already
// rejects it for strict_lipstick_mismatch (pinned above). A mutation there cannot be observed.
test('ranker: strict lipstick still rejects a marked row', () => {
  const r = withFlag('on', () => score({ ...ADMITTED, product_id: 'g', title: 'Matte Lip Gloss', product_type: 'Lip Gloss' }, 'matte lipstick'));
  assert.equal(r.relevant, false);
});

test('ranker: the category and family guesses do not reject a marked row', () => {
  const h = require('./acceptance/search_acceptance_harness.cjs');
  const rows = h.loadRows();
  // category guess (families empty)
  const jsm = rows.find((r) => r.product_id === 'acceptance_jsm_lip_pression_metal_serum_gloss');
  assert.equal(withFlag('on', () => score({ ...jsm }, 'lip gloss')).relevant, false, 'premise: unmarked it is rejected');
  assert.equal(withFlag('on', () => score({ ...jsm, [ne.NAME_EVIDENCE_ADMITTED]: true }, 'lip gloss')).relevant, true);
  // family guess: a sun mist the catalog files under toner, searched by its title
  const mist = rows.find((r) => r.product_id === 'sig_f15d35090db822cba12e633b1eca7933');
  assert.equal(withFlag('on', () => score({ ...mist }, mist.title)).relevant, false, 'premise: unmarked it is rejected');
  assert.equal(withFlag('on', () => score({ ...mist, [ne.NAME_EVIDENCE_ADMITTED]: true }, mist.title)).relevant, true);
});

// --- contraindications: surface rules skipped, SAFETY rules never ----------------------------

test('ranker: a safety contraindication rejects a marked row at the ranker call site, not only in isolation', () => {
  // Review of #2230: the safety tests call isBeautyProductContraindicatedForQuery directly, so a
  // ranker that skipped the call for admitted rows passed them. This goes through the ranker with
  // a row whose category IS waived.
  const query = 'fragrance free moisturizer';
  const product = { ...ADMITTED, product_id: 'f', title: 'Silk Cream', product_type: 'Cream',
    description: 'Ingredients: aqua, linalool, limonene',
    category_path: ['beauty', 'makeup', 'lip'], catalog_category_path: 'beauty/makeup/lip' };
  const gateResult = withFlag('on', () => gate({ ...product }, contractFor(query), query));
  assert.equal(gateResult.category_waived_by_name_evidence, true, 'premise: the category is waived');
  assert.equal(withFlag('on', () => score({ ...product }, query)).relevant, false);
});

test('contraindications: a marked row skips the SURFACE rules', () => {
  const lip = { title: 'LIP-PRESSION Metal Serum Gloss', product_type: 'makeup' };
  const intent = inferBeautyMainlineIntent(q);
  assert.equal(isBeautyProductContraindicatedForQuery(lip, q, intent), true, 'premise: the lip-care surface rule fires');
  assert.equal(isBeautyProductContraindicatedForQuery(lip, q, intent, { admittedByNameEvidence: true }), false);
});

test('contraindications: EVERY safety rule still applies to a marked row, each on an input only it catches', () => {
  // Each input was verified to be caught by exactly that rule: guarding the rule with the
  // surface switch flips the result to false. Review of #2230 v3 found only six of the fourteen
  // safety rules pinned; guarding any of the other eight survived. All fourteen are listed here, in
  // the order isBeautyProductContraindicatedForQuery (src/server.js) checks them.
  for (const [rule, query, product] of [
    ['avoid_retinoids (retinoid for a retinol-free query)', 'retinol free serum', { title: 'Night Serum', product_type: 'Serum', description: 'retinol 0.3%' }],
    ['retinoid for a sunscreen/cleanser/moisturizer query', 'night moisturizer', { title: 'Night Cream', product_type: 'Moisturizer', description: 'retinol 0.1%' }],
    ['avoid_cooling_strong_cleanser (scrub for a sensitive cleanser query)', 'sensitive skin cleanser', { title: 'Walnut Scrub Cleanser', product_type: 'Cleanser', description: 'walnut scrub' }],
    ['avoid_exfoliating_acids (acid for a peeling-skin query)', 'peeling skin cream', { title: 'Glycolic Toner Pads', product_type: 'Toner', description: 'glycolic acid' }],
    ['volume-plumping actives for a gentle query', 'gentle serum', { title: 'Plump Serum', product_type: 'Serum', description: 'volufiline complex' }],
    ['scented product for a calm-face query', 'face moisturizer', { title: 'Rose Scented Cream', product_type: 'Moisturizer' }],
    ['resurfacing product for a barrier-ingredient moisturizer query', 'ceramide moisturizer', { title: 'Clarifying Cream', product_type: 'Moisturizer' }],
    ['acid treatment for a barrier-ingredient moisturizer query', 'ceramide moisturizer', { title: 'Azelaic Acid Suspension 10%', product_type: 'Treatment' }],
    ['fragrance for a fragrance-averse query', 'fragrance free moisturizer', { title: 'Silk Cream', product_type: 'Moisturizer', description: 'Ingredients: aqua, linalool, limonene' }],
    ['exfoliating acid for a calm-skin query', 'sensitive skin serum', { title: 'Glow Glycolic Serum', product_type: 'Serum', description: 'glycolic acid 7%' }],
    ['avoid_retinoids (peel for pregnancy)', 'pregnancy safe peel', { title: 'Radiance Peel Pads', product_type: 'Exfoliant', description: 'aha peel' }],
    ['cooling irritants for sensitive skin', 'sensitive skin gel', { title: 'Mint Cooling Gel', product_type: 'Gel', description: 'menthol and peppermint' }],
    ['anti-aging actives for a barrier query', 'barrier repair cream', { title: 'Firming Lifting Cream', product_type: 'Cream', description: 'firming lifting' }],
    ['retinoid for a brightening query', 'Retinol Night Serum brightening', { title: 'Retinol Night Serum', product_type: 'Serum', description: 'retinol 0.3%' }],
  ]) {
    assert.equal(isBeautyProductContraindicatedForQuery(product, query, inferBeautyMainlineIntent(query), { admittedByNameEvidence: true }), true, rule);
  }
});
