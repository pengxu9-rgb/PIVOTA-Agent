#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const {
  buildProductIntelDraftBundle,
  PRODUCT_INTEL_CONTRACT_VERSION,
  PIVOTA_INSIGHTS_DISPLAY_NAME,
} = require('../src/pdpProductIntel');

function parseArgs(argv) {
  const out = {
    cases: 'scripts/fixtures/product_intel_pilot_cases.json',
    out: '',
    markdown: '',
    manualOverrides: 'scripts/fixtures/product_intel_manual_overrides.json',
    model: process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL || 'gemini-3-pro-preview',
    skipGemini: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cases' && next) {
      out.cases = next;
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (token === '--markdown' && next) {
      out.markdown = next;
      i += 1;
    } else if (token === '--manual-overrides' && next) {
      out.manualOverrides = next;
      i += 1;
    } else if (token === '--model' && next) {
      out.model = next;
      i += 1;
    } else if (token === '--skip-gemini') {
      out.skipGemini = true;
    }
  }

  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function isLowSignalSellerHighlightText(text) {
  const normalized = asString(text).toLowerCase();
  if (!normalized) return false;
  return /(^|\b)(double up and save|stock up|save with|jumbo size|travel size|value size|value pack|limited edition|extended use)(\b|$)/.test(
    normalized,
  );
}

function isGenericSellerHighlightText(text) {
  const normalized = asString(text).toLowerCase();
  if (!normalized) return false;
  return [
    /(^|\b)designed to\b/,
    /(^|\b)claims? to\b/,
    /(^|\b)features? a (lightweight|rich|gel|stick|buttery|non-greasy|smooth)\b/,
    /(^|\b)delivered in (a )?convenient\b/,
    /(^|\b)formulated to be gentle\b/,
    /(^|\b)powered by (a )?blend\b/,
    /(^|\b)provides? up to \d+\s*hours?\b/,
    /(^|\b)for daily use\b/,
    /(^|\b)for intensive overnight moisture\b/,
    /\bpositions? itself\b/,
    /\bcenters? its\b.*\bstory\b/,
    /\bbuilds? its\b.*\bstory\b/,
    /\bformula story\b/,
    /\bvisible-[a-z-]+\s+story\b/,
    /\bpositioning\b/,
    /\bframes? itself as\b/,
    /\bleans toward\b/,
    /\bdedicated treatment step\b/,
    /\bplain barrier cream\b/,
    /\bgeneral face brightening serum\b/,
    /\bfunctioning as\b/,
    /\bacting like\b/,
    /\brole\b/,
    /\bformat\b/,
  ].some((pattern) => pattern.test(normalized));
}

function stripSellerMerchandisingLead(text) {
  return asString(text)
    .replace(/^double up and save with\s+/i, '')
    .replace(/^stock up with\s+/i, '')
    .replace(/^save with\s+/i, '')
    .replace(/^offered in (an? )?/i, '')
    .replace(/^available in (an? )?/i, '')
    .replace(/^this\s+jumbo\s+size\s+of\s+/i, '')
    .replace(/^jumbo[-\s]+sized?\s+/i, '')
    .replace(/^jumbo\s+size\s+of\s+/i, '')
    .replace(/^our\s+jumbo\s+size\s+of\s+/i, '')
    .trim();
}

function normalizeSellerWhatItIs(text) {
  return asString(text)
    .replace(/^our\s+/i, 'A ')
    .replace(/^this\s+/i, 'A ')
    .replace(/^clinically-inspired\s+/i, 'A ')
    .replace(/^clinically inspired\s+/i, 'A ')
    .replace(/^jumbo[-\s]+sized?,?\s+/i, 'A ')
    .replace(/^a\s+a\s+/i, 'A ')
    .trim();
}

function isWeakSellerWhatItIsText(text) {
  const normalized = asString(text).toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 36) return true;
  return [
    /\bour supercharged\b/,
    /\bmulti-benefit\b/,
    /\bjumbo[-\s]+size\b/,
    /\bdouble up and save\b/,
    /\bclinically-inspired\b/,
  ].some((pattern) => pattern.test(normalized));
}

function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function formatCompactCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function toHeadlineCase(value) {
  return asString(value)
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) =>
      token
        .split('-')
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join('-'),
    )
    .join(' ');
}

function normalizeLabelSet(values) {
  return new Set(
    toList(values)
      .map((value) => asString(value).toLowerCase())
      .filter(Boolean),
  );
}

