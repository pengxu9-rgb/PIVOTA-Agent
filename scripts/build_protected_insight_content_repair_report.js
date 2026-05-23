#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { closePool, query } = require('../src/db');
const {
  classifyProductIntelKbRow,
  readProductIntelBundleFromKbRow,
} = require('../src/services/externalSeedPdpReadiness');
const {
  hashJson,
  hasCommerceTruthClaim,
  isProtectedPivotaInsight,
} = require('../src/services/pivotaInsightsQuality');
const {
  hasSingleItemTitleMultiItemBodyMismatch,
} = require('./build_protected_insight_highlight_repair_report');

const OWNER_DELEGATED_REVIEW_CONTRACT_VERSION = 'pivota.owner_delegated_review.v1';
const CONTENT_REPAIR_CONTRACT_VERSION = 'pivota.protected_content_repair.v1';

const ALLOWED_BLOCKERS = new Set([
  'missing_card_highlight',
  'generic_copy_signal',
  'ellipsis_or_truncated',
  'what_it_is_too_long',
]);

function parseArgs(argv) {
  const out = {
    market: 'US',
    domain: '',
    limit: 25,
    scanLimit: 1000,
    productIds: [],
    out: '',
    reviewer: 'codex_quality_reviewer',
    reviewedAt: '',
    ownerInstruction:
      'Owner delegated Codex to perform conservative protected Pivota Insights content repair review.',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--market' && next) {
      out.market = text(next);
      index += 1;
    } else if (token === '--domain' && next) {
      out.domain = text(next);
      index += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Math.min(100, Number(next) || 25));
      index += 1;
    } else if (token === '--scan-limit' && next) {
      out.scanLimit = Math.max(1, Math.min(5000, Number(next) || 1000));
      index += 1;
    } else if (token === '--product-ids' && next) {
      out.productIds = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
    } else if (token === '--out' && next) {
      out.out = text(next);
      index += 1;
    } else if (token === '--reviewer' && next) {
      out.reviewer = text(next);
      index += 1;
    } else if (token === '--reviewed-at' && next) {
      out.reviewedAt = text(next);
      index += 1;
    } else if (token === '--owner-instruction' && next) {
      out.ownerInstruction = text(next);
      index += 1;
    }
  }

  return out;
}

