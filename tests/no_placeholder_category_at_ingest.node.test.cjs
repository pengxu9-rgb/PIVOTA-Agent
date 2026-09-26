'use strict';

// AN UNCATEGORISED ROW MUST NOT BE WRITTEN WITH A PLACEHOLDER CATEGORY.
//
// Three committed writers stamped `category_path = 'beauty'` on rows they could not categorise:
//   scripts/sync-external-seeds-to-catalog.cjs          -- terminal fallback of the category ladder
//   scripts/sync-ulta-external-seeds-to-catalog.cjs     -- no classifier at all, so for every row
//   scripts/apply-reviewed-external-seed-category-patch.cjs -- validator regex `/^beauty(?:\/|$)/`
//
// `beauty` is a NAMESPACE, not an answer to "what is this", and it is the worst available answer,
// because it fails in two directions at once: the row is unretrievable by category-scoped recall at
// serving, AND it looks finished to every tool that would repair it -- pivota-backend's regex
// backfill selects `WHERE category_path IS NULL`, and an off-taxonomy health check passes a bare
// domain because `beauty` IS on the taxonomy (services/category_path_aliases.py builds
// ANCESTOR_NODES with `range(1, len(parts))`, so every root is a node: `has_category_door("beauty")`
// is True while `resolve("beauty")` is None).
//
// Measured on the live index via search_catalog("eau de parfum"): 16 of 50 rows sit on bare
// `beauty` -- the entire Ariana Grande fragrance line (Cloud, Cloud 2.0, Cloud Pink, Ari, God Is A
// Woman, r.e.m.), Cosmic Kylie Jenner, every PixiPerfume.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  categoryPathIsCategorised,
  MIN_CATEGORISED_PATH_SEGMENTS,
  CANONICAL_CATEGORY_PATHS,
} = require('../src/services/beautyTaxonomy');
const SYNC_INTERNALS = require('../scripts/sync-external-seeds-to-catalog.cjs')._internals;
const ULTA_INTERNALS = require('../scripts/sync-ulta-external-seeds-to-catalog.cjs')._internals;
const { inferCatalogMirrorCategory, buildMirror } = SYNC_INTERNALS;
const { buildMirror: buildUltaMirror } = ULTA_INTERNALS;
const {
  _internals: { validateEntry, buildCategoryPatchPlanForRow },
} = require('../scripts/apply-reviewed-external-seed-category-patch.cjs');
const { normalizeFeedRecord, buildSeedRowFromOYOffer } = require('../src/services/oliveYoungAffiliateFeed');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const SYNC_SRC = fs.readFileSync(path.join(SCRIPTS, 'sync-external-seeds-to-catalog.cjs'), 'utf8');
const ULTA_SRC = fs.readFileSync(path.join(SCRIPTS, 'sync-ulta-external-seeds-to-catalog.cjs'), 'utf8');
const OY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'oliveYoungAffiliateFeed.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. The rule itself, and that it is ONE rule across the three writers.
// ---------------------------------------------------------------------------

test('a bare top-level domain is not a categorisation; two segments is', () => {
  for (const value of ['beauty', 'beauty/', '/beauty/', 'fashion', 'electronics', '', '   ', null, undefined]) {
    assert.equal(
      categoryPathIsCategorised(value),
      false,
      `${JSON.stringify(value)} must not count as categorised`,
    );
  }
  for (const value of [
    'beauty/fragrance',
    'beauty/fragrance/perfume',
    'beauty/skincare/treat/serum',
    'beauty/makeup/face/blush',
    ['beauty', 'fragrance'],
    '/beauty/fragrance/',
  ]) {
    assert.equal(
      categoryPathIsCategorised(value),
      true,
      `${JSON.stringify(value)} must count as categorised`,
    );
  }
  // The threshold is the rule. pivota-backend's is_categorised_path() and the serving-side
  // categoryPathIsCategorised both require >= 2 segments; a silent bump here is the drift.
  assert.equal(MIN_CATEGORISED_PATH_SEGMENTS, 2);
});

// ---------------------------------------------------------------------------
// 2. Writer 1 -- scripts/sync-external-seeds-to-catalog.cjs
// ---------------------------------------------------------------------------

