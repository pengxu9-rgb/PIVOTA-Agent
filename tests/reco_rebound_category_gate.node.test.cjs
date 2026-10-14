'use strict';

// A CATALOG REBOUND MUST BE THE KIND OF PRODUCT THAT WAS ASKED FOR.
//
// Live on the agent door 2026-10-14 (gateway-00650-muv), four makeup/fragrance needs each returned a
// `catalog_rebound` row -- grounding swapped the model's product for a different catalog product:
//
//   bronzer for fair skin          -> NUXE Lip Moisturising Stick, labelled category "Bronzer"
//   cream blush for olive skin     -> Tom Ford Santal Blush Eau de Parfum, labelled "Blush"
//   light floral eau de toilette   -> a leather/amber Tom Ford parfum
//   matte red lipstick             -> a nude liquid lipstick
//
// The first two are a different category; the row's own category/product_type repeated the requested
// type, so the classifier passed them. The last two are the right category with the wrong shade or
// scent, which no category check can see. Rule (src/auroraBff/recoReboundCategoryGate.js): makeup and
// fragrance never rebound; a skincare rebound must agree with the catalog's own taxonomy path.
//
// The grounding pass is driven END TO END here: the pool is what the recall path itself writes to the
// durable cache (normalizeRecoCatalogProduct -> extractRecoRecallPoolForCache -> the cache sanitizer),
// read back through the real cache, classified, gated, merged and projected through the agent door.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const dbModule = require('../src/db');
const { __internal } = require('../src/auroraBff/routes');
const { sanitizeRecoRecallPoolCandidates } = require('../src/auroraBff/recoRecallPoolCache');
const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
const {
  judgeRecoReboundCandidate,
  readCatalogCategoryPath,
  SKINCARE_LEAF_STEP,
} = require('../src/auroraBff/recoReboundCategoryGate');

const url = (id) => `https://agent.pivota.cc/products/${id}`;

// A search row in the shape the catalog search returns (category_path array + catalog_category_path
// string, as observed on search_catalog for these products), with `category`/`product_type` set to
// whatever the live row carried.
function searchRow({ id, merchant = 'external_seed', title, brand, price, label, path, pathAs = 'both' }) {
  const segments = path.split('/');
  return {
    product_id: id,
    merchant_id: merchant,
    title,
    brand,
    price,
    currency: 'USD',
    url: url(id),
    ...(label ? { category: label, product_type: label } : {}),
    ...(pathAs === 'both' || pathAs === 'array' ? { category_path: segments } : {}),
    ...(pathAs === 'both' || pathAs === 'string' ? { catalog_category_path: path } : {}),
  };
}

// What the recall path persists for a search that returned `rows`.
function cachedPoolFrom(rows) {
  const rawCandidates = rows.map((row) => __internal.normalizeRecoCatalogProduct(row)).filter(Boolean);
  return sanitizeRecoRecallPoolCandidates(
    __internal.extractRecoRecallPoolForCache({ searchResults: [{ ok: true }], rawCandidates }),
  );
}

function resetCircuit() {
  __internal.markRecoCatalogFailFastSuccess();
  const state = __internal.recoCatalogFailFastState;
  if (state.off_request_probe_timer) {
    clearTimeout(state.off_request_probe_timer);
    state.off_request_probe_timer = null;
  }
  state.off_request_probe_in_flight = false;
}

async function ground(plans, rows) {
  resetCircuit();
  const pool = cachedPoolFrom(rows);
  const originalQuery = dbModule.query;
  dbModule.query = async (sql) => (/SELECT payload/.test(sql)
    ? { rows: [{ payload: pool, refreshed_at: new Date().toISOString() }] }
    : { rows: [], rowCount: 0 });
  try {
    return await __internal.groundRecoRecommendationsFromCatalog({
      recommendations: plans,
      ctx: { lang: 'EN' },
      logger: null,
      defaultTargetContext: null,
    });
  } finally {
    dbModule.query = originalQuery;
  }
}

// The LIVE recall path: no cached pool, the search answering directly. This is the path that stamps
// each recalled row with the item's requested step (`retrieval_step`), which the classifier falls back
// to when the row's own type is a word it does not map -- so here even a truthful 'perfume' label on
// Santal Blush passed before this change. The cache path drops retrieval_step; both are driven.
async function groundLive(plans, rows) {
  resetCircuit();
  const before = process.env.AURORA_BFF_RECO_RECALL_POOL_CACHE_ENABLED;
  process.env.AURORA_BFF_RECO_RECALL_POOL_CACHE_ENABLED = 'false';
  try {
    return await __internal.groundRecoRecommendationsFromCatalog({
      recommendations: plans,
      ctx: { lang: 'EN' },
      logger: null,
      defaultTargetContext: null,
      searchFn: async () => ({ ok: true, products: rows.map((row) => ({ ...row })) }),
    });
  } finally {
    if (before === undefined) delete process.env.AURORA_BFF_RECO_RECALL_POOL_CACHE_ENABLED;
    else process.env.AURORA_BFF_RECO_RECALL_POOL_CACHE_ENABLED = before;
  }
}