function jaccardOverlap(leftValues, rightValues) {
  const left = normalizeLabelSet(leftValues);
  const right = normalizeLabelSet(rightValues);
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function resolveManualOverride(caseRow, manualOverrides) {
  if (!manualOverrides || typeof manualOverrides !== 'object') return null;
  const caseId = asString(caseRow?.case_id);
  const productId = asString(caseRow?.canonical_product_ref?.product_id || caseRow?.product?.product_id);
  return (
    manualOverrides[caseId] ||
    manualOverrides[`product:${productId}`] ||
    null
  );
}

function inferRoutineLabel(step, fallbackCategory) {
  const stepText = asString(step).toLowerCase();
  if (stepText === 'serum') return 'serum';
  if (stepText === 'moisturizer') return 'moisturizer';
  if (stepText === 'sunscreen') return 'sunscreen';
  if (stepText === 'cleanser') return 'cleanser';
  if (stepText === 'eye treatment') return 'eye treatment';
  if (stepText === 'eye stick') return 'eye stick';
  const category = asString(fallbackCategory).toLowerCase();
  if (category.includes('serum')) return 'serum';
  if (category.includes('moisturizer') || category.includes('cream')) return 'cream';
  if (category.includes('sunscreen') || category.includes('spf')) return 'sunscreen';
  if (category.includes('cleanser')) return 'cleanser';
  if (category.includes('eye')) return 'eye treatment';
  return '';
}

function compactWhatItIsHeadline(headline) {
  const text = toHeadlineCase(headline);
  if (!text || /^Pivota Insights$/i.test(text)) return '';
  return text.length <= 42 ? text : '';
}

function buildCompactSubtitle(caseRow, bundle) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  const core = bundle?.product_intel_core || {};
  const stepLabel = inferRoutineLabel(core?.routine_fit?.step, product.category || product.product_type);
  const whatBody = asString(core?.what_it_is?.body).toLowerCase();

  if (whatBody.includes('multi-active') && stepLabel) {
    return toHeadlineCase(`multi-active ${stepLabel}`);
  }
  if (whatBody.includes('vitamin c') && whatBody.includes('niacinamide') && stepLabel) {
    return toHeadlineCase(`vitamin c + niacinamide ${stepLabel}`);
  }
  if (whatBody.includes('amla') && stepLabel) {
    return toHeadlineCase(`amla brightening ${stepLabel}`);
  }
  if ((whatBody.includes('broad-spectrum') || whatBody.includes('spf') || whatBody.includes('sunscreen')) && stepLabel === 'moisturizer') {
    return 'SPF moisturizer';
  }
  if (whatBody.includes('color-correcting') && whatBody.includes('eye') && stepLabel) {
    return toHeadlineCase(`color-correcting ${stepLabel}`);
  }

  const compactHeadline = compactWhatItIsHeadline(core?.what_it_is?.headline);
  if (compactHeadline) return compactHeadline;

  return toHeadlineCase(product.product_type || product.category).slice(0, 42);
}

function normalizeBadgeCandidates(value) {
  return toList(value)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const badgeLabel = asString(row?.badge_label || row?.label || item);
      if (!badgeLabel) return null;
      return {
        badge_type: asString(row?.badge_type || row?.type),
        badge_label: badgeLabel,
      };
    })
    .filter(Boolean);
}

function buildProofBadge(caseRow, bundle) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  const explicit = normalizeBadgeCandidates(
    bundle?.market_signal_badges || product.market_signal_badges,
  );
  if (explicit.length) return explicit[0];

  const review = product.review_summary && typeof product.review_summary === 'object' ? product.review_summary : {};
  const rating = Number(review.rating || review.average_rating || 0) || 0;
  const reviewCount = Number(review.review_count || review.reviewCount || 0) || 0;
  if (rating >= 4.5 && reviewCount >= 100) {
    return {
      badge_type: 'review_signal',
      badge_label: `${rating.toFixed(1)}★ (${formatCompactCount(reviewCount)})`,
    };
  }

  const counts =
    product.community_signals && typeof product.community_signals === 'object'
      ? product.community_signals.source_counts || {}
      : {};
  const editorial = Number(counts.editorial || 0) || 0;
  const creatorMentions = Number(counts.creator_mentions || counts.creatorMentions || 0) || 0;
  const media = Number(counts.media || 0) || 0;
  if (editorial >= 3) {
    return {
      badge_type: 'editorial_signal',
      badge_label: `Seen in ${editorial} editor picks`,
    };
  }
  if (creatorMentions >= 8) {
    return {
      badge_type: 'creator_signal',
      badge_label: `Seen in ${creatorMentions} creator mentions`,
    };
  }
  if (media >= 3) {
    return {
      badge_type: 'media_signal',
      badge_label: `Seen in ${media} media mentions`,
    };
  }
  return null;
}

function buildTitleCandidate(caseRow) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  const brand = asString(product.brand);
  const title = asString(product.title || product.name);
  if (!brand || !title) return title || 'Untitled product';
  if (title.toLowerCase().startsWith(brand.toLowerCase())) return title;
  return `${brand} ${title}`.trim();
}

function buildShoppingCardPayload(caseRow, bundle) {
  const title = buildTitleCandidate(caseRow);
  const subtitle = buildCompactSubtitle(caseRow, bundle);
  const proofBadge = buildProofBadge(caseRow, bundle);
  const intro = asString(bundle?.product_intel_core?.what_it_is?.body);
  const marketSignalBadges = normalizeBadgeCandidates(
    bundle?.market_signal_badges || (proofBadge ? [proofBadge] : []),
  );

  return {
    contract_version: 'pivota.shopping_card.v1',
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(proofBadge?.badge_label ? { proof_badge: proofBadge.badge_label } : {}),
    ...(intro ? { intro } : {}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
    ...(asString(bundle?.evidence_profile) ? { evidence_profile: asString(bundle.evidence_profile) } : {}),
  };
}

function normalizeSelectedReviewSummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rating = Number(source.rating || source.average_rating || source.avg_rating || 0) || 0;
  const reviewCount = Number(source.review_count || source.reviewCount || source.count || 0) || 0;
  if (!rating && !reviewCount) return null;
  return {
    ...(rating ? { rating } : {}),
    ...(reviewCount ? { review_count: reviewCount } : {}),
  };
}