function text(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeReviewedAt(value) {
  const raw = text(value);
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`invalid_reviewed_at:${raw}`);
  return date.toISOString();
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function cleanSourceText(value) {
  return text(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/•/g, '; ')
    .replace(/[$€£¥]\s*\d+(?:\.\d{2})?\s*(?:value)?\b/gi, ' ')
    .replace(/\b\d{1,3}%\s*off\b/gi, ' ')
    .replace(/\bsave\s+\d{1,3}%\b/gi, ' ')
    .replace(/\b(?:sale|discount|promo|promotion|clearance)\b/gi, ' ')
    .replace(/\bVolume:\s*\d+(?:\.\d+)?\s*(?:ml|fl\.?\s*oz|oz)\b/gi, ' ')
    .replace(/\b(?:not tested on animals|paraben-free|cruelty-free|safe for all skin types)\b\.?/gi, ' ')
    .replace(/\b(?:suitable|suited)\s+for\s+all\s+skin\s+types\b\.?/gi, ' ')
    .replace(/\ball\s+skin\s+types\b/gi, 'broad routine positioning')
    .replace(/\bcalms?\s*&\s*minimi[sz]es redness\b/gi, 'supports the look of calmer skin')
    .replace(/\bminimi[sz]e redness\s+and\s+calm skin\b/gi, 'support a calmer-looking routine')
    .replace(
      /\bprovides an invisible layer of skin-soothers,\s*making it the ultimate remedy for dry skin\s*-\s*now in travel-size\b/gi,
      'provides a hydration layer and is positioned as a travel-size mist for dry-feeling skin',
    )
    .replace(
      /\bbalances and soothes even the most sensitive skin\b/gi,
      'balances the routine and is positioned for gentle-feeling toner use',
    )
    .replace(/\bmaking it the ultimate remedy for dry skin\s*-\s*now in travel-size\b/gi, 'as a travel-size hydration mist for dry-feeling skin')
    .replace(/\bultimate remedy\b/gi, 'hydrating mist')
    .replace(/\bsoothes? even the most sensitive skin\b/gi, 'is positioned for gentle-feeling toner routines')
    .replace(/\bsoothes? skin\b/gi, 'is positioned around soothing-looking care')
    .replace(/\bminimi[sz]e redness\b/gi, 'support the look of calmer skin')
    .replace(/\bcalms? skin\b/gi, 'supports the look of calmer skin')
    .replace(/^\s*[;:,-]+\s*/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\.{2,}|…/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sentence(value, maxLength = 220) {
  const cleaned = cleanSourceText(value);
  if (!cleaned) return '';
  const parts = cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const picked = parts.find((item) => item.length >= 28) || parts[0] || cleaned;
  const limited =
    picked.length <= maxLength ? picked : picked.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return limited.replace(/[,:;]+$/g, '').replace(/[.!?]*$/, '.');
}

function sentenceFragment(value) {
  return text(value).replace(/[.!?]+$/g, '').trim();
}

function articleFor(value) {
  return /^[aeiou]/i.test(text(value)) ? 'An' : 'A';
}

function readSeedData(seedRow) {
  const seedData = asObject(seedRow.seed_data);
  return {
    seedData,
    snapshot: asObject(seedData.snapshot),
  };
}

function displayBrandName(value) {
  const raw = text(value);
  if (!raw) return '';
  const known = {
    'fenty beauty': 'Fenty Beauty',
    'fenty skin': 'Fenty Skin',
    pixi: 'Pixi',
    'pixi beauty': 'Pixi',
    pixibeauty: 'Pixi',
  };
  const normalized = raw.toLowerCase();
  if (known[normalized]) return known[normalized];
  return raw
    .split(/\s+/)
    .map((part) => (part ? `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}` : part))
    .join(' ');
}

function brandName(seedRow) {
  const { seedData, snapshot } = readSeedData(seedRow);
  return displayBrandName(
    asObject(seedData.brand).name ||
      seedData.brand ||
      seedData.brand_name ||
      asObject(snapshot.brand).name ||
      snapshot.brand ||
      snapshot.brand_name,
  );
}

function readOfficialDescription(seedRow) {
  const { seedData, snapshot } = readSeedData(seedRow);
  return (
    text(seedData.description) ||
    text(snapshot.description) ||
    text(seedData.pdp_description_raw) ||
    text(snapshot.pdp_description_raw)
  );
}

function readDetailsSections(seedRow) {
  const { seedData, snapshot } = readSeedData(seedRow);
  return [
    ...asArray(seedData.pdp_details_sections),
    ...asArray(snapshot.pdp_details_sections),
    ...asArray(seedData.details_sections),
    ...asArray(snapshot.details_sections),
  ];
}

function detailsBodyByHeading(seedRow, headingPattern) {
  return text(
    readDetailsSections(seedRow).find((item) => headingPattern.test(text(item?.heading)))?.body,
  );
}

function readIngredientText(seedRow) {
  const { seedData, snapshot } = readSeedData(seedRow);
  return (
    text(seedData.raw_ingredient_text_clean) ||
    text(snapshot.raw_ingredient_text_clean) ||
    text(seedData.inci_list) ||
    text(snapshot.inci_list) ||
    detailsBodyByHeading(seedRow, /ingredients?/i)
  );
}

function readReviewSummary(seedRow) {
  const { seedData, snapshot } = readSeedData(seedRow);
  if (isPlainObject(seedData.review_summary)) return seedData.review_summary;
  if (isPlainObject(snapshot.review_summary)) return snapshot.review_summary;
  return null;
}

function reviewCount(seedRow) {
  const summary = readReviewSummary(seedRow);
  return Math.max(0, Number(summary?.review_count || summary?.product_line_review_count || 0) || 0);
}

function reviewRating(seedRow) {
  const summary = readReviewSummary(seedRow);
  return Number(summary?.rating || 0) || 0;
}

function isMultiItemText(value) {
  const source = text(value).toLowerCase();
  const sizeFragments = source.match(/\b\d+(?:\.\d+)?\s*(?:ml|fl\.?\s*oz|oz)\s*[-–—:]/gi) || [];
  if (sizeFragments.length < 2) return false;
  const roleFragments =
    source.match(/\b(?:cleanser|tonic|toner|lotion|serum|mist|cream|creme|oil|mask|balm)\b/gi) || [];
  return new Set(roleFragments.map((item) => item.toLowerCase())).size >= 2;
}

function classifyTitle(title) {
  const lower = text(title).toLowerCase();
  if (/\b(?:leave[-\s]?in|detangling)\b/.test(lower) && /\b(?:conditioner|spray)\b/.test(lower)) {
    return {
      label: 'leave-in conditioner spray',
      headline: 'Leave-in conditioner spray',
      highlight: 'Detangling leave-in spray',
      step: 'hair_care',
      bestFor: [
        { tag: 'detangling_hair_care', label: 'Detangling hair-care routines', confidence: 'moderate' },
        { tag: 'leave_in_conditioner', label: 'Leave-in conditioner shoppers', confidence: 'moderate' },
      ],
    };
  }
  if (/\b(?:clay|pore|detox)\b/.test(lower) && /\bmask\b/.test(lower)) {
    return {
      label: 'clay face mask',
      headline: 'Clay face mask',
      highlight: 'Clay pore mask',
      step: 'mask',
      bestFor: [
        { tag: 'clay_mask', label: 'Clay mask routines', confidence: 'moderate' },
        { tag: 'pore_care', label: 'Pore-care shoppers', confidence: 'moderate' },
      ],
    };
  }
  if (/\b(?:body cream|butta drop|whipped oil body cream)\b/.test(lower)) {
    return {
      label: 'body cream',
      headline: 'Body cream',
      highlight: 'Whipped body cream',
      step: 'body_care',
      bestFor: [
        { tag: 'body_moisturizer', label: 'Body moisturizer routines', confidence: 'moderate' },
        { tag: 'body_glow', label: 'Body glow shoppers', confidence: 'moderate' },
      ],
    };
  }
  if (/\b(?:lip[-\s]?loving scrubstick|lip scrub|scrubstick)\b/.test(lower)) {
    return {
      label: 'lip scrub',
      headline: 'Lip scrub',
      highlight: 'Lip scrub stick',
      step: 'lip_care',
      bestFor: [
        { tag: 'lip_prep', label: 'Lip-prep routines', confidence: 'moderate' },
        { tag: 'lip_care', label: 'Lip-care shoppers', confidence: 'moderate' },
      ],
    };
  }
  if (/\b(?:fat water|toner essence|milky toner essence)\b/.test(lower)) {
    return {
      label: 'toner essence',
      headline: 'Toner essence',
      highlight: 'Toner-essence step',
      step: 'toner',
      bestFor: [
        { tag: 'toner_essence', label: 'Toner-essence routines', confidence: 'moderate' },
        { tag: 'hydrating_toner', label: 'Hydrating toner shoppers', confidence: 'moderate' },
      ],
    };
  }
  if (/\bmascara\b/.test(lower)) {
    return {
      label: 'mascara',
      headline: 'Mascara',
      highlight: 'Volumizing mascara',
      step: 'eye_makeup',
      bestFor: [
        { tag: 'mascara_shoppers', label: 'Mascara shoppers', confidence: 'moderate' },
        { tag: 'eye_makeup', label: 'Eye-makeup routines', confidence: 'moderate' },
      ],
    };
  }
  if (/\b(?:setting|blotting|brightening|blurring)\b/.test(lower) && /\bpowder\b/.test(lower)) {
    return {
      label: 'face powder',
      headline: 'Face powder',
      highlight: /blotting/.test(lower) ? 'Blotting powder compact' : 'Blurring setting powder',
      step: 'complexion',
      bestFor: [
        { tag: 'setting_powder', label: 'Setting-powder routines', confidence: 'moderate' },
        { tag: 'complexion_finish', label: 'Complexion finish shoppers', confidence: 'moderate' },
      ],
    };
  }
  if (/\bprimer\b/.test(lower)) {
    return {
      label: 'makeup primer',
      headline: 'Makeup primer',
      highlight: /hydrat/.test(lower) ? 'Hydrating primer base' : 'Complexion primer base',
      step: 'complexion',
      bestFor: [
        { tag: 'primer_shoppers', label: 'Primer shoppers', confidence: 'moderate' },
        { tag: 'complexion_prep', label: 'Complexion-prep routines', confidence: 'moderate' },
      ],
    };
  }
  if (/\b(?:match stix|skinstick)\b/.test(lower)) {
    return {
      label: 'glow skinstick',
      headline: 'Glow skinstick',
      highlight: 'Cream glow skinstick',
      step: 'complexion',
      bestFor: [
        { tag: 'cream_highlighter', label: 'Cream highlighter shoppers', confidence: 'moderate' },
        { tag: 'complexion_glow', label: 'Complexion glow routines', confidence: 'moderate' },
      ],
    };
  }
  if (/\bhydrating\s+milky\s+mist\b/.test(lower)) {
    return {
      label: 'facial mist',
      headline: 'Hydrating facial mist',
      highlight: 'Hydrating facial mist',
      step: 'mist',
      bestFor: [
        { tag: 'hydration_mist', label: 'Hydration mist routines', confidence: 'moderate' },
        { tag: 'pre_serum_or_refresh', label: 'Pre-serum or refresh steps', confidence: 'moderate' },
      ],
    };
  }
  if (/\bmilky\s+tonic\b/.test(lower)) {
    return {
      label: 'milky toner',
      headline: 'Milky toner step',
      highlight: 'Milky toner step',
      step: 'toner',
      bestFor: [
        { tag: 'gentle_toner', label: 'Gentle toner routines', confidence: 'moderate' },
        { tag: 'travel_toner', label: 'Travel-size toner shoppers', confidence: 'moderate' },
      ],
    };
  }
  if (/\brose\s+tonic\b/.test(lower)) {
    return {
      label: 'rose toner',
      headline: 'Rose toner step',
      highlight: 'Rose toner step',
      step: 'toner',
      bestFor: [
        { tag: 'rose_toner', label: 'Rose toner routines', confidence: 'moderate' },
        { tag: 'calmer_looking_skin', label: 'Calmer-looking toner steps', confidence: 'moderate' },
      ],
    };
  }
  if (/\btonic\b|\btoner\b/.test(lower)) {
    return {
      label: 'toner',
      headline: 'Toner step',
      highlight: 'Toner step',
      step: 'toner',
      bestFor: [{ tag: 'toner_routine', label: 'Toner routines', confidence: 'moderate' }],
    };
  }
  if (/\bmist\b/.test(lower)) {
    return {
      label: 'facial mist',
      headline: 'Facial mist',
      highlight: 'Facial mist',
      step: 'mist',
      bestFor: [{ tag: 'mist_routine', label: 'Mist routines', confidence: 'moderate' }],
    };
  }
  return {
    label: 'beauty product',
    headline: 'Product identity',
    highlight: 'Official product detail',
    step: 'beauty',
    bestFor: [{ tag: 'official_source_comparison', label: 'Official-source comparison', confidence: 'moderate' }],
  };
}

function buildFormulaSummary(seedRow) {
  const ingredientText = readIngredientText(seedRow);
  const cleaned = cleanSourceText(ingredientText)
    .replace(/\bfull ingredient list\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 20) return '';
  return sentence(cleaned, 180);
}

function sourceCoverage(seedRow, existingBundle) {
  const existingCoverage = asObject(existingBundle?.source_coverage);
  const count = reviewCount(seedRow);
  return {
    ...existingCoverage,
    seller: {
      ...asObject(existingCoverage.seller),
      available: Boolean(readOfficialDescription(seedRow)),
      source_url: text(seedRow.canonical_url || seedRow.destination_url),
    },
    formula: {
      ...asObject(existingCoverage.formula),
      available: Boolean(readIngredientText(seedRow)),
      source_url: text(seedRow.canonical_url || seedRow.destination_url),
    },
    reviews: {
      ...asObject(existingCoverage.reviews),
      available: count > 0,
      count,
      source: count > 0 ? 'merchant_public_review_summary' : undefined,
    },
    creator: {
      ...asObject(existingCoverage.creator),
      available: false,
      count: 0,
    },
    editorial: {
      ...asObject(existingCoverage.editorial),
      available: false,
      count: 0,
    },
  };
}

function buildReviewSummaryForBundle(seedRow) {
  const summary = readReviewSummary(seedRow);
  const count = reviewCount(seedRow);
  const rating = reviewRating(seedRow);
  if (!summary || !count || !rating) return null;
  return {
    rating,
    scale: Number(summary.scale || 5) || 5,
    review_count: count,
    source: 'merchant_public_review_summary',
    aggregation_scope: text(summary.aggregation_scope) || 'product_or_line',
  };
}

function buildCommunitySignals(seedRow) {
  const count = reviewCount(seedRow);
  const rating = reviewRating(seedRow);
  if (!count || !rating) {
    return {
      status: 'unavailable',
      unavailable_reason: 'insufficient_feedback',
      confidence: 'low',
      evidence_profile: 'seller_only',
    };
  }
  return {
    status: 'available',
    source: 'merchant_public_review_summary',
    evidence_profile: 'community_supported',
    confidence: count >= 50 ? 'moderate' : 'low',
    top_loves: [`${rating.toFixed(1)} average across ${count} merchant-public reviews.`],
    caveats: [
      'Treat review summaries as merchant-public feedback, not independent clinical evidence.',
    ],
  };
}

function buildCandidateBundle({ seedRow, kbRow, reviewedAt, reviewer }) {
  const existing = readProductIntelBundleFromKbRow(kbRow);
  if (!existing) return null;
  const title = text(seedRow.title || existing.shopping_card?.title);
  const kind = classifyTitle(title);
  const description = readOfficialDescription(seedRow);
  const detailsText = detailsBodyByHeading(seedRow, /details?/i);
  const useDetails = detailsText && !isMultiItemText(detailsText);
  const descriptionSentence = sentence(description || (useDetails ? detailsText : ''));
  if (!descriptionSentence) return null;
  const formulaSummary = buildFormulaSummary(seedRow);
  const count = reviewCount(seedRow);
  const previousBundleHash = hashJson(existing);
  const coverage = sourceCoverage(seedRow, existing);
  const sourceUrl = text(seedRow.canonical_url || seedRow.destination_url);
  const brand = brandName(seedRow);
  const productLabel = text(`${brand} ${kind.label}`) || kind.label;
  const whatItIsBody = `${articleFor(productLabel)} ${productLabel} listed on the official source page as ${title}. The official description says: ${descriptionSentence}`;
  const why = [
    {
      headline: 'Official product detail',
      body: `The official source positions this as ${kind.label}. Official description: ${descriptionSentence}`,
      evidence_strength: 'official_source',
    },
  ];
  if (formulaSummary) {
    why.push({
      headline: 'Formula context captured',
      body: `Captured source fields mention ${sentenceFragment(formulaSummary)}. Agents should keep formula claims within those captured fields.`,
      evidence_strength: 'seller_plus_formula',
    });
  }
  if (count > 0) {
    why.push({
      headline: 'Merchant-public feedback available',
      body: `Merchant-public review summary is available for this product line, so agents can use it as feedback context without treating it as independent clinical evidence.`,
      evidence_strength: 'community_supported',
    });
  }

  const candidate = cloneJson(existing);
  candidate.quality_state = existing.quality_state || 'eligible';
  candidate.evidence_profile = 'community_supported';
  candidate.source_coverage = coverage;
  const reviewSummary = buildReviewSummaryForBundle(seedRow);
  if (reviewSummary) candidate.review_summary = reviewSummary;
  candidate.community_signals = buildCommunitySignals(seedRow);
  candidate.product_intel_core = {
    ...asObject(candidate.product_intel_core),
    display_name: 'Pivota Insights',
    what_it_is: {
      headline: kind.headline,
      body: whatItIsBody,
    },
    best_for: kind.bestFor,
    why_it_stands_out: why,
    routine_fit: {
      step: kind.step,
      am_pm: ['am', 'pm'],
      pairing_notes: [`Use as a ${kind.label} step; keep offer facts in the commerce mainline.`],
    },
    watchouts: [
      {
        type: 'commerce_truth_guardrail',
        label: 'Use the commerce mainline for offer facts; keep this insight focused on source-backed product identity.',
        severity: 'medium',
      },
      {
        type: 'review_scope',
        label: 'Merchant-public review signals are feedback context, not independent clinical evidence.',
        severity: 'medium',
      },
      {
        type: formulaSummary ? 'formula_scope' : 'formula_gap',
        label: formulaSummary
          ? 'Formula context is limited to captured source fields; avoid unsupported safety or sensitivity claims.'
          : 'No complete ingredient list was captured for this repair; avoid formula-level claims.',
        severity: 'medium',
      },
    ],
    confidence: {
      overall: count > 0 ? 'moderate' : 'limited',
      fields: {
        what_it_is: 'high',
        best_for: 'moderate',
        why_it_stands_out: 'moderate',
        routine_fit: 'moderate',
        watchouts: 'moderate',
      },
    },
    freshness: {
      generated_at: reviewedAt,
      source_version: 'protected_community_content_repair',
    },
    quality_state: candidate.quality_state,
    evidence_profile: candidate.evidence_profile,
    source_coverage: coverage,
  };
  candidate.shopping_card = {
    ...asObject(candidate.shopping_card),
    contract_version: 'pivota.shopping_card.v1',
    title: candidate.shopping_card?.title || `PIXI BEAUTY ${title}`,
    subtitle: kind.headline,
    highlight: kind.highlight,
    intro: whatItIsBody,
    evidence_profile: candidate.evidence_profile,
  };
  candidate.search_card = {
    ...asObject(candidate.search_card),
    title_candidate: candidate.search_card?.title_candidate || `PIXI BEAUTY ${title}`,
    compact_candidate: kind.headline,
    highlight_candidate: kind.highlight,
    intro_candidate: whatItIsBody,
  };
  candidate.card_highlight = kind.highlight;
  candidate.provenance = {
    ...asObject(candidate.provenance),
    protected_content_repair: {
      contract_version: CONTENT_REPAIR_CONTRACT_VERSION,
      repair_type: 'protected_community_content_repair',
      source: 'official_seed_and_existing_protected_bundle',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: reviewedAt,
      official_source_url: sourceUrl,
      previous_bundle_hash: previousBundleHash,
      repaired_fields: [
        'product_intel_core.what_it_is',
        'product_intel_core.best_for',
        'product_intel_core.why_it_stands_out',
        'product_intel_core.routine_fit',
        'product_intel_core.watchouts',
        'shopping_card',
        'search_card',
        'card_highlight',
      ],
    },
  };

  return { bundle: candidate, previousBundleHash };
}

function buildSkipReason({ classification, kbRow, seedRow }) {
  const productId = text(seedRow?.external_product_id || seedRow?.product_id);
  const bundle = readProductIntelBundleFromKbRow(kbRow);
  if (!bundle) return 'missing_bundle';
  if (!classification.displayable) return 'not_displayable';
  if (!classification.human_reviewed) return 'not_human_reviewed';
  if (!isProtectedPivotaInsight(kbRow, { productId, bundle })) return 'not_protected';
  if (text(classification.evidence_profile).toLowerCase() !== 'community_supported') {
    return `not_community_supported:${classification.evidence_profile || 'unknown'}`;
  }
  const blocking = asArray(classification.blocking_issues);
  if (!blocking.length) return 'no_blocking_issues';
  const unexpected = blocking.filter((issue) => !ALLOWED_BLOCKERS.has(issue));
  if (unexpected.length) return `unsupported_blockers:${unexpected.join('|')}`;
  if (hasCommerceTruthClaim(bundle)) return 'existing_commerce_truth_claim';
  if (!readOfficialDescription(seedRow)) return 'missing_official_description';
  return '';
}

function buildContentRepairRow(seedRow, kbRow, options = {}) {
  const productId = text(seedRow?.external_product_id || seedRow?.product_id);
  const classification = classifyProductIntelKbRow(kbRow, { productId });
  const skipReason = buildSkipReason({ classification, kbRow, seedRow });
  if (skipReason) {
    return {
      skipped: true,
      case_id: productId,
      reason: skipReason,
      title: text(seedRow?.title),
    };
  }

  const reviewedAt = normalizeReviewedAt(options.reviewedAt);
  const reviewer = text(options.reviewer) || 'codex_quality_reviewer';
  const candidate = buildCandidateBundle({ seedRow, kbRow, reviewedAt, reviewer });
  if (!candidate) {
    return {
      skipped: true,
      case_id: productId,
      reason: 'candidate_unavailable',
      title: text(seedRow?.title),
    };
  }

  if (hasCommerceTruthClaim(candidate.bundle)) {
    return {
      skipped: true,
      case_id: productId,
      reason: 'candidate_commerce_truth_claim',
      title: text(seedRow?.title),
    };
  }

  const candidateEntry = {
    kb_key: `product:${productId}`,
    analysis: {
      product_intel_v1: candidate.bundle,
    },
  };
  const candidateClassification = classifyProductIntelKbRow(candidateEntry, { productId });
  if (!candidateClassification.displayable || candidateClassification.blocking_issues.length) {
    return {
      skipped: true,
      case_id: productId,
      reason: `candidate_quality_blocked:${candidateClassification.blocking_issues.join('|') || 'not_displayable'}`,
      title: text(seedRow?.title),
      candidate_issues: candidateClassification.issues,
    };
  }

  const candidateHash = hashJson(candidate.bundle);
  return {
    case_id: productId,
    review_status: 'completed',
    review_decision: 'rewrite',
    reviewer,
    reviewer_kind: 'assistant',
    reviewed_at: reviewedAt,
    notes:
      'Owner-delegated assistant protected-content repair. Existing protected community-supported bundle is replaced only after candidate passes public quality gates.',
    owner_delegated_review: {
      contract_version: OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
      delegated_to: reviewer,
      reviewer_kind: 'assistant',
      owner_instruction:
        text(options.ownerInstruction) ||
        'Owner delegated Codex to perform conservative protected Pivota Insights content repair review.',
      source_review_packet_decision: 'pass_recommended',
      source_public_write_allowed_by_packet: true,
      rationale:
        'Existing protected bundle has fixable content blockers; replacement is official-source-grounded, preserves community_supported evidence, avoids commerce truth, and passes public quality gates.',
      candidate_bundle_hash: candidateHash,
      previous_bundle_hash: candidate.previousBundleHash,
    },
    quality_improvement_review: {
      decision: 'approved_replacement',
      reviewer,
      reviewer_kind: 'assistant',
      owner_delegated: true,
      approval_basis: 'owner_delegated_assistant_quality_review',
      reason:
        'Approved as a surgical protected-content repair that fixes stale/generic/mismatched insight fields without downgrading evidence profile or adding commerce claims.',
      candidate_bundle_hash: candidateHash,
      previous_bundle_hash: candidate.previousBundleHash,
    },
    baseline: {
      canonical_product_ref:
        candidate.bundle.canonical_product_ref || {
          merchant_id: 'external_seed',
          product_id: productId,
        },
    },
    selected: {
      selected_mode: 'protected_community_content_repair',
      selected_field_count: 8,
      field_sources: {
        'product_intel_core.what_it_is': 'official_seed_content_repair',
        'product_intel_core.best_for': 'reviewed_title_category_repair',
        'product_intel_core.why_it_stands_out': 'official_seed_and_review_summary_repair',
        'product_intel_core.routine_fit': 'reviewed_title_category_repair',
        'product_intel_core.watchouts': 'owner_delegated_quality_repair',
        shopping_card: 'official_seed_content_repair',
        search_card: 'official_seed_content_repair',
        card_highlight: 'official_seed_content_repair',
      },
      bundle: candidate.bundle,
    },
    review_packet: {
      title: text(seedRow?.title),
      canonical_url: text(seedRow?.canonical_url || seedRow?.destination_url),
      previous_bundle_hash: candidate.previousBundleHash,
      candidate_bundle_hash: candidateHash,
      previous_blocking_issues: classification.blocking_issues,
      candidate_issues: candidateClassification.issues,
      preserved_evidence_profile: candidate.bundle.evidence_profile,
      official_description: readOfficialDescription(seedRow),
      multi_item_details_ignored: isMultiItemText(detailsBodyByHeading(seedRow, /details?/i)) ||
        hasSingleItemTitleMultiItemBodyMismatch({
          seedRow,
          bundle: readProductIntelBundleFromKbRow(kbRow),
        }),
    },
  };
}

function buildContentRepairReport(seedRows, kbRows, options = {}) {
  const kbByProductId = new Map(
    asArray(kbRows).map((row) => [text(row?.kb_key).replace(/^product:/, ''), row]),
  );
  const rows = [];
  const skippedRows = [];

  for (const seedRow of asArray(seedRows)) {
    const productId = text(seedRow?.external_product_id || seedRow?.product_id);
    const kbRow = kbByProductId.get(productId);
    if (!kbRow) {
      skippedRows.push({ case_id: productId, reason: 'missing_kb_row', title: text(seedRow?.title) });
      continue;
    }
    const row = buildContentRepairRow(seedRow, kbRow, options);
    if (row.skipped) {
      skippedRows.push(row);
      continue;
    }
    rows.push(row);
    if (rows.length >= Number(options.limit || 25)) break;
  }

  return {
    meta: {
      generated_at: normalizeReviewedAt(options.reviewedAt),
      source: 'protected_insight_content_repair',
      review_contract_version: OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
      repair_contract_version: CONTENT_REPAIR_CONTRACT_VERSION,
      selected_cases: rows.length,
      skipped_cases: skippedRows.length,
      reviewer: text(options.reviewer) || 'codex_quality_reviewer',
      reviewer_kind: 'assistant',
      guardrail:
        'Only displayable, human-reviewed, protected community-supported bundles with fixable content blockers are eligible.',
    },
    rows,
    skipped_rows: skippedRows,
  };
}

async function fetchCandidateRows(options) {
  const productIds = asArray(options.productIds).map(text).filter(Boolean);
  const params = [text(options.market || 'US') || 'US'];
  const clauses = [
    "eps.status = 'active'",
    "eps.external_product_id LIKE 'ext_%'",
    'eps.market = $1',
  ];
  if (text(options.domain)) {
    params.push(text(options.domain));
    clauses.push(`eps.domain = $${params.length}`);
  }
  if (productIds.length) {
    params.push(productIds);
    clauses.push(`eps.external_product_id = ANY($${params.length}::text[])`);
  }
  const scanLimit = productIds.length
    ? Math.max(productIds.length, Number(options.scanLimit || 1000))
    : Number(options.scanLimit || 1000);
  params.push(Math.max(1, Math.min(5000, scanLimit)));

  const result = await query(
    `
      SELECT
        eps.external_product_id,
        eps.title,
        eps.canonical_url,
        eps.destination_url,
        eps.seed_data,
        kb.kb_key,
        kb.source,
        kb.source_meta,
        kb.last_success_at,
        kb.last_error,
        kb.updated_at,
        kb.analysis
      FROM external_product_seeds eps
      JOIN aurora_product_intel_kb kb
        ON kb.kb_key = ('product:' || eps.external_product_id)
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY eps.updated_at DESC NULLS LAST, eps.external_product_id
      LIMIT $${params.length}
    `,
    params,
  );

  const seedRows = [];
  const kbRows = [];
  for (const row of result.rows || []) {
    seedRows.push({
      external_product_id: row.external_product_id,
      title: row.title,
      canonical_url: row.canonical_url,
      destination_url: row.destination_url,
      seed_data: row.seed_data,
    });
    kbRows.push({
      kb_key: row.kb_key,
      source: row.source,
      source_meta: row.source_meta,
      last_success_at: row.last_success_at,
      last_error: row.last_error,
      updated_at: row.updated_at,
      analysis: row.analysis,
    });
  }
  return { seedRows, kbRows };
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const outPath = resolvePath(rootDir, args.out);
  if (!outPath) throw new Error('missing_out_path');

  const reviewedAt = normalizeReviewedAt(args.reviewedAt);
  const { seedRows, kbRows } = await fetchCandidateRows(args);
  const report = buildContentRepairReport(seedRows, kbRows, {
    ...args,
    reviewedAt,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      out: outPath,
      rows: report.rows.map((row) => row.case_id),
      skipped: report.skipped_rows.length,
    })}\n`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}

module.exports = {
  CONTENT_REPAIR_CONTRACT_VERSION,
  OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
  buildCandidateBundle,
  buildContentRepairReport,
  buildContentRepairRow,
  cleanSourceText,
  classifyTitle,
  isMultiItemText,
  parseArgs,
};