const PATHS = { 'cached pool': ground, 'live search': groundLive };

// Through the agent door, exactly as the lane hands rows to it after grounding.
async function door(grounded, need) {
  const rows = grounded.recommendations.map((row) => __internal.coerceRecoItemForUi(row, { lang: 'EN' }));
  const recommend = makeRecommendProducts({
    isEnabled: () => true,
    generate: async () => ({ norm: { payload: { recommendations: rows, recommendation_meta: { confidence_basis: 'model_self_report' } } } }),
    verifyPrice: async (product) => ({ price: product.price, currency: product.currency || 'USD' }),
  });
  return recommend({ need });
}

// ---------------------------------------------------------------------------------------------------
// 1. The four live cases. Each grounded to its wrong product before this change.
// ---------------------------------------------------------------------------------------------------

const LIVE = [
  {
    need: "a bronzer for fair skin that isn't too orange",
    plan: { name: 'Hoola Matte Bronzer', brand: 'Benefit', product_type: 'bronzer', score: 90 },
    row: searchRow({
      id: 'sig_3388a5e139e21623163e558d86e66741', title: 'Lip Moisturising Stick', brand: 'NUXE',
      price: 9.2, label: 'Bronzer', path: 'beauty/makeup/lip/balm',
    }),
  },
  {
    need: 'a cream blush that looks natural on olive skin',
    plan: { name: 'Cloud Paint Gel-Cream Blush', brand: 'Glossier', product_type: 'blush', score: 88 },
    row: searchRow({
      id: 'sig_b8079c59f40c0888aa9b6b496173d87c', title: 'Santal Blush Eau de Parfum', brand: 'Tom Ford Beauty',
      price: 300, label: 'Blush', path: 'beauty/fragrance/perfume', pathAs: 'array',
    }),
  },
  {
    need: 'a light floral eau de toilette for daytime',
    plan: { name: 'Daisy Eau de Toilette', brand: 'Marc Jacobs', product_type: 'eau de toilette', score: 86 },
    // The RIGHT category: a category gate alone passes this one.
    row: searchRow({
      id: 'sig_7c1e0d1f2a3b4c5d6e7f8091a2b3c4d5', title: 'Noir Leather Amber Parfum', brand: 'Example Maison',
      price: 530, label: 'perfume', path: 'beauty/fragrance/perfume', pathAs: 'string',
    }),
  },
  {
    need: 'a long-wearing matte red lipstick for warm undertones',
    plan: { name: 'Ruby Woo Retro Matte Lipstick', brand: 'MAC', product_type: 'lipstick', score: 87 },
    // The RIGHT category again, the wrong shade.
    row: searchRow({
      id: 'sig_0f9e8d7c6b5a49382716150413121110', title: 'Stunna Lip Paint Longwear Fluid Lip Color — Uncensored Nude',
      brand: 'Fenty Beauty', price: 28, label: 'lipstick', path: 'beauty/makeup/lip/lipstick',
    }),
  },
];

for (const c of LIVE) for (const [pathName, run] of Object.entries(PATHS)) {
  test(`live case (${pathName}): "${c.need}" does not ground to ${c.row.title}`, async () => {
    const out = await run([c.plan], [c.row]);
    assert.equal(out.recommendations.length, 1);
    const item = out.recommendations[0];
    assert.equal(item.grounding_status, 'ungrounded', `${c.row.title} must not stand in for ${c.plan.name}`);
    assert.notEqual(item.product_id, c.row.product_id);
    assert.equal(out.grounded_count, 0);
    assert.equal(out.debug.rebound_rejected_by_reason.shade_or_scent_led_type, 1);

    // At the door: no item, and the model's product survives only as an unresolved archetype.
    const response = await door(out, c.need);
    assert.deepEqual(response.signals, [], 'nothing the buyer was not asked about is served');
    assert.ok(!JSON.stringify(response).includes(c.row.product_id));
    assert.deepEqual(response.metadata.unresolved_archetypes, [c.plan.name]);
  });
}

test('live search: Santal Blush is refused for a blush even when it is truthfully labelled perfume', async () => {
  // The retrieval_step fallback on its own, with no title-guessed label to help it.
  const truthful = { ...LIVE[1].row, category: 'perfume', product_type: 'perfume' };
  const out = await groundLive([LIVE[1].plan], [truthful]);
  assert.equal(out.recommendations[0].grounding_status, 'ungrounded');
  assert.equal(out.debug.rebound_rejected_by_reason.shade_or_scent_led_type, 1);
});