function seedRow(overrides = {}) {
  const { seed_data: seedData, ...rest } = overrides;
  return {
    mirror_merchant_id: 'external_seed',
    id: 'eps_probe',
    external_product_id: 'ext_probe',
    market: 'US',
    domain: 'example.com',
    title: 'Probe Product',
    image_url: 'https://cdn.example.com/probe.jpg',
    price_amount: 42,
    price_currency: 'USD',
    availability: 'in_stock',
    canonical_url: 'https://example.com/products/probe',
    status: 'active',
    identity_listing: {
      identity_status: 'approved',
      live_read_enabled: true,
      review_required: false,
      source_tier: 'brand',
    },
    ...rest,
    seed_data: {
      brand: 'Probe Brand',
      description: 'A reviewed product with source-backed content and current commerce details.',
      ...seedData,
    },
  };
}

// Rows that NO branch of the ladder can classify. Each one previously came back on `beauty`.
// This is a vocabulary, not a single probe: the fragrance branch added below fixes one uncovered
// category, and the point of the change is that the NEXT uncovered category does not get a
// placeholder either.
const UNCATEGORISABLE = [
  { title: 'Ari', note: 'a real stranded row: an Ariana Grande fragrance whose title names nothing' },
  { title: 'God Is A Woman', note: 'ditto -- title carries no product noun at all' },
  { title: 'r.e.m.', note: 'ditto' },
  { title: 'Bibbidi Bobbidi Boo', note: 'an invented name in no covered category' },
  { title: 'Widget 3000', note: 'a category the ladder has never heard of' },
];

test('writer 1: a row the ladder cannot classify gets NO category, not `beauty`', () => {
  for (const probe of UNCATEGORISABLE) {
    const shape = inferCatalogMirrorCategory(seedRow({ title: probe.title }));
    assert.equal(
      shape.categoryPath,
      '',
      `${probe.title} (${probe.note}) must come back uncategorised, got ${JSON.stringify(shape.categoryPath)}`,
    );
    assert.equal(
      categoryPathIsCategorised(shape.categoryPath),
      false,
      `${probe.title} must not satisfy the ingest gate`,
    );
  }
});

test('writer 1: the mirror row carries the empty path to the sink the gate reads', () => {
  // Asserting the classifier returned '' is not asserting the WRITE is empty -- buildMirror is the
  // thing that lands `category_path`, and a later line could re-introduce a default. Assert at the
  // column.
  const mirror = buildMirror(seedRow({ title: 'Widget 3000' }));
  assert.equal(mirror.product.category_path, '');
  assert.equal(mirror.product.product_payload.category_path, '');
  assert.equal(categoryPathIsCategorised(mirror.product.category_path), false);
  // And the product_type placeholder goes with it: `Beauty Product` is the same fiction in the
  // taxonomy field next door.
  assert.notEqual(mirror.product.product_type, 'Beauty Product');
});

