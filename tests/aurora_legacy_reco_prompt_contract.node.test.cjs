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
  assert.match(text, /If no candidate is strong enough, return \{"alternatives": \[\]\}/i);
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