test('the model\'s OWN makeup pick still grounds -- the same product is not a rebound', async () => {
  const fenty = searchRow({
    id: 'sig_0cab904684e9a32776d641e41d9148c5', title: "Sun Stalk'r Instant Warmth Bronzer — Coco Naughty",
    brand: 'Fenty Beauty', price: 38, label: 'Bronzer', path: 'beauty/makeup/face/bronzer',
  });
  const plan = { product_id: fenty.product_id, merchant_id: 'external_seed', name: fenty.title, product_type: 'bronzer', score: 90 };
  const out = await ground([plan], [LIVE[0].row, fenty]);
  const item = out.recommendations[0];
  assert.equal(item.grounding_status, 'grounded');
  assert.equal(item.product_id, fenty.product_id, 'the lip balm ahead of it in the pool is skipped, not taken');
  assert.notEqual(item.__pivota_score_basis, 'catalog_rebound');
  const response = await door(out, 'a bronzer for fair skin');
  assert.equal(response.signals.length, 1);
  assert.equal(response.signals[0].value.lane_confidence.basis, 'model_self_report');
  assert.equal(response.signals[0].value.lane_confidence.level, 'high');
});

test('a makeup item whose product_type says nothing is judged by its name, and still refused a substitute', async () => {
  // Mutant killed: judging only rec.product_type. 'makeup' resolves to no step, so a gate that read
  // only the type would wave the lip balm through as "requested_type_unresolved"... or, worse, accept.
  const out = await ground([{ ...LIVE[0].plan, product_type: 'makeup' }], [LIVE[0].row]);
  assert.equal(out.recommendations[0].grounding_status, 'ungrounded');
  assert.equal(out.debug.rebound_rejected_by_reason.shade_or_scent_led_type, 1);
});

// ---------------------------------------------------------------------------------------------------
// 2. Skincare keeps its rebounds, judged by the catalog path rather than the row's label.
// ---------------------------------------------------------------------------------------------------

const MOISTURIZER = searchRow({
  id: 'sig_1111111111111111111111111111aaaa', title: 'Toleriane Double Repair Face Moisturizer',
  brand: 'La Roche-Posay', price: 23, label: 'moisturizer', path: 'beauty/skincare/moisturize/cream',
});

test('a skincare rebound whose catalog path agrees still grounds, labelled with its OWN type', async () => {
  const plan = { name: 'Cicaplast Baume B5', brand: 'La Roche-Posay', product_type: 'moisturizer', score: 91 };
  const out = await ground([plan], [MOISTURIZER]);
  const item = out.recommendations[0];
  assert.equal(item.grounding_status, 'grounded');
  assert.equal(item.product_id, MOISTURIZER.product_id);
  assert.equal(item.__pivota_score_basis, 'catalog_rebound');
  assert.equal(item.catalog_category_path, 'beauty/skincare/moisturize/cream', 'the path survived the durable cache');
  const response = await door(out, 'a moisturizer for a damaged barrier');
  assert.equal(response.signals.length, 1);
  assert.equal(response.signals[0].value.lane_confidence.basis, 'catalog_rebound');
  assert.equal(response.signals[0].value.lane_confidence.level, null);
});

test('a skincare row LABELLED as the request but filed elsewhere is refused, and the next row is tried', async () => {
  // The label says moisturiser and so does the title; the reviewed path says foundation. Ranked AHEAD
  // of the real moisturiser, so the gate is the only thing between it and the item.
  const filedElsewhere = searchRow({
    id: 'sig_3333333333333333333333333333cccc', title: 'Barrier Repair Face Moisturizer Stick', brand: 'Example',
    price: 19, label: 'moisturizer', path: 'beauty/makeup/face/foundation',
  });
  const plan = { name: 'Cicaplast Baume B5', brand: 'La Roche-Posay', product_type: 'moisturizer', score: 91 };
  const out = await ground([plan], [filedElsewhere, MOISTURIZER]);
  // Mutant killed: `break` instead of `continue` on a refusal -- the item would go ungrounded although
  // a compatible substitute sat right behind the refused one.
  assert.equal(out.recommendations[0].product_id, MOISTURIZER.product_id);
  assert.equal(out.debug.rebound_rejected_by_reason.catalog_category_other_domain, 1);
});

test('a skincare leaf from an incompatible family is refused', async () => {
  const cleanserFiledRow = searchRow({
    id: 'sig_2222222222222222222222222222bbbb', title: 'Daily SPF 50 Cleansing Foam', brand: 'Example',
    price: 15, label: 'sunscreen', path: 'beauty/skincare/cleanse/cleanser',
  });
  const out = await ground([{ name: 'Unseen Sunscreen SPF 40', brand: 'Supergoop', product_type: 'sunscreen', score: 90 }], [cleanserFiledRow]);
  assert.equal(out.recommendations[0].grounding_status, 'ungrounded');
  assert.equal(out.debug.rebound_rejected_by_reason.catalog_category_incompatible, 1);
});

// ---------------------------------------------------------------------------------------------------
// 3. The gate's own decisions, including the fallback for rows that carry no path.
// ---------------------------------------------------------------------------------------------------