// THE GATE IS DRIVEN, NOT READ. The two tests this replaces were pure source-text pins
// (`indexOf` + `assert.match`), and a source pin cannot see a broken BINDING. Both stayed green
// when the imported predicate was swapped for `() => true`, and when the destructured import was
// mistyped so the binding was `undefined` -- which in production throws
// `TypeError: categoryPathIsCategorised is not a function` on the FIRST row and aborts the entire
// batch, i.e. precisely the failure the "per-row skip, not a throw" shape exists to prevent.
for (const [name, internals, src] of [
  ['writer 1', SYNC_INTERNALS, SYNC_SRC],
  ['writer 2', ULTA_INTERNALS, ULTA_SRC],
]) {
  test(`${name}: the gate's predicate IS the shared module export, not a look-alike`, () => {
    assert.equal(
      internals.categoryPathIsCategorised,
      categoryPathIsCategorised,
      `${name} must gate on beautyTaxonomy's export; a local stub or a mistyped import that resolves `
        + 'to undefined is the failure this pins',
    );
    assert.equal(typeof internals.categoryPathIsCategorised, 'function');
  });

  test(`${name}: the gate skips an uncategorised mirror with a counted reason, and admits a real one`, () => {
    const skip = internals.mirrorCategorySkipReason({
      row: { external_product_id: 'ext_probe' },
      product: { category_path: 'beauty', title: 'Widget 3000' },
    });
    assert.ok(skip, 'a bare domain must produce a skip record');
    assert.equal(skip.reason, 'category_path_uncategorised');
    assert.equal(skip.external_product_id, 'ext_probe');
    assert.equal(skip.category_path, 'beauty');

    for (const empty of ['', null, undefined]) {
      assert.ok(
        internals.mirrorCategorySkipReason({ row: {}, product: { category_path: empty } }),
        `${JSON.stringify(empty)} must also skip`,
      );
    }
    assert.equal(
      internals.mirrorCategorySkipReason({ row: {}, product: { category_path: 'beauty/fragrance/perfume' } }),
      null,
      'a categorised path must be admitted',
    );
    // It must never throw -- applyMirrors wraps the batch in one BEGIN, so an exception here
    // discards the whole run rather than one row.
    assert.doesNotThrow(() => internals.mirrorCategorySkipReason(undefined));
    assert.doesNotThrow(() => internals.mirrorCategorySkipReason({}));
  });

  test(`${name}: run() consults the gate between building the mirror and writing it`, () => {
    // Still a source check, but now only for WIRING -- the behaviour above is driven. Deleting the
    // call is the mutant this catches.
    const at = src.indexOf('    const mirror = buildMirror(row);');
    assert.ok(at > 0, 'the row loop must still call buildMirror');
    const end = src.indexOf('    mirrors.push(mirror);', at);
    assert.ok(end > at, 'the row loop must still push mirrors');
    const body = src.slice(at, end);
    assert.match(body, /const categorySkip = mirrorCategorySkipReason\(mirror\);/);
    assert.match(body, /skipped\.push\(categorySkip\);/);
    assert.match(body.slice(body.indexOf('const categorySkip')), /continue;/);
    assert.doesNotMatch(body.slice(body.indexOf('const categorySkip')), /throw new Error/);
  });
}

test('writer 1: the fragrance branch admits real stranded rows from the live index', () => {
  // Verbatim titles measured on the live index sitting on bare `beauty`, plus the forms the ladder
  // had no arm for at all.
  const FRAGRANCE = [
    'Cloud Eau de Parfum - 3.4 oz',
    'Cosmic Kylie Jenner Eau de Parfum',
    'PixiPerfume Eau de Parfum - PixiRose',
    'ABSOLUS ALLEGORIA Tabac Sahara - Eau de Parfum',
    'Black Orchid Eau de Toilette',
    'Rose Perfume',
    'Grey Vetiver Parfum',
    'Azure Lime Cologne',
  ];
  for (const title of FRAGRANCE) {
    const shape = inferCatalogMirrorCategory(seedRow({ title }));
    assert.equal(
      shape.categoryPath,
      CANONICAL_CATEGORY_PATHS.fragrance,
      `${title} must classify as fragrance, got ${JSON.stringify(shape.categoryPath)}`,
    );
    assert.equal(categoryPathIsCategorised(shape.categoryPath), true);
  }
});

test('writer 1: the fragrance branch takes no row away from a branch that had it right', () => {
  // A NEW BRANCH MAY ONLY EVER CLAIM ROWS THAT WERE HEADED FOR THE PLACEHOLDER. Placed FIRST in the
  // ladder, this branch was measured over a 6,607-title corpus stealing five rows from branches
  // that had them right; running last makes it purely additive. These are the measured casualties,
  // pinned as controls -- each one names a fragrance word while being something else.
  const CONTROLS = [
    ['Neutrogena Hydro Boost Hyaluronic Acid Water Gel with Signature Fragrance', 'beauty/skincare/moisturizer'],
    ['Perfume Nourishing Body Cream Pure', 'beauty/skincare/moisturizer'],
    ['Santal Blush Eau de Parfum', 'beauty/makeup/blush'],
    ['Sun Stalk’r Sunscreen SPF 30, Fragrance Free', 'beauty/skincare/sunscreen'],
    ['Fragrance-Free Gentle Cleanser', 'beauty/skincare/cleanser'],
  ];
  for (const [title, expected] of CONTROLS) {
    const shape = inferCatalogMirrorCategory(seedRow({ title }));
    assert.equal(
      shape.categoryPath,
      expected,
      `${title} must stay on ${expected}, got ${JSON.stringify(shape.categoryPath)}`,
    );
  }
});

const INCI_DESCRIPTION = 'Ingredients: Aqua, Glycerin, Parfum (Fragrance), Tocopherol, Limonene.';