function attachShoppingCard(caseRow, bundle) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  const next = deepClone(bundle);
  const shoppingCard = buildShoppingCardPayload(caseRow, next);
  const proofBadge = asString(shoppingCard.proof_badge);
  const reviewSummary = normalizeSelectedReviewSummary(product.review_summary);
  const communitySignals =
    product.community_signals && typeof product.community_signals === 'object'
      ? deepClone(product.community_signals)
      : null;
  next.shopping_card = shoppingCard;
  next.search_card = {
    title_candidate: shoppingCard.title,
    ...(shoppingCard.subtitle ? { compact_candidate: shoppingCard.subtitle } : {}),
    ...(proofBadge ? { proof_badge_candidate: proofBadge } : {}),
    ...(shoppingCard.intro ? { intro_candidate: shoppingCard.intro } : {}),
  };
  if (Array.isArray(shoppingCard.market_signal_badges) && shoppingCard.market_signal_badges.length) {
    next.market_signal_badges = shoppingCard.market_signal_badges;
  }
  if (reviewSummary) {
    next.review_summary = reviewSummary;
  }
  if (communitySignals) {
    next.community_signals = communitySignals;
  }
  return next;
}

function hasGeminiKey() {
  return Boolean(
    String(
      process.env.GEMINI_API_KEY ||
        process.env.PIVOTA_GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        '',
    ).trim(),
  );
}

function geminiApiKey() {
  return String(
    process.env.GEMINI_API_KEY ||
      process.env.PIVOTA_GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      '',
  ).trim();
}

function geminiBaseUrl() {
  return String(
    process.env.GEMINI_BASE_URL ||
      process.env.GOOGLE_GENAI_BASE_URL ||
      'https://generativelanguage.googleapis.com',
  )
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1beta$/i, '')
    .replace(/\/v1$/i, '');
}

function extractJsonObject(text) {
  const raw = asString(text);
  if (!raw) throw new Error('empty_gemini_payload');
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('invalid_gemini_json');
  }
}

function normalizeEvidenceAvailability(flags) {
  const source = flags && typeof flags === 'object' ? flags : {};
  return {
    seller: Boolean(source.seller),
    formula: Boolean(source.formula),
    reviews: Boolean(source.reviews),
    creator: Boolean(source.creator),
    editorial: Boolean(source.editorial),
  };
}

function buildFactsPack(caseRow, baselineDraft) {
  const product = caseRow && typeof caseRow.product === 'object' ? caseRow.product : {};
  const reviewSummary =
    product.review_summary && typeof product.review_summary === 'object'
      ? {
          rating: product.review_summary.rating ?? null,
          review_count:
            product.review_summary.review_count ??
            product.review_summary.reviewCount ??
            null,
        }
      : null;
  const communitySignals =
    product.community_signals && typeof product.community_signals === 'object'
      ? product.community_signals
      : null;

  return {
    case_id: asString(caseRow.case_id),
    title: asString(product.title || product.name),
    brand: asString(product.brand),
    category: asString(product.category || product.product_type),
    description: asString(product.description),
    tags: toList(product.tags),
    texture: asString(product.texture),
    finish: asString(product.finish),
    how_to_use: asString(product.how_to_use || product.howToUse),
    ingredients_inci: toList(product.ingredients_inci || product.ingredients),
    review_summary: reviewSummary,
    community_signals: communitySignals,
    evidence_availability: normalizeEvidenceAvailability({
      seller: Boolean(
        asString(product.title || product.name) &&
          (asString(product.description) || asString(product.category || product.product_type)),
      ),
      formula: toList(product.ingredients_inci || product.ingredients).length > 0,
      reviews: Number(reviewSummary?.review_count || 0) > 0,
      creator: Number(communitySignals?.source_counts?.creator_mentions || 0) > 0,
      editorial: Number(communitySignals?.source_counts?.editorial || 0) > 0,
    }),
    baseline_evidence_profile: baselineDraft?.evidence_profile || null,
    baseline_quality_state: baselineDraft?.quality_state || null,
    baseline_source_coverage: baselineDraft?.source_coverage || null,
    baseline_routine_step: asString(baselineDraft?.product_intel_core?.routine_fit?.step),
    baseline_community_status: asString(baselineDraft?.community_signals?.status || 'unavailable'),
  };
}

function buildGeminiPrompt(caseRow, baselineDraft) {
  const factsPack = buildFactsPack(caseRow, baselineDraft);
  return [
    'You are generating narrative product intelligence for a Pivota normalized product page.',
    'Return only JSON matching the requested schema.',
    '',
    'Hard rules:',
    '- Ground every field only in the supplied product facts.',
    '- Do not invent price, offers, ingredients, ratings, or community feedback.',
    '- evidence_availability is authoritative. If reviews/creator/editorial are all false, community_signals.status must be "unavailable".',
    '- Do not output source_coverage, evidence_profile, quality_state, or freshness. Those are computed separately.',
    '- Avoid phrases like "users say", "people love", "viral", or "social media" unless community evidence is supplied.',
    '- Keep highlights concise, concrete, and product-specific.',
    '- For seller_only and seller_plus_formula cases, write in neutral product language, not brand voice.',
    '- Do not use packaging, size, value, convenience, or bare claim copy as a highlight unless it is central to how the product works.',
    '- Do not write generic highlights like "designed to provide hydration", "features a lightweight texture", or "delivered in a convenient stick format".',
    '- In seller_only mode, prefer formula architecture, role combination, active blend, UV role, or concern coverage over generic texture or claim repetition.',
    '- In seller_only mode, avoid abstraction words like "positioning", "story", "format", or "role" in highlights unless they describe a concrete functional difference.',
    '- Keep what_it_is to 1-2 short sentences and avoid phrases like "our", "supercharged", "multi-benefit", or "clinically inspired".',
    '- Limit seller_only why_it_stands_out to at most 2 items.',
    '- Do not leave product_intel_core.what_it_is.body empty when title/category/description exist.',
    '- If title/category/description are enough to infer routine role, fill routine_fit conservatively.',
    '- For seller_only or seller_plus_formula cases, still provide at least 1 best_for item and 1 why_it_stands_out item when description/category clearly support them.',
    '- Use [] or null for unsupported fields, never empty strings for required narrative text.',
    '',
    'Output fields:',
    '- product_intel_core.what_it_is',
    '- product_intel_core.best_for',
    '- product_intel_core.why_it_stands_out',
    '- product_intel_core.routine_fit',
    '- product_intel_core.watchouts',
    '- texture_finish',
    '- community_signals',
    '',
    'Product facts:',
    JSON.stringify(factsPack, null, 2),
  ].join('\n');
}