test('judgeRecoReboundCandidate: every makeup and fragrance step refuses, whatever the candidate', () => {
  for (const step of ['blush', 'bronzer', 'highlighter', 'foundation', 'concealer', 'face_powder', 'primer', 'lip_colour', 'eye_colour', 'fragrance']) {
    const verdict = judgeRecoReboundCandidate({ requestedStep: step, candidate: { catalog_category_path: 'beauty/makeup/face/blush', category: step } });
    assert.deepEqual(verdict, { accept: false, reason: 'shade_or_scent_led_type' }, step);
  }
});

test('judgeRecoReboundCandidate: path roots, leaves and the no-path fallback', () => {
  const judge = (requestedStep, candidate) => judgeRecoReboundCandidate({ requestedStep, candidate });
  // Body care is skincare to this door; self-tan and other roots are not.
  assert.equal(judge('moisturizer', { catalog_category_path: 'beauty/body/care', name: 'Daily Body Lotion' }).accept, true);
  for (const path of ['beauty/body/tanning', 'beauty/haircare/conditioner', 'beauty/tools/brush', 'beauty/sets/gift-set', 'beauty/devices/skincare-energy', 'beauty/skincarex/foo']) {
    assert.equal(judge('moisturizer', { catalog_category_path: path, name: 'Daily Moisture Cream' }).reason, 'catalog_category_other_domain', path);
  }
  // A path too coarse to name a step proves the domain only: the row's own words must name the kind.
  // Mutant killed: accepting every unmapped skincare/body path -- a body-care path would then stand in
  // for any step with no title check at all.
  assert.deepEqual(judge('sunscreen', { catalog_category_path: 'beauty/body/care', name: 'Gentle Body Cleanser' }), { accept: false, reason: 'own_type_incompatible' });
  assert.deepEqual(judge('sunscreen', { catalog_category_path: 'beauty/body/care', name: 'The Daily Ritual' }), { accept: false, reason: 'no_category_evidence' });
  assert.deepEqual(judge('sunscreen', { catalog_category_path: 'beauty/skincare/treat', name: 'Daily Calm Serum' }), { accept: false, reason: 'own_type_incompatible' });
  assert.equal(judge('moisturizer', { catalog_category_path: 'beauty/body', name: 'Body Lotion' }).accept, true, '"beauty/body" alone decides nothing');
  // Adjacent leaves pass (the taxonomy is coarser than the steps: there is no essence leaf).
  assert.equal(judge('essence', { catalog_category_path: 'beauty/skincare/tone/toner' }).accept, true);
  assert.equal(judge('sunscreen', { catalog_category_path: 'beauty/skincare/moisturize/cream' }).accept, true);
  // A mid-level path proves the domain and no more.
  assert.equal(judge('serum', { catalog_category_path: 'beauty/skincare/treat', name: 'Hydrating Serum' }).accept, true);
  // The path outranks the label in both directions.
  assert.equal(judge('cleanser', { catalog_category_path: 'beauty/skincare/cleanse/cleanser', category: 'lipstick' }).accept, true);
  assert.equal(judge('cleanser', { catalog_category_path: 'beauty/makeup/lip/balm', category: 'cleanser' }).accept, false);
  // The search's response hint writes the REQUESTED prefix into a row that has no path, and marks it.
  // Mutant killed: reading that path as the product's own category -- it would approve this lipstick
  // as a cleanser, since the hint says cleanser.
  const hinted = { category_path: 'beauty/skincare/cleanse/cleanser', catalog_category_path: 'beauty/skincare/cleanse/cleanser', category_path_inferred_from_query: true, name: 'Hydrating Face Serum' };
  assert.equal(readCatalogCategoryPath(hinted), '');
  assert.deepEqual(judge('cleanser', hinted), { accept: false, reason: 'own_type_incompatible' });
  // A requested type that resolves to no step has nothing to be compatible with. (End to end such an
  // item builds no recall queries at all today, so this branch is the gate's own floor, not a path the
  // pass currently reaches.)
  assert.deepEqual(judge('other', { catalog_category_path: 'beauty/skincare/moisturize/cream' }), { accept: false, reason: 'requested_type_unresolved' });
  assert.deepEqual(judge('', {}), { accept: false, reason: 'requested_type_unresolved' });
  // No path: the row's own type, else its title, must name a compatible step.
  assert.deepEqual(judge('cleanser', { category: 'lipstick' }), { accept: false, reason: 'own_type_incompatible' });
  assert.deepEqual(judge('cleanser', { product_type: 'serum' }), { accept: false, reason: 'own_type_incompatible' });
  assert.deepEqual(judge('cleanser', { category: 'cleanser' }), { accept: true, reason: 'own_type_compatible' });
  // Each field is tried on its own: a category that maps to no step must not hide a product_type that
  // does. Mutant killed: `category || product_type` as one string.
  assert.deepEqual(judge('moisturizer', { category: 'Skincare', product_type: 'cream' }), { accept: true, reason: 'own_type_compatible' });
  // And they must agree. Mutant killed: taking the first field that resolves -- a cleanser typed
  // "serum" would then stand in for a serum.
  assert.deepEqual(judge('serum', { product_type: 'serum', name: 'Gentle Foaming Cleanser' }), { accept: false, reason: 'own_type_incompatible' });
  // The candidate's own title is held to rule 2 as well, after the same masking.
  assert.deepEqual(judge('treatment', { product_type: 'Treatment', name: 'Hair Perfector No.3' }), { accept: false, reason: 'non_skin_candidate' });
  assert.deepEqual(judge('toner', { product_type: 'mist', name: 'Fragrance Body Mist' }), { accept: false, reason: 'non_skin_candidate' });
  assert.deepEqual(judge('toner', { catalog_category_path: 'beauty/skincare/tone/toner', name: 'Lash & Brow Conditioning Mist' }), { accept: false, reason: 'non_skin_candidate' });
  assert.deepEqual(judge('cleanser', { name: 'Fragrance-Free Gentle Cleanser' }), { accept: true, reason: 'own_type_compatible' });
  assert.deepEqual(judge('cleanser', { name: 'Gentle Cleanser that removes makeup' }), { accept: true, reason: 'own_type_compatible' });
  // Mutant killed: testing the candidate's title unmasked -- "Parfum-Free" would read as a perfume.
  assert.deepEqual(judge('cleanser', { name: 'Hydrating Cleanser, Parfum-Free' }), { accept: true, reason: 'own_type_compatible' });
  assert.deepEqual(judge('cleanser', { catalog_category_path: 'beauty/skincare/cleanse/cleanser', name: 'Oud Wood Parfum' }), { accept: false, reason: 'non_skin_candidate' });
  assert.deepEqual(judge('moisturizer', { catalog_category_path: 'beauty/skincare/moisturize/cream', name: 'Firming Eye Contour Cream' }), { accept: true, reason: 'catalog_category_compatible' });
  // On a row the search marked as inferred, category/product_type may be the REQUEST (the hint fills
  // them when empty), so only the title speaks. Mutant killed: reading them anyway.
  assert.deepEqual(
    judge('cleanser', { category: 'cleanser', product_type: 'cleanser', category_path_inferred_from_query: true, name: 'The Everyday Stick' }),
    { accept: false, reason: 'no_category_evidence' },
  );
  assert.deepEqual(
    judge('cleanser', { category: 'cleanser', category_path_inferred_from_query: true, name: 'The Daily Ritual' }),
    { accept: false, reason: 'no_category_evidence' },
  );
  // A seed row's type is 'external'; its title is then the witness, in both directions.
  assert.deepEqual(judge('cleanser', { product_type: 'external', name: 'Gentle Foaming Cleanser' }), { accept: true, reason: 'own_type_compatible' });
  assert.deepEqual(judge('cleanser', { product_type: 'external', name: 'Hydrating Face Serum' }), { accept: false, reason: 'own_type_incompatible' });
  // A makeup or fragrance title never gets as far as its type. ("lipstick" is not the word "lip"; and
  // "Lipikar" is a body moisturiser, so the list names lip products rather than matching a prefix.)
  assert.deepEqual(judge('cleanser', { product_type: 'external', name: 'Velvet Matte Lipstick' }), { accept: false, reason: 'non_skin_candidate' });
  assert.deepEqual(judge('cleanser', { product_type: 'external', name: 'Santal Blush Eau de Parfum' }), { accept: false, reason: 'non_skin_candidate' });
  assert.equal(judge('moisturizer', { catalog_category_path: 'beauty/body/care', name: 'Lipikar Balm AP+M Body Moisturizer' }).accept, true);
  // Mutant killed: accepting a substitute nothing identifies -- the "always skincare" promise would
  // then rest on a row typed 'external' with a title no step pattern reads.
  assert.deepEqual(judge('cleanser', { product_type: 'external', name: 'The Daily Ritual' }), { accept: false, reason: 'no_category_evidence' });
  assert.deepEqual(judge('cleanser', {}), { accept: false, reason: 'no_category_evidence' });
});