test('writer 1: a "fragrance free" claim is not a fragrance, in every hyphen the web uses', () => {
  // THE GUARD HAS TO BE THE REASON THIS PASSES. The two "fragrance free" rows in the CONTROLS list
  // above are claimed by EARLIER ladder branches (sunscreen, cleanser), so deleting the guard left
  // them green -- the same "passes for the wrong reason" defect this suite already fixed once for
  // the INCI probe. These titles reach the end of the ladder unclaimed, so only the guard can save
  // them.
  //
  // And the separators are real: the guard was `[\s-]*`, which accepts an ASCII hyphen and nothing
  // else, so a typographic hyphen, non-breaking hyphen, en dash or minus sign all classified a
  // fragrance-free product as a perfume.
  const SEPARATORS = [
    ['-', 'hyphen-minus'],
    ['\u2010', 'U+2010 hyphen'],
    ['\u2011', 'U+2011 non-breaking hyphen'],
    ['\u2013', 'U+2013 en dash'],
    ['\u2212', 'U+2212 minus sign'],
    [' ', 'space'],
    ['\u00a0', 'U+00A0 no-break space'],
  ];
  for (const [sep, label] of SEPARATORS) {
    const title = `Fragrance${sep}Free Daily Elixir`;
    const shape = inferCatalogMirrorCategory(seedRow({ title }));
    assert.notEqual(
      shape.categoryPath,
      CANONICAL_CATEGORY_PATHS.fragrance,
      `a fragrance-free claim written with ${label} must not classify as a fragrance`,
    );
  }
  // Control: the guard must not be swallowing everything -- drop the "free" and it IS a fragrance.
  assert.equal(
    inferCatalogMirrorCategory(seedRow({ title: 'Fragrance Daily Elixir' })).categoryPath,
    CANONICAL_CATEGORY_PATHS.fragrance,
  );
});

test('writer 1: a fragrance word inside a LONGER word is not a fragrance', () => {
  // `\bperfume` / `\bparfum` had no TRAILING boundary, so they matched inside ordinary words.
  //
  // THE PROBES CARRY NO VETO WORD, AND THAT IS THE POINT. An earlier version of this test used
  // "Perfumed Nail Polish" / "La Parfumerie Gift Card", and it could not fail: the veto caught
  // `polish` and `gift card` first, so restoring the unbounded pattern left the test green. These
  // titles reach the branch with nothing else to stop them, so only the boundary decides.
  for (const title of ['La Parfumerie', 'Parfumerie Boutique', 'Perfumery Studio Voucher', 'Perfumed Aura']) {
    assert.notEqual(
      inferCatalogMirrorCategory(seedRow({ title })).categoryPath,
      CANONICAL_CATEGORY_PATHS.fragrance,
      `${title} contains a fragrance word but is not a fragrance`,
    );
  }
  // Control: the bare nouns and their plurals must still match, or the boundary has gone too far.
  for (const title of ['Rose Perfume', 'Signature Perfumes', 'Grey Vetiver Parfum', 'Azure Lime Cologne']) {
    assert.equal(
      inferCatalogMirrorCategory(seedRow({ title })).categoryPath,
      CANONICAL_CATEGORY_PATHS.fragrance,
      `${title} names a fragrance`,
    );
  }
});

test('writer 1: the ladder names a lotion and a bare emulsion', () => {
  // Not cosmetic: over the 40 real ulta.com titles in the repo's readiness checkpoint these were
  // most of what fell through to the placeholder, and the branch only had `facial emulsion|face
  // emulsion` — so an emulsion calling itself "Face and Body" missed it.
  for (const title of [
    'Natural Moisturizing Factors + Inulin Body Lotion',
    'Niacinamide 5% Face and Body Emulsion for Dark Spots & Uneven Tone',
    'Retinal 0.2% Emulsion High-Strength Retinoid Nighttime Treatment',
  ]) {
    assert.equal(
      inferCatalogMirrorCategory(seedRow({ title })).categoryPath,
      'beauty/skincare/moisturizer',
      `${title} must reach a real category`,
    );
  }
});

