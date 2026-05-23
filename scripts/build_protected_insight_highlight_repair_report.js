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

const OWNER_DELEGATED_REVIEW_CONTRACT_VERSION = 'pivota.owner_delegated_review.v1';
const HIGHLIGHT_REPAIR_CONTRACT_VERSION = 'pivota.highlight_repair.v1';

function parseArgs(argv) {
  const out = {
    market: 'US',
    domain: '',
    limit: 50,
    scanLimit: 1000,
    productIds: [],
    out: '',
    reviewer: 'codex_quality_reviewer',
    reviewedAt: '',
    ownerInstruction:
      'Owner delegated Codex to perform conservative highlight-only repair review for protected Pivota Insights.',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--market' && next) {
      out.market = String(next).trim();
      index += 1;
    } else if (token === '--domain' && next) {
      out.domain = String(next).trim();
      index += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Math.min(500, Number(next) || 50));
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
      out.out = String(next).trim();
      index += 1;
    } else if (token === '--reviewer' && next) {
      out.reviewer = String(next).trim();
      index += 1;
    } else if (token === '--reviewed-at' && next) {
      out.reviewedAt = String(next).trim();
      index += 1;
    } else if (token === '--owner-instruction' && next) {
      out.ownerInstruction = String(next).trim();
      index += 1;
    }
  }

  return out;
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