test('judgeRecoReboundCandidate: an item naming fragrance, hair, scalp or lips is not face/body skincare', () => {
  // The step resolver reads these as skincare steps ("body mist" -> toner, "hair treatment" ->
  // treatment, "lip mask" -> mask), so the domain check alone let a facial toner stand in for a mist.
  const toner = { catalog_category_path: 'beauty/skincare/tone/toner' };
  for (const [requestedStep, requestedText] of [
    ['toner', 'body mist Cheirosa 62 Hair & Body Fragrance Mist'],
    ['toner', 'fragrance mist'],
    ['treatment', 'hair treatment Bond Repair Treatment'],
    ['serum', 'scalp serum'],
    ['mask', 'lip mask Lip Sleeping Mask'],
    // Makeup typed with a skincare word: the resolver settles these to toner / serum / moisturizer.
    ['toner', 'setting mist Urban Decay All Nighter Setting Mist'],
    ['serum', 'serum Rare Beauty Liquid Touch Serum Foundation'],
    ['moisturizer', 'cream Glow Highlighter Cream'],
    ['serum', 'serum Lash Growth Serum'],
    ['moisturizer', 'lotion Gradual Self-Tan Lotion'],
  ]) {
    assert.deepEqual(judgeRecoReboundCandidate({ requestedStep, requestedText, candidate: toner }),
      { accept: false, reason: 'non_skin_item' }, requestedText);
  }
  // A denial or a descriptor is not a category. Each of these is skincare and keeps its substitute.
  const cream = { catalog_category_path: 'beauty/skincare/moisturize/cream' };
  for (const [requestedStep, requestedText, candidate] of [
    ['toner', 'toner Fragrance-Free Hydrating Toner', toner],
    ['toner', 'toner with no added fragrance', toner],
    ['moisturizer', 'moisturizer Sans Parfum Hydrating Cream', cream],
    ['moisturizer', 'moisturizer 0% Fragrance Face Cream', cream],
    ['moisturizer', 'moisturizer 0% Parfum Face Cream', cream],
    ['moisturizer', 'body lotion Hand & Body Lotion with a light fragrance', cream],
    ['serum', 'serum Ingrown Hair Serum', { catalog_category_path: 'beauty/skincare/treat/serum' }],
    ['moisturizer', 'moisturizer Post Hair Removal Soothing Cream', cream],
    ['moisturizer', 'eye cream Eye & Lip Contour Cream', cream],
    ['cleanser', 'cleanser Eye and Lip Makeup Remover', { catalog_category_path: 'beauty/skincare/cleanse/cleanser' }],
    ['moisturizer', 'moisturizer Lipikar Balm AP+M', cream],
  ]) {
    assert.equal(judgeRecoReboundCandidate({ requestedStep, requestedText, candidate }).accept, true, requestedText);
  }
});