test('writer 1: a line extension that names two product classes is skipped, not served as perfume', () => {
  // THE VETO ALWAYS WINS; there is no "unambiguous form" override. Every fragrance house ships
  // these, and filing them as perfume is worse than the placeholder being removed: it turns
  // "invisible to category browse" into "served as the wrong answer to a fragrance query".
  const AMBIGUOUS = [
    'Chanel No 5 Eau de Parfum Body Lotion',
    'Eau de Toilette Deodorant Spray',
    'Eau de Parfum Shower Gel',
    'Fenty Parfum Body Cr\u00e8me',
    'Perfume Storage Organizer Tray',
    'Perfume Atomizer Refillable Travel Bottle',
  ];
  for (const title of AMBIGUOUS) {
    assert.notEqual(
      inferCatalogMirrorCategory(seedRow({ title })).categoryPath,
      CANONICAL_CATEGORY_PATHS.fragrance,
      `${title} names a second product class and must not be filed as a fragrance`,
    );
  }
  // `Cr\u00e8me` vs `Cream` must not decide it: the accent alone used to flip the answer.
  assert.equal(
    inferCatalogMirrorCategory(seedRow({ title: 'Fenty Parfum Body Cr\u00e8me' })).categoryPath,
    inferCatalogMirrorCategory(seedRow({ title: 'Fenty Parfum Body Creme' })).categoryPath,
  );
  // Control: FRAGRANCE FORMATS are how fragrance is sold and must still classify.
  for (const title of ['COBALT PERFUME OIL 10ml', 'Roll On Perfume', 'Find Comfort Body & Hair Fragrance Mist']) {
    assert.equal(
      inferCatalogMirrorCategory(seedRow({ title })).categoryPath,
      CANONICAL_CATEGORY_PATHS.fragrance,
      `${title} is a fragrance format, not another product class`,
    );
  }
});

test('writer 1: `parfum` in an ingredient list does not make a product a fragrance', () => {
  // THIS IS THE TITLE-ONLY NARROWING, AND NOTHING ELSE. `haystack` folds in seed descriptions, and
  // `parfum` is an INCI ingredient name printed on a great many products that are not fragrances --
  // so the branch reads `explicitCategory` + the TITLE only.
  //
  // These probes are chosen so that ONLY that narrowing can save them: each title reaches the end
  // of the ladder unclaimed AND names no product class in the branch's veto list. Point the branch
  // at `haystack` and every one of them becomes a perfume. (An earlier probe, "Barrier Repair Body
  // Scrub", could not fail: the veto caught `scrub` first, so the test passed for the wrong reason
  // and a mutant that read descriptions survived it.)
  for (const title of ['Bath Soak', 'Pillow Spray', 'Shower Steamer']) {
    const shape = inferCatalogMirrorCategory(seedRow({ title, seed_data: { description: INCI_DESCRIPTION } }));
    assert.notEqual(
      shape.categoryPath,
      CANONICAL_CATEGORY_PATHS.fragrance,
      `${title} names no fragrance; only its INCI list does`,
    );
    assert.equal(shape.categoryPath, '', `${title} must be left uncategorised for the gate to skip`);
  }

  // Control: the SAME description on a row whose title does name a fragrance is still a fragrance,
  // so the assertion above is about the title and not about the branch being unreachable.
  const named = inferCatalogMirrorCategory(
    seedRow({ title: 'Bath Soak Eau de Parfum', seed_data: { description: INCI_DESCRIPTION } }),
  );
  assert.equal(named.categoryPath, CANONICAL_CATEGORY_PATHS.fragrance);
});

test('writer 1: a scented product of another class is left uncategorised, not filed as perfume', () => {
  // The veto, which is a separate mechanism from the narrowing above: a body scrub named after a
  // fragrance line is not a perfume, and landing it on beauty/fragrance/perfume would be the same
  // defect this PR removes, one level more specific. Skipping it keeps it repairable.
  const shape = inferCatalogMirrorCategory(seedRow({ title: 'Perfume Nourishing Body Scrub Pure' }));
  assert.notEqual(shape.categoryPath, CANONICAL_CATEGORY_PATHS.fragrance);
  assert.equal(categoryPathIsCategorised(shape.categoryPath), false);
});

// ---------------------------------------------------------------------------
// 3. Writer 2 -- scripts/sync-ulta-external-seeds-to-catalog.cjs
// ---------------------------------------------------------------------------

