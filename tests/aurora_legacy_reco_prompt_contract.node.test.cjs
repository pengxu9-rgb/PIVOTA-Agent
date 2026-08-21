const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('legacy reco alternatives system prompt encodes candidate-only and uncertainty rules', () => {
  const promptPath = path.join(__dirname, '..', 'prompts', 'reco_alternatives_v1_0.system.txt');
  const text = fs.readFileSync(promptPath, 'utf8');

  assert.match(text, /strict skincare alternatives selector/i);
  assert.match(text, /exactly one top-level key: alternatives/i);
  assert.match(text, /Choose up to task\.max_alternatives alternatives/i);
  assert.match(text, /Select ONLY from candidates\[\]/i);
  assert.match(text, /you should usually return 1-3 distinct candidates instead of \[\]/i);
  assert.match(text, /Return \{"alternatives": \[\]\} only when every candidate is a self match, placeholder, clearly mismatched, or too weak/i);
  assert.match(text, /Every returned item must include short reasons plus concrete tradeoffs/i);
  assert.match(text, /Do not claim "exact dupe", "identical formula"/i);
  assert.match(text, /Respect profile sensitivity and barrier context/i);
});

test('hybrid reco alternatives system prompt encodes open-world fallback and anchor-only constraints', () => {
  const promptPath = path.join(__dirname, '..', 'prompts', 'reco_alternatives_hybrid_v1.system.txt');
  const text = fs.readFileSync(promptPath, 'utf8');

  assert.match(text, /strict but productive skincare alternatives selector/i);
  assert.match(text, /dupe-finding workflow/i);
  assert.match(text, /open-world products/i);
  assert.match(text, /broad public skincare product knowledge/i);
  assert.match(text, /candidate_origin/i);
  assert.match(text, /COMMON-ANCHOR SALVAGE POLICY/i);
  assert.match(text, /VIABILITY BAR/i);
  assert.match(text, /SELF-CHECK BEFORE RETURNING/i);
  assert.match(text, /If meta\.profile_mode is "anchor_only"/i);
  assert.match(text, /Never invent product IDs, SKUs, URLs, prices/i);
  assert.match(text, /Do NOT return \[\] merely because:/i);
  assert.match(text, /context\.candidates is empty/i);
  assert.match(text, /aim to return at least 2 viable alternatives when possible/i);
  assert.match(text, /\[\] should be rare/i);
  assert.match(text, /return 1 strong item rather than \[\]/i);
  assert.match(text, /do not wait for catalog grounding/i);
});

test('open-world reco system prompt encodes active-theme-only generation rules', () => {
  const promptPath = path.join(__dirname, '..', 'prompts', 'reco_alternatives_open_world_v1.system.txt');
  const text = fs.readFileSync(promptPath, 'utf8');

  assert.match(text, /Output exactly one JSON object with keys: alternative, empty_reason/i);
  assert.match(text, /If anchor\.active_themes is non-empty, you MUST return exactly 1 distinct real skincare product/i);
  assert.match(text, /Pure role, texture, category, or claim overlap without active or ingredient theme overlap is NOT enough/i);
  assert.match(text, /anchor_signal_insufficient_for_open_world/i);
  assert.match(text, /The Ordinary Niacinamide 10% \+ Zinc 1%/i);
});

test('legacy reco main system prompt encodes task_mode and candidate grounding rules', () => {
  const promptPath = path.join(__dirname, '..', 'prompts', 'reco_main_v1_0.system.txt');
  const text = fs.readFileSync(promptPath, 'utf8');

  assert.match(text, /precision skincare product ranking engine/i);
  assert.match(text, /Use profile, global_status, candidates, ingredient_candidates, product_candidates, and meta\.task_mode exactly as provided/i);
  assert.match(text, /If product_candidates\[\] is provided and non-empty, you MUST select only from product_candidates\[\]/i);
  assert.match(text, /If meta\.task_mode is "ingredient_lookup_no_candidates"/i);
  assert.match(text, /Do NOT fall back to generic profile-goal products/i);
  assert.match(text, /Do NOT output routines, onboarding plans/i);
  assert.match(text, /If ingredient verification is uncertain, set match_verified conservatively/i);
});