test('end to end: a serum foundation is not grounded to a niacinamide serum, nor a sunscreen to a self-tanner', async () => {
  const niacinamide = searchRow({
    id: 'sig_6666666666666666666666666666ffff', title: 'Niacinamide 10% + Zinc 1%', brand: 'Example',
    price: 6, label: 'serum', path: 'beauty/skincare/treat/serum',
  });
  const tan = searchRow({
    id: 'sig_7777777777777777777777777777aaaa', title: 'Self Tan Express Bronzing Mousse', brand: 'Example',
    price: 40, label: 'sunscreen', path: 'beauty/body/tanning',
  });
  for (const run of Object.values(PATHS)) {
    const foundation = await run([{ name: 'Liquid Touch Serum Foundation', brand: 'Rare Beauty', product_type: 'serum', score: 88 }], [niacinamide]);
    assert.equal(foundation.recommendations[0].grounding_status, 'ungrounded');
    const spf = await run([{ name: 'Unseen Sunscreen SPF 40', brand: 'Supergoop', product_type: 'sunscreen', score: 88 }], [tan]);
    assert.equal(spf.recommendations[0].grounding_status, 'ungrounded');
  }
});

test('judgeRecoReboundCandidate: a need that ASKS FOR makeup or fragrance gets no substitute', () => {
  const toner = { catalog_category_path: 'beauty/skincare/tone/toner', name: 'Hydrating Toner' };
  const judge = (needText) => judgeRecoReboundCandidate({ requestedStep: 'toner', requestedText: 'toner Facial Mist', needText, candidate: toner });
  for (const need of [
    'a setting mist that keeps makeup in place all day', // the resolver reads this as toner: gap list
    'a setting spray for oily skin',
    'a setting-spray',
    'a mist to set my makeup',
    'a makeup fixing spray',
    'a fixing spray for oily skin',
    'long-wear setting powder', // the context mask would blank "wear setting powder"
    'a long-wear foundation',
    'an eyelash growth serum',
    'a serum for thicker eyebrows',
    'a body mist for summer',
    'a light floral eau de toilette',
    "a bronzer for fair skin that isn't too orange",
    'a tinted moisturizer with SPF', // resolves to foundation: shade-led
  ]) {
    assert.deepEqual(judge(need), { accept: false, reason: 'shade_or_scent_led_need' }, need);
  }
  // A need is a sentence: these MENTION non-skin words and still ask for skincare. Mutant killed:
  // holding the need to the item rule (every word) -- each of these lost its substitute in review.
  for (const need of [
    'a hydrating toner for dry skin',
    'a toner that sits well under makeup',
    'a toner to wear under foundation',
    // Mutant killed: resolving the need unmasked -- "foundation" would be the only step left.
    'something light to wear under my foundation',
    // Mutant killed: scanning the need unmasked for the resolver gaps -- context is not an ask.
    'a toner to use under my setting powder',
    'a fragrance-free toner',
    'a moisturizer for perioral dermatitis around my lips',
    'a cleanser and moisturizer, plus something for chapped lips',
    'a body lotion for dry hands and nails',
    'a serum for frown lines between my brows',
    'a firming and contouring neck cream',
    'a soothing lotion for after tanning',
    'moisturizer without fragrance or perfume',
    'a body lotion with a light perfume',
    'a face wash for men with facial hair',
    'a serum to build a good foundation for my routine',
    '',
  ]) {
    assert.deepEqual(judge(need), { accept: true, reason: 'catalog_category_compatible' }, need);
  }
});