function ultaRow(overrides = {}) {
  const { seed_data: seedData, ...rest } = overrides;
  return {
    mirror_merchant_id: 'external_seed',
    id: 'eps_ulta_probe',
    external_product_id: 'ulta:probe',
    market: 'US',
    title: 'Probe Product',
    price_amount: 30,
    price_currency: 'USD',
    availability: 'in_stock',
    ...rest,
    seed_data: {
      brand: 'Probe Brand',
      canonical_url: 'https://www.ulta.com/p/probe',
      image_url: 'https://cdn.ulta.com/probe.jpg',
      description: 'A retailer offer mirrored from an Ulta brand listing.',
      ...seedData,
    },
  };
}

test('writer 2: an Ulta row is classified, not stamped `beauty`', () => {
  // The upstream producer never writes a per-product category_path, so BEFORE this change the
  // `|| 'beauty'` fallback was the value for the whole lane.
  const mirror = buildUltaMirror(ultaRow({ title: 'Cosmic Kylie Jenner Eau de Parfum' }));
  assert.equal(mirror.product.category_path, CANONICAL_CATEGORY_PATHS.fragrance);
  assert.equal(mirror.product.product_payload.category_path, CANONICAL_CATEGORY_PATHS.fragrance);
  assert.equal(categoryPathIsCategorised(mirror.product.category_path), true);
  // `retailer_offer` named a lane, not a product. The role is carried by source_role, which is
  // where every consumer reads it -- so the taxonomy field is free to say what the thing IS.
  assert.notEqual(mirror.product.product_type, 'retailer_offer');
  assert.equal(mirror.product.product_payload.source_role, 'retailer_offer');
});

test('writer 2: an unclassifiable Ulta row is left uncategorised for the gate to skip', () => {
  const mirror = buildUltaMirror(ultaRow({ title: 'Widget 3000' }));
  assert.equal(mirror.product.category_path, '');
  assert.equal(mirror.product.product_payload.category_path, '');
  assert.equal(categoryPathIsCategorised(mirror.product.category_path), false);
});

// ---------------------------------------------------------------------------
// 4. Writer 3 -- scripts/apply-reviewed-external-seed-category-patch.cjs
// ---------------------------------------------------------------------------

function reviewedEntry(categoryPath) {
  return {
    external_product_id: 'ext_reviewed',
    category: 'Perfume',
    product_type: 'Perfume',
    category_path: categoryPath,
    catalog_category_path: categoryPath,
    source_url: 'https://brand.example/products/thing',
    evidence: 'Official PDP title and breadcrumb reviewed against the live page.',
    reviewed_by: 'codex_review',
    confidence: 0.9,
  };
}

test('writer 3: a manifest claiming the bare domain is not a reviewed categorisation', () => {
  // `/^beauty(?:\/|$)/` -- the `|$` alternative made the literal string `beauty` PASS, so a manifest
  // of {category: 'beauty', product_type: 'beauty', category_path: 'beauty'} was accepted as
  // reviewed and written straight through.
  for (const bare of ['beauty', 'beauty/']) {
    const blockers = validateEntry(reviewedEntry(bare));
    assert.ok(
      blockers.includes('category_path_not_categorised'),
      `${JSON.stringify(bare)} must be blocked, got ${JSON.stringify(blockers)}`,
    );
    assert.ok(blockers.includes('catalog_category_path_not_categorised'));
    // AND THE REASON MUST NOT LIE. `beauty` IS in the beauty domain; reporting it as
    // `category_path_not_beauty` would send a reviewer looking for the wrong defect.
    assert.ok(
      !blockers.includes('category_path_not_beauty'),
      'a bare beauty path is uncategorised, NOT out-of-domain',
    );
  }
});

test('writer 3: a real path still passes, and a non-beauty path still reports the domain', () => {
  for (const good of ['beauty/fragrance', 'beauty/fragrance/perfume', 'beauty/skincare/treat/serum']) {
    assert.deepEqual(validateEntry(reviewedEntry(good)), [], `${good} must pass review`);
  }
  const offDomain = validateEntry(reviewedEntry('fashion/shoes'));
  assert.ok(offDomain.includes('category_path_not_beauty'));
  assert.ok(!offDomain.includes('category_path_not_categorised'), 'fashion/shoes IS categorised');
});