function normalizeGeminiDraftOutput(output) {
  const bestFor = toList(output?.product_intel_core?.best_for)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const label = asString(row?.label || item).slice(0, 120);
      if (!label) return null;
      return {
        tag:
          asString(row?.tag).slice(0, 80) ||
          label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) ||
          'fit',
        label,
        confidence: 'moderate',
      };
    })
    .filter(Boolean)
    .slice(0, 4);

  const highlights = toList(output?.product_intel_core?.why_it_stands_out)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const headline = asString(row?.headline).slice(0, 120);
      const body = asString(row?.body || item).slice(0, 240);
      if (!headline && !body) return null;
      const evidenceStrengthRaw = asString(row?.evidence_strength).toLowerCase();
      return {
        headline: headline || body.slice(0, 120),
        body,
        evidence_strength: ['strong', 'moderate', 'limited', 'uncertain'].includes(evidenceStrengthRaw)
          ? evidenceStrengthRaw
          : 'limited',
      };
    })
    .filter(
      (item) =>
        item &&
        !isLowSignalSellerHighlightText(`${item.headline} ${item.body}`) &&
        !isGenericSellerHighlightText(`${item.headline} ${item.body}`),
    )
    .slice(0, 4);

  const watchouts = toList(output?.product_intel_core?.watchouts)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const label = asString(row?.label || item).slice(0, 160);
      if (!label) return null;
      const severityRaw = asString(row?.severity).toLowerCase();
      return {
        type: asString(row?.type).slice(0, 80) || 'watchout',
        label,
        severity: ['low', 'medium', 'high'].includes(severityRaw) ? severityRaw : 'low',
      };
    })
    .filter(Boolean)
    .slice(0, 4);

  const textureFinish =
    output?.texture_finish && typeof output.texture_finish === 'object'
      ? {
          texture: asString(output.texture_finish.texture) || null,
          finish: asString(output.texture_finish.finish) || null,
          sensory_notes: toList(output.texture_finish.sensory_notes)
            .map((item) => asString(item).slice(0, 120))
            .filter(Boolean)
            .slice(0, 4),
          layering_notes: toList(output.texture_finish.layering_notes)
            .map((item) => asString(item).slice(0, 160))
            .filter(Boolean)
            .slice(0, 4),
        }
      : null;

  const communityStatusRaw = asString(output?.community_signals?.status).toLowerCase();
  const communitySignals = {
    status: communityStatusRaw === 'available' ? 'available' : 'unavailable',
    unavailable_reason: asString(output?.community_signals?.unavailable_reason) || null,
    top_loves: toList(output?.community_signals?.top_loves)
      .map((item) => asString(item).slice(0, 160))
      .filter(Boolean)
      .slice(0, 4),
    top_complaints: toList(output?.community_signals?.top_complaints)
      .map((item) => asString(item).slice(0, 160))
      .filter(Boolean)
      .slice(0, 4),
    best_fit_users: toList(output?.community_signals?.best_fit_users)
      .map((item) => asString(item).slice(0, 160))
      .filter(Boolean)
      .slice(0, 3),
    mixed_feedback: toList(output?.community_signals?.mixed_feedback)
      .map((item) => asString(item).slice(0, 180))
      .filter(Boolean)
      .slice(0, 3),
  };

  return {
    product_intel_core: {
      what_it_is: {
        headline:
          asString(output?.product_intel_core?.what_it_is?.headline).slice(0, 120) ||
          PIVOTA_INSIGHTS_DISPLAY_NAME,
        body: normalizeSellerWhatItIs(asString(output?.product_intel_core?.what_it_is?.body)).slice(0, 400),
      },
      best_for: bestFor,
      why_it_stands_out: highlights,
      routine_fit: {
        step: asString(output?.product_intel_core?.routine_fit?.step).slice(0, 80),
        am_pm: toList(output?.product_intel_core?.routine_fit?.am_pm)
          .map((item) => asString(item).toLowerCase())
          .filter((item) => item === 'am' || item === 'pm')
          .slice(0, 2),
        pairing_notes: toList(output?.product_intel_core?.routine_fit?.pairing_notes)
          .map((item) => asString(item).slice(0, 160))
          .filter(Boolean)
          .slice(0, 4),
      },
      watchouts,
    },
    texture_finish: textureFinish,
    community_signals: communitySignals,
  };
}