test('end to end: a fragrance mist plan is not grounded to a facial toner', async () => {
  const toner = searchRow({
    id: 'sig_4444444444444444444444444444dddd', title: 'Rose Hydrating Facial Toner', brand: 'Example',
    price: 22, label: 'toner', path: 'beauty/skincare/tone/toner',
  });
  // The type alone ('mist') reads as toner; only the NAME says fragrance. Mutant killed: judging the
  // item's type without its name.
  const out = await ground([{ name: 'Cheirosa 62 Hair & Body Fragrance Mist', brand: 'Sol de Janeiro', product_type: 'mist', score: 85 }], [toner]);
  assert.equal(out.recommendations[0].grounding_status, 'ungrounded');
  assert.equal(out.debug.rebound_rejected_by_reason.non_skin_item, 1);
});

test('a makeup pick named WITHOUT an id is withheld, even when a catalog title shares every word of it', async () => {
  // A name match was tried and reverted: brand + name words cannot tell the model's "Retro Matte
  // Lipstick" (in Ruby Woo, a red) from the catalog's "Retro Matte Lipstick - Velvet Teddy" (a nude) --
  // the live nude-for-red swap again. Picks from the candidates the model was shown carry ids and still
  // ground (the test above); a product named without one goes to unresolved_archetypes.
  const velvetTeddy = searchRow({
    id: 'sig_5555555555555555555555555555eeee', title: 'Retro Matte Lipstick - Velvet Teddy', brand: 'MAC',
    price: 25, label: 'lipstick', path: 'beauty/makeup/lip/lipstick',
  });
  const plan = { brand: 'MAC', name: 'Retro Matte Lipstick', display_name: 'Ruby Woo', product_type: 'lipstick', score: 90 };
  for (const run of Object.values(PATHS)) {
    const out = await run([plan], [velvetTeddy]);
    assert.equal(out.recommendations[0].grounding_status, 'ungrounded');
    assert.equal(out.debug.rebound_rejected_by_reason.shade_or_scent_led_type, 1);
  }
});

test('real search rows: a seed row\'s own string path is read; a path the search inferred from the query is not', () => {
  const debug = require('../src/server')._debug;
  const seed = (catalogCategoryPath) => debug.compactBeautyMainlineProductForResponse(debug.buildBeautyExternalSeedMainlineProduct({
    id: 'eps_x', external_product_id: 'ext_abc', title: 'Barrier Repair Face Moisturizer Stick', brand: 'Example',
    domain: 'example.com', canonical_url: 'https://example.com/products/x', market: 'US', availability: 'in_stock',
    price_amount: 19, price_currency: 'USD', catalog_category_path: catalogCategoryPath,
    seed_data: { snapshot: { title: 'Barrier Repair Face Moisturizer Stick', brand: 'Example', price: 19, currency: 'USD' } },
  }), null, 'moisturizer');
  const asCandidate = (row) => __internal.normalizeRecoCatalogProduct({ ...row, product_id: 'sig_3333333333333333333333333333cccc' });
  const request = { requestedStep: 'moisturizer', requestedText: 'moisturizer Cicaplast Baume B5' };

  // The seed builder writes the row's REAL path as a string into both fields. Mutant killed: treating
  // a string category_path as the hint's -- the foundation would pass on its "Moisturizer" title.
  const filed = seed('beauty/makeup/face/foundation');
  assert.equal(typeof filed.category_path, 'string');
  assert.deepEqual(judgeRecoReboundCandidate({ ...request, candidate: asCandidate(filed) }),
    { accept: false, reason: 'catalog_category_other_domain' });

  // A row with no path gets the QUERY's prefix from the response hint, marked as inferred.
  const contract = {
    contract_version: 'search_quality_contract_v1', target_domain: 'beauty', query_class: 'category_browse',
    effective_query: 'moisturizer', hard_constraints: { category_path_prefix: 'beauty/skincare/moisturize/cream/' }, soft_preferences: {},
  };
  const hinted = debug.applySearchQualityContractResponseHints(seed(null), contract, 'moisturizer');
  assert.equal(hinted.catalog_category_path, 'beauty/skincare/moisturize/cream', 'the hint ran');
  assert.equal(hinted.category_path_inferred_from_query, true);
  const candidate = asCandidate(hinted);
  assert.equal(candidate.catalog_category_path, undefined, 'the inferred path is not carried as the product\'s own');
  assert.equal(candidate.category_path_inferred_from_query, true, 'the mark survives normalize');
  assert.equal(sanitizeRecoRecallPoolCandidates([candidate])[0].category_path_inferred_from_query, true, 'and the durable cache');
  // Judged on its own title instead.
  assert.deepEqual(judgeRecoReboundCandidate({ ...request, candidate }), { accept: true, reason: 'own_type_compatible' });
});

