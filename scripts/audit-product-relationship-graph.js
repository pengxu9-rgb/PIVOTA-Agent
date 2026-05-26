#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  PRICE_FRESHNESS_MS,
  validateRelationshipEdge,
  __internal: relationshipInternals,
} = require('../src/auroraBff/productRelationshipGraph');

const ALTERNATIVE_RELATION_TYPES = new Set(['dupe', 'competitive_alternative']);
const SOCIAL_CLAIM_PATTERN = /\b(?:tiktok|tik\s*tok|instagram|insta|creator|influencer|viral|social proof|ugc|testimonial|celebrity|raved about|hyped|trending)\b/i;
const SOCIAL_SOURCE_SUPPORT_PATTERN = /\b(?:social|creator|influencer|tiktok|tik\s*tok|instagram|ugc|review|reviews|testimonial|press|editorial|citation|source)\b/i;

const UNSUPPORTED_CLAIM_PATTERNS = [
  { id: 'identical_formula', pattern: /\bidentical\s+formula\b/i },
  { id: 'cure_acne', pattern: /\bcures?\s+acne\b/i },
  { id: 'acne_cure', pattern: /\bacne\s+cures?\b/i },
  { id: 'wrinkle_reversal', pattern: /\bwrinkle\s+reversal\b/i },
  { id: 'treats_eczema', pattern: /\btreats?\s+eczema\b/i },
  { id: 'fda_approved', pattern: /\bfda[-\s]?approved\b/i },
  { id: 'dermatologist_endorsed', pattern: /\bdermatologist[-\s]+endorsed\b/i },
];

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return toNumberOrNull(
      value.amount ??
        value.value ??
        value.price ??
        value.min ??
        value.min_price ??
        value.minPrice ??
        value.sale_price ??
        value.salePrice,
    );
  }
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function argValue(args, name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function resolvePathMaybeRelative(targetPath, cwd = process.cwd()) {
  const normalized = normalizeString(targetPath);
  if (!normalized) return '';
  return path.isAbsolute(normalized) ? normalized : path.join(cwd, normalized);
}

function readReportFile(reportPath) {
  const resolved = resolvePathMaybeRelative(reportPath);
  if (!resolved) {
    throw new Error('missing --report <path>');
  }
  const body = fs.readFileSync(resolved, 'utf8').trim();
  if (!body) {
    throw new Error(`empty report file: ${resolved}`);
  }
  return JSON.parse(body);
}

function writeJsonFile(targetPath, payload) {
  const resolved = resolvePathMaybeRelative(targetPath);
  if (!resolved) return;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeTextFile(targetPath, body) {
  const resolved = resolvePathMaybeRelative(targetPath);
  if (!resolved) return;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function extractEdges(report) {
  if (Array.isArray(report)) return report;
  const obj = ensureObject(report);
  return firstArray(
    obj.edges,
    obj.product_relationship_edges,
    obj.relationship_edges,
    obj.rows,
    ensureObject(obj.data).edges,
    ensureObject(obj.report).edges,
  );
}

function extractReviewPackets(report) {
  const obj = ensureObject(report);
  return firstArray(
    obj.review_packets,
    obj.reviewPackets,
    ensureObject(obj.data).review_packets,
    ensureObject(obj.report).review_packets,
  );
}

function extractSummary(report) {
  const obj = ensureObject(report);
  return ensureObject(obj.summary || ensureObject(obj.data).summary || ensureObject(obj.report).summary);
}

function normalizeSourceRefs(edge) {
  if (relationshipInternals && typeof relationshipInternals.normalizeSourceRefs === 'function') {
    return relationshipInternals.normalizeSourceRefs(edge.source_refs || edge.sourceRefs);
  }
  return asArray(edge.source_refs || edge.sourceRefs).filter(Boolean);
}

function sourceRefsText(edge) {
  return normalizeSourceRefs(edge)
    .map((ref) => {
      if (typeof ref === 'string') return ref;
      if (!ref || typeof ref !== 'object') return '';
      return [ref.type, ref.source_type, ref.source, ref.name, ref.label, ref.title, ref.url, ref.href]
        .map((item) => normalizeString(item, 500))
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean)
    .join(' ');
}

function hasOnPageRelatedSource(edge) {
  return normalizeSourceRefs(edge).some((ref) => {
    const type = normalizeLower(typeof ref === 'string' ? ref : ref.type || ref.source_type || ref.source, 160);
    const name = normalizeLower(typeof ref === 'string' ? '' : ref.name || ref.label || ref.title, 160);
    return (
      type === 'on_page_related' ||
      type === 'on-page-related' ||
      /(?:^|[_\s-])on[_\s-]?page[_\s-]?related(?:$|[_\s-])/.test(type) ||
      /(?:^|[_\s-])pdp[_\s-]?related(?:$|[_\s-])/.test(type) ||
      /on[_\s-]?page\s+related/.test(name)
    );
  });
}

function edgeIdentity(edge) {
  return [
    normalizeLower(edge.market || 'US', 24),
    normalizeLower(edge.anchor_type || edge.anchorType, 24),
    normalizeLower(edge.anchor_ref || edge.anchorRef, 260),
    normalizeLower(edge.candidate_product_ref || edge.candidateProductRef, 260),
    normalizeLower(edge.relation_type || edge.relationType, 64),
  ].join('|');
}

function candidatePrice(edge) {
  const price = ensureObject(edge.price_evidence || edge.priceEvidence);
  const candidate = ensureObject(edge.candidate_snapshot || edge.candidateSnapshot);
  return toNumberOrNull(
    price.candidate_price_amount ??
      price.candidatePriceAmount ??
      price.price_amount ??
      price.priceAmount ??
      candidate.price ??
      candidate.price_amount ??
      candidate.priceAmount ??
      candidate.sale_price ??
      candidate.salePrice,
  );
}

function priceObservedAt(edge) {
  if (relationshipInternals && typeof relationshipInternals.getPriceObservedAt === 'function') {
    return relationshipInternals.getPriceObservedAt(edge);
  }
  const price = ensureObject(edge.price_evidence || edge.priceEvidence);
  const value = price.candidate_price_observed_at ?? price.candidatePriceObservedAt ?? price.observed_at ?? price.observedAt;
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function dupeFreshPriceIssues(edge, nowMs) {
  if (edge.relation_type !== 'dupe') return [];
  const issues = [];
  if (candidatePrice(edge) == null) issues.push('dupe_candidate_price_missing');
  const observedAt = priceObservedAt(edge);
  if (!observedAt) {
    issues.push('dupe_price_observed_at_missing');
  } else if (nowMs - new Date(observedAt).getTime() > PRICE_FRESHNESS_MS) {
    issues.push('dupe_price_stale');
  }
  return issues;
}

function expiredApprovedIssue(edge, nowMs) {
  if (edge.review_status !== 'approved') return false;
  if (!edge.expires_at) return false;
  const expiresMs = new Date(edge.expires_at).getTime();
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

function missingRequiredContext(edge) {
  const missing = [];
  if (!asArray(edge.category_taxonomy || edge.categoryTaxonomy).some((item) => normalizeString(item))) {
    missing.push('category_taxonomy');
  }
  if (!normalizeString(edge.use_case || edge.useCase, 240)) {
    missing.push('use_case');
  }
  if (!normalizeSourceRefs(edge).length) {
    missing.push('source_refs');
  }
  return missing;
}

function collectStrings(value, pathPrefix, out, depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = normalizeString(value, 2000);
    if (text) out.push({ path: pathPrefix, text });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => collectStrings(item, `${pathPrefix}[${idx}]`, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, pathPrefix ? `${pathPrefix}.${key}` : key, out, depth + 1);
    }
  }
  return out;
}

function claimTextFragments(edge) {
  const fragments = [];
  const candidate = ensureObject(edge.candidate_snapshot || edge.candidateSnapshot);
  const anchor = ensureObject(edge.anchor_snapshot || edge.anchorSnapshot);
  const candidateClaimFields = [
    'description',
    'short_description',
    'long_description',
    'marketing_copy',
    'claims',
    'claim',
    'benefits',
    'highlights',
    'reason',
    'reasons',
    'why',
  ];
  const anchorClaimFields = ['description', 'claims', 'benefits'];

  collectStrings(edge.why_candidate || edge.whyCandidate, 'why_candidate', fragments);
  collectStrings(edge.tradeoffs, 'tradeoffs', fragments);
  collectStrings(edge.watchouts, 'watchouts', fragments);
  collectStrings(edge.use_case || edge.useCase, 'use_case', fragments);
  for (const field of candidateClaimFields) {
    if (candidate[field] != null) collectStrings(candidate[field], `candidate_snapshot.${field}`, fragments);
  }
  for (const field of anchorClaimFields) {
    if (anchor[field] != null) collectStrings(anchor[field], `anchor_snapshot.${field}`, fragments);
  }
  return fragments;
}

function hasSupportingSocialSource(edge) {
  return SOCIAL_SOURCE_SUPPORT_PATTERN.test(sourceRefsText(edge));
}

function excerpt(text, max = 180) {
  const normalized = normalizeString(text, 2000).replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function auditUnsupportedClaims(edge, index) {
  const findings = [];
  const edgeId = normalizeString(edge.id || edge.edge_id || edge.edgeId, 160);
  const fragments = claimTextFragments(edge);
  const socialSupported = hasSupportingSocialSource(edge);

  for (const fragment of fragments) {
    for (const { id, pattern } of UNSUPPORTED_CLAIM_PATTERNS) {
      if (!pattern.test(fragment.text)) continue;
      findings.push({
        index,
        edge_id: edgeId || null,
        claim_id: id,
        path: fragment.path,
        text: excerpt(fragment.text),
      });
    }
    if (SOCIAL_CLAIM_PATTERN.test(fragment.text) && !socialSupported) {
      findings.push({
        index,
        edge_id: edgeId || null,
        claim_id: 'unsupported_social_proof',
        path: fragment.path,
        text: excerpt(fragment.text),
      });
    }
  }

  return findings;
}

function zeroGate(name, metric, sampleCount = 0) {
  return {
    name,
    status: metric === 0 ? 'pass' : 'fail',
    metric,
    threshold: 0,
    sample_count: sampleCount,
  };
}

function thresholdGate(name, metric, threshold, unit = 'count') {
  if (metric == null || threshold == null || !Number.isFinite(Number(metric)) || !Number.isFinite(Number(threshold))) {
    return {
      name,
      status: 'not_evaluable',
      metric: metric == null ? null : metric,
      threshold: threshold == null ? null : threshold,
      unit,
    };
  }
  return {
    name,
    status: Number(metric) >= Number(threshold) ? 'pass' : 'fail',
    metric,
    threshold,
    unit,
  };
}

function findThreshold(report, names) {
  const obj = ensureObject(report);
  const summary = extractSummary(report);
  const containers = [
    summary,
    ensureObject(summary.thresholds),
    ensureObject(summary.acceptance_thresholds),
    ensureObject(summary.pilot_acceptance),
    ensureObject(summary.pilot_acceptance_thresholds),
    ensureObject(obj.thresholds),
    ensureObject(obj.acceptance_thresholds),
    ensureObject(obj.pilot_acceptance),
    ensureObject(obj.pilot_acceptance_thresholds),
  ];

  for (const container of containers) {
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(container, name)) {
        const value = toNumberOrNull(container[name]);
        if (value != null) return value;
      }
    }
  }
  return null;
}

function normalizePercentageThreshold(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function isApprovedFresh(edge, validation, nowMs) {
  if (edge.review_status !== 'approved') return false;
  if (!validation || validation.ok !== true) return false;
  if (expiredApprovedIssue(edge, nowMs)) return false;
  return true;
}

function computePilotAcceptance(report, rows, nowMs) {
  const summary = extractSummary(report);
  const edgeRows = Array.isArray(rows) ? rows : [];
  const anchorCount = toNumberOrNull(
    summary.anchor_count ??
      summary.anchors_processed ??
      summary.anchors_processed_count ??
      summary.processed_anchor_count,
  );
  const reviewStatusCounts = {};
  for (const row of edgeRows) {
    const status = normalizeLower(row.edge.review_status || 'unknown', 40) || 'unknown';
    reviewStatusCounts[status] = Number(reviewStatusCounts[status] || 0) + 1;
  }

  const approvedAlternativeAnchors = new Set();
  let approvedNicheSpecialistCount = 0;
  for (const row of edgeRows) {
    const edge = row.edge;
    if (!isApprovedFresh(edge, row.validation, nowMs)) continue;
    if (ALTERNATIVE_RELATION_TYPES.has(edge.relation_type)) {
      approvedAlternativeAnchors.add(edge.anchor_ref);
    }
    if (edge.relation_type === 'niche_specialist') {
      approvedNicheSpecialistCount += 1;
    }
  }

  const approvedAlternativePercentage = anchorCount && anchorCount > 0
    ? Number(((approvedAlternativeAnchors.size / anchorCount) * 100).toFixed(2))
    : null;

  const anchorsProcessedThreshold = findThreshold(report, [
    'min_anchors_processed',
    'anchors_processed_min',
    'min_anchor_count',
    'anchor_count_min',
  ]) ?? (anchorCount != null ? 1 : null);
  const approvedAlternativeThreshold = normalizePercentageThreshold(findThreshold(report, [
    'min_approved_alternative_percentage',
    'approved_alternative_percentage_min',
    'min_anchors_with_approved_alternative_percentage',
    'anchors_with_approved_alternative_percentage_min',
    'min_approved_alternative_anchor_percentage',
    'approved_alternative_anchor_percentage_min',
  ]));
  const approvedNicheSpecialistThreshold = findThreshold(report, [
    'min_approved_niche_specialist_count',
    'approved_niche_specialist_count_min',
    'min_niche_specialist_count',
    'niche_specialist_count_min',
  ]);

  const metrics = {
    anchors_processed: anchorCount,
    approved_alternative_anchor_count: approvedAlternativeAnchors.size,
    approved_alternative_anchor_percentage: approvedAlternativePercentage,
    approved_niche_specialist_count: approvedNicheSpecialistCount,
    review_status_counts: reviewStatusCounts,
    review_packet_count: extractReviewPackets(report).length,
  };

  return {
    metrics,
    gates: {
      anchors_processed: thresholdGate('anchors_processed', anchorCount, anchorsProcessedThreshold, 'count'),
      approved_alternative_anchor_percentage: thresholdGate(
        'approved_alternative_anchor_percentage',
        approvedAlternativePercentage,
        approvedAlternativeThreshold,
        'percent',
      ),
      approved_niche_specialist_count: thresholdGate(
        'approved_niche_specialist_count',
        approvedNicheSpecialistCount,
        approvedNicheSpecialistThreshold,
        'count',
      ),
    },
  };
}

function auditReport(report, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const rawEdges = extractEdges(report);
  const rows = [];
  const duplicateBuckets = new Map();
  const findings = {
    validation_errors: [],
    duplicate_identities: [],
    same_brand_competitor_dupes: [],
    on_page_competitor_dupes: [],
    stale_or_price_missing_dupes: [],
    missing_source_category_use_case: [],
    expired_approved_edges: [],
    unsupported_claims: [],
  };

  rawEdges.forEach((rawEdge, index) => {
    const validation = validateRelationshipEdge(rawEdge, { nowMs });
    const edge = validation.value;
    rows.push({ index, rawEdge, edge, validation });

    if (!validation.ok) {
      findings.validation_errors.push({
        index,
        edge_id: edge.id || null,
        identity: edgeIdentity(edge),
        errors: validation.errors,
      });
    }

    const identity = edgeIdentity(edge);
    if (!duplicateBuckets.has(identity)) duplicateBuckets.set(identity, []);
    duplicateBuckets.get(identity).push({
      index,
      edge_id: edge.id || null,
    });

    if (ALTERNATIVE_RELATION_TYPES.has(edge.relation_type)) {
      const anchorBrand = relationshipInternals.extractBrand(edge.anchor_snapshot);
      const candidateBrand = relationshipInternals.extractBrand(edge.candidate_snapshot);
      if (anchorBrand && candidateBrand && anchorBrand === candidateBrand) {
        findings.same_brand_competitor_dupes.push({
          index,
          edge_id: edge.id || null,
          relation_type: edge.relation_type,
          anchor_ref: edge.anchor_ref,
          candidate_product_ref: edge.candidate_product_ref,
          brand: anchorBrand,
        });
      }
      if (hasOnPageRelatedSource(edge)) {
        findings.on_page_competitor_dupes.push({
          index,
          edge_id: edge.id || null,
          relation_type: edge.relation_type,
          anchor_ref: edge.anchor_ref,
          candidate_product_ref: edge.candidate_product_ref,
        });
      }
    }

    const priceIssues = dupeFreshPriceIssues(edge, nowMs);
    if (priceIssues.length) {
      findings.stale_or_price_missing_dupes.push({
        index,
        edge_id: edge.id || null,
        anchor_ref: edge.anchor_ref,
        candidate_product_ref: edge.candidate_product_ref,
        issues: priceIssues,
      });
    }

    const missingContext = missingRequiredContext(edge);
    if (missingContext.length) {
      findings.missing_source_category_use_case.push({
        index,
        edge_id: edge.id || null,
        anchor_ref: edge.anchor_ref,
        candidate_product_ref: edge.candidate_product_ref,
        missing: missingContext,
      });
    }

    if (expiredApprovedIssue(edge, nowMs)) {
      findings.expired_approved_edges.push({
        index,
        edge_id: edge.id || null,
        anchor_ref: edge.anchor_ref,
        candidate_product_ref: edge.candidate_product_ref,
        expires_at: edge.expires_at,
      });
    }

    findings.unsupported_claims.push(...auditUnsupportedClaims(edge, index));
  });

  for (const [identity, bucket] of duplicateBuckets.entries()) {
    if (bucket.length <= 1) continue;
    findings.duplicate_identities.push({
      identity,
      count: bucket.length,
      duplicate_edge_count: bucket.length - 1,
      edges: bucket,
    });
  }

  const validationErrorCount = findings.validation_errors.reduce((sum, row) => sum + row.errors.length, 0);
  const duplicateEdgeCount = findings.duplicate_identities.reduce((sum, row) => sum + row.duplicate_edge_count, 0);
  const missingCategoryCount = findings.missing_source_category_use_case.filter((row) => row.missing.includes('category_taxonomy')).length;
  const missingUseCaseCount = findings.missing_source_category_use_case.filter((row) => row.missing.includes('use_case')).length;
  const missingSourceRefsCount = findings.missing_source_category_use_case.filter((row) => row.missing.includes('source_refs')).length;

  const metrics = {
    edge_count: rows.length,
    invalid_edge_count: findings.validation_errors.length,
    validation_error_count: validationErrorCount,
    duplicate_identity_count: findings.duplicate_identities.length,
    duplicate_edge_count: duplicateEdgeCount,
    same_brand_competitor_dupe_count: findings.same_brand_competitor_dupes.length,
    on_page_competitor_dupe_count: findings.on_page_competitor_dupes.length,
    stale_price_missing_dupe_count: findings.stale_or_price_missing_dupes.length,
    missing_source_category_use_case_count: findings.missing_source_category_use_case.length,
    missing_category_count: missingCategoryCount,
    missing_use_case_count: missingUseCaseCount,
    missing_source_refs_count: missingSourceRefsCount,
    expired_approved_count: findings.expired_approved_edges.length,
    unsupported_claim_count: findings.unsupported_claims.length,
  };

  const hardGates = {
    edge_validation: zeroGate('edge_validation', metrics.validation_error_count, findings.validation_errors.length),
    duplicate_edge_identity: zeroGate('duplicate_edge_identity', metrics.duplicate_identity_count, findings.duplicate_identities.length),
    same_brand_competitor_dupe: zeroGate(
      'same_brand_competitor_dupe',
      metrics.same_brand_competitor_dupe_count,
      findings.same_brand_competitor_dupes.length,
    ),
    on_page_competitor_dupe: zeroGate(
      'on_page_competitor_dupe',
      metrics.on_page_competitor_dupe_count,
      findings.on_page_competitor_dupes.length,
    ),
    dupe_fresh_price: zeroGate(
      'dupe_fresh_price',
      metrics.stale_price_missing_dupe_count,
      findings.stale_or_price_missing_dupes.length,
    ),
    required_source_category_use_case: zeroGate(
      'required_source_category_use_case',
      metrics.missing_source_category_use_case_count,
      findings.missing_source_category_use_case.length,
    ),
    expired_approved: zeroGate('expired_approved', metrics.expired_approved_count, findings.expired_approved_edges.length),
    unsupported_claims: zeroGate('unsupported_claims', metrics.unsupported_claim_count, findings.unsupported_claims.length),
  };

  const pilotAcceptance = computePilotAcceptance(report, rows, nowMs);
  const allGateStatuses = [
    ...Object.values(hardGates).map((gate) => gate.status),
    ...Object.values(pilotAcceptance.gates).map((gate) => gate.status),
  ];
  const status = allGateStatuses.includes('fail') ? 'fail' : 'pass';

  return {
    status,
    generated_at: new Date(nowMs).toISOString(),
    report: {
      edge_count: rows.length,
      rejected_edge_count: asArray(ensureObject(report).rejected_edges || ensureObject(report).rejectedEdges).length,
      review_packet_count: extractReviewPackets(report).length,
      summary: extractSummary(report),
    },
    metrics,
    hard_gates: hardGates,
    pilot_acceptance: pilotAcceptance,
    findings,
  };
}

function tableRowsFromGates(gates) {
  return Object.values(gates).map((gate) => {
    const metric = gate.metric == null ? 'n/a' : gate.metric;
    const threshold = gate.threshold == null ? 'n/a' : gate.threshold;
    return `| ${gate.name} | ${gate.status} | ${metric} | ${threshold} |`;
  });
}

function renderMarkdownReport(audit) {
  const lines = [
    '# Product Relationship Graph Quality Audit',
    '',
    `Status: ${String(audit.status || 'unknown').toUpperCase()}`,
    `Generated at: ${audit.generated_at}`,
    '',
    '## Hard Gates',
    '',
    '| Gate | Status | Metric | Threshold |',
    '| --- | --- | ---: | ---: |',
    ...tableRowsFromGates(audit.hard_gates || {}),
    '',
    '## Pilot Acceptance',
    '',
    `- Anchors processed: ${audit.pilot_acceptance?.metrics?.anchors_processed ?? 'n/a'}`,
    `- Approved alternative anchor percentage: ${audit.pilot_acceptance?.metrics?.approved_alternative_anchor_percentage ?? 'n/a'}`,
    `- Approved niche specialist count: ${audit.pilot_acceptance?.metrics?.approved_niche_specialist_count ?? 'n/a'}`,
    '',
    '| Gate | Status | Metric | Threshold |',
    '| --- | --- | ---: | ---: |',
    ...tableRowsFromGates(audit.pilot_acceptance?.gates || {}),
    '',
    '## Finding Counts',
    '',
    `- Validation errors: ${audit.metrics.validation_error_count}`,
    `- Duplicate identities: ${audit.metrics.duplicate_identity_count}`,
    `- Same-brand competitor/dupe edges: ${audit.metrics.same_brand_competitor_dupe_count}`,
    `- On-page competitor/dupe edges: ${audit.metrics.on_page_competitor_dupe_count}`,
    `- Stale or price-missing dupes: ${audit.metrics.stale_price_missing_dupe_count}`,
    `- Missing source/category/use-case edges: ${audit.metrics.missing_source_category_use_case_count}`,
    `- Expired approved edges: ${audit.metrics.expired_approved_count}`,
    `- Unsupported claims: ${audit.metrics.unsupported_claim_count}`,
  ];

  const unsupported = asArray(audit.findings?.unsupported_claims).slice(0, 10);
  if (unsupported.length) {
    lines.push('', '## Unsupported Claim Samples', '');
    for (const item of unsupported) {
      lines.push(`- ${item.claim_id} at edge ${item.edge_id || item.index} (${item.path}): ${item.text}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function usage() {
  return [
    'Usage: node scripts/audit-product-relationship-graph.js --report <path> [--out <path>] [--markdown <path>]',
    '',
    'Audits a product relationship graph dry-run or published report JSON offline.',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const reportPath = argValue(argv, 'report');
  if (!reportPath) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const report = readReportFile(reportPath);
  const audit = auditReport(report);
  const outPath = argValue(argv, 'out');
  const markdownPath = argValue(argv, 'markdown');

  if (outPath) writeJsonFile(outPath, audit);
  if (markdownPath) writeTextFile(markdownPath, renderMarkdownReport(audit));

  const stdoutPayload = outPath
    ? {
      status: audit.status,
      generated_at: audit.generated_at,
      metrics: audit.metrics,
      hard_gates: audit.hard_gates,
      pilot_acceptance: audit.pilot_acceptance,
    }
    : audit;
  process.stdout.write(`${JSON.stringify(stdoutPayload, null, 2)}\n`);
  if (audit.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALTERNATIVE_RELATION_TYPES,
  UNSUPPORTED_CLAIM_PATTERNS,
  auditReport,
  auditUnsupportedClaims,
  claimTextFragments,
  computePilotAcceptance,
  dupeFreshPriceIssues,
  edgeIdentity,
  extractEdges,
  extractReviewPackets,
  extractSummary,
  hasOnPageRelatedSource,
  hasSupportingSocialSource,
  missingRequiredContext,
  renderMarkdownReport,
  resolvePathMaybeRelative,
};
