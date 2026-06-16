const crypto = require('crypto');

const {
  classifyProductIntelKbRow,
  readProductIntelBundleFromKbRow,
} = require('./externalSeedPdpReadiness');

const AGENT_PRODUCT_CONTEXT_CONTRACT_VERSION = 'pivota.agent_product_context.v1';

const QUALITY_LANES = Object.freeze({
  KEEP: 'keep',
  REPAIR: 'repair',
  REGENERATE: 'regenerate',
  HOLD_FOR_EVIDENCE: 'hold_for_evidence',
  SUPPRESS_PUBLIC: 'suppress_public',
});

const FIXABLE_PRODUCT_INTEL_ISSUES = new Set([
  'missing_card_highlight',
  'ellipsis_or_truncated',
  'what_it_is_too_long',
  'generic_copy_signal',
  'empty_watchouts',
]);

const PROTECTED_QUALITY_STATES = new Set(['verified', 'ready']);
// Tier-G grounded dossiers are decision-grade by construction (graded INCI × reviewed
// Ingredient KB × claim-safety screen) and already serve to agents without per-SKU human
// review (ADR-002 item 9). The PUBLIC quality-lane classifier historically gated on HUMAN
// review only, so a grounded bundle was `not_reviewed` → never `public_ready`. Treating
// 'grounded_verified' as protected lets a grounded bundle reach the public KEEP lane so its
// (FTC-screened) claims can be published as citable structured data. Gated by
// PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED (default OFF) — ship dark; flip per K-beauty pilot.
// See docs/kbeauty_merchant_appearance_enrichment_scope.md.
const PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED || '').trim(),
);
const PROTECTED_EVIDENCE_PROFILES = new Set(
  PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED
    ? ['community_supported', 'grounded_verified']
    : ['community_supported'],
);

const EVIDENCE_PROFILE_RANK = new Map([
  ['missing', 0],
  ['unknown', 0],
  ['seller_only_fallback', 0],
  ['seller_only', 1],
  ['limited', 1],
  ['seller_plus_formula', 2],
  ['seller_plus_reviews', 3],
  ['official_pdp_seed', 3],
  ['official_pdp_reviewed_line', 3],
  // Tier-G grounded dossier (graded INCI × reviewed Ingredient KB) is decision-grade
  // by construction — ranks with the reviewed tiers, above any positioning blurb, so
  // it is never treated as a downgrade vs a seller-tier bundle (dossier authoring
  // engine, Phase 1; see docs/dossier-authoring-engine-plan.md).
  ['grounded_verified', 4],
  ['pivota_reviewed', 4],
  ['community_supported', 5],
]);

const COMMERCE_TRUTH_CLAIM_RE =
  /(?:[$€£¥]\s*\d|\b\d+(?:\.\d{2})?\s*(?:usd|eur|gbp|jpy|cny|rmb)\b|\bsave\s+\d{1,3}%|\b\d{1,3}%\s*(?:off|savings?)\b|\b(?:discount|sale|clearance|promo|promotion)\b|\b(?:in stock|out of stock|sold out|ships?|shipping|checkout|buy now|add to cart)\b)/i;

