#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const {
  buildProductIntelDraftBundle,
  PRODUCT_INTEL_CONTRACT_VERSION,
  PIVOTA_INSIGHTS_DISPLAY_NAME,
} = require('../src/pdpProductIntel');
const {
  buildDisplayableProofBadge,
  filterDisplayableMarketSignalBadges,
  normalizeMarketSignalBadges,
} = require('../src/services/pivotaEvidenceSignals');
const {
  buildSearchCardPayload: buildServiceSearchCardPayload,
  buildShoppingCardPayload: buildServiceShoppingCardPayload,
} = require('../src/services/pivotaShoppingCard');

const GEMINI_PRIMARY_MODEL = 'gemini-3-flash-preview';
const GEMINI_UPGRADE_MODEL = 'gemini-3.1-pro-preview';
const GPT54_HUMAN_STANDARD_REWRITE_MODEL = 'gpt-5.4-human-standard-rewrite';

const GEMINI_MODEL_DEFAULTS = [
  GEMINI_PRIMARY_MODEL,
  GEMINI_UPGRADE_MODEL,
];

function parseArgs(argv) {
  const out = {
    cases: 'scripts/fixtures/product_intel_pilot_cases.json',
    out: '',
    markdown: '',
    manualOverrides: 'scripts/fixtures/product_intel_manual_overrides.json',
    model: process.env.PRODUCT_INTEL_PILOT_GEMINI_MODEL || 'gemini-3-flash-preview',
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

function parseGeminiModelList(_rawModel) {
  return GEMINI_MODEL_DEFAULTS.map((model) => normalizeGeminiModel(model));
}

function normalizeGeminiModel(rawModel) {
  return asString(rawModel).toLowerCase().replace(/^models\//, '');
}

function buildGeminiModelCallUrl(model) {
  return `${geminiBaseUrl()}/v1beta/models/${encodeURIComponent(normalizeGeminiModel(model))}:generateContent?key=${encodeURIComponent(geminiApiKey())}`;
}

async function invokeGeminiDraft(model, prompt) {
  const response = await axios.post(
    buildGeminiModelCallUrl(model),
    {
      systemInstruction: {
        parts: [
          {
            text: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
          },
        ],
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [
        {
          google_search: {},
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    },
    { timeout: 45000 },
  );

  const candidate = response?.data?.candidates?.[0] || {};
  const text =
    candidate?.content?.parts
      .map((part) => part?.text)
      .filter(Boolean)
      .join('\n') || '';

  const normalized = normalizeGeminiDraftOutput(extractJsonObject(text));
  const grounding = normalizeGeminiGroundingMetadata(candidate.groundingMetadata);
  if (grounding.has_grounding) {
    normalized.gemini_grounding = grounding;
  }
  return normalized;
}

function extractModelError(err) {
  const response = err?.response;
  const status = response?.status;
  const bodyMessage = response?.data?.error?.message || response?.data?.error?.status;
  if (status) {
    return `model_call_failed_${status}${bodyMessage ? `:${bodyMessage}` : ''}`;
  }
  return asString(err?.code || err?.message || err) || 'gemini_failed';
}

function normalizeGeminiGroundingMetadata(value) {
  const source = value && typeof value === 'object' ? value : {};
  const webSources = toList(source.groundingChunks)
    .map((chunk) => {
      const web = chunk?.web && typeof chunk.web === 'object' ? chunk.web : {};
      const uri = asString(web.uri);
      const title = asString(web.title);
      if (!uri && !title) return null;
      return {
        uri,
        title,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
  const webSearchQueries = toList(source.webSearchQueries)
    .map((item) => asString(item))
    .filter(Boolean)
    .slice(0, 8);

  return {
    has_grounding: webSources.length > 0 || webSearchQueries.length > 0,
    web_search_queries: webSearchQueries,
    web_sources: webSources,
    support_count: toList(source.groundingSupports).length,
  };
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

function normalizeQualityLabel(text) {
  return asString(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericWhatItIsHeadline(text) {
  const normalized = normalizeQualityLabel(text);
  if (!normalized) return false;
  return [
    normalizeQualityLabel(PIVOTA_INSIGHTS_DISPLAY_NAME),
    'pivota insight',
    'product insight',
    'product insights',
    'cleansing product',
    'skincare product',
    'beauty product',
  ].includes(normalized);
}

function isWeakBestForForPublish(bestFor) {
  const items = toList(bestFor)
    .map((item) => ({
      label: normalizeQualityLabel(item?.label || item?.tag || item),
      confidence: normalizeQualityLabel(item?.confidence),
    }))
    .filter((item) => item.label);
  if (!items.length) return true;

  const weakItem = (item) => {
    if (/^product fit shoppers?$/.test(item.label)) return true;
    if (/^(serum|cleanser|moisturizer|sunscreen|toner|essence|cream|lip|fragrance|makeup|skincare) shoppers?$/.test(item.label)) {
      return true;
    }
    return item.confidence === 'low' && /\b(shoppers?|routines?|users?)$/.test(item.label);
  };

  return items.every(weakItem);
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

function decodeCommonHtmlEntities(text) {
  return asString(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"');
}

function normalizeSellerWhatItIs(text) {
  return cleanProductText(text)
    .replace(/^our\s+/i, 'A ')
    .replace(/^this\s+/i, 'A ')
    .replace(/^clinically-inspired\s+/i, 'A ')
    .replace(/^clinically inspired\s+/i, 'A ')
    .replace(/^jumbo[-\s]+sized?,?\s+/i, 'A ')
    .replace(/\bour\b/gi, "the brand's")
    .replace(/\bwe\b/gi, 'the brand')
    .replace(/\bus\b/gi, 'the brand')
    .replace(/^a\s+a\s+/i, 'A ')
    .trim();
}

function plainTextValue(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
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
    /\bmiracle ingredient\b/,
  ].some((pattern) => pattern.test(normalized));
}

function hasProblematicGeneratedText(text) {
  const normalized = asString(text);
  if (!normalized) return false;
  return [
    /\[object Object\]/i,
    /\b(?:our|we|us)\b/i,
    /\bmiracle ingredient\b/i,
    /\bs\s+lightly\b/i,
    /\btexture\s+help\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function inferProductKindFromContext(context) {
  const text = `${context?.title || ''} ${context?.category || ''} ${(context?.tags || []).join(' ')}`.toLowerCase();
  if (/\b(lip|lipstick|lip oil|lip balm|lip color|gloss|glaze)\b/.test(text)) return 'lip';
  if (/\b(fragrance|perfume|parfum|eau de parfum|edt|scent)\b/.test(text)) return 'fragrance';
  if (/\b(foundation|concealer|skin tint|tint|base|cc stick)\b/.test(text)) return 'complexion_makeup';
  if (/\b(cleanser|cleansing|face wash|wash)\b/.test(text)) return 'cleanser';
  if (/\b(sunscreen|spf|uv)\b/.test(text)) return 'sunscreen';
  if (/\b(moisturizer|moisturising|moisturizing|cream|gel-cream|lotion)\b/.test(text)) return 'moisturizer';
  if (/\b(serum|ampoule|treatment|essence)\b/.test(text)) return 'serum';
  return 'product';
}

function hasExternalEvidenceLanguage(text) {
  return /\b(users?|people|reviewers?|customers?|community|viral|tiktok|reddit|social media|creators?|editors?|media|review aggregates?|consumer reviews?)\b/i.test(
    asString(text),
  );
}

function hasGroundingEvidence(bundle) {
  const grounding = bundle?.gemini_grounding || bundle?.provenance?.gemini_grounding;
  return Boolean(
    grounding?.has_grounding &&
      (
        toList(grounding.web_sources).length > 0 ||
        toList(grounding.web_search_queries).length > 0
      ),
  );
}

function hasIncompatibleBestForForContext(context, bestFor) {
  const kind = inferProductKindFromContext(context || {});
  const text = toList(bestFor)
    .flatMap((item) => [item?.tag, item?.label])
    .map((item) => asString(item).toLowerCase())
    .filter(Boolean)
    .join(' ');
  if (!text) return false;

  const facialSkinConcern =
    /\b(oily|oil[-_\s]?control|combination skin|acne|pores?|dry skin|dehydrated skin|sensitive skin|redness|dullness|uneven tone|fine lines?|barrier)\b/i;
  if ((kind === 'lip' || kind === 'fragrance') && facialSkinConcern.test(text)) return true;
  if (kind === 'complexion_makeup' && /\bcleanser|cleansing|wash|serum step|moisturizer step\b/i.test(text)) return true;
  return false;
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
  return normalizeMarketSignalBadges(toList(value)).map((badge) => ({
    badge_type: asString(badge.badge_type),
    badge_label: asString(badge.badge_label),
  }));
}

function buildProofBadge(caseRow, bundle) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  return buildDisplayableProofBadge(
    {
      market_signal_badges: bundle?.market_signal_badges || product.market_signal_badges,
      review_summary: bundle?.review_summary || product.review_summary,
      community_signals: bundle?.community_signals || product.community_signals,
    },
    { formatCompactCount },
  );
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
  return buildServiceShoppingCardPayload({
    product: caseRow?.product,
    bundle,
  });
}

function isUnsafeSelectedCardCopy(value) {
  const text = asString(value);
  if (!text) return false;
  return hasProblematicGeneratedText(text) || isLikelyIncompleteNarrativeText(text);
}

function dropUnsafeSelectedCardCopy(bundle) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  if (bundle.shopping_card && typeof bundle.shopping_card === 'object') {
    if (isUnsafeSelectedCardCopy(bundle.shopping_card.intro)) {
      delete bundle.shopping_card.intro;
    }
    if (isUnsafeSelectedCardCopy(bundle.shopping_card.highlight)) {
      delete bundle.shopping_card.highlight;
    }
  }
  if (bundle.search_card && typeof bundle.search_card === 'object') {
    if (isUnsafeSelectedCardCopy(bundle.search_card.intro_candidate)) {
      delete bundle.search_card.intro_candidate;
    }
    if (isUnsafeSelectedCardCopy(bundle.search_card.highlight_candidate)) {
      delete bundle.search_card.highlight_candidate;
    }
  }
  return bundle;
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
  const next = dropUnsafeSelectedCardCopy(deepClone(bundle));
  const shoppingCard = buildShoppingCardPayload(caseRow, next);
  const reviewSummary = normalizeSelectedReviewSummary(product.review_summary);
  const communitySignals =
    product.community_signals && typeof product.community_signals === 'object'
      ? deepClone(product.community_signals)
      : null;
  next.shopping_card = shoppingCard;
  next.search_card = buildServiceSearchCardPayload({
    product: caseRow?.product,
    bundle: next,
  });
  if (Array.isArray(shoppingCard.market_signal_badges) && shoppingCard.market_signal_badges.length) {
    next.market_signal_badges = shoppingCard.market_signal_badges;
  }
  if (reviewSummary) {
    next.review_summary = reviewSummary;
  }
  if (communitySignals) {
    const bundleCommunity = next.community_signals && typeof next.community_signals === 'object'
      ? next.community_signals
      : {};
    const productCounts =
      communitySignals.source_counts && typeof communitySignals.source_counts === 'object'
        ? communitySignals.source_counts
        : {};
    const bundleCounts =
      bundleCommunity.source_counts && typeof bundleCommunity.source_counts === 'object'
        ? bundleCommunity.source_counts
        : {};
    next.community_signals = {
      ...communitySignals,
      ...bundleCommunity,
      status: bundleCommunity.status || communitySignals.status,
      source_counts: {
        ...productCounts,
        ...bundleCounts,
        reviews: Math.max(
          Number(productCounts.reviews || 0) || 0,
          Number(bundleCounts.reviews || 0) || 0,
        ),
        creator_mentions: Math.max(
          Number(productCounts.creator_mentions || productCounts.creatorMentions || 0) || 0,
          Number(bundleCounts.creator_mentions || bundleCounts.creatorMentions || 0) || 0,
        ),
        editorial: Math.max(
          Number(productCounts.editorial || 0) || 0,
          Number(bundleCounts.editorial || 0) || 0,
        ),
      },
    };
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

function cleanProductText(value) {
  return decodeCommonHtmlEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^OFFICIAL:\s*/i, '')
    .replace(/\s*\/\/\/\s*SOCIAL HIGHLIGHTS:[\s\S]*$/i, '')
    .replace(/\s*SOCIAL HIGHLIGHTS:[\s\S]*$/i, '')
    .replace(/\bRead More\.?$/i, '')
    .replace(/[.…]{2,}$/g, '.')
    .trim();
}

function clampTextAtWordBoundary(value, maxLength) {
  const normalized = asString(value).replace(/\s+/g, ' ').trim();
  const max = Math.max(1, Number(maxLength) || 1);
  if (normalized.length <= max) return normalized;

  const slice = normalized.slice(0, max + 1);
  const sentenceBoundary = Math.max(
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?'),
    slice.lastIndexOf(';'),
  );
  if (sentenceBoundary >= Math.min(80, Math.floor(max * 0.55))) {
    return slice.slice(0, sentenceBoundary + 1).trim();
  }

  const wordBoundary = slice.lastIndexOf(' ');
  const truncated = slice
    .slice(0, wordBoundary >= Math.min(32, Math.floor(max * 0.35)) ? wordBoundary : max)
    .replace(/[\s,;:–—-]+$/g, '')
    .trim();
  return truncated || normalized.slice(0, max).trim();
}

function isLikelyIncompleteNarrativeText(value) {
  const raw = asString(value);
  if (/[,;:–—-]\s*$/.test(raw)) return true;
  const normalized = asString(value)
    .replace(/\s+/g, ' ')
    .replace(/[.!?;,:\s]+$/g, '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (/\b[a-z]$/.test(normalized) && /\b(?:radian|irritat|refin|disrupt|protect|bright|hydr|sooth|calm|blemish|hyperpigment)$/.test(normalized)) {
    return true;
  }
  return /\b(?:a|an|the|and|or|of|in|to|with|without|while|featuring|including|into|for|from|by|as|that|visible|support|supports|target|targets|provide|provides|deliver|delivers|improve|improves|reduce|reduces|calm|calms|derived|based)\b$/.test(
    normalized,
  );
}

function cleanProductDescriptionForIntel(value) {
  const cleaned = cleanProductText(value);
  if (!cleaned) return '';
  if (/…$|\.\.\.$/.test(cleaned)) return '';
  if (isLikelyIncompleteNarrativeText(cleaned)) return '';
  return cleaned;
}

function buildCompactHighlightHeadline(headlineValue, fallbackValue, maxLength = 96) {
  const source = cleanProductText(headlineValue) || cleanProductText(fallbackValue);
  if (!source) return '';
  if (source.length <= maxLength && !isLikelyIncompleteNarrativeText(source)) return source;

  const splitIfShortened = (pattern) => {
    const parts = source.split(pattern);
    return parts.length > 1 ? parts[0] : '';
  };
  const candidates = [
    splitIfShortened(/[—–:]/),
    splitIfShortened(/\s+to\s+/i),
    splitIfShortened(/\s+while\s+/i),
    splitIfShortened(/\s+without\s+/i),
    splitIfShortened(/\s+so\s+/i),
    splitIfShortened(/,\s+(?:while|with|featuring|including)\s+/i),
    splitIfShortened(/[.!?;]/),
  ]
    .map((item) => clampTextAtWordBoundary(item, maxLength))
    .filter((item) => item.length >= 18 && !isLikelyIncompleteNarrativeText(item));

  return candidates[0] || clampTextAtWordBoundary(source, maxLength);
}

function buildProductContext(caseRow) {
  const product = caseRow?.product && typeof caseRow.product === 'object' ? caseRow.product : {};
  return {
    brand: asString(product.brand),
    title: asString(product.title || product.name),
    category: asString(product.category || product.product_type),
    description: cleanProductDescriptionForIntel(product.description),
    ingredients: toList(product.ingredients_inci || product.ingredients),
    tags: toList(product.tags),
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
    source_url: asString(product.url || product.product_url || product.canonical_url || product.external_url),
    description: cleanProductDescriptionForIntel(product.description),
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
    '- Use the Google Search tool before drafting. Search for official brand/product pages, credible retailer pages, editorial/media reviews, review aggregations, and public consumer review patterns for this exact product.',
    '- Treat official/product pages as identity and formula evidence; treat reviews/media only as additive context. Do not use external claims unless the search result supports them.',
    '- If public review/media evidence is weak, mixed, sponsored, or about a sibling product, keep community_signals.status as "unavailable" and do not turn it into a proof badge or hype language.',
    '- If review_summary includes a high buyer review count and rating, treat that as verified buyer feedback. You may cite the exact rating/count as a factual review stat, but do not invent sentiment themes or positive-percentage breakdowns unless provided.',
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
    '- external_evidence_summary. Include short source-grounded notes only; use [] when unsupported.',
    '',
    'Product facts:',
    JSON.stringify(factsPack, null, 2),
  ].join('\n');
}

function normalizeExternalEvidenceSummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalizeNotes = (items) =>
    toList(items)
      .map((item) => {
        if (item && typeof item === 'object') {
          const sourceType = asString(item.source_type || item.source || item.type).slice(0, 80);
          const note = asString(item.note || item.summary || item.claim || item.text).slice(0, 220);
          const url = asString(item.url || item.uri).slice(0, 500);
          if (!note && !url) return null;
          return {
            ...(sourceType ? { source_type: sourceType } : {}),
            ...(note ? { note } : {}),
            ...(url ? { url } : {}),
          };
        }
        const note = asString(item).slice(0, 220);
        return note ? { note } : null;
      })
      .filter(Boolean)
      .slice(0, 6);

  return {
    official_pages: normalizeNotes(source.official_pages),
    retailer_pages: normalizeNotes(source.retailer_pages),
    editorial_media_reviews: normalizeNotes(source.editorial_media_reviews || source.media_reviews),
    consumer_review_patterns: normalizeNotes(source.consumer_review_patterns || source.public_reviews),
    caveats: normalizeNotes(source.caveats),
  };
}

function normalizeGeminiDraftOutput(output) {
  const bestFor = toList(output?.product_intel_core?.best_for)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const label = clampTextAtWordBoundary(
        plainTextValue(row?.label) || plainTextValue(row?.tag) || plainTextValue(item),
        120,
      );
      if (!label) return null;
      return {
        tag:
          plainTextValue(row?.tag).slice(0, 80) ||
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
      const body = clampTextAtWordBoundary(row?.body || item, 240);
      const headline = buildCompactHighlightHeadline(row?.headline, body, 96);
      if (!headline && !body) return null;
      const evidenceStrengthRaw = asString(row?.evidence_strength).toLowerCase();
      return {
        headline: headline || buildCompactHighlightHeadline(body, body, 96),
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
        !isGenericSellerHighlightText(`${item.headline} ${item.body}`) &&
        !isLikelyIncompleteNarrativeText(item.headline) &&
        !isLikelyIncompleteNarrativeText(item.body),
    )
    .slice(0, 4);

  const watchouts = toList(output?.product_intel_core?.watchouts)
    .map((item) => {
      const row = item && typeof item === 'object' ? item : null;
      const label = clampTextAtWordBoundary(row?.label || item, 160);
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
            .map((item) => clampTextAtWordBoundary(item, 120))
            .filter(Boolean)
            .slice(0, 4),
          layering_notes: toList(output.texture_finish.layering_notes)
            .map((item) => clampTextAtWordBoundary(item, 160))
            .filter(Boolean)
            .slice(0, 4),
        }
      : null;

  const communityStatusRaw = asString(output?.community_signals?.status).toLowerCase();
  const communitySignals = {
    status: communityStatusRaw === 'available' ? 'available' : 'unavailable',
    unavailable_reason: asString(output?.community_signals?.unavailable_reason) || null,
    top_loves: toList(output?.community_signals?.top_loves)
      .map((item) => clampTextAtWordBoundary(item, 160))
      .filter(Boolean)
      .slice(0, 4),
    top_complaints: toList(output?.community_signals?.top_complaints)
      .map((item) => clampTextAtWordBoundary(item, 160))
      .filter(Boolean)
      .slice(0, 4),
    best_fit_users: toList(output?.community_signals?.best_fit_users)
      .map((item) => clampTextAtWordBoundary(item, 160))
      .filter(Boolean)
      .slice(0, 3),
    mixed_feedback: toList(output?.community_signals?.mixed_feedback)
      .map((item) => clampTextAtWordBoundary(item, 180))
      .filter(Boolean)
      .slice(0, 3),
  };

  return {
    product_intel_core: {
      what_it_is: {
        headline:
          clampTextAtWordBoundary(output?.product_intel_core?.what_it_is?.headline, 120) ||
          PIVOTA_INSIGHTS_DISPLAY_NAME,
        body: clampTextAtWordBoundary(
          normalizeSellerWhatItIs(asString(output?.product_intel_core?.what_it_is?.body)),
          400,
        ),
      },
      best_for: bestFor,
      why_it_stands_out: highlights,
      routine_fit: {
        step: clampTextAtWordBoundary(output?.product_intel_core?.routine_fit?.step, 80),
        am_pm: toList(output?.product_intel_core?.routine_fit?.am_pm)
          .map((item) => asString(item).toLowerCase())
          .filter((item) => item === 'am' || item === 'pm')
          .slice(0, 2),
        pairing_notes: toList(output?.product_intel_core?.routine_fit?.pairing_notes)
          .map((item) => clampTextAtWordBoundary(item, 160))
          .filter(Boolean)
          .slice(0, 4),
      },
      watchouts,
    },
    texture_finish: textureFinish,
    community_signals: communitySignals,
    external_evidence_summary: normalizeExternalEvidenceSummary(output?.external_evidence_summary),
  };
}

function firstUsefulSentence(text) {
  const cleaned = cleanProductText(text)
    .replace(/\b(as seen on|trending on|viral hit|instagram favorite|influencers are obsessed)\b[\s\S]*$/i, '')
    .trim();
  const match = cleaned.match(/^(.{40,260}?[.!?])(\s|$)/);
  if (match) return match[1].trim();
  return cleaned.length >= 40 ? cleaned.slice(0, 260).trim() : '';
}

function extractActiveTerms(context) {
  const source = `${context?.description || ''} ${toList(context?.ingredients).join(' ')}`.toLowerCase();
  const terms = [
    'vitamin c',
    'retinol',
    'niacinamide',
    'hyaluronic acid',
    'salicylic acid',
    'squalane',
    'glycerin',
    'ceramide',
    'peptide',
    'azelaic acid',
    'birch',
    'zinc oxide',
    'blood orange',
    'patchouli',
    'sandalwood',
    'rose',
    'vanilla',
    'leather',
    'peach',
  ];
  return terms.filter((term) => source.includes(term)).slice(0, 6);
}

function buildHumanStandardWhatItIs(context, baselineBundle) {
  const kind = inferProductKindFromContext(context);
  const activeTerms = extractActiveTerms(context);
  const usefulDescriptionRaw = firstUsefulSentence(context.description);
  const usefulDescription = hasProblematicGeneratedText(usefulDescriptionRaw)
    ? ''
    : normalizeSellerWhatItIs(usefulDescriptionRaw);
  const baseHeadline = asString(baselineBundle?.product_intel_core?.what_it_is?.headline);

  if (kind === 'lip') {
    return {
      headline: /lip/i.test(baseHeadline) ? baseHeadline : 'Glossy lip oil',
      body: 'A lip product focused on glossy shine, soft-feeling lips, and a fuller-looking finish.',
    };
  }
  if (kind === 'fragrance') {
    return {
      headline: /fragrance|parfum|scent/i.test(baseHeadline) ? baseHeadline : 'Fragrance profile',
      body: usefulDescription || `A fragrance product${activeTerms.length ? ` built around ${activeTerms.join(', ')} notes` : ''}.`,
    };
  }
  if (kind === 'complexion_makeup') {
    return {
      headline: /foundation|tint|makeup|base/i.test(baseHeadline) ? baseHeadline : 'Complexion makeup',
      body: usefulDescription || 'A complexion makeup product focused on coverage, finish, and tone-evening wear.',
    };
  }
  if (kind === 'moisturizer') {
    return {
      headline: /cream|moistur/i.test(baseHeadline) ? baseHeadline : 'Daily moisturizer',
      body: usefulDescription || 'A daily moisturizer focused on hydration, comfort, and barrier-supportive skin care.',
    };
  }
  if (kind === 'sunscreen') {
    return {
      headline: /spf|sunscreen/i.test(baseHeadline) ? baseHeadline : 'Daily sunscreen',
      body: usefulDescription || 'A daily sunscreen product focused on UV protection within a daytime skin-care routine.',
    };
  }
  if (kind === 'serum') {
    return {
      headline: /serum|treatment/i.test(baseHeadline) ? baseHeadline : 'Treatment serum',
      body:
        usefulDescription ||
        `A treatment serum${activeTerms.length ? ` built around ${activeTerms.join(', ')}` : ''} for targeted skin-care routines.`,
    };
  }
  if (kind === 'cleanser') {
    return {
      headline: /cleanser/i.test(baseHeadline) ? baseHeadline : 'Daily cleanser',
      body:
        usefulDescription ||
        (activeTerms.length
          ? `A daily cleanser built around ${activeTerms.join(', ')} cues for removing daily buildup while keeping the routine comfortable.`
          : 'A cleanser focused on removing daily buildup while keeping the routine gentle and practical.'),
    };
  }

  return {
    headline: baseHeadline || 'Product insight',
    body: usefulDescription || asString(baselineBundle?.product_intel_core?.what_it_is?.body) || 'A product-level insight grounded in the available listing facts.',
  };
}

function buildHumanStandardBestFor(context, baselineBundle) {
  const kind = inferProductKindFromContext(context);
  const text = `${context?.title || ''} ${context?.category || ''} ${context?.description || ''}`.toLowerCase();
  const item = (tag, label) => ({ tag, label, confidence: 'moderate' });

  if (kind === 'lip') {
    return [item('lip_shine', 'Glossy lip shine'), item('lip_comfort', 'Soft-feeling lip comfort')];
  }
  if (kind === 'fragrance') {
    return [item('fragrance_wear', 'Fragrance wear'), item('scent_preference', 'Scent-profile shoppers')];
  }
  if (kind === 'complexion_makeup') {
    return [
      item(text.includes('matte') ? 'soft_matte_finish' : 'complexion_finish', text.includes('matte') ? 'Soft-matte finish' : 'Complexion finish'),
      item('coverage_preferences', 'Coverage-focused makeup routines'),
    ];
  }
  if (kind === 'sunscreen') {
    return [item('daily_uv_protection', 'Daily UV protection'), item('daytime_routines', 'Daytime skin-care routines')];
  }
  if (kind === 'cleanser') {
    return [item('daily_cleansing', 'Daily cleansing'), item('comfortable_cleanse', 'Comfort-focused cleansing routines')];
  }
  if (kind === 'serum') {
    if (text.includes('tone') || text.includes('vitamin c')) return [item('uneven_tone', 'Uneven tone concerns'), item('texture_refinement', 'Texture-smoothing routines')];
    if (/\b(sebum|pore|pores|congestion|breakout|acne|propolis)\b/.test(text)) return [item('oil_control', 'Oiliness and visible pores'), item('breakout_prone', 'Breakout-prone routines')];
    return [item('targeted_treatment', 'Targeted treatment routines')];
  }
  if (kind === 'moisturizer') {
    return [
      item(text.includes('barrier') ? 'barrier_comfort' : 'dryness', text.includes('barrier') ? 'Barrier-comfort routines' : 'Dry or dehydrated skin'),
      item('daily_moisture', 'Daily moisture support'),
    ];
  }

  const baselineBestFor = toList(baselineBundle?.product_intel_core?.best_for)
    .map((entry) => ({
      tag: asString(entry?.tag || entry?.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'fit',
      label: asString(entry?.label || entry?.tag).slice(0, 120),
      confidence: asString(entry?.confidence) || 'moderate',
    }))
    .filter((entry) => entry.label && !hasIncompatibleBestForForContext(context, [entry]))
    .slice(0, 3);
  return baselineBestFor.length ? baselineBestFor : [item('product_fit', 'Product-fit shoppers')];
}

function buildHumanStandardHighlights(context) {
  const kind = inferProductKindFromContext(context);
  const activeTerms = extractActiveTerms(context);
  const text = `${context?.title || ''} ${context?.description || ''}`.toLowerCase();
  const highlight = (headline, body, evidenceStrength = 'seller_grounded') => ({
    headline,
    body,
    evidence_strength: evidenceStrength,
  });

  if (kind === 'lip') {
    return [
      highlight('Gloss and lip comfort', 'Targets shine, softness, and a fuller-looking lip finish in one lip-oil step.'),
    ];
  }
  if (kind === 'fragrance') {
    return [
      highlight(
        'Scent-note structure',
        activeTerms.length
          ? `Defines the scent around ${activeTerms.join(', ')} notes for shoppers comparing fragrance profiles.`
          : 'Anchors the fragrance in scent profile and wear context for shoppers comparing fragrance styles.',
      ),
    ];
  }
  if (kind === 'complexion_makeup') {
    return [
      highlight(
        text.includes('matte') ? 'Soft-matte finish' : 'Coverage and finish focus',
        text.includes('spf')
          ? 'Combines complexion coverage with SPF-positioned daytime wear for routines that need both coverage and sun-care cues.'
          : 'Anchors the product in coverage, finish, and shade-use context for complexion makeup routines.',
      ),
    ];
  }
  if (kind === 'moisturizer') {
    return [
      highlight(
        text.includes('birch') ? 'Birch hydration focus' : 'Hydration and comfort',
        text.includes('barrier')
          ? 'Pairs moisturizing care with barrier-comfort claims for daily cream routines.'
          : 'Works as a daily moisture step with comfort-first skin-care use.',
      ),
    ];
  }
  if (kind === 'sunscreen') {
    return [
      highlight('Daytime UV step', 'Anchors the product in daily UV protection and daytime layering context.'),
    ];
  }
  if (kind === 'serum') {
    return [
      highlight(
        activeTerms.length > 1 ? 'Multi-active treatment scope' : 'Targeted treatment scope',
        activeTerms.length > 1
          ? `Combines ${activeTerms.join(', ')} for a targeted treatment step.`
          : 'Supports targeted treatment routines with the available active and concern cues.',
      ),
    ];
  }
  if (kind === 'cleanser') {
    return [
      highlight('Cleansing comfort', 'Supports daily cleansing with a comfort-first profile.'),
    ];
  }
  return [
    highlight('Listing-grounded use', 'Defines the product around the title, category, and available listing description.'),
  ].filter((item) => !isGenericSellerHighlightText(`${item.headline} ${item.body}`));
}

function buildHumanStandardWatchouts(context, baselineBundle) {
  const kind = inferProductKindFromContext(context);
  if (kind === 'sunscreen') {
    return [{ type: 'spf', label: 'Reapply as needed for extended daytime exposure.', severity: 'medium' }];
  }
  if (kind === 'serum' && /\b(retinol|salicylic acid|acid)\b/i.test(`${context?.description || ''} ${toList(context?.ingredients).join(' ')}`)) {
    return [{ type: 'active_blend', label: 'Introduce gradually if your routine already includes retinoids or exfoliating acids.', severity: 'medium' }];
  }
  return toList(baselineBundle?.product_intel_core?.watchouts)
    .map((item) => ({
      type: asString(item?.type).slice(0, 80) || 'watchout',
      label: asString(item?.label).slice(0, 160),
      severity: ['low', 'medium', 'high'].includes(asString(item?.severity).toLowerCase())
        ? asString(item?.severity).toLowerCase()
        : 'low',
    }))
    .filter((item) => item.label)
    .slice(0, 3);
}

function buildHumanStandardPairingNotes(kind) {
  if (kind === 'lip') return ['Use as a lip finishing step or reapply when shine and comfort fade.'];
  if (kind === 'fragrance') return ['Apply to pulse points and adjust amount based on scent intensity preference.'];
  if (kind === 'complexion_makeup') return ['Apply in the complexion makeup step and choose shade/coverage separately.'];
  if (kind === 'sunscreen') return ['Use as the last morning skin-care step before makeup.'];
  if (kind === 'moisturizer') return ['Apply after treatment steps; use SPF afterward in the morning.'];
  if (kind === 'serum') return ['Apply before moisturizer; use SPF in the morning when using active treatments.'];
  if (kind === 'cleanser') return ['Use before treatment and moisturizer steps.'];
  return ['Use according to the product category and seller directions.'];
}

function buildHumanStandardRewriteOutput(caseRow, baselineBundle, geminiOutput) {
  if (!baselineBundle) return null;
  const context = buildProductContext(caseRow);
  const baselineCore = baselineBundle.product_intel_core || {};
  const baselineRoutine = baselineCore.routine_fit || {};
  const grounding = geminiOutput?.gemini_grounding || null;
  const externalEvidenceSummary = geminiOutput?.external_evidence_summary || null;
  const whatItIs = buildHumanStandardWhatItIs(context, baselineBundle);
  const bestFor = buildHumanStandardBestFor(context, baselineBundle);
  const highlights = buildHumanStandardHighlights(context).filter(
    (item) =>
      item &&
      asString(item.body).length >= 20 &&
      !isLowSignalSellerHighlightText(`${item.headline} ${item.body}`) &&
      !isGenericSellerHighlightText(`${item.headline} ${item.body}`),
  );
  const routineStep = asString(baselineRoutine.step);
  const kind = inferProductKindFromContext(context);

  return {
    product_intel_core: {
      what_it_is: whatItIs,
      best_for: bestFor,
      why_it_stands_out: highlights.length ? highlights : toList(baselineCore.why_it_stands_out).slice(0, 1),
      routine_fit: {
        step: routineStep,
        am_pm: toList(baselineRoutine.am_pm).length
          ? toList(baselineRoutine.am_pm)
          : kind === 'sunscreen'
            ? ['am']
            : kind === 'fragrance'
              ? ['pm']
              : ['am', 'pm'],
        pairing_notes: toList(baselineRoutine.pairing_notes).length
          ? toList(baselineRoutine.pairing_notes)
          : buildHumanStandardPairingNotes(kind),
      },
      watchouts: buildHumanStandardWatchouts(context, baselineBundle),
    },
    texture_finish:
      geminiOutput?.texture_finish && typeof geminiOutput.texture_finish === 'object'
        ? geminiOutput.texture_finish
        : baselineBundle.texture_finish || null,
    community_signals:
      baselineBundle.community_signals?.status === 'available'
        ? deepClone(baselineBundle.community_signals)
        : {
            status: 'unavailable',
            unavailable_reason: grounding?.has_grounding
              ? 'grounded_public_consensus_not_reviewed_for_display'
              : 'insufficient_feedback',
          },
    external_evidence_summary: externalEvidenceSummary || normalizeExternalEvidenceSummary(null),
    ...(grounding?.has_grounding ? { gemini_grounding: grounding } : {}),
    human_standard_rewrite: true,
    reviewer_model: GPT54_HUMAN_STANDARD_REWRITE_MODEL,
    case_id: asString(caseRow?.case_id),
  };
}

async function runGeminiDraft(caseRow, baselineDraft, model) {
  if (!hasGeminiKey()) {
    return { skipped: true, reason: 'missing_gemini_api_key' };
  }
  const prompt = buildGeminiPrompt(caseRow, baselineDraft);
  const requestedCandidates = parseGeminiModelList(model);
  const modelCandidates = requestedCandidates.length ? requestedCandidates : GEMINI_MODEL_DEFAULTS;
  const attemptedModels = [];
  let lastError = 'all_gemini_models_failed';

  const runStage = async (modelCandidate, stageLabel) => {
    const normalizedModel = normalizeGeminiModel(modelCandidate);
    attemptedModels.push(normalizedModel);
    try {
      const parsed = await invokeGeminiDraft(normalizedModel, prompt);
      const qualityBundle = mergeGeminiDraftIntoBaseline(
        caseRow,
        baselineDraft,
        parsed,
        normalizedModel,
      );
      const qualityGate = evaluateGeminiCandidateQuality(baselineDraft, qualityBundle);
      return {
        skipped: false,
        output: parsed,
        merged_bundle: qualityBundle,
        model_used: normalizedModel,
        quality_gate: qualityGate,
        stage: stageLabel,
      };
    } catch (err) {
      lastError = extractModelError(err);
      return { skipped: true, reason: `model_call_failed:${lastError}`, model_used: normalizedModel, stage: stageLabel };
    }
  };

  const primaryModel = GEMINI_PRIMARY_MODEL;
  const upgradeModel = GEMINI_UPGRADE_MODEL;

  const primaryResult = await runStage(primaryModel, 'primary');
  if (!primaryResult.skipped && primaryResult.quality_gate?.overall_pass) {
    return {
      skipped: false,
      output: primaryResult.output,
      model_used: primaryResult.model_used,
      model_candidates: modelCandidates,
      attempted_models: attemptedModels,
      quality_gate: primaryResult.quality_gate,
      selection_strategy: 'gemini_flash_pass',
    };
  }

  const upgradeResult = await runStage(upgradeModel, 'upgrade');
  if (!upgradeResult.skipped && upgradeResult.quality_gate?.overall_pass) {
    return {
      skipped: false,
      output: upgradeResult.output,
      model_used: upgradeResult.model_used,
      model_candidates: modelCandidates,
      attempted_models: attemptedModels,
      quality_gate: upgradeResult.quality_gate,
      selection_strategy: 'gemini_upgrade_pass',
    };
  }

  const rewriteSeedOutput = upgradeResult.output || primaryResult.output || null;
  if (rewriteSeedOutput || baselineDraft) {
    const humanRewriteOutput = buildHumanStandardRewriteOutput(
      caseRow,
      baselineDraft,
      rewriteSeedOutput,
    );
    if (humanRewriteOutput) {
      const humanRewriteMerged = mergeGeminiDraftIntoBaseline(
        caseRow,
        baselineDraft,
        humanRewriteOutput,
        GPT54_HUMAN_STANDARD_REWRITE_MODEL,
      );
      const humanRewriteQuality = evaluateGeminiCandidateQuality(
        baselineDraft,
        humanRewriteMerged,
      );
      if (humanRewriteQuality.overall_pass) {
        return {
          skipped: false,
          output: humanRewriteOutput,
          model_used: GPT54_HUMAN_STANDARD_REWRITE_MODEL,
          model_candidates: modelCandidates,
          attempted_models: attemptedModels,
          quality_gate: {
            ...humanRewriteQuality,
            human_standard_rewrite: true,
            human_standard_reviewer_model: GPT54_HUMAN_STANDARD_REWRITE_MODEL,
          },
          selection_strategy: 'gpt54_human_standard_rewrite',
        };
      }
      return {
        skipped: true,
        reason: `human_standard_rewrite_failed:${(humanRewriteQuality.fail_reasons || []).join('|')}`,
        output: null,
        model_used: null,
        model_candidates: modelCandidates,
        attempted_models: attemptedModels,
        quality_gate: humanRewriteQuality,
        selection_strategy: 'human_standard_rewrite_failed',
      };
    }
  }

  if (!upgradeResult.skipped) {
    return {
      skipped: true,
      reason: `gemini_quality_failed:${(upgradeResult.quality_gate?.fail_reasons || []).join('|')}`,
      output: null,
      model_used: null,
      model_candidates: modelCandidates,
      attempted_models: attemptedModels,
      quality_gate: upgradeResult.quality_gate || primaryResult.quality_gate,
      selection_strategy: 'gemini_quality_failed',
    };
  }

  return {
    skipped: true,
    reason: `model_fallback_exhausted:${lastError}`,
    model_used: null,
    model_candidates: modelCandidates,
    attempted_models: attemptedModels,
    quality_gate: {
      ...(upgradeResult.quality_gate || primaryResult.quality_gate || {}),
      candidate_available: false,
      overall_pass: false,
      quality_score: 0,
      fail_reasons: [lastError],
      field_decisions: {
        ...(upgradeResult.quality_gate?.field_decisions || primaryResult.quality_gate?.field_decisions || {}),
      },
    },
    selection_strategy: 'gemini_call_failed',
  };
}

function mergeGeminiDraftIntoBaseline(caseRow, baselineBundle, geminiOutput, model) {
  if (!baselineBundle || !geminiOutput) return null;
  const generatedAt = new Date().toISOString();
  const merged = deepClone(baselineBundle);
  const productContext = buildProductContext(caseRow);
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

  if (geminiOutput.external_evidence_summary) {
    merged.external_evidence_summary = deepClone(geminiOutput.external_evidence_summary);
  }
  if (geminiOutput.gemini_grounding?.has_grounding) {
    merged.gemini_grounding = deepClone(geminiOutput.gemini_grounding);
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
    product_context: productContext,
    ...(geminiOutput.gemini_grounding?.has_grounding
      ? { gemini_grounding: deepClone(geminiOutput.gemini_grounding) }
      : {}),
    ...(geminiOutput.external_evidence_summary
      ? { external_evidence_summary: deepClone(geminiOutput.external_evidence_summary) }
      : {}),
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

function hasIncompleteHighlightCopy(highlights) {
  return toList(highlights).some(
    (item) =>
      isLikelyIncompleteNarrativeText(item?.headline) ||
      isLikelyIncompleteNarrativeText(item?.body),
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
  const productContext = geminiCandidateBundle?.provenance?.product_context || {};
  const sellerOnlyMode =
    baselineBundle.evidence_profile === 'seller_only' ||
    baselineBundle.evidence_profile === 'seller_plus_formula';
  const narrativeText = flattenBundleNarrative(geminiCandidateBundle);
  const externalEvidenceLanguage = hasExternalEvidenceLanguage(narrativeText);
  const groundedExternalEvidence = hasGroundingEvidence(geminiCandidateBundle);
  const sellerOnlyViolation =
    sellerOnlyMode &&
    externalEvidenceLanguage &&
    !groundedExternalEvidence;
  const problematicGeneratedText = hasProblematicGeneratedText(narrativeText);
  const incompatibleBestFor = hasIncompatibleBestForForContext(
    productContext,
    candidateCore.best_for,
  );
  const incompleteHighlights = hasIncompleteHighlightCopy(candidateCore.why_it_stands_out);
  const weakCandidateWhatItIsHeadline = isGenericWhatItIsHeadline(candidateCore.what_it_is?.headline);
  const weakBaselineBestFor = isWeakBestForForPublish(baselineCore.best_for);
  const weakCandidateBestFor = isWeakBestForForPublish(candidateCore.best_for);

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
      !weakCandidateWhatItIsHeadline &&
      !sellerOnlyViolation &&
      !problematicGeneratedText &&
      !(sellerOnlyMode && isWeakSellerWhatItIsText(candidateCore.what_it_is?.body)),
    best_for:
      Array.isArray(candidateCore.best_for) &&
      candidateCore.best_for.length > 0 &&
      !weakCandidateBestFor &&
      (
        !baselineCore.best_for?.length ||
        baselineBundle.evidence_profile !== 'community_supported' ||
        bestForOverlap >= 0.15 ||
        weakBaselineBestFor
      ) &&
      !incompatibleBestFor &&
      !sellerOnlyViolation &&
      !problematicGeneratedText,
    why_it_stands_out:
      Array.isArray(candidateCore.why_it_stands_out) &&
      candidateCore.why_it_stands_out.length > 0 &&
      !incompleteHighlights &&
      candidateCore.why_it_stands_out.some(
        (item) =>
          asString(item?.body).length >= 20 &&
          !isLowSignalSellerHighlightText(`${item?.headline || ''} ${item?.body || ''}`) &&
          !(sellerOnlyMode && isGenericSellerHighlightText(`${item?.headline || ''} ${item?.body || ''}`)),
      ) &&
      !sellerOnlyViolation &&
      !problematicGeneratedText,
    routine_fit:
      asString(candidateCore.routine_fit?.step) === asString(baselineCore.routine_fit?.step) &&
      (toList(candidateCore.routine_fit?.pairing_notes).length > 0 ||
        toList(candidateCore.routine_fit?.am_pm).length > 0) &&
      !sellerOnlyViolation &&
      !problematicGeneratedText,
    watchouts:
      (!sellerOnlyViolation &&
        !problematicGeneratedText &&
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
  if (problematicGeneratedText) failReasons.push('problematic_generated_text');
  if (incompatibleBestFor) failReasons.push('incompatible_best_for');
  if (incompleteHighlights) failReasons.push('incomplete_highlight_copy');
  if (weakCandidateWhatItIsHeadline) failReasons.push('generic_what_it_is_headline');
  if (weakCandidateBestFor) failReasons.push('weak_best_for_taxonomy_fallback');
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
    problematic_generated_text: problematicGeneratedText,
    external_evidence_language: externalEvidenceLanguage,
    grounded_external_evidence: groundedExternalEvidence,
    incompatible_best_for: incompatibleBestFor,
    incomplete_highlights: incompleteHighlights,
    best_for_overlap: bestForOverlap,
    watchout_overlap: watchoutOverlap,
    field_decisions: fieldDecisions,
  };
}

function buildSelectedBundle(caseRow, baselineBundle, geminiCandidateBundle, quality, model) {
  const selected = deepClone(baselineBundle);
  const generatedFieldSource =
    normalizeGeminiModel(model) === normalizeGeminiModel(GPT54_HUMAN_STANDARD_REWRITE_MODEL)
      ? 'human_standard'
      : 'gemini';
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
      fieldSources.what_it_is = generatedFieldSource;
    }
    if (quality.field_decisions.best_for) {
      selected.product_intel_core.best_for = deepClone(
        geminiCandidateBundle.product_intel_core.best_for,
      );
      fieldSources.best_for = generatedFieldSource;
    }
    if (quality.field_decisions.why_it_stands_out) {
      selected.product_intel_core.why_it_stands_out = deepClone(
        geminiCandidateBundle.product_intel_core.why_it_stands_out,
      );
      fieldSources.why_it_stands_out = generatedFieldSource;
    }
    if (quality.field_decisions.routine_fit) {
      selected.product_intel_core.routine_fit = deepClone(
        geminiCandidateBundle.product_intel_core.routine_fit,
      );
      fieldSources.routine_fit = generatedFieldSource;
    }
    if (quality.field_decisions.watchouts) {
      selected.product_intel_core.watchouts = deepClone(
        geminiCandidateBundle.product_intel_core.watchouts,
      );
      fieldSources.watchouts = generatedFieldSource;
    }
    if (quality.field_decisions.texture_finish) {
      selected.texture_finish = deepClone(geminiCandidateBundle.texture_finish);
      fieldSources.texture_finish = generatedFieldSource;
    }
    if (quality.field_decisions.community_signals) {
      selected.community_signals = deepClone(geminiCandidateBundle.community_signals);
      fieldSources.community_signals = generatedFieldSource;
    }
  }

  const humanStandardPatch = (() => {
    let cached = null;
    return () => {
      if (cached !== null) return cached;
      cached = buildHumanStandardRewriteOutput(
        caseRow,
        baselineBundle,
        geminiCandidateBundle,
      );
      return cached;
    };
  })();
  if (selected.product_intel_core?.what_it_is?.body) {
    selected.product_intel_core.what_it_is.body = normalizeSellerWhatItIs(
      selected.product_intel_core.what_it_is.body,
    );
  }
  if (hasProblematicGeneratedText(selected.product_intel_core?.what_it_is?.body)) {
    const patch = humanStandardPatch();
    if (patch?.product_intel_core?.what_it_is?.body) {
      selected.product_intel_core.what_it_is = deepClone(patch.product_intel_core.what_it_is);
      fieldSources.what_it_is = 'human_standard';
    }
  }
  const generatedUnsafeForRepair =
    Boolean(quality?.seller_only_violation) || Boolean(quality?.problematic_generated_text);
  if (
    !generatedUnsafeForRepair &&
    isGenericWhatItIsHeadline(selected.product_intel_core?.what_it_is?.headline)
  ) {
    const patch = humanStandardPatch();
    if (
      patch?.product_intel_core?.what_it_is?.headline &&
      !isGenericWhatItIsHeadline(patch.product_intel_core.what_it_is.headline)
    ) {
      selected.product_intel_core.what_it_is = deepClone(patch.product_intel_core.what_it_is);
      fieldSources.what_it_is = 'human_standard';
    }
  }
  if (!generatedUnsafeForRepair && isWeakBestForForPublish(selected.product_intel_core?.best_for)) {
    const patch = humanStandardPatch();
    if (
      Array.isArray(patch?.product_intel_core?.best_for) &&
      patch.product_intel_core.best_for.length &&
      !isWeakBestForForPublish(patch.product_intel_core.best_for)
    ) {
      selected.product_intel_core.best_for = deepClone(patch.product_intel_core.best_for);
      fieldSources.best_for = 'human_standard';
    }
  }
  if (hasIncompleteHighlightCopy(selected.product_intel_core?.why_it_stands_out)) {
    const patch = humanStandardPatch();
    const patchHighlights = toList(patch?.product_intel_core?.why_it_stands_out).filter(
      (item) =>
        asString(item?.headline) &&
        asString(item?.body) &&
        !hasProblematicGeneratedText(`${item.headline} ${item.body}`) &&
        !isLikelyIncompleteNarrativeText(item.headline) &&
        !isLikelyIncompleteNarrativeText(item.body),
    );
    if (patchHighlights.length) {
      selected.product_intel_core.why_it_stands_out = deepClone(patchHighlights);
      fieldSources.why_it_stands_out = 'human_standard';
    } else {
      selected.product_intel_core.why_it_stands_out = deepClone(
        baselineBundle.product_intel_core?.why_it_stands_out || [],
      );
      fieldSources.why_it_stands_out = 'baseline';
    }
  }
  if (Array.isArray(selected.product_intel_core?.watchouts)) {
    selected.product_intel_core.watchouts = selected.product_intel_core.watchouts.filter(
      (item) =>
        asString(item?.label) &&
        !hasProblematicGeneratedText(item?.label) &&
        !isLikelyIncompleteNarrativeText(item?.label),
    );
  }

  const selectedFieldCount = Object.values(fieldSources).filter((value) => value !== 'baseline').length;
  const humanStandardSelected = Object.values(fieldSources).some((value) => value === 'human_standard');
  const geminiSelected = Object.values(fieldSources).some((value) => value === 'gemini');
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
    generator: humanStandardSelected
      ? geminiSelected
        ? 'baseline_plus_gemini_plus_human_standard'
        : 'gpt54_human_standard_rewrite'
      : selectedFieldCount > 0
        ? 'baseline_plus_gemini'
        : 'baseline_only',
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
    selected_mode: humanStandardSelected
      ? geminiSelected
        ? 'hybrid_gemini_human_standard'
        : 'human_standard_rewrite'
      : selectedFieldCount > 0
        ? 'hybrid_gemini'
        : 'baseline_only',
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

  ['confidence', 'freshness', 'quality_state', 'evidence_profile', 'source_coverage'].forEach((field) => {
    if (manualCore[field] == null) return;
    core[field] = deepClone(manualCore[field]);
    bundle[field] = deepClone(manualCore[field]);
  });

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

  if (Array.isArray(manualOverride.external_highlight_signals)) {
    bundle.external_highlight_signals = deepClone(manualOverride.external_highlight_signals);
    fieldSources.external_highlight_signals = 'manual';
    manualFieldCount += 1;
  }

  if (manualOverride.shopping_card && typeof manualOverride.shopping_card === 'object') {
    bundle.shopping_card = {
      ...(bundle.shopping_card || {}),
      ...deepClone(manualOverride.shopping_card),
    };
  }

  if (manualOverride.search_card && typeof manualOverride.search_card === 'object') {
    bundle.search_card = {
      ...(bundle.search_card || {}),
      ...deepClone(manualOverride.search_card),
    };
  }

  bundle.product_intel_core = core;
  bundle.provenance = {
    ...(bundle.provenance || {}),
    source: 'product_intel_pilot_compare',
    generator: 'curated_override',
    selection_strategy: 'curated_override',
    override_reason: asString(manualOverride.notes) || 'manual_quality_override',
    ...(asString(manualOverride.external_highlight_review_status)
      ? { external_highlight_review_status: asString(manualOverride.external_highlight_review_status) }
      : {}),
    ...(asString(manualOverride.external_evidence_generated_at)
      ? { external_evidence_generated_at: asString(manualOverride.external_evidence_generated_at) }
      : {}),
    ...(asString(manualOverride.external_evidence_model)
      ? { external_evidence_model: asString(manualOverride.external_evidence_model) }
      : {}),
    ...(asString(manualOverride.external_review_batch)
      ? { external_review_batch: asString(manualOverride.external_review_batch) }
      : {}),
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
    `Human-standard rewrites: ${meta.human_standard_rewrites || 0}`,
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

    const requestedModel = args.model;
    const geminiRaw = args.skipGemini
      ? { skipped: true, reason: 'skip_gemini_flag', model_used: null, model_candidates: parseGeminiModelList(requestedModel), attempted_models: [] }
      : await runGeminiDraft(caseRow, baseline, args.model);
    const usedModel = geminiRaw.model_used || requestedModel;
    const geminiCandidate = geminiRaw.skipped
      ? null
      : mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiRaw.output, usedModel);
    const qualityGate = geminiRaw.quality_gate || evaluateGeminiCandidateQuality(baseline, geminiCandidate);
    const manualOverride = resolveManualOverride(caseRow, manualOverrides);
    const selected = applyManualOverrideToSelected(
      caseRow,
      buildSelectedBundle(caseRow, baseline, geminiCandidate, qualityGate, usedModel),
      manualOverride,
    );

    reportRows.push({
      case_id: asString(caseRow.case_id) || 'unnamed_case',
      notes: asString(caseRow.notes),
      manual_override_applied: Boolean(manualOverride),
      baseline,
      gemini: geminiRaw.skipped
        ? {
          skipped: true,
          reason: geminiRaw.reason,
          model: geminiRaw.model_used,
          model_candidates: geminiRaw.model_candidates || parseGeminiModelList(requestedModel),
          attempted_models: geminiRaw.attempted_models || [],
          quality_gate: geminiRaw.quality_gate,
          selection_strategy: geminiRaw.selection_strategy || 'gemini_skipped',
        }
        : {
          skipped: false,
          raw: geminiRaw.output,
          candidate: geminiCandidate,
          model: geminiRaw.model_used,
          model_candidates: geminiRaw.model_candidates || parseGeminiModelList(requestedModel),
          attempted_models: geminiRaw.attempted_models || [],
          quality_gate: qualityGate,
          selection_strategy: geminiRaw.selection_strategy || 'gemini_completed',
        },
      manual_override: manualOverride ? deepClone(manualOverride) : null,
      quality_gate: qualityGate,
      selected: applyManualOverrideToSelected(
        caseRow,
        buildSelectedBundle(caseRow, baseline, geminiCandidate, qualityGate, usedModel),
        manualOverride,
      ),
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
    gemini_model_used: Array.from(
      new Set(
        reportRows.map((row) => asString(row.gemini?.model)).filter(Boolean),
      ),
    ),
    gemini_completed: reportRows.filter((row) => row.gemini && row.gemini.skipped === false).length,
    gemini_skipped: reportRows.filter((row) => row.gemini && row.gemini.skipped !== false).length,
    hybrid_selected: reportRows.filter((row) => row.selected?.selected_mode === 'hybrid_gemini').length,
    human_standard_rewrites: reportRows.filter((row) => row.selected?.selected_mode === 'human_standard_rewrite').length,
    baseline_only: reportRows.filter((row) => row.selected?.selected_mode === 'baseline_only').length,
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
  parseArgs,
  applyManualOverrideToSelected,
  resolveManualOverride,
  buildShoppingCardPayload,
  parseGeminiModelList,
  runGeminiDraft,
};
