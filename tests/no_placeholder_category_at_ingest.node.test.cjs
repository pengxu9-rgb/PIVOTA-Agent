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
const {
  _internals: { inferCatalogMirrorCategory, buildMirror },
} = require('../scripts/sync-external-seeds-to-catalog.cjs');
const {
  _internals: { buildMirror: buildUltaMirror },
} = require('../scripts/sync-ulta-external-seeds-to-catalog.cjs');
const {
  _internals: { validateEntry },
} = require('../scripts/apply-reviewed-external-seed-category-patch.cjs');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const SYNC_SRC = fs.readFileSync(path.join(SCRIPTS, 'sync-external-seeds-to-catalog.cjs'), 'utf8');
const ULTA_SRC = fs.readFileSync(path.join(SCRIPTS, 'sync-ulta-external-seeds-to-catalog.cjs'), 'utf8');

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

test('writer 1: run() skips the uncategorised row with a counted reason, and does not throw', () => {
  // applyMirrors wraps the whole batch in one BEGIN and --batch-size defaults to every fetched row,
  // so a guard that THREW here would abort an entire sync run over one uncategorised seed. The gate
  // must be a per-row `skipped.push(...) + continue`, in the loop, before `mirrors.push`.
  const loopStart = SYNC_SRC.indexOf('    const mirror = buildMirror(row);');
  assert.ok(loopStart > 0, 'the row loop must still call buildMirror');
  const loopEnd = SYNC_SRC.indexOf('    mirrors.push(mirror);', loopStart);
  assert.ok(loopEnd > loopStart, 'the row loop must still push mirrors');
  const body = SYNC_SRC.slice(loopStart, loopEnd);

  assert.match(
    body,
    /if \(!categoryPathIsCategorised\(mirror\.product\.category_path\)\) \{/,
    'the uncategorised gate must run between buildMirror and mirrors.push',
  );
  assert.match(body, /reason: 'category_path_uncategorised'/, 'the skip must carry a counted reason');
  const gate = body.slice(body.indexOf('if (!categoryPathIsCategorised('));
  assert.doesNotMatch(gate, /throw new Error/, 'the gate must skip the row, never abort the batch');
  assert.match(gate, /continue;/, 'the gate must continue to the next row');
});

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

test('writer 2: run() skips the uncategorised row with a counted reason, and does not throw', () => {
  const loopStart = ULTA_SRC.indexOf('    const mirror = buildMirror(row);');
  assert.ok(loopStart > 0, 'the row loop must still call buildMirror');
  const loopEnd = ULTA_SRC.indexOf('    mirrors.push(mirror);', loopStart);
  assert.ok(loopEnd > loopStart, 'the row loop must still push mirrors');
  const body = ULTA_SRC.slice(loopStart, loopEnd);

  assert.match(
    body,
    /if \(!categoryPathIsCategorised\(mirror\.product\.category_path\)\) \{/,
    'the uncategorised gate must run between buildMirror and mirrors.push',
  );
  assert.match(body, /reason: 'category_path_uncategorised'/, 'the skip must carry a counted reason');
  const gate = body.slice(body.indexOf('if (!categoryPathIsCategorised('));
  assert.doesNotMatch(gate, /throw new Error/, 'the gate must skip the row, never abort the batch');
  assert.match(gate, /continue;/, 'the gate must continue to the next row');
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

// ---------------------------------------------------------------------------
// 5. No writer may reintroduce the literal.
// ---------------------------------------------------------------------------

// Comments in these files quote the defect they removed, so the literal legitimately survives in
// prose. Strip comments before looking for it, or this guard fires on its own documentation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('no writer falls back to the bare domain literal', () => {
  for (const [name, src] of [['sync-external-seeds', SYNC_SRC], ['sync-ulta-external-seeds', ULTA_SRC]]) {
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