test('every skincare leaf maps to a real step, and the table covers the captured taxonomy', () => {
  const { leaves } = require('./fixtures/recall_taxonomy_leaves.json');
  const skincareLeaves = leaves.filter((leaf) => leaf.split('/').length === 4 && leaf.startsWith('beauty/skincare/'));
  assert.deepEqual(Object.keys(SKINCARE_LEAF_STEP).sort(), skincareLeaves.sort(),
    'a skincare leaf added upstream must be mapped here on purpose');
  const { normalizeRecoTargetStep } = require('../src/auroraBff/recoTargetStep');
  for (const [leaf, step] of Object.entries(SKINCARE_LEAF_STEP)) {
    assert.equal(normalizeRecoTargetStep(step), step, leaf);
  }
});

test('readCatalogCategoryPath reads both spellings and normalises them', () => {
  assert.equal(readCatalogCategoryPath({ category_path: ['Beauty', 'Makeup', 'Lip', 'Balm'] }), 'beauty/makeup/lip/balm');
  assert.equal(readCatalogCategoryPath({ catalog_category_path: 'beauty/fragrance/perfume' }), 'beauty/fragrance/perfume');
  assert.equal(readCatalogCategoryPath({ catalog_category_path: 'beauty/fragrance/perfume', category_path: ['beauty', 'makeup'] }), 'beauty/fragrance/perfume');
  assert.equal(readCatalogCategoryPath({ category_path: 'beauty/makeup/face/foundation' }), 'beauty/makeup/face/foundation', 'a seed row spells it as a string');
  assert.equal(readCatalogCategoryPath({ catalog_category_path: 'beauty/makeup/face/foundation', category_path_inferred_from_query: true }), '');
  assert.equal(readCatalogCategoryPath({}), '');
  assert.equal(readCatalogCategoryPath(null), '');
});

test('the catalog path survives normalize and the durable cache, from either spelling', () => {
  for (const pathAs of ['array', 'string']) {
    const pool = cachedPoolFrom([searchRow({ ...LIVE[0].row, id: LIVE[0].row.product_id, path: 'beauty/makeup/lip/balm', label: 'Bronzer', pathAs })]);
    assert.equal(pool[0].catalog_category_path, 'beauty/makeup/lip/balm', pathAs);
  }
});

// ---------------------------------------------------------------------------------------------------
// 4. The merge no longer labels a substitute with the requested type.
// ---------------------------------------------------------------------------------------------------

test('a substitute keeps its own type, or none -- never the requested one', () => {
  const plan = { name: 'Hoola Matte Bronzer', brand: 'Benefit', product_type: 'bronzer', score: 90 };
  const unlabelled = { product_id: 'sig_3388a5e139e21623163e558d86e66741', merchant_id: 'external_seed', name: 'Lip Moisturising Stick' };
  const merged = __internal.mergeRecoPlanWithGroundedCandidate(plan, unlabelled);
  assert.equal(merged.__pivota_score_basis, 'catalog_rebound');
  assert.equal(merged.category, null, 'category fell back to the requested type');
  assert.equal(merged.product_type, undefined);
  assert.equal(merged.sku.product_type, undefined, 'sku.product_type was stamped with the requested type');
  const labelled = __internal.mergeRecoPlanWithGroundedCandidate(plan, { ...unlabelled, product_type: 'balm' });
  assert.equal(labelled.product_type, 'balm');
  assert.equal(labelled.sku.product_type, 'balm');
  assert.equal(labelled.category, 'balm');
  // The model's own product keeps the type it was asked for, as before.
  const same = __internal.mergeRecoPlanWithGroundedCandidate(
    { ...plan, product_id: unlabelled.product_id, merchant_id: 'external_seed' },
    unlabelled,
  );
  assert.equal(same.sku.product_type, 'bronzer');
  assert.equal(same.category, 'bronzer');
});

// ---------------------------------------------------------------------------------------------------
// 5. Query terms: no "skincare" suffix on a makeup or fragrance type.
// ---------------------------------------------------------------------------------------------------

test('a makeup or fragrance plan item is not queried as "<type> skincare"', () => {
  for (const productType of ['bronzer', 'cream blush', 'lipstick', 'eau de toilette', 'perfume']) {
    for (const lang of ['EN', 'CN']) {
      const terms = __internal.deriveRecoPlanQueryTerms({ product_type: productType }, lang);
      assert.deepEqual(terms, [productType], `${productType}/${lang}: ${JSON.stringify(terms)}`);
    }
  }
  // The skincare lane is unchanged.
  assert.deepEqual(__internal.deriveRecoPlanQueryTerms({ product_type: 'cleanser' }, 'EN'), ['cleanser', 'cleanser skincare']);
  assert.deepEqual(__internal.deriveRecoPlanQueryTerms({ product_type: 'cleanser' }, 'CN'), ['cleanser', 'cleanser 护肤']);
  assert.deepEqual(__internal.deriveRecoPlanQueryTerms({}, 'EN'), ['skincare', 'skincare skincare']);
});
