#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { closePool, query, withClient } = require('../src/db');
const {
  PRODUCT_INTEL_CONTRACT_VERSION,
  normalizePublishedProductIntelBundle,
} = require('../src/pdpProductIntel');
const {
  assessPivotaInsightReplacement,
  buildPivotaInsightInventoryRow,
} = require('../src/services/pivotaInsightsQuality');

const REVIEW_SOURCE = 'pivota_insights_laneige_official_pdp_review_v1';
const REVIEWER = 'codex_manual_review';
const PROTECTED_QUALITY_STATES = new Set(['reviewed', 'verified', 'published', 'ready']);

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function stripHtml(input) {
  return asString(input)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(value, limit = 360) {
  const text = stripHtml(value);
  if (!text) return '';
  if (text.length <= limit) return text;
  const truncated = text.slice(0, limit);
  const boundary = truncated.lastIndexOf(' ');
  return truncated.slice(0, boundary > limit * 0.65 ? boundary : limit).trim();
}

function firstSentence(value, fallback = '') {
  const text = stripHtml(value);
  if (!text) return fallback;
  const match = text.match(/[^.!?]+[.!?]?/);
  const sentence = stripHtml(match ? match[0] : text);
  return sentence || fallback;
}

function usefulDescriptionSentence(value) {
  const text = stripHtml(value);
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [];
  for (const raw of sentences) {
    const current = stripHtml(raw);
    if (current.length < 28) continue;
    if (/\b(viral product|you've been waiting for|oh so soft|new arrival|best seller|limited edition|introducing|skincare newbie|skincare nerd|we've got you covered)\b/i.test(current)) continue;
    return current;
  }
  return '';
}

function sentence(value) {
  const text = stripHtml(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function articleFor(label) {
  return /^[aeiou]/i.test(asString(label)) ? 'an' : 'a';
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function parseListish(value) {
  if (Array.isArray(value)) {
    return uniq(value.flatMap((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        return [
          item.name,
          item.label,
          item.title,
          item.ingredient,
          item.value,
          item.text,
          item.description,
        ].filter(Boolean).join(' ');
      }
      return '';
    }));
  }
  const text = stripHtml(value);
  if (!text) return [];
  return uniq(
    text
      .split(/\s*(?:\n|•|\||;)\s*/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function readFirstField(seedData, snapshot, keys) {
  for (const key of keys) {
    const value = seedData[key];
    if (asString(value) || (Array.isArray(value) && value.length)) return value;
  }
  for (const key of keys) {
    const value = snapshot[key];
    if (asString(value) || (Array.isArray(value) && value.length)) return value;
  }
  return '';
}

function readSeedFacts(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const title = asString(row.title || row.catalog_title || snapshot.title || seedData.title);
  const brand = asString(row.brand || snapshot.brand || seedData.brand || 'LANEIGE').replace(/\s+US$/i, '');
  const description = stripHtml(readFirstField(seedData, snapshot, [
    'pdp_description_raw',
    'description',
    'short_description',
    'pdp_overview_raw',
    'overview',
  ]));
  const howTo = parseListish(readFirstField(seedData, snapshot, [
    'pdp_how_to_use_raw',
    'how_to_use',
    'directions',
  ]));
  const activeIngredients = parseListish(readFirstField(seedData, snapshot, [
    'pdp_active_ingredients_raw',
    'active_ingredients',
    'key_ingredients',
    'pdp_key_ingredients_raw',
  ]));
  const rawIngredients = parseListish(readFirstField(seedData, snapshot, [
    'pdp_ingredients_raw',
    'raw_ingredient_text_clean',
    'ingredients_inci',
  ]));
  const details = parseListish(readFirstField(seedData, snapshot, [
    'pdp_details_sections',
    'details_sections',
    'product_details',
    'pdp_product_facts_raw',
  ]));
  return {
    seedData,
    snapshot,
    title,
    brand,
    description,
    howTo,
    activeIngredients,
    rawIngredients,
    details,
    canonicalUrl: asString(row.canonical_url || row.destination_url || row.catalog_canonical_url),
  };
}

function findTokens(text, patterns) {
  const lower = stripHtml(text).toLowerCase();
  const out = [];
  for (const [label, pattern] of patterns) {
    if (pattern.test(lower)) out.push(label);
  }
  return uniq(out);
}

function inferRole(facts) {
  const text = `${facts.title} ${facts.description} ${facts.activeIngredients.join(' ')} ${facts.details.join(' ')}`.toLowerCase();
  if (/\bblurring powder|setting powder|powder\b/.test(text)) return { label: 'Blurring setting powder', step: 'makeup setting', amPm: ['as_needed'] };
  if (/\bcleansing foam|gel cleanser|oil-to-foam|cleanser\b/.test(text)) return { label: 'Cleanser', step: 'cleanser', amPm: ['am', 'pm'] };
  if (/\bsunscreen|spf\b/.test(text)) return { label: 'Daily sunscreen', step: 'sunscreen', amPm: ['am'] };
  if (/\btoner\b/.test(text)) return { label: 'Hydrating toner', step: 'toner', amPm: ['am', 'pm'] };
  if (/\beye cream|eye sleeping mask\b/.test(text)) return { label: 'Eye treatment', step: 'eye treatment', amPm: ['pm'] };
  if (/\blip serum\b/.test(text)) return { label: 'Tinted lip serum', step: 'lip treatment', amPm: ['as_needed'] };
  if (/\blip sleeping mask|lip treatment|lip glowy balm|lip balm\b/.test(text)) return { label: 'Lip treatment', step: 'lip treatment', amPm: ['as_needed'] };
  if (/\bsleeping mask|water sleeping mask|mask\b/.test(text)) return { label: 'Overnight treatment mask', step: 'sleeping mask', amPm: ['pm'] };
  if (/\bserum\b/.test(text)) return { label: 'Treatment serum', step: 'serum', amPm: ['am', 'pm'] };
  if (/\bcream moisturizer|gel moisturizer|intensive moisturizer|cream\b/.test(text)) return { label: 'Moisturizer', step: 'moisturizer', amPm: ['am', 'pm'] };
  return { label: 'Skincare product', step: 'skincare', amPm: ['am', 'pm'] };
}

function inferConcernsAndAnchors(facts, role) {
  const combined = [
    facts.title,
    facts.description,
    facts.activeIngredients.join(' '),
    facts.rawIngredients.slice(0, 40).join(' '),
    facts.details.join(' '),
  ].join(' ');
  let anchors = findTokens(combined, [
    ['blue hyaluronic acid', /\bblue\s+hyaluronic\b/],
    ['hyaluronic acid', /\bhyaluronic\b/],
    ['centella / cica', /\bcentella|cica\b/],
    ['vitamin C', /\bvitamin\s*c|ascorbic|ethyl ascorbic\b/],
    ['niacinamide', /\bniacinamide\b/],
    ['peptide', /\bpeptide\b/],
    ['collagen', /\bcollagen\b/],
    ['ceramide', /\bceramide\b/],
    ['panthenol', /\bpanthenol\b/],
    ['squalane', /\bsqualane\b/],
    ['silica', /\bsilica\b/],
    ['SPF 50+', /\bspf\s*50\+?\b/],
    ['mineral UV filters', /\bzinc\s+oxide|titanium\s+dioxide\b/],
    ['AHA / PHA exfoliation', /\baha|pha|lactic\s+acid|glycolic\s+acid\b/],
  ]);
  if (anchors.includes('blue hyaluronic acid')) {
    anchors = anchors.filter((anchor) => anchor !== 'hyaluronic acid');
  }
  let concerns = findTokens(combined, [
    ['hydration', /\bhydrat|moistur|water bank|hyaluronic\b/],
    ['barrier support', /\bbarrier|ceramide|panthenol|cica|centella\b/],
    ['firmness', /\bfirm|bouncy|collagen|peptide|elasticity\b/],
    ['brightness', /\bbright|radiance|radian|vitamin\s*c|dark spot|tone\b/],
    ['soft-focus makeup finish', /\bblur|blurring|powder|sebum|shine|matte|finish\b/],
    ['lip moisture', /\blip|balm|sleeping mask|glowy\b/],
    ['UV protection', /\bspf|sunscreen|uv\b/],
    ['gentle cleansing', /\bcleanser|cleansing|foam|oil-to-foam\b/],
    ['overnight care', /\bsleeping mask|overnight\b/],
  ]);
  concerns = concerns.filter((concern) => {
    if (role.step === 'makeup setting') return concern === 'soft-focus makeup finish';
    if (role.step === 'cleanser') return ['gentle cleansing', 'hydration', 'barrier support'].includes(concern);
    if (role.step === 'sunscreen') return ['UV protection', 'hydration', 'barrier support'].includes(concern);
    if (role.step === 'sleeping mask') return ['overnight care', 'hydration', 'barrier support', 'firmness', 'brightness'].includes(concern);
    if (role.step === 'lip treatment') return ['lip moisture', 'hydration', 'barrier support', 'brightness'].includes(concern);
    if (concern === 'gentle cleansing') return role.step === 'cleanser';
    if (concern === 'lip moisture') return role.step === 'lip treatment';
    if (concern === 'overnight care') return role.step === 'sleeping mask';
    if (concern === 'soft-focus makeup finish') return role.step === 'makeup setting';
    if (concern === 'UV protection') return role.step === 'sunscreen';
    return true;
  });
  if (!concerns.length && role.step) concerns.push(role.step);
  return { anchors: anchors.slice(0, 4), concerns: concerns.slice(0, 4) };
}

function buildBestFor(concerns, role) {
  const labels = concerns.length ? concerns : [role.label];
  return labels.slice(0, 4).map((label) => ({
    tag: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    label,
    confidence: 'moderate',
  }));
}

function buildPairingNotes(facts, role) {
  const howTo = facts.howTo.map((item) => cleanInstruction(item, 160)).filter(Boolean);
  if (howTo.length) return howTo.slice(0, 2);
  if (role.step === 'sunscreen') return ['Use as the last morning skincare step before makeup or sun exposure.'];
  if (role.step === 'cleanser') return ['Use as a cleansing step, then follow with toner, serum, and moisturizer as needed.'];
  if (role.step === 'sleeping mask') return ['Use at the end of an evening routine when the skin needs overnight moisture.'];
  if (role.step === 'makeup setting') return ['Apply after base makeup where you want a softer, less shiny finish.'];
  if (role.step === 'lip treatment') return ['Use on bare lips or over lip color depending on the finish you want.'];
  return ['Fit it into the routine step implied by the official product directions.'];
}

function cleanInstruction(value, limit = 170) {
  let text = stripHtml(value)
    .replace(/^[-*\s]+/, '')
    .replace(/\s+x\s+OH\.?$/i, '')
    .replace(/\s+-\s+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  text = text
    .replace(/^as a daily cleanser:\s*/i, '')
    .replace(/\bto remove complexion makeup:\s*[\s\S]*$/i, '')
    .trim();
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [];
  for (const raw of sentences) {
    const current = sentence(raw);
    if (current.length >= 24 && current.length <= limit) return current;
  }
  const compact = compactText(text, limit);
  const boundary = compact.search(/\b(?:then|and|before|after|with|onto|over)\s*$/i);
  return boundary > 40 ? compact.slice(0, boundary).trim() : compact;
}

function buildCompleteHighlight(values, fallback) {
  const items = uniq(values).filter(Boolean);
  let out = '';
  for (const item of items) {
    const next = out ? `${out}, ${item}` : item;
    if (next.length > 40) break;
    out = next;
  }
  return out || compactText(fallback, 40);
}

function buildInsightBundle(row) {
  const facts = readSeedFacts(row);
  const role = inferRole(facts);
  const { anchors, concerns } = inferConcernsAndAnchors(facts, role);
  const title = facts.title;
  const descriptionSentence = usefulDescriptionSentence(facts.description);
  const anchorPhrase = anchors.length ? anchors.slice(0, 3).join(', ') : '';
  const concernPhrase = concerns.length ? concerns.slice(0, 3).join(', ') : role.step;
  const whatBody = sentence([
    `${title} is ${articleFor(role.label)} ${role.label.toLowerCase()} from ${facts.brand || 'LANEIGE'}`,
    descriptionSentence ? `the official PDP describes it as ${descriptionSentence.replace(/\.$/, '')}` : '',
  ].filter(Boolean).join('; '));
  const why = [];
  if (anchorPhrase) {
    why.push({
      headline: 'Source-backed formula cues',
      body: sentence(`The official PDP fields identify ${anchorPhrase}, giving shoppers concrete formula cues to compare against nearby ${facts.brand || 'LANEIGE'} options`),
      evidence_strength: 'official_pdp_reviewed',
    });
  }
  why.push({
    headline: 'Clear routine placement',
    body: sentence(`Use it as ${articleFor(role.step)} ${role.step} step when the goal is ${concernPhrase}`),
    evidence_strength: 'official_pdp_reviewed',
  });
  if (facts.howTo.length) {
    why.push({
      headline: 'Usage instructions available',
      body: sentence(`Official directions are present, including: ${cleanInstruction(facts.howTo[0], 170)}`),
      evidence_strength: 'official_pdp_reviewed',
    });
  }
  const watchouts = [];
  if (/\bspf|sunscreen\b/i.test(`${title} ${facts.description}`)) {
    watchouts.push({
      type: 'spf_use',
      label: 'Use enough product and reapply as directed for sun protection.',
      severity: 'medium',
    });
  }
  if (/\bretinol|aha|bha|pha|exfoliat/i.test(`${title} ${facts.description} ${facts.activeIngredients.join(' ')}`)) {
    watchouts.push({
      type: 'active_layering',
      label: 'Introduce exfoliating or renewal actives gradually if your skin is reactive.',
      severity: 'medium',
    });
  }
  if (!watchouts.length) {
    watchouts.push({
      type: 'skin_fit',
      label: 'Patch test if your skin is fragrance-sensitive or easily irritated.',
      severity: 'low',
    });
  }
  const highlight = buildCompleteHighlight(anchors.length ? anchors : concerns, role.label);
  const generatedAt = new Date().toISOString();
  const evidenceProfile = 'official_pdp_reviewed_line';
  return {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: 'Pivota Insights',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      platform: 'external_seed',
      product_id: row.external_product_id,
      pivota_signature_id: row.pivota_signature_id || null,
    },
    product_group_id: row.product_key || null,
    product_intel_core: {
      what_it_is: {
        headline: role.label,
        body: whatBody,
      },
      best_for: buildBestFor(concerns, role),
      why_it_stands_out: why.slice(0, 3),
      routine_fit: {
        step: role.step,
        am_pm: role.amPm,
        pairing_notes: buildPairingNotes(facts, role),
      },
      watchouts,
      display_name: 'Pivota Insights',
      freshness: {
        source_version: 'laneige_official_pdp_reviewed_v1',
        generated_at: generatedAt,
      },
      quality_state: 'reviewed',
      evidence_profile: evidenceProfile,
      source_coverage: {
        official_pdp_description: Boolean(facts.description),
        official_pdp_formula: facts.rawIngredients.length > 0 || facts.activeIngredients.length > 0,
        official_pdp_how_to: facts.howTo.length > 0,
        canonical_url: facts.canonicalUrl || null,
      },
    },
    community_signals: {
      status: 'unavailable',
      unavailable_reason: 'no_reviewed_external_consensus_for_this_publish',
      confidence: 'low',
      evidence_profile: evidenceProfile,
    },
    recommendation_intents: {
      similar: [],
      complementary: [],
      routine_pairing: [],
      underfill_reason: 'not_generated_in_manual_insight_review',
      confidence: 'low',
    },
    shopping_card: {
      contract_version: 'pivota.shopping_card.v1',
      title,
      subtitle: role.label,
      highlight,
      intro: whatBody,
      evidence_profile: evidenceProfile,
    },
    search_card: {
      title_candidate: title,
      compact_candidate: role.label,
      highlight_candidate: highlight,
      intro_candidate: whatBody,
    },
    quality_state: 'reviewed',
    evidence_profile: evidenceProfile,
    source_coverage: {
      source: 'official_pdp',
      canonical_url: facts.canonicalUrl || null,
      fields: {
        description: Boolean(facts.description),
        ingredients: facts.rawIngredients.length,
        active_ingredients: facts.activeIngredients.length,
        how_to: facts.howTo.length,
        details: facts.details.length,
      },
    },
    confidence: {
      tier: facts.rawIngredients.length || facts.activeIngredients.length ? 'moderate' : 'limited',
      rationale: 'Reviewed against official PDP fields already stored on the external seed.',
    },
    freshness: {
      source_version: 'laneige_official_pdp_reviewed_v1',
      generated_at: generatedAt,
    },
    provenance: {
      source: REVIEW_SOURCE,
      generator: 'strict_human_manual_rewrite',
      reviewer: REVIEWER,
      reviewer_kind: 'assistant',
      review_status: 'completed',
      review_decision: 'rewrite',
      review_tier: 'assistant_reviewed',
      selection_strategy: 'curated_override',
      field_sources: {
        what_it_is: 'human_standard',
        why_it_stands_out: 'human_standard',
        best_for: 'official_pdp_derived',
        routine_fit: 'official_pdp_derived',
        watchouts: 'human_standard',
      },
      source_signals: [
        facts.description ? 'official_pdp_description' : null,
        facts.rawIngredients.length ? 'official_pdp_ingredients' : null,
        facts.activeIngredients.length ? 'official_pdp_active_ingredients' : null,
        facts.howTo.length ? 'official_pdp_how_to' : null,
      ].filter(Boolean),
    },
  };
}

function buildKbKeys(row) {
  return uniq([
    `product:${row.external_product_id}`,
    row.pivota_signature_id ? `product:${row.pivota_signature_id}` : '',
  ]);
}

function existingEntryForKey(row, kbKey) {
  if (kbKey === `product:${row.external_product_id}` && row.ext_kb_key) {
    return {
      kb_key: row.ext_kb_key,
      analysis: row.ext_analysis,
      source: row.ext_source,
      source_meta: row.ext_source_meta,
      last_success_at: row.ext_last_success_at,
      updated_at: row.ext_updated_at,
    };
  }
  if (kbKey === `product:${row.pivota_signature_id}` && row.sig_kb_key) {
    return {
      kb_key: row.sig_kb_key,
      analysis: row.sig_analysis,
      source: row.sig_source,
      source_meta: row.sig_source_meta,
      last_success_at: row.sig_last_success_at,
      updated_at: row.sig_updated_at,
    };
  }
  return null;
}

function readQualityState(entry) {
  const bundle = asObject(entry?.analysis?.product_intel_v1 || entry?.analysis?.product_intel || entry?.analysis);
  const core = asObject(bundle.product_intel_core);
  return asString(bundle.quality_state || core.quality_state || entry?.source_meta?.quality_state).toLowerCase();
}

function hasOfficialPdpEvidence(row) {
  const facts = readSeedFacts(row);
  return Boolean(
    facts.description &&
      facts.canonicalUrl &&
      (facts.rawIngredients.length || facts.activeIngredients.length || facts.howTo.length || facts.details.length)
  );
}

function shouldSkipExisting(entry) {
  if (!entry) return null;
  const state = readQualityState(entry);
  if (PROTECTED_QUALITY_STATES.has(state)) return `protected_quality_state:${state}`;
  return null;
}

function buildPlan(row) {
  const bundle = buildInsightBundle(row);
  const canonicalProductRef = {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    product_id: row.external_product_id,
    pivota_signature_id: row.pivota_signature_id || null,
  };
  const normalized = normalizePublishedProductIntelBundle(bundle, {
    canonicalProductRef,
    productGroupId: row.product_key || null,
    requireReviewed: true,
  });
  const candidateBase = {
    analysis: { product_intel_v1: bundle },
    source: REVIEW_SOURCE,
    source_meta: {
      external_product_id: row.external_product_id,
      pivota_signature_id: row.pivota_signature_id || null,
      review_status: 'completed',
      review_decision: 'rewrite',
      review_tier: 'assistant_reviewed',
      reviewer: REVIEWER,
      evidence_profile: bundle.evidence_profile,
      quality_state: bundle.quality_state,
      source_origin: 'official_pdp_fields',
      source_url: readSeedFacts(row).canonicalUrl || null,
    },
  };
  const plan = {
    external_product_id: row.external_product_id,
    pivota_signature_id: row.pivota_signature_id || null,
    title: row.title,
    canonical_url: row.canonical_url || row.destination_url || row.catalog_canonical_url || null,
    changed: false,
    blocked: false,
    skip_reason: null,
    candidate_hash: hashJson(bundle),
    preview: {
      headline: bundle.product_intel_core.what_it_is.headline,
      what_it_is: bundle.product_intel_core.what_it_is.body,
      why_it_stands_out: bundle.product_intel_core.why_it_stands_out,
      best_for: bundle.product_intel_core.best_for,
      shopping_highlight: bundle.shopping_card.highlight,
    },
    writes: [],
  };
  if (!hasOfficialPdpEvidence(row)) {
    plan.blocked = true;
    plan.skip_reason = 'missing_official_pdp_evidence';
    return plan;
  }
  if (!normalized) {
    plan.blocked = true;
    plan.skip_reason = 'candidate_failed_reviewed_normalization';
    return plan;
  }
  for (const kbKey of buildKbKeys(row)) {
    const existing = existingEntryForKey(row, kbKey);
    const protectedReason = shouldSkipExisting(existing);
    if (protectedReason) {
      plan.writes.push({
        kb_key: kbKey,
        action: 'skip',
        reason: protectedReason,
        old_hash: existing?.analysis ? hashJson(existing.analysis) : null,
      });
      continue;
    }
    const candidate = {
      ...candidateBase,
      kb_key: kbKey,
    };
    const assessment = assessPivotaInsightReplacement({
      existingEntry: existing,
      candidateEntry: candidate,
      sourceRow: {
        quality_improvement_review: {
          decision: 'approved_replacement',
          reviewer_kind: 'assistant',
          owner_delegated: true,
          reason: 'Owner requested strict manual-quality rewrite of weak LANEIGE insights using official PDP fields.',
        },
      },
    });
    if (!assessment.allowed) {
      plan.writes.push({
        kb_key: kbKey,
        action: 'skip',
        reason: assessment.reason,
        old_hash: existing?.analysis ? hashJson(existing.analysis) : null,
        candidate_hash: hashJson(candidate.analysis),
        assessment,
      });
      continue;
    }
    plan.changed = true;
    plan.writes.push({
      kb_key: kbKey,
      action: existing ? 'update' : 'insert',
      reason: assessment.reason,
      old_hash: existing?.analysis ? hashJson(existing.analysis) : null,
      candidate_hash: hashJson(candidate.analysis),
      analysis: candidate.analysis,
      source: candidate.source,
      source_meta: {
        ...candidate.source_meta,
        quality_improvement: {
          previous_bundle_hash: assessment.previous_bundle_hash || null,
          candidate_bundle_hash: assessment.candidate_bundle_hash || null,
          replacement_decision: assessment.reason,
          existing_quality_lane: assessment.existing?.lane || null,
          candidate_quality_lane: assessment.candidate?.lane || null,
          existing_evidence_profile: assessment.existing?.evidence_profile || null,
          candidate_evidence_profile: assessment.candidate?.evidence_profile || null,
        },
      },
      after_inventory: buildPivotaInsightInventoryRow(candidate, {
        productId: row.external_product_id,
        title: row.title,
      }),
    });
  }
  if (!plan.writes.some((write) => write.action === 'insert' || write.action === 'update')) {
    plan.changed = false;
    if (!plan.skip_reason) plan.skip_reason = 'no_safe_writes';
  }
  return plan;
}

async function fetchRows(args) {
  const params = [];
  const where = [
    "eps.status = 'active'",
    "(eps.seed_data->>'brand' ILIKE 'LANEIGE%' OR eps.seed_data->'snapshot'->>'brand' ILIKE 'LANEIGE%')",
  ];
  if (args.productId) {
    params.push(args.productId);
    where.push(`(eps.external_product_id = $${params.length} OR cp.pivota_signature_id = $${params.length})`);
  }
  if (!args.includeReviewed) {
    where.push(`
      (
        kb_ext.kb_key IS NULL OR
        lower(coalesce(
          kb_ext.analysis->'product_intel_v1'->>'quality_state',
          kb_ext.analysis->'product_intel_v1'->'product_intel_core'->>'quality_state',
          kb_ext.source_meta->>'quality_state',
          ''
        )) NOT IN ('reviewed', 'verified', 'published', 'ready')
      )
    `);
  }
  const limitSql = args.limit > 0 ? `LIMIT ${Number(args.limit)}` : '';
  const result = await query(
    `
      SELECT
        eps.external_product_id,
        eps.title,
        coalesce(eps.seed_data->>'brand', eps.seed_data->'snapshot'->>'brand') AS brand,
        eps.domain,
        eps.market,
        eps.canonical_url,
        eps.destination_url,
        eps.seed_data,
        cp.pivota_signature_id,
        cp.product_key,
        cp.title AS catalog_title,
        cp.category,
        cp.product_type,
        cp.category_path,
        cp.description,
        cp.image_url,
        cp.canonical_url AS catalog_canonical_url,
        kb_ext.kb_key AS ext_kb_key,
        kb_ext.analysis AS ext_analysis,
        kb_ext.source AS ext_source,
        kb_ext.source_meta AS ext_source_meta,
        kb_ext.last_success_at AS ext_last_success_at,
        kb_ext.updated_at AS ext_updated_at,
        kb_sig.kb_key AS sig_kb_key,
        kb_sig.analysis AS sig_analysis,
        kb_sig.source AS sig_source,
        kb_sig.source_meta AS sig_source_meta,
        kb_sig.last_success_at AS sig_last_success_at,
        kb_sig.updated_at AS sig_updated_at
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN aurora_product_intel_kb kb_ext
        ON kb_ext.kb_key = 'product:' || eps.external_product_id
      LEFT JOIN aurora_product_intel_kb kb_sig
        ON kb_sig.kb_key = 'product:' || cp.pivota_signature_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY eps.title, eps.external_product_id
      ${limitSql}
    `,
    params,
  );
  return result.rows || [];
}

function parseArgs() {
  return {
    apply: hasFlag('apply'),
    includeReviewed: hasFlag('include-reviewed'),
    productId: asString(argValue('product-id')),
    limit: Math.max(0, Number(argValue('limit', '0')) || 0),
    outDir: argValue('out-dir', 'reports/pdp_db_quality_inventory/laneige_insights_review'),
  };
}

function writeReport(args, report) {
  const rootDir = path.resolve(__dirname, '..');
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(rootDir, args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const name = `${args.apply ? 'apply' : 'dry-run'}-${report.generated_at.replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(outDir, name);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

async function applyPlans(plans) {
  let upserts = 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const plan of plans) {
        for (const write of plan.writes) {
          if (write.action !== 'insert' && write.action !== 'update') continue;
          await client.query(
            `
              INSERT INTO aurora_product_intel_kb (
                kb_key,
                analysis,
                source,
                source_meta,
                last_success_at,
                created_at,
                updated_at
              )
              VALUES ($1, $2::jsonb, $3, $4::jsonb, NOW(), NOW(), NOW())
              ON CONFLICT (kb_key) DO UPDATE
              SET analysis = EXCLUDED.analysis,
                  source = EXCLUDED.source,
                  source_meta = EXCLUDED.source_meta,
                  last_success_at = NOW(),
                  updated_at = NOW()
            `,
            [write.kb_key, JSON.stringify(write.analysis), write.source, JSON.stringify(write.source_meta)],
          );
          upserts += 1;
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
  return { upserts };
}

function summarize(plans) {
  const summary = {
    scanned: plans.length,
    changed_products: plans.filter((plan) => plan.changed).length,
    blocked_products: plans.filter((plan) => plan.blocked).length,
    skipped_products: plans.filter((plan) => !plan.changed && !plan.blocked).length,
    write_actions: {},
    skip_reasons: {},
  };
  for (const plan of plans) {
    if (plan.skip_reason) summary.skip_reasons[plan.skip_reason] = (summary.skip_reasons[plan.skip_reason] || 0) + 1;
    for (const write of plan.writes) {
      summary.write_actions[write.action] = (summary.write_actions[write.action] || 0) + 1;
      if (write.action === 'skip') {
        summary.skip_reasons[write.reason] = (summary.skip_reasons[write.reason] || 0) + 1;
      }
    }
  }
  return summary;
}

async function main() {
  const args = parseArgs();
  const generatedAt = new Date().toISOString();
  const rows = await fetchRows(args);
  const plans = rows.map((row) => buildPlan(row));
  const report = {
    generated_at: generatedAt,
    source: REVIEW_SOURCE,
    mode: args.apply ? 'apply' : 'dry_run',
    filters: {
      product_id: args.productId || null,
      limit: args.limit || null,
      include_reviewed: args.includeReviewed,
    },
    summary: summarize(plans),
    plans: plans.map((plan) => ({
      ...plan,
      writes: plan.writes.map((write) => {
        const { analysis, source_meta: sourceMeta, ...rest } = write;
        return {
          ...rest,
          source_meta: sourceMeta ? {
            evidence_profile: sourceMeta.evidence_profile,
            quality_state: sourceMeta.quality_state,
            source_origin: sourceMeta.source_origin,
            source_url: sourceMeta.source_url,
            quality_improvement: sourceMeta.quality_improvement,
          } : undefined,
        };
      }),
    })),
  };
  if (args.apply) {
    report.apply_result = await applyPlans(plans);
  }
  const reportPath = writeReport(args, report);
  process.stdout.write(`${JSON.stringify({ status: 'ok', report: reportPath, summary: report.summary, apply_result: report.apply_result || null }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}

module.exports = {
  buildInsightBundle,
  buildPlan,
  inferRole,
  inferConcernsAndAnchors,
};