function cloneJson(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeReviewedAt(value) {
  const text = asString(value);
  const date = text ? new Date(text) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`invalid_reviewed_at:${text}`);
  return date.toISOString();
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function compactWhitespace(value) {
  return asString(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTitleNoise(value) {
  return compactWhitespace(value)
    .replace(/\([^)]*%\s*off[^)]*\)/gi, '')
    .replace(/\b(?:mini|travel size|original size|limited edition)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCommerceTruthText(text) {
  return hasCommerceTruthClaim({
    product_intel_core: {
      what_it_is: {
        body: text,
      },
    },
  });
}

function isWeakHighlightText(text) {
  const normalized = compactWhitespace(text).toLowerCase();
  if (!normalized) return true;
  if (/…|\.\.\./.test(normalized)) return true;
  if (normalized.length > 40 || normalized.length < 8) return true;
  if (isCommerceTruthText(normalized)) return true;
  if (
    /\b(?:popular|unique|high quality|must-have|favorite|amazing|best-selling|limited edition|save|sale|discount)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /\b(?:product role|routine role|formula story|merchant data|seller data|product data|positioning)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return !/[a-z][a-z0-9.+-]*\s+[a-z][a-z0-9.+-]*/i.test(normalized);
}

function normalizeHighlightCandidate(value) {
  let text = compactWhitespace(value)
    .replace(/[.!?]+$/g, '')
    .replace(/^[-:;,\s]+|[-:;,\s]+$/g, '');
  if (!text) return '';
  if (text.length > 40) {
    text = text.slice(0, 40).replace(/\s+\S*$/, '').trim();
  }
  if (isWeakHighlightText(text)) return '';
  return text;
}

function titleCaseToken(value) {
  const text = asString(value).toLowerCase();
  if (!text) return '';
  if (text === 'c') return 'C';
  if (text === 'vitamin-c' || text === 'vitamin c') return 'Vitamin C';
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

function buildTitleBasedHighlight(title) {
  const cleanTitle = stripTitleNoise(title);
  const lower = cleanTitle.toLowerCase();

  if (/\bmakeup fixing mist\b/.test(lower)) return 'Makeup setting mist';
  if (/\bretinol tonic\b/.test(lower)) return 'Retinol toner step';
  if (/\brose tonic\b/.test(lower)) return 'Rose toner step';
  if (/\bmilky tonic\b/.test(lower)) return 'Milky toner step';
  if (/\bhydrating milky mist\b/.test(lower)) return 'Hydrating milky mist';
  if (/\bglow mist\b/.test(lower)) return 'Hydrating glow mist';
  if (/(?:\+c vit|vitamin[-\s]?c)\s+priming oil\b/.test(lower)) {
    return 'Vitamin C priming oil';
  }

  const tonic = lower.match(/\b([a-z+][a-z+\s-]{1,24})\s+tonic\b/);
  if (tonic) {
    const token = tonic[1].split(/\s+/).filter(Boolean).slice(-2).join(' ');
    const label = titleCaseToken(token.replace(/^\+/, ''));
    if (label) return `${label} toner step`;
  }

  const mist = lower.match(/\b([a-z+][a-z+\s-]{1,24})\s+mist\b/);
  if (mist) {
    const token = mist[1].split(/\s+/).filter(Boolean).slice(-2).join(' ');
    const label = titleCaseToken(token.replace(/^\+/, ''));
    if (label) return `${label} mist`;
  }

  return '';
}

function collectBundleHighlightCandidates({ title, bundle }) {
  const core = asObject(bundle?.product_intel_core);
  const candidates = [buildTitleBasedHighlight(title)];

  for (const item of asArray(core.why_it_stands_out)) {
    const row = asObject(item);
    candidates.push(row.headline);
  }
  for (const item of asArray(core.best_for)) {
    const row = asObject(item);
    candidates.push(row.label || row.tag || item);
  }
  candidates.push(core.what_it_is?.headline);
  candidates.push(bundle?.shopping_card?.subtitle);
  candidates.push(bundle?.search_card?.compact_candidate);

  return candidates.map(normalizeHighlightCandidate).filter(Boolean);
}

function chooseHighlight({ title, bundle }) {
  const seen = new Set();
  for (const candidate of collectBundleHighlightCandidates({ title, bundle })) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    return candidate;
  }
  return '';
}

function buildCandidateBundle({ seedRow, kbRow, reviewedAt, reviewer }) {
  const bundle = readProductIntelBundleFromKbRow(kbRow);
  const title = asString(seedRow?.title || seedRow?.seed_title || bundle?.shopping_card?.title);
  const previousBundleHash = bundle ? hashJson(bundle) : '';
  const highlight = chooseHighlight({ title, bundle });
  if (!highlight) return null;

  const candidate = cloneJson(bundle);
  candidate.shopping_card = {
    ...(asObject(candidate.shopping_card) || {}),
    highlight,
  };
  candidate.search_card = {
    ...(asObject(candidate.search_card) || {}),
    highlight_candidate: highlight,
  };
  candidate.card_highlight = highlight;
  candidate.provenance = {
    ...(asObject(candidate.provenance) || {}),
    highlight_repair: {
      contract_version: HIGHLIGHT_REPAIR_CONTRACT_VERSION,
      repair_type: 'missing_card_highlight_only',
      source: 'existing_protected_bundle',
      reviewer,
      reviewer_kind: 'assistant',
      reviewed_at: reviewedAt,
      previous_bundle_hash: previousBundleHash,
      highlight,
    },
  };
  return { bundle: candidate, highlight, previousBundleHash };
}

function hasSingleItemTitleMultiItemBodyMismatch({ seedRow, bundle }) {
  const title = asString(seedRow?.title || bundle?.shopping_card?.title).toLowerCase();
  if (!title) return false;
  if (/\b(?:set|kit|bundle|duo|trio|routine|must-haves?|favourites?|favorites?|starter)\b/.test(title)) {
    return false;
  }
  const body = compactWhitespace(bundle?.product_intel_core?.what_it_is?.body);
  const sizeFragments = body.match(/\b\d+(?:\.\d+)?\s*(?:ml|fl\.?\s*oz|oz)\s*[-–—:]/gi) || [];
  if (sizeFragments.length < 2) return false;
  const productRoleFragments = body.match(
    /\b(?:cleanser|tonic|toner|lotion|serum|mist|cream|creme|oil|mask|balm)\b/gi,
  ) || [];
  return new Set(productRoleFragments.map((item) => item.toLowerCase())).size >= 2;
}

function buildSkipReason({ classification, kbRow, seedRow, requireCommunitySupported = true }) {
  const productId = asString(seedRow?.external_product_id || seedRow?.product_id);
  const bundle = readProductIntelBundleFromKbRow(kbRow);
  if (!bundle) return 'missing_bundle';
  if (!classification.displayable) return 'not_displayable';
  if (!classification.human_reviewed) return 'not_human_reviewed';
  if (classification.has_card_highlight) return 'already_has_card_highlight';
  const blocking = asArray(classification.blocking_issues);
  if (blocking.length !== 1 || blocking[0] !== 'missing_card_highlight') {
    return `non_highlight_blockers:${blocking.join('|') || 'none'}`;
  }
  if (!isProtectedPivotaInsight(kbRow, { productId, bundle })) return 'not_protected';
  if (
    requireCommunitySupported &&
    asString(classification.evidence_profile).toLowerCase() !== 'community_supported'
  ) {
    return `not_community_supported:${classification.evidence_profile || 'unknown'}`;
  }
  if (hasSingleItemTitleMultiItemBodyMismatch({ seedRow, bundle })) {
    return 'single_item_title_with_multi_item_bundle_body';
  }
  if (hasCommerceTruthClaim(bundle)) return 'existing_commerce_truth_claim';
  return '';
}

function buildHighlightRepairRow(seedRow, kbRow, options = {}) {
  const productId = asString(seedRow?.external_product_id || seedRow?.product_id);
  const classification = classifyProductIntelKbRow(kbRow, { productId });
  const skipReason = buildSkipReason({
    classification,
    kbRow,
    seedRow,
    requireCommunitySupported: options.requireCommunitySupported !== false,
  });
  if (skipReason) {
    return {
      skipped: true,
      case_id: productId,
      reason: skipReason,
      title: asString(seedRow?.title),
    };
  }

  const reviewedAt = normalizeReviewedAt(options.reviewedAt);
  const reviewer = asString(options.reviewer) || 'codex_quality_reviewer';
  const candidate = buildCandidateBundle({ seedRow, kbRow, reviewedAt, reviewer });
  if (!candidate) {
    return {
      skipped: true,
      case_id: productId,
      reason: 'highlight_candidate_unavailable',
      title: asString(seedRow?.title),
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
      'Owner-delegated assistant highlight-only repair. Existing protected bundle content is preserved; only compact card highlight fields are added.',
    owner_delegated_review: {
      contract_version: OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
      delegated_to: reviewer,
      reviewer_kind: 'assistant',
      owner_instruction:
        asString(options.ownerInstruction) ||
        'Owner delegated Codex to perform conservative highlight-only repair review for protected Pivota Insights.',
      source_review_packet_decision: 'pass_recommended',
      source_public_write_allowed_by_packet: true,
      rationale:
        'Existing protected community-supported bundle is displayable and human-reviewed; repair only adds a compact, non-commerce card highlight.',
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
        'Approved as a highlight-only repair that preserves the protected community-supported bundle and fixes the missing-card-highlight blocker.',
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
      selected_mode: 'highlight_only_repair',
      selected_field_count: 3,
      field_sources: {
        'shopping_card.highlight': 'highlight_repair',
        'search_card.highlight_candidate': 'highlight_repair',
        card_highlight: 'highlight_repair',
      },
      bundle: candidate.bundle,
    },
    review_packet: {
      title: asString(seedRow?.title),
      canonical_url: asString(seedRow?.canonical_url || seedRow?.destination_url),
      previous_bundle_hash: candidate.previousBundleHash,
      candidate_bundle_hash: candidateHash,
      added_highlight: candidate.highlight,
      preserved_evidence_profile: asString(classification.evidence_profile),
      preserved_quality_state: asString(classification.quality_state),
      previous_blocking_issues: classification.blocking_issues,
    },
  };
}

function buildHighlightRepairReport(seedRows, kbRows, options = {}) {
  const kbByProductId = new Map(
    asArray(kbRows).map((row) => [asString(row?.kb_key).replace(/^product:/, ''), row]),
  );
  const skippedRows = [];
  const rows = [];
  for (const seedRow of asArray(seedRows)) {
    const productId = asString(seedRow?.external_product_id || seedRow?.product_id);
    const kbRow = kbByProductId.get(productId);
    if (!kbRow) {
      skippedRows.push({ case_id: productId, reason: 'missing_kb_row', title: asString(seedRow?.title) });
      continue;
    }
    const row = buildHighlightRepairRow(seedRow, kbRow, options);
    if (row.skipped) {
      skippedRows.push(row);
      continue;
    }
    rows.push(row);
    if (rows.length >= Number(options.limit || 50)) break;
  }

  return {
    meta: {
      generated_at: normalizeReviewedAt(options.reviewedAt),
      source: 'protected_insight_highlight_repair',
      review_contract_version: OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
      repair_contract_version: HIGHLIGHT_REPAIR_CONTRACT_VERSION,
      selected_cases: rows.length,
      skipped_cases: skippedRows.length,
      reviewer: asString(options.reviewer) || 'codex_quality_reviewer',
      reviewer_kind: 'assistant',
      guardrail:
        'Only displayable, human-reviewed, protected community-supported bundles with missing_card_highlight as their sole blocker are eligible.',
    },
    rows,
    skipped_rows: skippedRows,
  };
}

async function fetchCandidateRows(options) {
  const productIds = asArray(options.productIds).map(asString).filter(Boolean);
  const params = [asString(options.market || 'US') || 'US'];
  const clauses = [
    "eps.status = 'active'",
    "eps.external_product_id LIKE 'ext_%'",
    'eps.market = $1',
  ];
  if (asString(options.domain)) {
    params.push(asString(options.domain));
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
  const report = buildHighlightRepairReport(seedRows, kbRows, {
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
  HIGHLIGHT_REPAIR_CONTRACT_VERSION,
  OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
  buildHighlightRepairReport,
  buildHighlightRepairRow,
  buildTitleBasedHighlight,
  chooseHighlight,
  hasSingleItemTitleMultiItemBodyMismatch,
  normalizeHighlightCandidate,
  parseArgs,
};