async function runGeminiDraft(caseRow, baselineDraft, model) {
  if (!hasGeminiKey()) {
    return { skipped: true, reason: 'missing_gemini_api_key' };
  }
  const prompt = buildGeminiPrompt(caseRow, baselineDraft);

  try {
    const response = await axios.post(
      `${geminiBaseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey())}`,
      {
        systemInstruction: {
          parts: [
            {
              text: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      },
      { timeout: 45000 },
    );
    const text =
      response?.data?.candidates?.[0]?.content?.parts?.map((part) => part?.text).filter(Boolean).join('\n') || '';
    const parsed = normalizeGeminiDraftOutput(extractJsonObject(text));
    return {
      skipped: false,
      output: parsed,
    };
  } catch (err) {
    return {
      skipped: true,
      reason: asString(err && (err.code || err.message)) || 'gemini_failed',
    };
  }
}

function mergeGeminiDraftIntoBaseline(caseRow, baselineBundle, geminiOutput, model) {
  if (!baselineBundle || !geminiOutput) return null;
  const generatedAt = new Date().toISOString();
  const merged = deepClone(baselineBundle);
  const baselineCore = baselineBundle.product_intel_core || {};
  const baselineCommunity = baselineBundle.community_signals || {};
  const geminiCore = geminiOutput.product_intel_core || {};
  const geminiRoutine = geminiCore.routine_fit || {};

  merged.product_intel_core = {
    ...baselineCore,
    what_it_is: {
      ...(baselineCore.what_it_is || {}),
      ...(geminiCore.what_it_is || {}),
    },
    best_for:
      Array.isArray(geminiCore.best_for) && geminiCore.best_for.length
        ? geminiCore.best_for
        : baselineCore.best_for || [],
    why_it_stands_out:
      Array.isArray(geminiCore.why_it_stands_out) && geminiCore.why_it_stands_out.length
        ? geminiCore.why_it_stands_out
        : baselineCore.why_it_stands_out || [],
    routine_fit: {
      ...(baselineCore.routine_fit || {}),
      step: asString(baselineCore.routine_fit?.step),
      am_pm:
        Array.isArray(geminiRoutine.am_pm) && geminiRoutine.am_pm.length
          ? geminiRoutine.am_pm
          : baselineCore.routine_fit?.am_pm || [],
      pairing_notes:
        Array.isArray(geminiRoutine.pairing_notes) && geminiRoutine.pairing_notes.length
          ? geminiRoutine.pairing_notes
          : baselineCore.routine_fit?.pairing_notes || [],
    },
    watchouts:
      Array.isArray(geminiCore.watchouts) && geminiCore.watchouts.length
        ? geminiCore.watchouts
        : baselineCore.watchouts || [],
    confidence: baselineCore.confidence || merged.confidence,
    freshness: {
      generated_at: generatedAt,
      source_version: `pilot_gemini_candidate:${model}`,
    },
    quality_state: baselineCore.quality_state || baselineBundle.quality_state || 'limited',
    evidence_profile: baselineCore.evidence_profile || baselineBundle.evidence_profile || null,
    source_coverage: baselineCore.source_coverage || baselineBundle.source_coverage || null,
  };

  if (geminiOutput.texture_finish) {
    merged.texture_finish = {
      ...(baselineBundle.texture_finish || {}),
      ...geminiOutput.texture_finish,
      confidence:
        baselineBundle.texture_finish?.confidence ||
        baselineCore.confidence?.overall ||
        baselineBundle.confidence?.overall ||
        'moderate',
      evidence_profile: baselineBundle.evidence_profile || null,
    };
  }

  if ((baselineCommunity.status || 'unavailable') === 'available') {
    merged.community_signals = {
      ...baselineCommunity,
      top_loves:
        geminiOutput.community_signals?.top_loves?.length
          ? geminiOutput.community_signals.top_loves
          : baselineCommunity.top_loves || [],
      top_complaints:
        geminiOutput.community_signals?.top_complaints?.length
          ? geminiOutput.community_signals.top_complaints
          : baselineCommunity.top_complaints || [],
      best_fit_users:
        geminiOutput.community_signals?.best_fit_users?.length
          ? geminiOutput.community_signals.best_fit_users
          : baselineCommunity.best_fit_users || [],
      mixed_feedback:
        geminiOutput.community_signals?.mixed_feedback?.length
          ? geminiOutput.community_signals.mixed_feedback
          : baselineCommunity.mixed_feedback || [],
      status: 'available',
      unavailable_reason: null,
    };
  } else {
    merged.community_signals = {
      ...baselineCommunity,
      status: 'unavailable',
      unavailable_reason: 'insufficient_feedback',
    };
  }

  merged.quality_state = baselineBundle.quality_state || 'limited';
  merged.evidence_profile = baselineBundle.evidence_profile || null;
  merged.source_coverage = baselineBundle.source_coverage || null;
  merged.confidence = baselineBundle.confidence || baselineCore.confidence || null;
  merged.freshness = {
    generated_at: generatedAt,
    source_version: `pilot_gemini_candidate:${model}`,
  };
  merged.provenance = {
    ...(baselineBundle.provenance || {}),
    source: 'product_intel_pilot_compare',
    generator: 'gemini_candidate',
    model,
    case_id: asString(caseRow?.case_id),
  };

  return merged;
}

function flattenBundleNarrative(bundle) {
  const core = bundle?.product_intel_core || {};
  const community = bundle?.community_signals || {};
  return [
    core.what_it_is?.headline,
    core.what_it_is?.body,
    ...(core.best_for || []).map((item) => item?.label || item?.tag),
    ...(core.why_it_stands_out || []).flatMap((item) => [item?.headline, item?.body]),
    ...(core.watchouts || []).map((item) => item?.label),
    ...(community.top_loves || []),
    ...(community.top_complaints || []),
    ...(community.best_fit_users || []),
    ...(community.mixed_feedback || []),
  ]
    .map((value) => asString(value))
    .filter(Boolean)
    .join(' ');
}

function hasMeaningfulTextureFinish(textureFinish) {
  if (!textureFinish || typeof textureFinish !== 'object') return false;
  return Boolean(
    asString(textureFinish.texture) ||
      asString(textureFinish.finish) ||
      (Array.isArray(textureFinish.sensory_notes) && textureFinish.sensory_notes.length) ||
      (Array.isArray(textureFinish.layering_notes) && textureFinish.layering_notes.length),
  );
}

function evaluateGeminiCandidateQuality(baselineBundle, geminiCandidateBundle) {
  if (!baselineBundle || !geminiCandidateBundle) {
    return {
      candidate_available: false,
      overall_pass: false,
      quality_score: 0,
      fail_reasons: ['missing_candidate'],
      field_decisions: {},
    };
  }

  const baselineCore = baselineBundle.product_intel_core || {};
  const candidateCore = geminiCandidateBundle.product_intel_core || {};
  const baselineCommunity = baselineBundle.community_signals || {};
  const candidateCommunity = geminiCandidateBundle.community_signals || {};
  const sellerOnlyMode =
    baselineBundle.evidence_profile === 'seller_only' ||
    baselineBundle.evidence_profile === 'seller_plus_formula';
  const narrativeText = flattenBundleNarrative(geminiCandidateBundle);
  const sellerOnlyViolation =
    sellerOnlyMode &&
    /\b(users?|people|reviewers?|customers?|community|viral|tiktok|reddit|social media)\b/i.test(
      narrativeText,
    );

  const bestForOverlap = Number(
    jaccardOverlap(
      (baselineCore.best_for || []).map((item) => item.label || item.tag),
      (candidateCore.best_for || []).map((item) => item.label || item.tag),
    ).toFixed(2),
  );
  const watchoutOverlap = Number(
    jaccardOverlap(
      (baselineCore.watchouts || []).map((item) => item.label),
      (candidateCore.watchouts || []).map((item) => item.label),
    ).toFixed(2),
  );

  const fieldDecisions = {
    what_it_is:
      asString(candidateCore.what_it_is?.body).length >= 24 &&
      !sellerOnlyViolation &&
      !(sellerOnlyMode && isWeakSellerWhatItIsText(candidateCore.what_it_is?.body)),
    best_for:
      Array.isArray(candidateCore.best_for) &&
      candidateCore.best_for.length > 0 &&
      (
        !baselineCore.best_for?.length ||
        baselineBundle.evidence_profile !== 'community_supported' ||
        bestForOverlap >= 0.15
      ) &&
      !sellerOnlyViolation,
    why_it_stands_out:
      Array.isArray(candidateCore.why_it_stands_out) &&
      candidateCore.why_it_stands_out.length > 0 &&
      candidateCore.why_it_stands_out.some(
        (item) =>
          asString(item?.body).length >= 20 &&
          !isLowSignalSellerHighlightText(`${item?.headline || ''} ${item?.body || ''}`) &&
          !(sellerOnlyMode && isGenericSellerHighlightText(`${item?.headline || ''} ${item?.body || ''}`)),
      ) &&
      !sellerOnlyViolation,
    routine_fit:
      asString(candidateCore.routine_fit?.step) === asString(baselineCore.routine_fit?.step) &&
      (toList(candidateCore.routine_fit?.pairing_notes).length > 0 ||
        toList(candidateCore.routine_fit?.am_pm).length > 0) &&
      !sellerOnlyViolation,
    watchouts:
      (!sellerOnlyViolation &&
        Array.isArray(candidateCore.watchouts) &&
        candidateCore.watchouts.every((item) => asString(item?.label).length > 0)) ||
      false,
    texture_finish: hasMeaningfulTextureFinish(geminiCandidateBundle.texture_finish),
    community_signals:
      (baselineCommunity.status || 'unavailable') === 'available' &&
      (candidateCommunity.status || 'unavailable') === 'available' &&
      (toList(candidateCommunity.top_loves).length > 0 ||
        toList(candidateCommunity.top_complaints).length > 0 ||
        toList(candidateCommunity.best_fit_users).length > 0 ||
        toList(candidateCommunity.mixed_feedback).length > 0),
  };

  const qualityScore = Object.values(fieldDecisions).filter(Boolean).length;
  const failReasons = [];
  if (sellerOnlyViolation) failReasons.push('seller_only_community_language');
  if (!fieldDecisions.what_it_is) failReasons.push('weak_what_it_is');
  if (!fieldDecisions.best_for) failReasons.push('weak_best_for');
  if (!fieldDecisions.why_it_stands_out) failReasons.push('weak_highlights');
  if (!fieldDecisions.routine_fit) failReasons.push('weak_routine_fit');
  if ((baselineCommunity.status || 'unavailable') === 'available' && !fieldDecisions.community_signals) {
    failReasons.push('weak_community_signals');
  }

  return {
    candidate_available: true,
    overall_pass: qualityScore >= 4 && !sellerOnlyViolation,
    quality_score: qualityScore,
    fail_reasons: failReasons,
    seller_only_violation: sellerOnlyViolation,
    best_for_overlap: bestForOverlap,
    watchout_overlap: watchoutOverlap,
    field_decisions: fieldDecisions,
  };
}

function buildSelectedBundle(caseRow, baselineBundle, geminiCandidateBundle, quality, model) {
  const selected = deepClone(baselineBundle);
  const fieldSources = {
    what_it_is: 'baseline',
    best_for: 'baseline',
    why_it_stands_out: 'baseline',
    routine_fit: 'baseline',
    watchouts: 'baseline',
    texture_finish: 'baseline',
    community_signals: 'baseline',
  };

  if (geminiCandidateBundle && quality?.candidate_available) {
    if (quality.field_decisions.what_it_is) {
      selected.product_intel_core.what_it_is = deepClone(
        geminiCandidateBundle.product_intel_core.what_it_is,
      );
      fieldSources.what_it_is = 'gemini';
    }
    if (quality.field_decisions.best_for) {
      selected.product_intel_core.best_for = deepClone(
        geminiCandidateBundle.product_intel_core.best_for,
      );
      fieldSources.best_for = 'gemini';
    }
    if (quality.field_decisions.why_it_stands_out) {
      selected.product_intel_core.why_it_stands_out = deepClone(
        geminiCandidateBundle.product_intel_core.why_it_stands_out,
      );
      fieldSources.why_it_stands_out = 'gemini';
    }
    if (quality.field_decisions.routine_fit) {
      selected.product_intel_core.routine_fit = deepClone(
        geminiCandidateBundle.product_intel_core.routine_fit,
      );
      fieldSources.routine_fit = 'gemini';
    }
    if (quality.field_decisions.watchouts) {
      selected.product_intel_core.watchouts = deepClone(
        geminiCandidateBundle.product_intel_core.watchouts,
      );
      fieldSources.watchouts = 'gemini';
    }
    if (quality.field_decisions.texture_finish) {
      selected.texture_finish = deepClone(geminiCandidateBundle.texture_finish);
      fieldSources.texture_finish = 'gemini';
    }
    if (quality.field_decisions.community_signals) {
      selected.community_signals = deepClone(geminiCandidateBundle.community_signals);
      fieldSources.community_signals = 'gemini';
    }
  }

  const selectedFieldCount = Object.values(fieldSources).filter((value) => value === 'gemini').length;
  const generatedAt = new Date().toISOString();
  if (selectedFieldCount > 0) {
    selected.freshness = {
      generated_at: generatedAt,
      source_version: `pilot_selected:${model}`,
    };
    if (selected.product_intel_core) {
      selected.product_intel_core.freshness = deepClone(selected.freshness);
    }
  }

  selected.provenance = {
    ...(selected.provenance || {}),
    source: 'product_intel_pilot_compare',
    generator: selectedFieldCount > 0 ? 'baseline_plus_gemini' : 'baseline_only',
    selection_strategy: 'baseline_first_gemini_guarded',
    gemini_model: geminiCandidateBundle ? model : null,
    field_sources: fieldSources,
    gemini_quality_gate: quality || {
      candidate_available: false,
      overall_pass: false,
      quality_score: 0,
      fail_reasons: ['missing_candidate'],
      field_decisions: {},
    },
  };

  return {
    bundle: attachShoppingCard(caseRow, selected),
    field_sources: fieldSources,
    selected_field_count: selectedFieldCount,
    selected_mode: selectedFieldCount > 0 ? 'hybrid_gemini' : 'baseline_only',
  };
}

function applyManualOverrideToSelected(caseRow, selectedResult, manualOverride) {
  if (!selectedResult || !manualOverride || typeof manualOverride !== 'object') return selectedResult;

  const selected = deepClone(selectedResult);
  const bundle = selected.bundle || {};
  const core = bundle.product_intel_core || {};
  const manualCore = manualOverride.product_intel_core && typeof manualOverride.product_intel_core === 'object'
    ? manualOverride.product_intel_core
    : {};

  const fieldSources = {
    ...(selected.field_sources || {}),
  };
  let manualFieldCount = 0;

  const assignManualField = (field, value) => {
    if (value == null) return;
    core[field] = deepClone(value);
    fieldSources[field] = 'manual';
    manualFieldCount += 1;
  };

  assignManualField('what_it_is', manualCore.what_it_is);
  assignManualField('best_for', manualCore.best_for);
  assignManualField('why_it_stands_out', manualCore.why_it_stands_out);
  assignManualField('routine_fit', manualCore.routine_fit);
  assignManualField('watchouts', manualCore.watchouts);

  if (manualOverride.texture_finish && typeof manualOverride.texture_finish === 'object') {
    bundle.texture_finish = deepClone(manualOverride.texture_finish);
    fieldSources.texture_finish = 'manual';
    manualFieldCount += 1;
  }

  if (manualOverride.community_signals && typeof manualOverride.community_signals === 'object') {
    bundle.community_signals = deepClone(manualOverride.community_signals);
    fieldSources.community_signals = 'manual';
    manualFieldCount += 1;
  }

  bundle.product_intel_core = core;
  bundle.provenance = {
    ...(bundle.provenance || {}),
    source: 'product_intel_pilot_compare',
    generator: 'curated_override',
    selection_strategy: 'curated_override',
    override_reason: asString(manualOverride.notes) || 'manual_quality_override',
  };

  selected.bundle = attachShoppingCard(caseRow, bundle);
  selected.field_sources = fieldSources;
  selected.selected_field_count = manualFieldCount;
  selected.selected_mode = 'manual_override';
  return selected;
}

function buildComparisonSummary(baselineBundle, geminiCandidateBundle, selectedResult, quality) {
  const baselineCore = baselineBundle?.product_intel_core || {};
  const geminiCore = geminiCandidateBundle?.product_intel_core || {};
  return {
    compared: Boolean(baselineBundle && geminiCandidateBundle),
    best_for_overlap: Number(
      jaccardOverlap(
        (baselineCore.best_for || []).map((item) => item.label || item.tag),
        (geminiCore.best_for || []).map((item) => item.label || item.tag),
      ).toFixed(2),
    ),
    watchout_overlap: Number(
      jaccardOverlap(
        (baselineCore.watchouts || []).map((item) => item.label),
        (geminiCore.watchouts || []).map((item) => item.label),
      ).toFixed(2),
    ),
    baseline_highlight_count: Array.isArray(baselineCore.why_it_stands_out)
      ? baselineCore.why_it_stands_out.length
      : 0,
    gemini_highlight_count: Array.isArray(geminiCore.why_it_stands_out)
      ? geminiCore.why_it_stands_out.length
      : 0,
    gemini_quality: quality || null,
    selected_mode: selectedResult?.selected_mode || 'baseline_only',
    selected_field_count: selectedResult?.selected_field_count || 0,
    selected_field_sources: selectedResult?.field_sources || {},
  };
}

function buildMarkdownReport(rows, meta) {
  const lines = [
    '# Product Intel Pilot Compare',
    '',
    `Generated: ${meta.generated_at}`,
    `Cases: ${rows.length}`,
    `Gemini model: ${meta.gemini_model}`,
    `Gemini completed: ${meta.gemini_completed}`,
    `Gemini skipped: ${meta.gemini_skipped}`,
    `Hybrid selected: ${meta.hybrid_selected}`,
    `Baseline only: ${meta.baseline_only}`,
    '',
  ];

  for (const row of rows) {
    lines.push(`## ${row.case_id}`);
    if (row.notes) lines.push('', row.notes);
    lines.push('');
    lines.push(`- Evidence profile: ${row.baseline?.evidence_profile || 'n/a'}`);
    lines.push(`- Baseline what it is: ${row.baseline?.product_intel_core?.what_it_is?.body || 'n/a'}`);
    lines.push(`- Gemini what it is: ${row.gemini?.candidate?.product_intel_core?.what_it_is?.body || row.gemini?.reason || 'n/a'}`);
    lines.push(`- Selected mode: ${row.selected?.selected_mode || 'baseline_only'}`);
    lines.push(`- Selected field sources: ${JSON.stringify(row.selected?.field_sources || {})}`);
    lines.push(`- Gemini quality: ${JSON.stringify(row.quality_gate || {})}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const args = parseArgs(process.argv);
  const casesPath = resolvePath(rootDir, args.cases);
  const casesPayload = readJson(casesPath);
  const cases = Array.isArray(casesPayload) ? casesPayload : [];
  const manualOverrides = readJsonIfExists(resolvePath(rootDir, args.manualOverrides)) || {};

  const reportRows = [];
  for (const caseRow of cases) {
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product || {},
      relatedProducts: Array.isArray(caseRow.related_products) ? caseRow.related_products : [],
      canonicalProductRef: caseRow.canonical_product_ref || null,
      productGroupId: caseRow.product_group_id || null,
    });

    const geminiRaw = args.skipGemini
      ? { skipped: true, reason: 'skip_gemini_flag' }
      : await runGeminiDraft(caseRow, baseline, args.model);
    const geminiCandidate = geminiRaw.skipped
      ? null
      : mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiRaw.output, args.model);
    const qualityGate = evaluateGeminiCandidateQuality(baseline, geminiCandidate);
    const selectedBase = buildSelectedBundle(caseRow, baseline, geminiCandidate, qualityGate, args.model);
    const manualOverride = resolveManualOverride(caseRow, manualOverrides);
    const selected = applyManualOverrideToSelected(caseRow, selectedBase, manualOverride);

    reportRows.push({
      case_id: asString(caseRow.case_id) || 'unnamed_case',
      notes: asString(caseRow.notes),
      manual_override_applied: Boolean(manualOverride),
      baseline,
      gemini: geminiRaw.skipped
        ? { skipped: true, reason: geminiRaw.reason }
        : { skipped: false, raw: geminiRaw.output, candidate: geminiCandidate },
      manual_override: manualOverride ? deepClone(manualOverride) : null,
      quality_gate: qualityGate,
      selected,
      comparison: buildComparisonSummary(baseline, geminiCandidate, selected, qualityGate),
    });
  }

  const generatedAt = new Date().toISOString();
  const jsonOut =
    resolvePath(
      rootDir,
      args.out || `reports/product_intel_pilot_compare_${generatedAt.replace(/[:.]/g, '-')}.json`,
    );
  const markdownOut =
    resolvePath(
      rootDir,
      args.markdown || `reports/product_intel_pilot_compare_${generatedAt.replace(/[:.]/g, '-')}.md`,
    );
  const meta = {
    generated_at: generatedAt,
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    gemini_model: args.model,
    gemini_completed: reportRows.filter((row) => row.gemini && row.gemini.skipped === false).length,
    gemini_skipped: reportRows.filter((row) => row.gemini && row.gemini.skipped !== false).length,
    hybrid_selected: reportRows.filter((row) => row.selected?.selected_mode === 'hybrid_gemini').length,
    baseline_only: reportRows.filter((row) => row.selected?.selected_mode !== 'hybrid_gemini').length,
  };

  writeJson(jsonOut, { meta, rows: reportRows });
  writeText(markdownOut, buildMarkdownReport(reportRows, meta));

  process.stdout.write(
    `${JSON.stringify({ status: 'ok', cases: reportRows.length, json: jsonOut, markdown: markdownOut })}\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildFactsPack,
  normalizeGeminiDraftOutput,
  mergeGeminiDraftIntoBaseline,
  evaluateGeminiCandidateQuality,
  buildSelectedBundle,
  buildComparisonSummary,
  buildMarkdownReport,
  applyManualOverrideToSelected,
  resolveManualOverride,
  buildShoppingCardPayload,
};