const LANE_PRIORITY = new Map([
  [QUALITY_LANES.REGENERATE, 90],
  [QUALITY_LANES.REPAIR, 70],
  [QUALITY_LANES.SUPPRESS_PUBLIC, 55],
  [QUALITY_LANES.HOLD_FOR_EVIDENCE, 45],
  [QUALITY_LANES.KEEP, 0],
]);

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

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function lowerText(value) {
  return stripHtml(value).toLowerCase();
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

function cloneJson(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function readBundleFromKbLike(row) {
  return readProductIntelBundleFromKbRow(row) || null;
}

function productIdFromKbKey(kbKey) {
  const text = asString(kbKey);
  return text.startsWith('product:') ? text.slice('product:'.length) : text;
}

function classifyKbLike(row, options = {}) {
  if (row && Array.isArray(row.issues) && asString(row.status)) return row;
  return classifyProductIntelKbRow(row, {
    productId: options.productId || productIdFromKbKey(row?.kb_key || row?.kbKey),
  });
}

function readQualityState(classification, bundle = null, sourceMeta = null) {
  return lowerText(
    classification?.quality_state ||
      bundle?.quality_state ||
      bundle?.product_intel_core?.quality_state ||
      sourceMeta?.quality_state,
  );
}

function readEvidenceProfile(classification, bundle = null, sourceMeta = null) {
  return lowerText(
    classification?.evidence_profile ||
      bundle?.evidence_profile ||
      bundle?.product_intel_core?.evidence_profile ||
      sourceMeta?.evidence_profile,
  );
}

function readReviewTier(bundle = null, sourceMeta = null) {
  return lowerText(
    bundle?.provenance?.review_tier ||
      bundle?.review_tier ||
      sourceMeta?.review_tier ||
      sourceMeta?.review_contract?.review_tier,
  );
}

function evidenceProfileRank(profile) {
  const key = lowerText(profile) || 'unknown';
  return EVIDENCE_PROFILE_RANK.has(key) ? EVIDENCE_PROFILE_RANK.get(key) : 1;
}

function isProtectedPivotaInsight(rowOrClassification, options = {}) {
  const classification = classifyKbLike(rowOrClassification, options);
  const bundle = options.bundle || readBundleFromKbLike(rowOrClassification);
  const sourceMeta = asObject(rowOrClassification?.source_meta || rowOrClassification?.kb_source_meta);
  const qualityState = readQualityState(classification, bundle, sourceMeta);
  const evidenceProfile = readEvidenceProfile(classification, bundle, sourceMeta);
  const reviewTier = readReviewTier(bundle, sourceMeta);

  return Boolean(
    classification.high_quality_ready ||
      PROTECTED_QUALITY_STATES.has(qualityState) ||
      PROTECTED_EVIDENCE_PROFILES.has(evidenceProfile) ||
      reviewTier === 'strict_human',
  );
}

function isKeepQualityInsight(classification, bundle = null, sourceMeta = null) {
  const qualityState = readQualityState(classification, bundle, sourceMeta);
  const evidenceProfile = readEvidenceProfile(classification, bundle, sourceMeta);
  return Boolean(
    classification.high_quality_ready ||
      PROTECTED_QUALITY_STATES.has(qualityState) ||
      PROTECTED_EVIDENCE_PROFILES.has(evidenceProfile),
  );
}

function classifyPivotaInsightQualityLane(rowOrClassification, options = {}) {
  const classification = classifyKbLike(rowOrClassification, options);
  const bundle = options.bundle || readBundleFromKbLike(rowOrClassification);
  const sourceMeta = asObject(rowOrClassification?.source_meta || rowOrClassification?.kb_source_meta);
  const commerceTruthIssue = Boolean(bundle && hasCommerceTruthClaim(bundle));
  const issues = Array.from(
    new Set([
      ...asArray(classification.issues),
      ...(commerceTruthIssue ? ['commerce_truth_claim'] : []),
    ]),
  );
  const blockingIssues = Array.from(
    new Set([
      ...asArray(classification.blocking_issues),
      ...(commerceTruthIssue ? ['commerce_truth_claim'] : []),
    ]),
  );
  const evidenceProfile = readEvidenceProfile(classification);
  const protectedInsight = isProtectedPivotaInsight(rowOrClassification, {
    ...options,
    bundle,
  });
  const hasOfficialSource = Boolean(
    options.hasOfficialSource || options.officialUrl || options.canonicalUrl || options.sourceUrl,
  );
  let lane = QUALITY_LANES.REGENERATE;
  let reason = 'requires_regeneration';

  if (commerceTruthIssue) {
    lane = QUALITY_LANES.REPAIR;
    reason = 'commerce_truth_claim_requires_mainline_source';
  } else if (isKeepQualityInsight(classification, bundle, sourceMeta)) {
    lane = QUALITY_LANES.KEEP;
    reason = 'protected_good_content';
  } else if (classification.status === 'missing_kb' || issues.includes('missing_kb')) {
    lane = hasOfficialSource ? QUALITY_LANES.REGENERATE : QUALITY_LANES.HOLD_FOR_EVIDENCE;
    reason = hasOfficialSource ? 'missing_kb_with_source_available' : 'missing_kb_without_source';
  } else if (issues.includes('kb_error') || issues.includes('missing_bundle')) {
    lane = QUALITY_LANES.REGENERATE;
    reason = issues.includes('kb_error') ? 'kb_error' : 'missing_bundle';
  } else if (evidenceProfile === 'seller_only_fallback') {
    lane = QUALITY_LANES.SUPPRESS_PUBLIC;
    reason = 'seller_only_fallback_not_public';
  } else if (
    classification.displayable &&
    evidenceProfile === 'seller_only' &&
    !blockingIssues.length
  ) {
    lane = QUALITY_LANES.SUPPRESS_PUBLIC;
    reason = 'seller_only_agent_readable_public_needs_stronger_evidence';
  } else if (
    classification.displayable &&
    classification.human_reviewed &&
    ((!blockingIssues.length || blockingIssues.every((issue) => FIXABLE_PRODUCT_INTEL_ISSUES.has(issue))) ||
      issues.some((issue) => issue.startsWith('quality_')) ||
      issues.includes('seller_only_evidence'))
  ) {
    lane = QUALITY_LANES.REPAIR;
    reason = 'reviewed_displayable_with_fixable_quality_issues';
  } else if (!classification.displayable && !hasOfficialSource) {
    lane = QUALITY_LANES.HOLD_FOR_EVIDENCE;
    reason = 'not_displayable_without_source';
  }

  const priority = (LANE_PRIORITY.get(lane) || 0) + Math.min(20, blockingIssues.length * 5);
  return {
    lane,
    reason,
    priority,
    agent_readable: [QUALITY_LANES.KEEP, QUALITY_LANES.REPAIR, QUALITY_LANES.SUPPRESS_PUBLIC].includes(lane),
    public_ready: lane === QUALITY_LANES.KEEP && classification.displayable,
    protected: protectedInsight,
    issues,
    blocking_issues: blockingIssues,
    quality_state: readQualityState(classification),
    evidence_profile: evidenceProfile || 'unknown',
  };
}

function inferConfidenceTier(bundle) {
  const qualityState = readQualityState(null, bundle);
  const evidenceProfile = readEvidenceProfile(null, bundle);
  if (qualityState === 'verified' || evidenceProfile === 'community_supported') return 'high';
  if (qualityState === 'reviewed' && evidenceProfile !== 'seller_only') return 'moderate';
  return 'limited';
}

function compactText(value, limit = 320) {
  const text = stripHtml(value);
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

function itemText(item) {
  if (typeof item === 'string') return compactText(item);
  const source = asObject(item);
  return compactText([source.headline, source.label, source.body, source.tag].filter(Boolean).join(' - '));
}

function collectBundleTexts(bundle) {
  const source = asObject(bundle);
  const core = asObject(source.product_intel_core);
  const texts = [
    core.what_it_is?.headline,
    core.what_it_is?.body,
    source.shopping_card?.subtitle,
    source.shopping_card?.highlight,
    source.shopping_card?.intro,
    source.search_card?.compact_candidate,
    source.search_card?.highlight_candidate,
    source.search_card?.intro_candidate,
  ];
  for (const item of asArray(core.why_it_stands_out)) texts.push(itemText(item));
  for (const item of asArray(core.best_for)) texts.push(itemText(item));
  for (const item of asArray(core.watchouts)) texts.push(itemText(item));
  return texts.map(stripHtml).filter(Boolean);
}

function hasCommerceTruthClaim(bundle) {
  return collectBundleTexts(bundle).some((text) => COMMERCE_TRUTH_CLAIM_RE.test(text));
}

function buildAgentProductContext(bundle, options = {}) {
  const source = asObject(bundle);
  const core = asObject(source.product_intel_core);
  const whatItIs = compactText(core.what_it_is?.body || source.what_it_is?.body);
  const standouts = asArray(core.why_it_stands_out).map(itemText).filter(Boolean).slice(0, 4);
  const bestFor = asArray(core.best_for).map(itemText).filter(Boolean).slice(0, 5);
  const watchouts = asArray(core.watchouts).map(itemText).filter(Boolean).slice(0, 5);
  const unknowns = [];
  if (!whatItIs) unknowns.push('what_it_is');
  if (!standouts.length) unknowns.push('why_it_stands_out');
  if (!bestFor.length) unknowns.push('best_for');
  if (!watchouts.length) unknowns.push('watchouts');

  const evidenceProfile = readEvidenceProfile(null, source) || 'seller_only';
  const qualityState = readQualityState(null, source) || 'limited';
  return {
    contract_version: AGENT_PRODUCT_CONTEXT_CONTRACT_VERSION,
    generated_from: source.contract_version || 'pivota.product_intel.v1',
    confidence_tier: options.confidenceTier || inferConfidenceTier(source),
    source_tier: evidenceProfile,
    quality_state: qualityState,
    facts: {
      what_it_is: whatItIs || null,
      why_it_stands_out: standouts,
      best_for: bestFor,
      watchouts,
    },
    unknowns,
    guardrails: {
      no_price_or_availability_claims: true,
      commerce_truth_source: 'commerce_mainline_only',
      public_external_claims_require_review: true,
      seller_only_public_consensus_allowed: evidenceProfile !== 'seller_only',
    },
  };
}

function ensureAgentContextOnBundle(bundle, options = {}) {
  const next = cloneJson(bundle) || {};
  const existing = asObject(next.agent_context || next.agentContext);
  if (existing.contract_version === AGENT_PRODUCT_CONTEXT_CONTRACT_VERSION) return next;
  next.agent_context = buildAgentProductContext(next, options);
  return next;
}

function readReplacementApproval(sourceRow, candidateBundle) {
  const review = asObject(
    sourceRow?.quality_improvement_review ||
      sourceRow?.replacement_review ||
      candidateBundle?.quality_improvement_review ||
      candidateBundle?.provenance?.quality_improvement_review,
  );
  const decision = lowerText(review.decision || review.review_decision || review.status);
  const reviewerKind = lowerText(review.reviewer_kind || review.reviewerKind);
  const reason = asString(review.reason || review.rationale || review.notes);
  const ownerDelegated = Boolean(
    review.owner_delegated ||
      review.ownerDelegated ||
      review.owner_delegated_to_assistant_reviewer ||
      review.owner_delegated_review ||
      /owner[-_\s]?delegated/i.test(asString(review.approval_basis || review.approvalBasis)),
  );
  const approvedHuman =
    decision === 'approved_replacement' && reviewerKind === 'human' && Boolean(reason);
  const approvedOwnerDelegatedAssistant =
    decision === 'approved_replacement' &&
    reviewerKind === 'assistant' &&
    ownerDelegated &&
    Boolean(reason);
  return {
    approved: approvedHuman || approvedOwnerDelegatedAssistant,
    decision,
    reviewer_kind: reviewerKind,
    reason,
    owner_delegated: ownerDelegated,
    approval_kind: approvedHuman
      ? 'human'
      : approvedOwnerDelegatedAssistant
        ? 'owner_delegated_assistant'
        : '',
  };
}

function buildQualitySnapshot(rowOrClassification, options = {}) {
  const classification = classifyKbLike(rowOrClassification, options);
  const lane = classifyPivotaInsightQualityLane(rowOrClassification, options);
  const bundle = options.bundle || readBundleFromKbLike(rowOrClassification);
  const sourceMeta = asObject(rowOrClassification?.source_meta || rowOrClassification?.kb_source_meta);
  const issues = Array.from(
    new Set([
      ...asArray(classification.issues),
      ...(bundle && hasCommerceTruthClaim(bundle) ? ['commerce_truth_claim'] : []),
    ]),
  );
  const blockingIssues = Array.from(
    new Set([
      ...asArray(classification.blocking_issues),
      ...(bundle && hasCommerceTruthClaim(bundle) ? ['commerce_truth_claim'] : []),
    ]),
  );
  return {
    lane: lane.lane,
    reason: lane.reason,
    priority: lane.priority,
    protected: lane.protected,
    displayable: Boolean(classification.displayable),
    high_quality_ready: Boolean(classification.high_quality_ready),
    human_reviewed: Boolean(classification.human_reviewed),
    issues,
    blocking_issues: blockingIssues,
    quality_state: readQualityState(classification, bundle, sourceMeta) || 'unknown',
    evidence_profile: readEvidenceProfile(classification, bundle, sourceMeta) || 'unknown',
    evidence_rank: evidenceProfileRank(readEvidenceProfile(classification, bundle, sourceMeta)),
    review_tier: readReviewTier(bundle, sourceMeta) || 'unknown',
  };
}

function qualitySeverity(snapshot) {
  return (LANE_PRIORITY.get(snapshot.lane) || 0) + Math.min(20, asArray(snapshot.blocking_issues).length * 5);
}

function assessPivotaInsightReplacement({ existingEntry = null, candidateEntry = null, sourceRow = null } = {}) {
  const candidateBundle = readBundleFromKbLike(candidateEntry);
  if (!candidateBundle) {
    return {
      allowed: false,
      reason: 'candidate_missing_product_intel_bundle',
    };
  }

  const candidate = buildQualitySnapshot(candidateEntry);
  const candidateHash = hashJson(candidateBundle);
  if (!candidate.displayable || candidate.blocking_issues.length) {
    return {
      allowed: false,
      reason: 'candidate_not_publish_quality_ready',
      candidate,
      candidate_bundle_hash: candidateHash,
    };
  }

  const existingBundle = readBundleFromKbLike(existingEntry);
  if (!existingBundle) {
    return {
      allowed: true,
      reason: 'new_product_intel_bundle',
      candidate,
      candidate_bundle_hash: candidateHash,
    };
  }

  const existing = buildQualitySnapshot(existingEntry);
  const existingHash = hashJson(existingBundle);
  const replacementApproval = readReplacementApproval(sourceRow, candidateBundle);
  if (existing.protected && !replacementApproval.approved) {
    return {
      allowed: false,
      reason: 'protected_existing_bundle_requires_explicit_human_replacement_review',
      existing,
      candidate,
      previous_bundle_hash: existingHash,
      candidate_bundle_hash: candidateHash,
    };
  }

  if (candidate.evidence_rank < existing.evidence_rank && !replacementApproval.approved) {
    return {
      allowed: false,
      reason: 'candidate_downgrades_evidence_profile',
      existing,
      candidate,
      previous_bundle_hash: existingHash,
      candidate_bundle_hash: candidateHash,
    };
  }

  if (qualitySeverity(candidate) > qualitySeverity(existing) && !replacementApproval.approved) {
    return {
      allowed: false,
      reason: 'candidate_downgrades_quality_lane',
      existing,
      candidate,
      previous_bundle_hash: existingHash,
      candidate_bundle_hash: candidateHash,
    };
  }

  return {
    allowed: true,
    reason: replacementApproval.approved
      ? replacementApproval.approval_kind === 'owner_delegated_assistant'
        ? 'explicit_owner_delegated_assistant_replacement_review'
        : 'explicit_human_replacement_review'
      : 'candidate_not_lower_quality',
    existing,
    candidate,
    previous_bundle_hash: existingHash,
    candidate_bundle_hash: candidateHash,
    previous_source: asString(existingEntry.source || existingEntry.kb_source),
    previous_source_meta: asObject(existingEntry.source_meta || existingEntry.kb_source_meta),
    previous_last_success_at: asString(existingEntry.last_success_at || existingEntry.kb_last_success_at),
    previous_updated_at: asString(existingEntry.updated_at || existingEntry.kb_updated_at),
    replacement_review: replacementApproval.approved ? replacementApproval : null,
  };
}

function stampReplacementProvenance(entry, assessment) {
  const next = cloneJson(entry) || {};
  const bundle = readBundleFromKbLike(next);
  if (!bundle) return next;
  const qualityImprovement = {
    previous_bundle_hash: assessment.previous_bundle_hash || null,
    candidate_bundle_hash: assessment.candidate_bundle_hash || null,
    previous_source: assessment.previous_source || null,
    previous_source_meta: assessment.previous_source_meta || null,
    previous_last_success_at: assessment.previous_last_success_at || null,
    previous_updated_at: assessment.previous_updated_at || null,
    existing_quality_lane: assessment.existing?.lane || null,
    candidate_quality_lane: assessment.candidate?.lane || null,
    existing_evidence_profile: assessment.existing?.evidence_profile || null,
    candidate_evidence_profile: assessment.candidate?.evidence_profile || null,
    replacement_decision: assessment.reason,
  };
  bundle.provenance = {
    ...(bundle.provenance || {}),
    quality_improvement: qualityImprovement,
  };
  next.analysis = {
    ...(next.analysis || {}),
    product_intel_v1: bundle,
  };
  next.source_meta = {
    ...(next.source_meta || {}),
    quality_improvement: qualityImprovement,
  };
  return next;
}

function buildPivotaInsightInventoryRow(row, options = {}) {
  const bundle = readBundleFromKbLike(row);
  const classification = classifyKbLike(row, options);
  const lane = classifyPivotaInsightQualityLane(row, { ...options, bundle });
  const productId = options.productId || productIdFromKbKey(row?.kb_key || row?.kbKey);
  return {
    product_id: productId,
    kb_key: asString(row?.kb_key || row?.kbKey),
    source: asString(row?.source || row?.kb_source),
    updated_at: asString(row?.updated_at || row?.kb_updated_at),
    last_success_at: asString(row?.last_success_at || row?.kb_last_success_at),
    title: asString(options.title || row?.title),
    canonical_url: asString(options.canonicalUrl || options.canonical_url || row?.canonical_url),
    bundle_hash: bundle ? hashJson(bundle) : '',
    ...buildQualitySnapshot(row, { ...options, bundle }),
    agent_readable: lane.agent_readable,
    public_ready: lane.public_ready,
  };
}

function increment(map, key) {
  const normalized = asString(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + 1;
}

function topEntries(map, limit = 25) {
  return Object.entries(map || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function summarizePivotaInsightInventory(rows) {
  const summary = {
    scanned: rows.length,
    lanes: {},
    issues: {},
    blocking_issues: {},
    quality_state: {},
    evidence_profile: {},
    protected: 0,
    high_quality_ready: 0,
    agent_readable: 0,
    public_ready: 0,
  };
  for (const row of rows) {
    increment(summary.lanes, row.lane);
    increment(summary.quality_state, row.quality_state);
    increment(summary.evidence_profile, row.evidence_profile);
    if (row.protected) summary.protected += 1;
    if (row.high_quality_ready) summary.high_quality_ready += 1;
    if (row.agent_readable) summary.agent_readable += 1;
    if (row.public_ready) summary.public_ready += 1;
    for (const issue of asArray(row.issues)) increment(summary.issues, issue);
    for (const issue of asArray(row.blocking_issues)) increment(summary.blocking_issues, issue);
  }
  return {
    ...summary,
    lanes: topEntries(summary.lanes, 10),
    issues: topEntries(summary.issues, 30),
    blocking_issues: topEntries(summary.blocking_issues, 30),
    quality_state: topEntries(summary.quality_state, 20),
    evidence_profile: topEntries(summary.evidence_profile, 20),
  };
}

module.exports = {
  AGENT_PRODUCT_CONTEXT_CONTRACT_VERSION,
  QUALITY_LANES,
  assessPivotaInsightReplacement,
  buildAgentProductContext,
  buildPivotaInsightInventoryRow,
  classifyPivotaInsightQualityLane,
  ensureAgentContextOnBundle,
  hashJson,
  hasCommerceTruthClaim,
  isProtectedPivotaInsight,
  stampReplacementProvenance,
  summarizePivotaInsightInventory,
};