test('legacy ingredient reco upstream prompt encodes hard ingredient constraints and empty-result policy', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const prompt = __internal.buildIngredientRecoUpstreamPrompt({
      language: 'EN',
      context: {
        goal: 'barrier',
        sensitivity: 'high',
        ingredient_candidates: ['Ceramide NP', 'Panthenol'],
        product_candidates: [
          { name: 'Ceramide Serum', brand: 'Product Brand' },
          { name: 'Barrier Cream', brand: 'Repair Brand' },
        ],
      },
    });

    assert.match(prompt, /\[PROMPT_VERSION=inline_ingredient_reco_v2\]/i);
    assert.match(prompt, /Role: strict ingredient-constrained product selector/i);
    assert.match(prompt, /select ONLY from those candidates/i);
    assert.match(prompt, /return fewer items or an empty result instead of generic skincare picks/i);
    assert.match(prompt, /Do not invent products, SKUs, brands, URLs/i);
    assert.match(prompt, /Product candidates \(select ONLY from these\): Ceramide Serum, Barrier Cream/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('legacy reco alternatives query includes hardened prompt blocks and schema-first payload', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const promptPack = __internal.buildAuroraRecoAlternativesQuery({
      lang: 'EN',
      profileSnapshot: {
        skinType: 'combination',
        sensitivity: 'high',
        barrierStatus: 'impaired',
        goals: ['barrier repair'],
      },
      productInput: 'Anchor Product',
      productObj: {
        brand: 'Anchor Brand',
        name: 'Anchor Product',
        known_actives: ['Niacinamide'],
      },
      maxTotal: 3,
      region: 'US',
      anchorId: 'anchor_123',
      candidates: [
        {
          id: 'cand_1',
          name: 'Candidate One',
          brand: 'Brand One',
          category: 'serum',
          pdp_url: 'https://example.com/c1',
          signals: ['barrier support'],
        },
        {
          id: 'cand_2',
          name: 'Candidate Two',
          brand: 'Brand Two',
          category: 'serum',
          pdp_url: 'https://example.com/c2',
          signals: ['lower irritation'],
        },
      ],
    });

    const contract = __internal.validateRecoPromptContract({
      query: promptPack.query,
      expectedTemplateId: 'reco_alternatives_v1_0',
    });

    assert.equal(contract.ok, true);

    const promptPack2 = __internal.buildAuroraRecoAlternativesQuery({
      lang: 'EN',
      profileSnapshot: { skinType: 'combination', sensitivity: 'high', barrierStatus: 'impaired', goals: ['barrier repair'] },
      productInput: 'Anchor Product',
      productObj: { brand: 'Anchor Brand', name: 'Anchor Product', known_actives: ['Niacinamide'] },
      maxTotal: 3,
      region: 'US',
      anchorId: 'anchor_123',
      candidates: [
        { id: 'cand_1', name: 'Candidate One', brand: 'Brand One', category: 'serum', pdp_url: 'https://example.com/c1', signals: ['barrier support'] },
        { id: 'cand_2', name: 'Candidate Two', brand: 'Brand Two', category: 'serum', pdp_url: 'https://example.com/c2', signals: ['lower irritation'] },
      ],
    });
    const hash1 = crypto.createHash('sha1').update(String(promptPack.query || '')).digest('hex').slice(0, 16);
    const hash2 = crypto.createHash('sha1').update(String(promptPack2.query || '')).digest('hex').slice(0, 16);
    assert.equal(hash1, hash2, 'prompt hash must be deterministic for identical inputs');

    assert.match(promptPack.systemPrompt, /Select ONLY from candidates\[\]/i);
    assert.match(promptPack.systemPrompt, /Every returned item must include short reasons plus concrete tradeoffs/i);
    assert.match(promptPack.query, /PROMPT_TEMPLATE_ID=reco_alternatives_v1_0/i);
    assert.match(promptPack.query, /SYSTEM_PROMPT:/i);
    assert.match(promptPack.query, /USER_PROMPT_JSON:/i);
    assert.match(promptPack.query, /"hard_rules"\s*:/i);
    assert.match(promptPack.query, /"known_actives"\s*:\s*\[/i);
    assert.match(promptPack.query, /Select ONLY from candidates\[\] and copy identifiers from the chosen candidate exactly/i);
    assert.match(promptPack.query, /Do not claim exact dupe or identical formula/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('hybrid reco alternatives query includes recommendation_mode, anchor_only profile mode, and open-world rules', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const promptPack = __internal.buildAuroraRecoAlternativesQuery({
      lang: 'EN',
      profileSnapshot: {
        skinType: 'unknown',
        sensitivity: 'unknown',
        barrierStatus: 'unknown',
        goals: [],
        context_present: false,
      },
      productInput: 'Lab Series Daily Rescue Energizing Lightweight Lotion Moisturizer',
      productObj: {
        brand: 'Lab Series',
        name: 'Daily Rescue Energizing Lightweight Lotion Moisturizer',
      },
      maxTotal: 3,
      region: 'US',
      anchorId: '',
      candidates: [],
      mode: 'open_world_only',
      profileMode: 'anchor_only',
    });

    const contract = __internal.validateRecoPromptContract({
      query: promptPack.query,
      expectedTemplateId: 'reco_alternatives_hybrid_v1',
    });

    assert.equal(contract.ok, true);
    assert.match(promptPack.query, /PROMPT_TEMPLATE_ID=reco_alternatives_hybrid_v1/i);
    assert.match(promptPack.query, /"recommendation_mode"\s*:\s*"open_world_only"/i);
    assert.match(promptPack.query, /"profile_mode"\s*:\s*"anchor_only"/i);
    assert.match(promptPack.query, /"profile_context_present"\s*:\s*false/i);
    assert.match(promptPack.query, /"skinType"\s*:\s*"unknown"/i);
    assert.match(promptPack.query, /"goals"\s*:\s*\[\s*\]/i);
    assert.match(promptPack.query, /"usage_role"\s*:\s*"moisturizer"/i);
    assert.match(promptPack.query, /"texture_hints"\s*:\s*\[/i);
    assert.match(promptPack.systemPrompt, /do NOT personalize to an assumed user/i);
    assert.match(promptPack.systemPrompt, /Never invent product IDs, SKUs, URLs, prices/i);
    assert.match(promptPack.query, /aim to return 2-4 viable real-product alternatives/i);
    assert.match(promptPack.query, /ignore candidate-pool dependence/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('hybrid reco alternatives query lifts ingredient and role signals from target_product', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const promptPack = __internal.buildAuroraRecoAlternativesQuery({
      lang: 'EN',
      profileSnapshot: {
        skinType: 'unknown',
        sensitivity: 'unknown',
        barrierStatus: 'unknown',
        goals: [],
        context_present: false,
      },
      productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
      productObj: {
        brand: 'The Ordinary',
        product_name: 'Niacinamide 10% + Zinc 1%',
        product_type: 'serum',
        category: 'serum',
        ingredients: [
          { name: 'Niacinamide', concentration: '10%' },
          { name: 'Zinc PCA', concentration: '1%' },
        ],
        claims: ['Oil control', 'Blemish support'],
      },
      maxTotal: 3,
      region: 'US',
      anchorId: '',
      candidates: [],
      mode: 'open_world_only',
      profileMode: 'anchor_only',
    });

    assert.match(promptPack.query, /"product_type"\s*:\s*"serum"/i);
    assert.match(promptPack.query, /"category"\s*:\s*"serum"/i);
    assert.match(promptPack.query, /"usage_role"\s*:\s*"serum"/i);
    assert.match(promptPack.query, /"hero_ingredients"\s*:\s*\[\s*"Niacinamide"/i);
    assert.match(promptPack.query, /Zinc PCA/i);
    assert.match(promptPack.query, /"known_actives"\s*:\s*\[[^\]]*Niacinamide/i);
    assert.match(promptPack.query, /"primary_claims"\s*:\s*\[[^\]]*Oil control/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('legacy reco main query includes task_mode and candidate constraint payload', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const query = __internal.buildAuroraProductRecommendationsQuery({
      profile: {
        skinType: 'combination',
        sensitivity: 'high',
        barrierStatus: 'impaired',
        goals: ['barrier repair'],
      },
      requestText: 'Recommend ingredient-matched products for barrier repair',
      lang: 'EN',
      globalStatus: {
        budget_known: false,
        itinerary_provided: false,
        recent_logs_provided: false,
      },
      candidates: [
        {
          sku_id: 'cand_sku_1',
          product_id: 'cand_pid_1',
          brand: 'Brand One',
          name: 'Candidate One',
          category: 'serum',
        },
      ],
      ingredientContext: {
        query: 'ceramide',
        goal: 'barrier',
        sensitivity: 'high',
        candidates: ['Ceramide NP', 'Panthenol'],
        product_candidates: [
          {
            sku_id: 'prod_sku_1',
            product_id: 'prod_pid_1',
            brand: 'Product Brand',
            name: 'Ceramide Serum',
            category: 'serum',
          },
        ],
      },
    });

    const contract = __internal.validateRecoPromptContract({
      query,
      expectedTemplateId: 'reco_main_v1_2',
    });

    assert.equal(contract.ok, true);

    const query2 = __internal.buildAuroraProductRecommendationsQuery({
      profile: { skinType: 'combination', sensitivity: 'high', barrierStatus: 'impaired', goals: ['barrier repair'] },
      requestText: 'Recommend ingredient-matched products for barrier repair',
      lang: 'EN',
      globalStatus: { budget_known: false, itinerary_provided: false, recent_logs_provided: false },
      candidates: [
        { sku_id: 'cand_sku_1', product_id: 'cand_pid_1', brand: 'Brand One', name: 'Candidate One', category: 'serum' },
      ],
      ingredientContext: {
        query: 'ceramide',
        goal: 'barrier',
        sensitivity: 'high',
        candidates: ['Ceramide NP', 'Panthenol'],
        product_candidates: [
          { sku_id: 'prod_sku_1', product_id: 'prod_pid_1', brand: 'Product Brand', name: 'Ceramide Serum', category: 'serum' },
        ],
      },
    });
    const hash1 = crypto.createHash('sha1').update(String(query || '')).digest('hex').slice(0, 16);
    const hash2 = crypto.createHash('sha1').update(String(query2 || '')).digest('hex').slice(0, 16);
    assert.equal(hash1, hash2, 'prompt hash must be deterministic for identical inputs');

    assert.match(query, /"task_mode"\s*:\s*"ingredient_filtered_products"/i);
    assert.match(query, /"ingredient_candidates"\s*:\s*\[/i);
    assert.match(query, /"product_candidates"\s*:\s*\[/i);
    assert.match(query, /"product_id"\s*:\s*"prod_pid_1"/i);
    assert.match(query, /Respect ingredient_context strictly/i);
    assert.match(query, /ingredient_lookup_no_candidates/i);
  } finally {
    delete require.cache[moduleId];
  }
});

// A candidate with no price must reach the reco LLM as `price_usd: null`, never 0.
//
// normalizeRecoPromptCandidates used to decide "is this a price?" with a bare
// `Number.isFinite(Number(x))`, and Number() maps null, '', '   ', false and [] all to 0 — a
// finite number — so every one of those "no price" shapes serialized into the prompt as
// `"price_usd": 0`, i.e. "this product is free". `true` priced the product at $1. It cost real
// prices too: `{price_usd: null, price: 62}` returned 0, because the null passed the finite check
// and the `price` leg was never reached.
//
// The shapes are caller-supplied: the ingredient leg passes
// `session.meta.ingredient_context.product_candidates[]` from the request body through
// normalizeIngredientRecoContextValue, which only drops non-objects and slices — no price
// normalization at all — so the guard has to hold here.
//
// Every no-price shape is placed in the first 12 rows deliberately: that is the ingredient leg's
// cap (see RECO_PROMPT_PRICE_INGREDIENT_CAP), so the shapes that can actually arrive from a
// request body are exercised on the leg that can actually receive them.
const RECO_PROMPT_PRICE_ROWS = [
  // No price, in every shape Number() silently turns into 0 (or 1).
  { product_id: 'price_null', row: { price: null }, expected: null },
  { product_id: 'price_usd_null', row: { price_usd: null }, expected: null },
  { product_id: 'price_empty_string', row: { price: '' }, expected: null },
  { product_id: 'price_blank_string', row: { price: '   ' }, expected: null },
  { product_id: 'price_false', row: { price: false }, expected: null },
  { product_id: 'price_true', row: { price: true }, expected: null },
  { product_id: 'price_empty_array', row: { price: [] }, expected: null },
  { product_id: 'price_absent', row: {}, expected: null },
  // A price OBJECT in a currency this lane cannot convert is still a no-price shape: there are
  // no FX rates here, the same reason recoPriceCeiling.js refuses cross-currency comparisons,
  // so 4500 JPY must not surface under a field named price_usd. Its USD sibling IS a price and
  // sits with the priced rows below.
  { product_id: 'price_object_jpy', row: { price: { amount: 4500, currency: 'JPY' } }, expected: null },
  // Non-finite numbers are not prices either. `Infinity` matters on its own: JSON.stringify emits
  // it as `null`, so the prompt STRING self-heals and only the payload object would carry it —
  // which is exactly the kind of defect a prompt-text-only assertion cannot see.
  { product_id: 'price_infinity', row: { price: Infinity }, expected: null },
  { product_id: 'price_infinity_string', row: { price: 'Infinity' }, expected: null },
  { product_id: 'price_nan', row: { price: NaN }, expected: null },
  // --- everything above is a no-price shape and rides on BOTH legs; the rows below are stated
  // prices and fall past the ingredient leg's cap. ---
  // A real price still passes through untouched.
  { product_id: 'price_number', row: { price: 62 }, expected: 62 },
  { product_id: 'price_usd_number', row: { price_usd: 41.5 }, expected: 41.5 },
  { product_id: 'price_numeric_string', row: { price: '62' }, expected: 62 },
  // A USD price OBJECT is a price. This is the shape normalizeRecoCatalogProduct actually emits,
  // and reading only scalars here meant EVERY catalog-sourced candidate reached the model as
  // null. Pinned as `expected: null` until 2026-08-21 — the table recorded the defect as
  // intended behaviour.
  { product_id: 'price_object', row: { price: { amount: 62, currency: 'USD' } }, expected: 62 },
  { product_id: 'price_padded_numeric_string', row: { price: '  62  ' }, expected: 62 },
  // The price_usd leg must FALL THROUGH to price when price_usd carries no price — rejecting
  // price_usd must not also discard a perfectly good `price`. This is the pair the pre-fix code
  // got wrong in the expensive direction: it answered 0 and threw the 62 away.
  { product_id: 'price_usd_null_price_set', row: { price_usd: null, price: 62 }, expected: 62 },
  { product_id: 'price_usd_empty_price_set', row: { price_usd: '', price: 62 }, expected: 62 },
  // ...but an explicit numeric 0 in price_usd IS a stated price, so it wins over `price`. This is
  // the `??` vs `||` distinction: `||` would skip the stated zero and report 62.
  { product_id: 'price_usd_zero_price_set', row: { price_usd: 0, price: 62 }, expected: 0 },
  // The guard keys on the no-price SHAPES above, not on falsiness: a caller that explicitly
  // states 0 is asserting a price, not omitting one.
  { product_id: 'price_explicit_zero', row: { price: 0 }, expected: 0 },
];

// normalizeIngredientRecoContextValue caps product_candidates at 12 rows. The test feeds it MORE
// than the cap and asserts exactly the cap comes back, so a cap that moves in EITHER direction
// fails here — feeding exactly 12 would only catch a cap that shrinks.
const RECO_PROMPT_PRICE_INGREDIENT_CAP = 12;
const RECO_PROMPT_PRICE_INGREDIENT_ROWS = RECO_PROMPT_PRICE_ROWS.slice(0, RECO_PROMPT_PRICE_INGREDIENT_CAP);

function buildRecoPromptPriceCandidates(rows) {
  return rows.map((entry) => ({
    product_id: entry.product_id,
    sku_id: `sku_${entry.product_id}`,
    brand: 'Price Guard Brand',
    name: `Price Guard ${entry.product_id}`,
    category: 'serum',
    ...entry.row,
  }));
}

function assertRecoPromptPrices(normalized, rows, legLabel) {
  assert.equal(normalized.length, rows.length, `${legLabel}: every row must survive normalization`);
  for (const [index, entry] of rows.entries()) {
    const got = normalized[index];
    assert.equal(got.product_id, entry.product_id, `${legLabel}: row order must match`);
    assert.equal(
      got.price_usd,
      entry.expected,
      `${legLabel}: ${entry.product_id} must serialize price_usd as ${JSON.stringify(entry.expected)}, got ${JSON.stringify(got.price_usd)}`,
    );
    if (entry.expected === null) {
      assert.equal(
        Object.is(got.price_usd, null),
        true,
        `${legLabel}: ${entry.product_id} must be null, not 0/undefined/NaN`,
      );
    }
  }
}

test('reco prompt candidates report an unknown price as null, never a fabricated zero', () => {
  // Without this the suite goes vacuous if the table is ever emptied: every assertion below
  // degrades to `0 === 0` and passes against any implementation at all.
  assert.equal(RECO_PROMPT_PRICE_ROWS.length, 21, 'the price table must keep its full shape coverage');
  // POSITIONAL, not a count. A count is invariant under swapping an in-cap no-price row with an
  // out-of-cap priced one: the table would still total 12 while the flagship no-price shape sat
  // outside the window the ingredient leg actually sees. This asserts the sentence it states.
  assert.ok(
    RECO_PROMPT_PRICE_ROWS.every((entry, index) => entry.expected !== null || index < RECO_PROMPT_PRICE_INGREDIENT_CAP),
    'every no-price shape must sit inside the ingredient leg cap, where request-supplied rows land',
  );
  assert.equal(
    RECO_PROMPT_PRICE_ROWS.filter((entry) => entry.expected === null).length,
    RECO_PROMPT_PRICE_INGREDIENT_CAP,
    'the cap must stay saturated with no-price shapes, so the ingredient leg keeps exercising them',
  );

  const { moduleId, __internal } = loadRouteInternals();
  try {
    const bundle = __internal.buildAuroraProductRecommendationsPromptBundle({
      profile: { skinType: 'combination', sensitivity: 'high', goals: ['barrier repair'] },
      requestText: 'Recommend a barrier serum',
      lang: 'EN',
      globalStatus: { budget_known: false, itinerary_provided: false, recent_logs_provided: false },
      candidates: buildRecoPromptPriceCandidates(RECO_PROMPT_PRICE_ROWS),
      ingredientContext: {
        query: 'ceramide',
        goal: 'barrier',
        // Deliberately over the cap: the assertion below pins where the truncation lands.
        product_candidates: buildRecoPromptPriceCandidates(RECO_PROMPT_PRICE_ROWS),
      },
    });

    // Both legs run through normalizeRecoPromptCandidates: the catalog pool lands on
    // `candidates`, the request-supplied ingredient rows on `product_candidates`.
    assertRecoPromptPrices(bundle.user_payload.candidates, RECO_PROMPT_PRICE_ROWS, 'candidates[]');
    assertRecoPromptPrices(
      bundle.user_payload.product_candidates,
      RECO_PROMPT_PRICE_INGREDIENT_ROWS,
      'product_candidates[]',
    );

    // The prompt STRING is where a fabricated zero would do its damage, but it is the WEAKER of
    // the two checks and cannot replace the payload assertions above: JSON.stringify renders both
    // NaN and Infinity as `null`, so a non-finite price looks correct here while the payload
    // object carries it. Kept as a belt-and-braces check on what actually reaches the model.
    const serializedPrices = String(bundle.query).match(/"price_usd":\s*[^,\s}]+/g) || [];
    assert.equal(
      serializedPrices.length,
      RECO_PROMPT_PRICE_ROWS.length + RECO_PROMPT_PRICE_INGREDIENT_ROWS.length,
      'every candidate on both legs must serialize a price_usd',
    );
    const zeroCount = serializedPrices.filter((entry) => /"price_usd":\s*0$/.test(entry)).length;
    const expectedZeroCount =
      RECO_PROMPT_PRICE_ROWS.filter((entry) => entry.expected === 0).length
      + RECO_PROMPT_PRICE_INGREDIENT_ROWS.filter((entry) => entry.expected === 0).length;
    assert.equal(
      zeroCount,
      expectedZeroCount,
      `only explicitly-stated zero prices may appear in the prompt; got ${zeroCount} of "price_usd": 0`,
    );
    assert.equal(
      /"price_usd":\s*1(?![\d.])/.test(String(bundle.query)),
      false,
      '`price: true` must not price a product at $1',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

// The catalog leg could never deliver a price to the reco LLM at all.
//
// normalizeRecoCatalogProduct emits price as an OBJECT — `price: { amount, currency, unknown }`
// from extractCatalogCandidatePrice — and never a scalar `price_usd`. normalizeRecoPromptCandidates
// read only scalars, and `Number({amount: 62, currency: 'USD'})` is NaN, so EVERY catalog-sourced
// candidate reached the model as `"price_usd": null` — including rows whose raw input stated a
// perfectly good price. Pre-existing rather than introduced by the null-price fix (the old
// `Number(item.price)` was NaN here too), but it means budget-aware and value-framing reasoning
// has been running blind.
//
// Rows go through the real normalizeRecoCatalogProduct rather than being hand-written in the
// object shape, because the defect is precisely that the two functions disagree about where a
// price lives — hand-writing the shape would test a shape nothing produces.
const RECO_PROMPT_CATALOG_PRICE_ROWS = [
  { label: 'usd_object', raw: { price: { amount: 62, currency: 'USD' } }, expected: 62 },
  { label: 'usd_scalar', raw: { price: 62 }, expected: 62 },
  { label: 'usd_scalar_string', raw: { price: '$41.50' }, expected: 41.5 },
  { label: 'price_usd_scalar', raw: { price_usd: 41.5 }, expected: 41.5 },
  { label: 'offers_array', raw: { offers: [{ amount: 18, currency: 'USD' }] }, expected: 18 },
  // No FX rates in this lane — the same reason recoPriceCeiling.js refuses cross-currency
  // comparisons. A JPY amount published under a field named `price_usd` would read to the model
  // as $4500, which is worse than the null it would replace.
  { label: 'jpy_object', raw: { price: { amount: 4500, currency: 'JPY' } }, expected: null },
  // The row above states its currency INSIDE the price object, which normalizePriceObject has
  // always read correctly — so on its own it pins the USD gate only where it was never at risk.
  // These state it as a SIBLING of the amount, the shape this repo's own rows actually use
  // (LOCAL_EXTERNAL_SEED_SELECT_FIELDS selects `price_amount, price_currency`). That is the shape
  // the gate genuinely depends on: without these, a regression in extractCatalogCandidatePrice
  // would relabel a foreign amount USD and publish it into a live prompt, suite still green.
  { label: 'jpy_sibling_currency', raw: { price_amount: 4500, currency: 'JPY' }, expected: null },
  { label: 'jpy_sibling_price_currency', raw: { price_amount: 4500, price_currency: 'JPY' }, expected: null },
  { label: 'eur_sibling_scalar', raw: { sale_price: 59, currency: 'EUR' }, expected: null },
  // ...and one level deeper: an element inside offers[] goes through normalizePriceObject
  // directly, which is exactly where `price_currency` was missing from the currency aliases.
  { label: 'jpy_offer_price_currency', raw: { offers: [{ price_amount: 4500, price_currency: 'JPY' }] }, expected: null },
  // normalizePriceObject also reads the currency off a NESTED `price` object when the amount sits
  // on the outer one, so that alias list needs `price_currency` for the same reason the direct one
  // does. (Nesting the AMOUNT instead short-circuits the amount chain on `rawPrice.price` and
  // yields no price at all — which is why this row nests only the currency.)
  { label: 'jpy_nested_price_currency', raw: { price: { amount: 4500, price: { price_currency: 'JPY' } } }, expected: null },
  { label: 'usd_offer_price_currency', raw: { offers: [{ price_amount: 18, price_currency: 'USD' }] }, expected: 18 },
  { label: 'cny_scalar', raw: { price_cny: 320 }, expected: null },
  { label: 'no_price', raw: {}, expected: null },
];

test('reco prompt candidates carry the catalog price object through as price_usd, USD only', () => {
  // Without this the loop below goes vacuous if the table is ever emptied.
  assert.equal(RECO_PROMPT_CATALOG_PRICE_ROWS.length, 14, 'the catalog price table must keep its shape coverage');
  assert.equal(
    RECO_PROMPT_CATALOG_PRICE_ROWS.filter((entry) => entry.expected != null).length,
    6,
    'the priced half of the table must stay populated',
  );

  const { moduleId, __internal } = loadRouteInternals();
  try {
    const normalized = RECO_PROMPT_CATALOG_PRICE_ROWS.map((entry, index) =>
      __internal.normalizeRecoCatalogProduct({
        product_id: `catalog_${entry.label}`,
        merchant_id: 'm_price_guard',
        name: `Catalog Price ${entry.label}`,
        category: 'serum',
        ...entry.raw,
      }),
    );
    // `.map()` preserves length unconditionally, so asserting on it proves nothing — check that
    // every row actually produced a normalized object.
    assert.equal(
      normalized.filter((row) => row && typeof row === 'object').length,
      RECO_PROMPT_CATALOG_PRICE_ROWS.length,
      'every catalog row must normalize to an object, not null',
    );

    // Pin the premise of the whole test: the catalog normalizer really does speak `price` objects
    // and really does not emit `price_usd`. If that ever changes, this test is measuring the wrong
    // thing and should say so here rather than quietly passing for a new reason.
    for (const [index, entry] of RECO_PROMPT_CATALOG_PRICE_ROWS.entries()) {
      assert.equal(
        normalized[index].price_usd,
        undefined,
        `${entry.label}: normalizeRecoCatalogProduct must not emit a scalar price_usd`,
      );
      if (entry.raw && Object.keys(entry.raw).length) {
        assert.equal(
          typeof normalized[index].price,
          'object',
          `${entry.label}: a priced catalog row must carry a price OBJECT`,
        );
      }
    }

    const bundle = __internal.buildAuroraProductRecommendationsPromptBundle({
      profile: { skinType: 'combination', sensitivity: 'high', goals: ['barrier repair'] },
      requestText: 'Recommend a barrier serum',
      lang: 'EN',
      globalStatus: { budget_known: true, itinerary_provided: false, recent_logs_provided: false },
      candidates: normalized,
    });

    for (const [index, entry] of RECO_PROMPT_CATALOG_PRICE_ROWS.entries()) {
      const got = bundle.user_payload.candidates[index];
      assert.equal(got.name, `Catalog Price ${entry.label}`, `${entry.label}: row order must match`);
      assert.equal(
        got.price_usd,
        entry.expected,
        `${entry.label}: must serialize price_usd as ${JSON.stringify(entry.expected)}, got ${JSON.stringify(got.price_usd)}`,
      );
    }

    // The prompt STRING is what the model reads. A non-USD amount must be absent from it outright,
    // not merely absent from the payload object.
    const query = String(bundle.query);
    assert.match(query, /"price_usd":\s*62/, 'a USD catalog price must reach the prompt');
    assert.match(query, /"price_usd":\s*41\.5/, 'a decimal USD catalog price must reach the prompt');
    assert.match(query, /"price_usd":\s*18/, 'a price read from offers[] must reach the prompt');
    assert.equal(/\b4500\b/.test(query), false, 'a JPY amount must never be published as price_usd');
    assert.equal(/\b320\b/.test(query), false, 'a CNY amount must never be published as price_usd');

    const nullCount = (query.match(/"price_usd":\s*null/g) || []).length;
    assert.equal(
      nullCount,
      RECO_PROMPT_CATALOG_PRICE_ROWS.filter((entry) => entry.expected === null).length,
      'exactly the unpriced and non-USD rows may serialize a null price',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('the catalog price object leg cannot override a stated scalar price', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // Ordering guard: the object leg is last and uses `??`, so it can only ever turn a null into a
    // price. A row carrying BOTH a scalar and a conflicting object must answer with the scalar —
    // including the stated zero, which `||` would have skipped.
    const bundle = __internal.buildAuroraProductRecommendationsPromptBundle({
      profile: {},
      requestText: 'r',
      lang: 'EN',
      globalStatus: {},
      candidates: [
        { product_id: 'a', name: 'scalar wins', price_usd: 41.5, price: { amount: 62, currency: 'USD' } },
        { product_id: 'b', name: 'stated zero wins', price_usd: 0, price: { amount: 62, currency: 'USD' } },
        { product_id: 'c', name: 'object fills the gap', price: { amount: 62, currency: 'USD' } },
      ],
    });
    const prices = bundle.user_payload.candidates.map((row) => row.price_usd);
    assert.deepEqual(prices, [41.5, 0, 62], 'scalar price_usd wins; the object leg only fills a null');
  } finally {
    delete require.cache[moduleId];
  }
});

test('the catalog price object leg refuses objects that do not state a USD amount', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // These rows are passed RAW, not through normalizeRecoCatalogProduct, because that is exactly
    // how they arrive on the ingredient leg: normalizeIngredientRecoContextValue takes
    // `ingredient_context.product_candidates[]` off the request body and only drops non-objects
    // and slices, so a caller can hand this function any object it likes under `price`.
    const rows = [
      // normalizePriceObject's own "we could not read a price" marker, honoured rather than
      // reinterpreted: an unknown price is not a $62 one.
      { label: 'unknown_flag', price: { amount: 62, currency: 'USD', unknown: true }, expected: null },
      // No currency stated is not USD. Assuming USD here is how a foreign amount becomes a dollar
      // figure, so a currency that is not a 3-letter code fails the check.
      { label: 'no_currency', price: { amount: 62 }, expected: null },
      { label: 'blank_currency', price: { amount: 62, currency: '   ' }, expected: null },
      { label: 'bad_currency', price: { amount: 62, currency: 'USDX' }, expected: null },
      { label: 'nested_array', price: [{ amount: 62, currency: 'USD' }], expected: null },
      // A no-price shape inside an otherwise USD object is still a no-price shape: the amount runs
      // through the same toRecoPromptPriceOrNull guard as the scalar legs, so no fabricated zero.
      { label: 'null_amount', price: { amount: null, currency: 'USD' }, expected: null },
      { label: 'empty_amount', price: { amount: '', currency: 'USD' }, expected: null },
      { label: 'bool_amount', price: { amount: true, currency: 'USD' }, expected: null },
      // ...and the accepted spellings still work, so the rejections above are not blanket.
      { label: 'lowercase_currency', price: { amount: 62, currency: 'usd' }, expected: 62 },
      { label: 'value_key', price: { value: 41.5, currency: 'USD' }, expected: 41.5 },
      { label: 'string_amount', price: { amount: '18', currency: 'USD' }, expected: 18 },
      { label: 'stated_zero', price: { amount: 0, currency: 'USD' }, expected: 0 },
    ];
    assert.equal(rows.filter((row) => row.expected === null).length, 8, 'the rejected half must stay populated');
    assert.equal(rows.filter((row) => row.expected !== null).length, 4, 'the accepted half must stay populated');

    const bundle = __internal.buildAuroraProductRecommendationsPromptBundle({
      profile: {},
      requestText: 'r',
      lang: 'EN',
      globalStatus: {},
      candidates: rows.map((row, index) => ({
        product_id: `obj_${index}`,
        name: `Object ${row.label}`,
        price: row.price,
      })),
    });

    for (const [index, row] of rows.entries()) {
      const got = bundle.user_payload.candidates[index];
      assert.equal(got.name, `Object ${row.label}`, `${row.label}: row order must match`);
      assert.equal(
        got.price_usd,
        row.expected,
        `${row.label}: must serialize price_usd as ${JSON.stringify(row.expected)}, got ${JSON.stringify(got.price_usd)}`,
      );
    }

    // A rejected object must produce NO price, not a zero — the failure mode this whole family is
    // about. Only the one row that states 0 outright may serialize a zero.
    const zeroCount = (String(bundle.query).match(/"price_usd":\s*0(?![\d.])/g) || []).length;
    assert.equal(zeroCount, 1, 'only the explicitly stated zero may serialize as 0');
  } finally {
    delete require.cache[moduleId];
  }
});