test('writer 3: a placeholder prior claim does not block its own repair', () => {
  // THE PLACEHOLDER BLOCKED THE ONE TOOL BUILT TO FIX IT. `findConflicts` protected any non-empty
  // existing value as a prior claim, and `beauty` is not a claim -- it is the absence of one,
  // written down. The only escape was --allow-overwrite, which disables conflict protection for
  // every field across the whole run.
  const entry = reviewedEntry('beauty/fragrance/perfume');
  const plan = (seedData) =>
    buildCategoryPatchPlanForRow(
      { external_product_id: 'ext_reviewed', title: 'Cloud Eau de Parfum', seed_data: seedData },
      { ...entry, title: 'Cloud Eau de Parfum' },
      {},
    );

  for (const placeholder of [
    { category_path: 'beauty', category: 'beauty', snapshot: {} },
    { category_path: 'beauty', category: 'Beauty Product', snapshot: {} },
    { catalog_category_path: 'beauty', snapshot: {} },
    { snapshot: { category_path: 'beauty' } },
  ]) {
    const out = plan(placeholder);
    assert.equal(
      out.status,
      'planned',
      `a placeholder prior claim must not block the repair, got ${JSON.stringify(out.blocking_reasons || [])}`,
    );
  }

  // AND A REAL DISAGREEMENT MUST STILL BLOCK -- otherwise this is not a narrowing, it is deleting
  // the protection. `Flaura Eau De Parfum` really is stored under makeup/face/blush, and that is a
  // mis-categorisation for a human to resolve, not something a manifest may silently overwrite.
  const real = plan({ category_path: 'beauty/makeup/face/blush', category: 'Blush', snapshot: {} });
  assert.equal(real.status, 'blocked');
  assert.ok(
    real.blocking_reasons.some((r) => r.includes('beauty/makeup/face/blush')),
    `a real prior path must still conflict, got ${JSON.stringify(real.blocking_reasons)}`,
  );
});

test('writer 4: the OliveYoung feed seeds no placeholder category either', () => {
  // The fourth committed writer of the same literal, and the one that caused the block above:
  // it writes the SEED, and the reviewed-patch lane reads `seed_data.category_path` as a claim.
  const record = normalizeFeedRecord(
    {
      product_id: 'oy_probe',
      title: 'Cloud Eau de Parfum',
      brand: 'Ariana Grande',
      product_url: 'https://global.oliveyoung.com/product/detail?prdtNo=oy_probe',
      price: '58.00',
      currency: 'USD',
      availability: 'in_stock',
    },
    'US',
  );
  assert.equal(record.category_path, '', 'a feed row with no category must not invent one');

  const seed = buildSeedRowFromOYOffer(record, { market: 'US' });
  const seeded = seed.seed_data.category_path;
  assert.ok(
    seeded === undefined || categoryPathIsCategorised(seeded),
    `the seed must carry a real category or none, got ${JSON.stringify(seeded)}`,
  );

  // Control: a feed row that DOES carry a category still passes it through untouched.
  const withCategory = buildSeedRowFromOYOffer(
    { ...record, category_path: 'beauty/fragrance/perfume' },
    { market: 'US' },
  );
  assert.equal(withCategory.seed_data.category_path, 'beauty/fragrance/perfume');
});

// ---------------------------------------------------------------------------
// 5. No writer may reintroduce the literal.
// ---------------------------------------------------------------------------

// Comments in these files quote the defect they removed, so the literal legitimately survives in
// prose. Strip comments before looking for it, or this guard fires on its own documentation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('no writer falls back to the bare domain literal', () => {
  for (const [name, src] of [
    ['sync-external-seeds', SYNC_SRC],
    ['sync-ulta-external-seeds', ULTA_SRC],
    ['oliveYoungAffiliateFeed', OY_SRC],
  ]) {
    const code = stripComments(src);
    const hit = code.match(/\|\|\s*'beauty'/);
    assert.equal(
      hit,
      null,
      `${name} must not fall back to the bare domain; skip the row with a counted reason instead`,
    );
  }
  // The stripper must not be the reason this passes: it has to still see live code.
  assert.match(stripComments(SYNC_SRC), /function inferCatalogMirrorCategory\(row\) \{/);
  assert.match(stripComments(ULTA_SRC), /const categoryShape = inferCatalogMirrorCategory\(row\);/);
  // And it must still catch the literal when it IS in code.
  assert.match(stripComments("const x = a || 'beauty'; // || 'beauty'"), /\|\|\s*'beauty'/);
  assert.doesNotMatch(stripComments("// const x = a || 'beauty';"), /\|\|\s*'beauty'/);
});
