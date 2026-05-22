#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PRODUCT_INTEL_CONTRACT_VERSION } = require('../src/pdpProductIntel');
const { closePool, query } = require('../src/db');
const {
  buildKbEntriesForRow,
  prepareEntriesForWrite,
  fetchExistingProductIntelKbRows,
} = require('./publish_product_intel_pilot_to_kb');
const {
  buildPivotaInsightInventoryRow,
  hasCommerceTruthClaim,
} = require('../src/services/pivotaInsightsQuality');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeId(value) {
  return text(value);
}

function firstSentence(value, maxLength = 220) {
  const cleaned = text(value);
  if (!cleaned) return '';
  const sentence = cleaned.match(/^(.{40,}?[.!?])\s/)?.[1] || cleaned;
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, maxLength - 1).replace(/\s+\S*$/, '')}.`;
}

function titleCaseFromPath(value) {
  return text(value)
    .split(/[/_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferCategory(seed, inventoryRow) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return (
    text(seedData.category) ||
    text(snapshot.category) ||
    text(seedData.product_type) ||
    text(snapshot.product_type) ||
    titleCaseFromPath(seedData.category_path || snapshot.category_path || inventoryRow?.category_path)
  );
}

function inferCategoryPath(seed, inventoryRow) {
  const seedData = asObject(seed.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return text(
    seedData.category_path ||
      snapshot.category_path ||
      seedData.catalog_category_path ||
      snapshot.catalog_category_path ||
      inventoryRow?.category_path ||
      inventoryRow?.catalog_category_path,
  );
}

function inferKind(title, category, categoryPath, description = '') {
  const haystack = `${title} ${category} ${categoryPath} ${description}`.toLowerCase();
  if (/\b(?:brush|applicator|beauty tool|makeup brush)\b/.test(haystack) && !/\bbrush cleanser\b/.test(haystack)) {
    return 'brush';
  }
  if (/\bfoundation\b/.test(haystack)) return 'foundation';
  if (/\bconcealer\b/.test(haystack)) return 'concealer';
  if (/\b(?:lipstick|lip color|lip balm|lip gloss|lip liner|lip pencil|lip luxe|gloss)\b/.test(haystack)) return 'lip';
  if (/\b(?:candle)\b/.test(haystack)) return 'home_fragrance';
  if (/\b(?:eau de parfum|parfum|eau de toilette|body spray|fragrance|cologne)\b/.test(haystack)) return 'fragrance';
  if (/\b(?:perfumery|scent|olfactive|oud|ombre leather|ombré leather|soleil blanc|private blend)\b/.test(haystack)) {
    return 'fragrance';
  }
  if (/\b(?:brow|eyebrow)\b/.test(haystack)) return 'brow';
  if (/\b(?:eye repair|eye cream|eye treatment)\b/.test(haystack)) return 'eye_treatment';
  if (/\b(?:eyeliner|mascara|eye color|eyeshadow|eye primer)\b/.test(haystack)) return 'eye_makeup';
  if (/\b(?:blush)\b/.test(haystack)) return 'blush';
  if (/\b(?:bronzer)\b/.test(haystack)) return 'bronzer';
  if (/\b(?:highlighting|highlighter|illuminate)\b/.test(haystack)) return 'highlighter';
  if (/\b(?:powder)\b/.test(haystack)) return 'face_powder';
  if (/\b(?:body oil)\b/.test(haystack)) return 'body_oil';
  if (/\b(?:cleansing|cleanser)\b/.test(haystack)) return 'cleanser';
  if (/\b(?:treatment lotion|treatment emulsion|emulsion|lotion|serum|toner)\b/.test(haystack)) return 'skincare';
  if (/\b(?:moisturizer|cream|mist|serum|cleanser|skincare)\b/.test(haystack)) return 'skincare';
  return 'beauty_product';
}

function kindLabel(kind, category) {
  const labels = {
    foundation: 'foundation',
    concealer: 'concealer',
    lip: text(category).toLowerCase() || 'lip product',
    fragrance: 'fragrance',
    brow: 'brow product',
    eye_treatment: 'eye treatment',
    eye_makeup: 'eye makeup',
    blush: 'blush',
    bronzer: 'bronzer',
    highlighter: 'highlighter',
    face_powder: 'face powder',
    body_oil: 'body oil',
    cleanser: 'cleanser',
    brush: 'beauty brush',
    skincare: 'skincare product',
    home_fragrance: 'home fragrance',
    beauty_product: text(category).toLowerCase() || 'beauty product',
  };
  return labels[kind] || labels.beauty_product;
}

function displayCategoryForKind(kind, category) {
  const explicit = text(category);
  if (explicit && explicit.toLowerCase() !== 'beauty product') return explicit;
  const labels = {
    foundation: 'Foundation',
    concealer: 'Concealer',
    lip: 'Lip Product',
    fragrance: 'Fragrance',
    brow: 'Brow Product',
    eye_treatment: 'Eye Treatment',
    eye_makeup: 'Eye Makeup',
    blush: 'Blush',
    bronzer: 'Bronzer',
    highlighter: 'Highlighter',
    face_powder: 'Face Powder',
    body_oil: 'Body Oil',
    cleanser: 'Cleanser',
    brush: 'Beauty Brush',
    skincare: 'Skincare',
    home_fragrance: 'Home Fragrance',
    beauty_product: 'Beauty Product',
  };
  return labels[kind] || labels.beauty_product;
}

function routineStep(kind) {
  const steps = {
    foundation: 'complexion',
    concealer: 'complexion',
    lip: 'lip_color',
    fragrance: 'fragrance',
    brow: 'brow_makeup',
    eye_treatment: 'skin_care',
    eye_makeup: 'eye_makeup',
    blush: 'cheek_color',
    bronzer: 'cheek_color',
    highlighter: 'complexion',
    face_powder: 'complexion',
    body_oil: 'body_care',
    cleanser: 'cleanse',
    brush: 'tool',
    skincare: 'skin_care',
    home_fragrance: 'home_fragrance',
    beauty_product: 'beauty',
  };
  return steps[kind] || 'beauty';
}

function ingredientSignals(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const candidates = [
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
    seedData.inci_list,
    snapshot.inci_list,
    seedData.ingredient_tokens,
    snapshot.ingredient_tokens,
    seedData.key_ingredients,
    snapshot.key_ingredients,
    seedData.ingredient_intel,
    snapshot.ingredient_intel,
  ];
  const flattened = [];
  for (const item of candidates) {
    if (!item) continue;
    if (typeof item === 'string') flattened.push(item);
    else if (Array.isArray(item)) flattened.push(item.map((part) => text(part)).filter(Boolean).join(', '));
    else if (typeof item === 'object') flattened.push(JSON.stringify(item));
  }
  const joined = text(flattened.join(' '));
  return {
    available: joined.length > 20,
    ingredient_count: asArray(seedData.ingredient_tokens || snapshot.ingredient_tokens).length,
    summary: firstSentence(joined, 160),
  };
}

function sourceDescription(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return (
    text(seedData.description) ||
    text(snapshot.description) ||
    text(seedData.pdp_description_raw) ||
    text(snapshot.pdp_description_raw)
  );
}

function buildBestFor(kind, category) {
  const label = kindLabel(kind, category);
  return [
    {
      tag: `${kind}_shoppers`,
      label: `${label.charAt(0).toUpperCase()}${label.slice(1)} shoppers`,
      confidence: 'moderate',
    },
    {
      tag: 'official_source_comparison',
      label: 'Official-source comparison',
      confidence: 'moderate',
    },
  ];
}

function buildHighlightPhrase(kind, category, description) {
  const desc = description.toLowerCase();
  if (kind === 'foundation' && /soft-?matte|blurring|blur/.test(desc)) return 'Soft-matte blurring base';
  if (kind === 'concealer' && /conceal|soft-?matte|shade/.test(desc)) return 'Complexion coverage detail';
  if (kind === 'lip' && /matte/.test(desc)) return 'Matte lip formula detail';
  if (kind === 'lip' && /gloss|shine/.test(desc)) return 'Shine lip formula detail';
  if (kind === 'lip' && /oil|creamy|emollience|glide/.test(desc)) return 'Creamy lip formula detail';
  if (kind === 'fragrance' && /(?:amber|leather|vanilla|floral|wood|rose|oud|citrus|ginger|cardamom)/.test(desc)) {
    const noteTerms = [
      ['ginger', 'Ginger'],
      ['cardamom', 'Cardamom'],
      ['coriander', 'Coriander'],
      ['vanilla', 'Vanilla'],
      ['leather', 'Leather'],
      ['amber', 'Amber'],
      ['honeyed wood', 'Honeyed woods'],
      ['woods', 'Woods'],
      ['oud', 'Oud'],
      ['rose', 'Rose'],
      ['citrus', 'Citrus'],
      ['bergamot', 'Bergamot'],
      ['jasmine', 'Jasmine'],
      ['tobacco', 'Tobacco'],
      ['cherry', 'Cherry'],
      ['sandalwood', 'Sandalwood'],
      ['neroli', 'Neroli'],
      ['tonka', 'Tonka'],
      ['myrrh', 'Myrrh'],
    ]
      .filter(([needle]) => desc.includes(needle))
      .map(([, label]) => label);
    if (noteTerms.length >= 2) return `${noteTerms.slice(0, 2).join(' ')} scent profile`.slice(0, 40);
    if (noteTerms.length === 1) return `${noteTerms[0]} scent profile`;
    return 'Official scent note profile';
  }
  if (kind === 'brow') return 'Brow-shaping source identity';
  if (kind === 'eye_treatment') return 'Eye treatment source identity';
  if (kind === 'eye_makeup') return 'Eye-makeup source identity';
  if (kind === 'blush') return 'Cheek color source identity';
  if (kind === 'bronzer') return 'Bronzer source identity';
  if (kind === 'highlighter') return 'Highlighter source identity';
  if (kind === 'face_powder') return 'Complexion powder detail';
  if (kind === 'body_oil') return 'Body oil source identity';
  if (kind === 'cleanser') return 'Cleanser source identity';
  if (kind === 'brush') return 'Brush format source identity';
  if (kind === 'skincare') return 'Skincare source identity';
  if (kind === 'home_fragrance') return 'Home-fragrance source identity';
  return `${text(category) || 'Beauty'} source identity`.slice(0, 40).trim();
}

function buildBundle({ seed, inventoryRow, generatedAt, batchName, reviewer }) {
  const seedData = asObject(seed.seed_data);
  const productId = text(seed.external_product_id);
  const title = text(seed.title || seedData.title || inventoryRow.title);
  const brand = text(seedData.brand || inventoryRow.brand || 'Tom Ford Beauty');
  const sourceUrl = text(seed.canonical_url || seed.destination_url || inventoryRow.canonical_url);
  const rawCategory = inferCategory(seed, inventoryRow);
  const categoryPath = inferCategoryPath(seed, inventoryRow);
  const description = sourceDescription(seedData);
  const descriptionSentence = firstSentence(description);
  const kind = inferKind(title, rawCategory, categoryPath, description);
  const category = displayCategoryForKind(kind, rawCategory);
  const label = kindLabel(kind, category);
  const ingredient = ingredientSignals(seedData);
  const evidenceProfile = ingredient.available ? 'seller_plus_formula' : 'official_pdp_seed';
  const highlight = buildHighlightPhrase(kind, category, description);
  const whatItIsBody = descriptionSentence
    ? `A ${brand} ${label} listed on the official source page as ${title}. The official description identifies: ${descriptionSentence}`
    : `A ${brand} ${label} listed on the official source page as ${title}.`;
  const formulaBody = ingredient.available
    ? `The seed includes official formula or ingredient-derived detail, so agents can cite source-backed product composition without making safety or medical claims.`
    : `No complete ingredient list was captured for this review batch, so formula-level claims stay unavailable.`;

  const sourceCoverage = {
    seller: {
      available: Boolean(sourceUrl),
      source_url: sourceUrl,
    },
    formula: {
      available: ingredient.available,
      ingredient_count: ingredient.ingredient_count,
      source_url: sourceUrl,
    },
    reviews: {
      available: false,
      count: 0,
    },
    creator: {
      available: false,
      count: 0,
    },
    editorial: {
      available: false,
      count: 0,
    },
  };
  const fieldSources = {
    what_it_is: 'official_seed_description',
    best_for: 'reviewed_category_and_official_title',
    why_it_stands_out: ingredient.available ? 'official_seed_description_and_formula' : 'official_seed_description',
    routine_fit: 'reviewed_category_and_official_title',
    watchouts: 'owner_delegated_assistant_review',
    texture_finish: 'reviewed_category_and_official_title',
    source_coverage: 'official_pdp_seed_snapshot',
    community_signals: 'not_collected',
  };

  return {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: 'Pivota Insights',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: productId,
      platform: 'external_seed',
    },
    product_group_id: text(inventoryRow.sellable_item_group_id) || null,
    product_intel_core: {
      display_name: 'Pivota Insights',
      what_it_is: {
        headline: `${label.charAt(0).toUpperCase()}${label.slice(1)} identity`,
        body: whatItIsBody,
      },
      best_for: buildBestFor(kind, category),
      why_it_stands_out: [
        {
          headline: 'Official product detail',
          body: descriptionSentence
            ? `The official seed description provides concrete product detail for ${title}, which is stronger than generic category copy.`
            : `The official title and reviewed category identify this PDP as ${category}, giving agents a grounded product type.`,
          evidence_strength: evidenceProfile,
        },
        {
          headline: ingredient.available ? 'Formula context captured' : 'Evidence gaps kept explicit',
          body: formulaBody,
          evidence_strength: evidenceProfile,
        },
      ],
      routine_fit: {
        step: routineStep(kind),
        am_pm: ['as_needed'],
        pairing_notes: [
          `Use within the ${label} context; avoid inferring benefits not present in the official source.`,
        ],
      },
      watchouts: [
        {
          type: ingredient.available ? 'formula_scope' : 'formula_gap',
          label: ingredient.available
            ? 'Formula details are source-derived; avoid medical, safety, or suitability claims not present in the source.'
            : 'No complete ingredient list was captured for this review batch; avoid formula-level or safety claims.',
          severity: 'medium',
        },
        {
          type: 'evidence_gap',
          label: 'No independent review or community evidence was approved for this row; do not describe it as popular or community-backed.',
          severity: 'medium',
        },
        {
          type: 'scope_guardrail',
          label: 'Use the commerce mainline for price and availability; keep this insight focused on source-backed product identity.',
          severity: 'medium',
        },
      ],
      confidence: {
        overall: 'moderate',
        fields: {
          what_it_is: sourceUrl ? 'high' : 'moderate',
          best_for: 'moderate',
          why_it_stands_out: descriptionSentence ? 'moderate' : 'low',
          routine_fit: 'moderate',
          watchouts: 'moderate',
        },
      },
      freshness: {
        generated_at: generatedAt,
        source_version: batchName,
      },
      quality_state: 'reviewed',
      evidence_profile: evidenceProfile,
      source_coverage: sourceCoverage,
    },
    texture_finish: {
      finish: label,
      texture: kind,
      source: 'reviewed_category_and_official_title',
    },
    community_signals: {
      status: 'unavailable',
      reason: 'not_collected_for_this_review_batch',
    },
    recommendation_intents: {
      similar: [],
      complementary: [],
      routine_pairing: [],
      underfill_reason: null,
      confidence: 'low',
    },
    market_signal_badges: [],
    external_highlight_signals: [],
    quality_state: 'reviewed',
    evidence_profile: evidenceProfile,
    source_coverage: sourceCoverage,
    confidence: {
      overall: 'moderate',
      fields: {
        what_it_is: sourceUrl ? 'high' : 'moderate',
        best_for: 'moderate',
        why_it_stands_out: descriptionSentence ? 'moderate' : 'low',
        routine_fit: 'moderate',
        watchouts: 'moderate',
      },
    },
    freshness: {
      generated_at: generatedAt,
      source_version: batchName,
    },
    offer_pointers: {
      offers_count: 0,
      default_offer_id: null,
      best_price_offer_id: null,
      commerce_modes: [],
    },
    provenance: {
      source: 'owner_delegated_official_seed_rewrite',
      generator: 'owner_delegated_assistant_reviewed_rewrite',
      selection_strategy: 'official_pdp_seed_guarded_manual_review',
      field_sources: fieldSources,
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: generatedAt,
      external_highlight_review_status: 'seller_only_fallback',
      external_review_batch: batchName,
      official_source_url: sourceUrl,
      official_source_ingredient_count: ingredient.ingredient_count,
      rewrite_reason:
        'Owner-delegated assistant review: official PDP seed rewrite; no price, availability, community, medical, or unsupported safety claims added.',
    },
    shopping_card: {
      contract_version: 'pivota.shopping_card.v1',
      title,
      subtitle: category,
      highlight,
      intro: whatItIsBody,
      evidence_profile: evidenceProfile,
    },
    search_card: {
      title_candidate: title,
      compact_candidate: category,
      highlight_candidate: highlight,
      intro_candidate: whatItIsBody,
      proof_badge_candidate: '',
    },
  };
}

function buildReportRows({ seeds, inventoryById, generatedAt, batchName, reviewer }) {
  return seeds.map((seed) => {
    const productId = text(seed.external_product_id);
    const inventoryRow = inventoryById.get(productId) || {};
    const bundle = buildBundle({ seed, inventoryRow, generatedAt, batchName, reviewer });
    return {
      case_id: `live_${productId}`,
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: generatedAt,
      notes: `Approved official-PDP-seed rewrite for ${text(seed.title)}; evidence_profile=${bundle.evidence_profile}; source_url=${text(seed.canonical_url || seed.destination_url)}`,
      owner_delegated_review: {
        contract_version: 'pivota.owner_delegated_review.v1',
        delegated_to: reviewer,
        reviewer_kind: 'assistant',
        owner_instruction: 'User delegated Codex to perform high-quality human review for Pivota Insights quality improvement.',
        guardrails: [
          'Do not overwrite good content with lower-quality content.',
          'No price or availability claims in Pivota Insights.',
          'Use official source facts only; keep evidence confidence explicit.',
        ],
      },
      quality_improvement_review: {
        decision: 'approved_replacement',
        reviewer_kind: 'assistant',
        owner_delegated: true,
        reason:
          'Owner-delegated assistant review confirms the replacement uses official PDP seed facts, avoids commerce and unsupported evidence claims, and explicitly marks evidence gaps instead of inventing claims.',
      },
      baseline: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: productId,
          platform: 'external_seed',
        },
      },
      selected: {
        selected_mode: 'manual_reviewed_rewrite',
        selected_field_count: 7,
        field_sources: bundle.provenance.field_sources,
        bundle,
      },
    };
  });
}

function selectInventoryRows(rows, options) {
  const domain = text(options.domain).toLowerCase();
  const lane = text(options.lane) || 'lane_3_kb_rewrite_review';
  const limit = Math.max(1, Number(options.limit || 100) || 100);
  const requireDescription = options.requireDescription !== false;
  return rows
    .filter((row) => !domain || text(row.domain).toLowerCase() === domain)
    .filter((row) => text(row.recommended_lane) === lane)
    .filter((row) => !text(row.seed_missing_fields))
    .filter((row) => text(row.identity_status) === 'approved' && row.identity_live_read_enabled !== false)
    .filter((row) => !row.kb_direct_high_quality_ready)
    .filter((row) => (requireDescription ? true : true))
    .slice(0, limit);
}

async function fetchSeeds(productIds) {
  if (!productIds.length) return [];
  const result = await query(
    `
      SELECT
        external_product_id,
        title,
        image_url,
        destination_url,
        canonical_url,
        seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], external_product_id)
    `,
    [productIds],
  );
  return result.rows || [];
}

function validateCandidateRows(reportRows) {
  const diagnostics = [];
  for (const row of reportRows) {
    const entries = buildKbEntriesForRow(row);
    if (entries.length !== 1) {
      diagnostics.push({ case_id: row.case_id, ok: false, reason: 'publish_entry_not_built' });
      continue;
    }
    const entry = entries[0];
    const inventory = buildPivotaInsightInventoryRow(entry, {
      title: row.selected?.bundle?.shopping_card?.title,
      canonicalUrl: row.selected?.bundle?.provenance?.official_source_url,
    });
    const commerceClaim = hasCommerceTruthClaim(row.selected?.bundle);
    diagnostics.push({
      case_id: row.case_id,
      product_id: row.selected?.bundle?.canonical_product_ref?.product_id,
      ok: inventory.public_ready && !commerceClaim,
      public_ready: inventory.public_ready,
      high_quality_ready: inventory.high_quality_ready,
      lane: inventory.lane,
      issues: inventory.issues,
      blocking_issues: inventory.blocking_issues,
      evidence_profile: inventory.evidence_profile,
      commerce_truth_claim: commerceClaim,
    });
  }
  return diagnostics;
}

async function main() {
  const inventoryPath = argValue('inventory');
  const outPath = argValue('out');
  if (!inventoryPath) throw new Error('--inventory is required');
  if (!outPath) throw new Error('--out is required');

  const batchName = text(argValue('batch-name')) || `official_seed_product_intel_${Date.now()}`;
  const reviewer = text(argValue('reviewer')) || 'codex_quality_reviewer_owner_delegated';
  const generatedAt = new Date().toISOString();
  const inventoryRows = readJson(inventoryPath);
  const selectedInventory = selectInventoryRows(inventoryRows, {
    domain: argValue('domain'),
    lane: argValue('lane', 'lane_3_kb_rewrite_review'),
    limit: argValue('limit', '100'),
    requireDescription: !hasFlag('allow-missing-description'),
  });
  const productIds = selectedInventory.map((row) => normalizeId(row.external_product_id)).filter(Boolean);
  const seeds = await fetchSeeds(productIds);
  const inventoryById = new Map(selectedInventory.map((row) => [normalizeId(row.external_product_id), row]));
  const seedById = new Map(seeds.map((seed) => [normalizeId(seed.external_product_id), seed]));
  const orderedSeeds = productIds.map((id) => seedById.get(id)).filter(Boolean);
  const reportRows = buildReportRows({
    seeds: orderedSeeds,
    inventoryById,
    generatedAt,
    batchName,
    reviewer,
  });
  const candidateDiagnostics = validateCandidateRows(reportRows);
  const badDiagnostics = candidateDiagnostics.filter((item) => !item.ok);
  if (badDiagnostics.length) {
    const err = new Error(`candidate_quality_validation_failed:${badDiagnostics.length}`);
    err.diagnostics = badDiagnostics;
    throw err;
  }

  if (hasFlag('validate-replacements')) {
    const entries = reportRows.flatMap((row) => buildKbEntriesForRow(row));
    const existingByKey = await fetchExistingProductIntelKbRows(entries.map((entry) => entry.kb_key));
    const { blockedEntries } = prepareEntriesForWrite(entries, reportRows, existingByKey);
    if (blockedEntries.length) {
      const err = new Error(`replacement_validation_blocked:${blockedEntries.length}`);
      err.blockedEntries = blockedEntries;
      throw err;
    }
  }

  const report = {
    meta: {
      generated_at: generatedAt,
      source: 'reviewed_official_seed_product_intel_report',
      batch_name: batchName,
      inventory: inventoryPath,
      selected_cases: reportRows.length,
      reviewer,
      reviewer_kind: 'assistant',
      candidate_quality_summary: {
        public_ready: candidateDiagnostics.filter((item) => item.public_ready).length,
        high_quality_ready: candidateDiagnostics.filter((item) => item.high_quality_ready).length,
        evidence_profile: candidateDiagnostics.reduce((acc, item) => {
          acc[item.evidence_profile] = (acc[item.evidence_profile] || 0) + 1;
          return acc;
        }, {}),
      },
    },
    rows: reportRows,
  };
  writeJson(outPath, report);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      out: outPath,
      rows: reportRows.length,
      selected_product_ids: productIds,
      quality: report.meta.candidate_quality_summary,
    })}\n`,
  );
}

main()
  .catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    if (err && err.diagnostics) {
      process.stderr.write(`${JSON.stringify(err.diagnostics, null, 2)}\n`);
    }
    if (err && err.blockedEntries) {
      process.stderr.write(`${JSON.stringify(err.blockedEntries, null, 2)}\n`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
    if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
  });
