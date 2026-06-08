#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIRM_TOKEN = 'RUN_PDP_QUALITY_UPGRADE_LOOP_V1';
const SYNC_CONFIRM_TOKEN = 'SYNC_REVIEWED_EXTERNAL_SEEDS_TO_CATALOG';
const CATEGORY_PATCH_CONFIRM_TOKEN = 'APPLY_REVIEWED_EXTERNAL_SEED_CATEGORY_PATCH';
const RELGRAPH_SYNC_ROUTINE_CONFIRM_TOKEN = 'APPLY_RELGRAPH_SYNC_ROUTINE';

function argValue(name, fallback = '') {
  const eqPrefix = `--${name}=`;
  const eqHit = process.argv.find((arg) => arg.startsWith(eqPrefix));
  if (eqHit) return eqHit.slice(eqPrefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const next = process.argv[idx + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asBool(value) {
  return value === true || asString(value).toLowerCase() === 'true';
}

function parseDelimited(value) {
  return Array.from(
    new Set(
      asString(value)
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function splitPipe(value) {
  return asString(value)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function csvEscape(value) {
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  const compact = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[",\n\r]/.test(compact)) return `"${compact.replace(/"/g, '""')}"`;
  return compact;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function safeFilePart(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'run';
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function log(message) {
  process.stderr.write(`[pdp-quality-upgrade] ${message}\n`);
}

function hostFromUrl(value) {
  try {
    return new URL(asString(value)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function hasOfficialBrandSource(row) {
  const canonical = asString(row.canonical_url || row.destination_url);
  if (!/^https:\/\//i.test(canonical)) return false;
  const rowDomain = asString(row.domain).replace(/^www\./, '').toLowerCase();
  const sourceHost = hostFromUrl(canonical);
  if (rowDomain && sourceHost && rowDomain !== sourceHost) return false;
  return asString(row.identity_source_tier).toLowerCase() === 'brand';
}

function identityReady(row) {
  return (
    asBool(row.identity_exists) &&
    asString(row.identity_status).toLowerCase() === 'approved' &&
    asBool(row.identity_live_read_enabled) &&
    !asBool(row.identity_review_required)
  );
}

function hasSeedGaps(row) {
  return splitPipe(row.seed_missing_fields).length > 0;
}

function missingFields(row) {
  return splitPipe(row.seed_missing_fields);
}

function titleText(row) {
  return asString(row.title).toLowerCase().replace(/&/g, ' and ');
}

function inferReviewedCategoryPatch(row) {
  const title = titleText(row);
  const sourceUrl = asString(row.canonical_url || row.destination_url);
  const base = {
    external_product_id: asString(row.external_product_id),
    market: asString(row.market || 'US').toUpperCase() || 'US',
    title: asString(row.title),
    canonical_url: sourceUrl,
    source_url: sourceUrl,
    source_kind: 'automatic_official_pdp_title_category_review',
    reviewed_by: 'codex_pdp_quality_upgrade_loop',
    reason: 'automatic_high_confidence_official_title_category_patch',
    confidence: 0.92,
  };

  const setSignal = /\b(?:set|kit|duo|trio|bundle|collection|4[-\s]?piece|6[-\s]?piece)\b/.test(title);
  if (
    setSignal &&
    /\bhand\s+care\b/.test(title) &&
    /\b(?:cuticle|nail|scrub|cream|balm|oil)\b/.test(title)
  ) {
    return {
      ...base,
      category: 'Hand Care Set',
      product_type: 'Hand Care Set',
      category_path: 'beauty/body/hand-care',
      catalog_category_path: 'beauty/body/hand-care',
      evidence: `Official brand PDP title "${asString(row.title)}" identifies a multi-item hand-care set.`,
    };
  }
  if (/\bnail\s+polish\s+remover\b/.test(title)) {
    return {
      ...base,
      category: 'Nail Polish Remover',
      product_type: 'Nail Polish Remover',
      category_path: 'beauty/makeup/nails/nail-polish-remover',
      catalog_category_path: 'beauty/makeup/nails/nail-polish-remover',
      evidence: `Official brand PDP title "${asString(row.title)}" identifies a nail polish remover product.`,
    };
  }
  if (/\bcuticle\s+oil\b/.test(title)) {
    return {
      ...base,
      category: 'Cuticle Oil',
      product_type: 'Cuticle Oil',
      category_path: 'beauty/makeup/nails/cuticle-oil',
      catalog_category_path: 'beauty/makeup/nails/cuticle-oil',
      evidence: `Official brand PDP title "${asString(row.title)}" identifies a cuticle oil product.`,
    };
  }
  if (/\bnail\s+polish\b/.test(title) && setSignal) {
    return {
      ...base,
      category: 'Nail Polish Set',
      product_type: 'Nail Polish Set',
      category_path: 'beauty/makeup/nails/nail-polish-set',
      catalog_category_path: 'beauty/makeup/nails/nail-polish-set',
      evidence: `Official brand PDP title "${asString(row.title)}" identifies a multi-item nail polish set.`,
    };
  }
  if (/\bnail\s+polish\b/.test(title)) {
    return {
      ...base,
      category: 'Nail Polish',
      product_type: 'Nail Polish',
      category_path: 'beauty/makeup/nails/nail-polish',
      catalog_category_path: 'beauty/makeup/nails/nail-polish',
      evidence: `Official brand PDP title "${asString(row.title)}" identifies a nail polish product.`,
    };
  }
  if (/\blip\s+gloss\b/.test(title) && setSignal) {
    return {
      ...base,
      category: 'Lip Gloss Set',
      product_type: 'Lip Gloss Set',
      category_path: 'beauty/makeup/lips/lip-gloss-set',
      catalog_category_path: 'beauty/makeup/lips/lip-gloss-set',
      evidence: `Official brand PDP title "${asString(row.title)}" identifies a multi-item lip gloss set.`,
    };
  }
  return null;
}

function isSafeCategoryPatchCandidate(row) {
  const fields = missingFields(row);
  if (fields.length !== 1 || fields[0] !== 'category') return false;
  if (asBool(row.terminal_hold)) return false;
  if (!hasOfficialBrandSource(row)) return false;
  if (!identityReady(row)) return false;
  if (!asBool(row.catalog_attached)) return false;
  if (hasProblematicInsightCopy(row)) return false;
  return Boolean(inferReviewedCategoryPatch(row));
}

function hasProblematicInsightCopy(row) {
  const issues = new Set([...splitPipe(row.kb_direct_issues), ...splitPipe(row.kb_direct_blocking_issues)]);
  return issues.has('public_promo_availability_copy') || issues.has('commerce_truth_claim');
}

function isInsightRewriteBlocker(row) {
  return ['kb_missing', 'kb_blocked', 'kb_displayable_limited'].includes(asString(row.main_blocker));
}

function isSafeInsightRewriteCandidate(row) {
  if (asBool(row.terminal_hold)) return false;
  if (hasSeedGaps(row)) return false;
  if (!hasOfficialBrandSource(row)) return false;
  if (!identityReady(row)) return false;
  if (!asBool(row.catalog_attached)) return false;
  if (!asBool(row.index_serving_eligible)) return false;
  if (!asBool(row.commerce_doc_public)) return false;
  if (asBool(row.kb_direct_high_quality_ready)) return false;
  if (hasProblematicInsightCopy(row)) return false;
  return isInsightRewriteBlocker(row);
}

function classifyInventoryRow(row) {
  const issues = [...splitPipe(row.kb_direct_issues), ...splitPipe(row.kb_direct_blocking_issues)];
  if (asBool(row.terminal_hold)) {
    return {
      action: 'hold',
      lane: 'terminal_hold',
      reason: asString(row.terminal_hold_reason) || 'terminal_hold',
      auto_apply: false,
    };
  }
  if (asBool(row.db_serving_ready) && asBool(row.kb_effective_high_quality_ready)) {
    return {
      action: 'keep',
      lane: 'ready_no_action',
      reason: 'db_serving_ready_high_quality',
      auto_apply: false,
    };
  }
  if (!identityReady(row)) {
    return {
      action: 'hold',
      lane: 'identity_index_review',
      reason: asBool(row.identity_review_required) ? 'identity_review_required' : 'identity_not_live_ready',
      auto_apply: false,
    };
  }
  if (isSafeCategoryPatchCandidate(row)) {
    return {
      action: 'category_patch',
      lane: 'lane_2_seed_commerce_facts',
      reason: 'seed_missing_fields:category',
      auto_apply: true,
    };
  }
  if (hasSeedGaps(row)) {
    return {
      action: 'hold',
      lane: 'seed_commerce_or_content_gap',
      reason: `seed_missing_fields:${asString(row.seed_missing_fields)}`,
      auto_apply: false,
    };
  }
  if (isSafeInsightRewriteCandidate(row)) {
    return {
      action: 'insight_rewrite',
      lane: 'lane_3_kb_rewrite_review',
      reason: asString(row.main_blocker),
      auto_apply: true,
    };
  }
  if (
    ['index_doc_shadow_only', 'db_not_serving_ready'].includes(asString(row.main_blocker)) &&
    asBool(row.catalog_attached) &&
    asBool(row.kb_effective_high_quality_ready)
  ) {
    return {
      action: 'serving_state_sync_candidate',
      lane: 'lane_1_identity_index',
      reason: asString(row.main_blocker),
      auto_apply: false,
    };
  }
  if (hasProblematicInsightCopy(row)) {
    return {
      action: 'hold',
      lane: 'insight_content_review',
      reason: issues.includes('public_promo_availability_copy')
        ? 'public_promo_availability_copy'
        : 'commerce_truth_claim',
      auto_apply: false,
    };
  }
  return {
    action: 'hold',
    lane: asString(row.recommended_lane || row.main_blocker) || 'unclassified',
    reason: asString(row.main_blocker || row.blocker_detail) || 'unclassified',
    auto_apply: false,
  };
}

function summarizePlan(planRows) {
  const summary = {
    scanned: planRows.length,
    by_action: {},
    by_lane: {},
    by_reason: {},
    auto_apply_count: 0,
  };
  for (const row of planRows) {
    summary.by_action[row.action] = (summary.by_action[row.action] || 0) + 1;
    summary.by_lane[row.lane] = (summary.by_lane[row.lane] || 0) + 1;
    summary.by_reason[row.reason] = (summary.by_reason[row.reason] || 0) + 1;
    if (row.auto_apply) summary.auto_apply_count += 1;
  }
  return summary;
}

function buildPlanRows(inventoryRows) {
  return inventoryRows.map((row) => {
    const decision = classifyInventoryRow(row);
    return {
      external_product_id: asString(row.external_product_id),
      title: asString(row.title),
      domain: asString(row.domain),
      main_blocker: asString(row.main_blocker),
      recommended_lane: asString(row.recommended_lane),
      kb_status: asString(row.kb_direct_status),
      kb_quality_state: asString(row.kb_direct_quality_state),
      kb_evidence_profile: asString(row.kb_direct_evidence_profile),
      identity_status: asString(row.identity_status),
      catalog_attached: asBool(row.catalog_attached),
      index_serving_eligible: asBool(row.index_serving_eligible),
      commerce_doc_public: asBool(row.commerce_doc_public),
      terminal_hold: asBool(row.terminal_hold),
      terminal_hold_reason: asString(row.terminal_hold_reason),
      seed_missing_fields: asString(row.seed_missing_fields),
      action: decision.action,
      lane: decision.lane,
      reason: decision.reason,
      auto_apply: decision.auto_apply,
      inferred_category: inferReviewedCategoryPatch(row)?.category || '',
      inferred_category_path: inferReviewedCategoryPatch(row)?.category_path || '',
    };
  });
}

function runNodeScript(scriptPath, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
  });
  const run = {
    command: [process.execPath, scriptPath, ...args],
    exit_code: result.status,
    signal: result.signal,
    duration_ms: Date.now() - startedAt,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
  if (options.stdoutPath) fs.writeFileSync(options.stdoutPath, run.stdout, 'utf8');
  if (options.stderrPath) fs.writeFileSync(options.stderrPath, run.stderr, 'utf8');
  if (result.status !== 0) {
    const err = new Error(`script_failed:${scriptPath}:exit_${result.status}`);
    err.run = run;
    throw err;
  }
  return run;
}

function buildAuditArgs(options, auditDir) {
  const args = [
    '--market',
    options.market,
    '--limit',
    String(options.limit),
    '--page-size',
    String(options.pageSize),
    '--sample-limit',
    String(options.sampleLimit),
    '--out-dir',
    auditDir,
  ];
  if (options.domain) args.push('--domain', options.domain);
  if (options.externalProductIds.length) args.push('--external-product-ids', options.externalProductIds.join(','));
  if (options.resume) args.push('--resume');
  if (options.force) args.push('--force');
  return args;
}

function buildReportArgs(options, inventoryPath, reportPath, batchName) {
  const args = [
    '--inventory',
    inventoryPath,
    '--out',
    reportPath,
    '--batch-name',
    batchName,
    '--reviewer',
    options.reviewer,
    '--limit',
    String(options.batchSize),
    '--validate-replacements',
  ];
  if (options.includeMissingOfficialSource) args.push('--include-missing-official-source');
  if (options.includeReviewedSellerOnly) args.push('--include-reviewed-seller-only');
  if (options.includeNotReviewedOfficialSource) args.push('--include-not-reviewed-official-source');
  return args;
}

function buildPublishArgs(reportPath, outPath, { write = false } = {}) {
  const args = ['--report', reportPath, '--out', outPath, '--validate-replacements'];
  if (write) {
    args.splice(args.indexOf('--validate-replacements'), 1);
    args.push('--write');
  }
  return args;
}

function buildSyncArgs(ids, outPath, { affectedProductsOut = '' } = {}) {
  const args = [
    '--apply',
    '--confirm',
    SYNC_CONFIRM_TOKEN,
    '--external-product-ids',
    ids.join(','),
    '--upsert-serving-state',
    '--bootstrap-reviewed-identity-live-read',
    '--out',
    outPath,
  ];
  if (affectedProductsOut) args.push('--affected-products-out', affectedProductsOut);
  return args;
}

function buildRelgraphSyncRoutineArgs(affectedProductsPath, outDir, options) {
  const args = [
    '--market',
    options.market,
    '--affected-products-file',
    affectedProductsPath,
    '--out-dir',
    outDir,
    '--limit',
    String(options.relgraphLimit),
    '--review-limit',
    String(options.relgraphReviewLimit),
  ];
  if (options.relgraphSkipReview) {
    args.push('--skip-review');
  } else {
    args.push('--cutoff', options.relgraphCutoff);
  }
  if (options.relgraphApplyBuild) args.push('--apply-build');
  if (options.relgraphApplyReview) args.push('--apply-review');
  if (options.relgraphApplyBuild || options.relgraphApplyReview) {
    args.push('--confirm', RELGRAPH_SYNC_ROUTINE_CONFIRM_TOKEN);
  }
  return args;
}

function buildCategoryPatchManifest(rows, options) {
  return {
    contract_version: 'pdp_quality_upgrade_loop.category_patch_manifest.v1',
    market: options.market,
    reviewed_by: options.reviewer,
    source_kind: 'automatic_official_pdp_title_category_review',
    generated_at: new Date().toISOString(),
    entries: rows.map((row) => ({
      ...inferReviewedCategoryPatch(row),
      reviewed_by: options.reviewer,
    })),
  };
}

function buildCategoryPatchArgs(manifestPath, outPath, options, { write = false } = {}) {
  const args = ['--manifest', manifestPath, '--market', options.market, '--out', outPath];
  if (write) args.push('--write', '--confirm', CATEGORY_PATCH_CONFIRM_TOKEN);
  return args;
}

function parseOptions() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const write = hasFlag('write');
  const outDir =
    argValue('out-dir') ||
    path.join('reports', `pdp_quality_upgrade_loop_${datePart}_${safeFilePart(argValue('domain') || 'all')}`);
  const options = {
    market: asString(argValue('market', 'US')).toUpperCase() || 'US',
    domain: asString(argValue('domain', '')),
    externalProductIds: parseDelimited(argValue('external-product-ids') || argValue('externalProductIds')),
    limit: Math.max(1, Number(argValue('limit', '20000')) || 20000),
    pageSize: Math.max(1, Math.min(Number(argValue('page-size', '500')) || 500, 1000)),
    sampleLimit: Math.max(1, Math.min(Number(argValue('sample-limit', '25')) || 25, 100)),
    batchSize: Math.max(1, Math.min(Number(argValue('batch-size', '25')) || 25, 100)),
    maxCycles: Math.max(1, Math.min(Number(argValue('max-cycles', write ? '10' : '1')) || 1, 100)),
    outDir: path.resolve(outDir),
    reviewer: asString(argValue('reviewer')) || 'codex_quality_reviewer_owner_delegated',
    batchName: asString(argValue('batch-name')) || `auto_pdp_quality_upgrade_${datePart}`,
    write,
    confirm: asString(argValue('confirm')),
    resume: hasFlag('resume'),
    force: hasFlag('force'),
    syncServingState: !hasFlag('skip-serving-sync'),
    runRelgraphRoutine: hasFlag('run-relgraph-routine'),
    relgraphCutoff: asString(argValue('relgraph-cutoff')),
    relgraphSkipReview: hasFlag('relgraph-skip-review'),
    relgraphApplyBuild: hasFlag('relgraph-apply-build'),
    relgraphApplyReview: hasFlag('relgraph-apply-review'),
    relgraphLimit: Math.max(1, Math.min(Number(argValue('relgraph-limit', '200')) || 200, 2000)),
    relgraphReviewLimit: Math.max(1, Math.min(Number(argValue('relgraph-review-limit', '250')) || 250, 5000)),
    includeMissingOfficialSource: !hasFlag('skip-missing-official-source'),
    includeReviewedSellerOnly: !hasFlag('skip-reviewed-seller-only'),
    includeNotReviewedOfficialSource: hasFlag('include-not-reviewed-official-source'),
  };
  if (options.write && options.confirm !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }
  if (options.runRelgraphRoutine && !options.syncServingState) {
    throw new Error('--run-relgraph-routine requires catalog serving sync; remove --skip-serving-sync');
  }
  if (options.runRelgraphRoutine && !options.relgraphSkipReview && !options.relgraphCutoff) {
    throw new Error('--run-relgraph-routine requires --relgraph-cutoff unless --relgraph-skip-review is set');
  }
  if ((options.relgraphApplyBuild || options.relgraphApplyReview) && !options.write) {
    throw new Error('relgraph apply flags require --write and the PDP quality loop confirmation');
  }
  if ((options.relgraphApplyBuild || options.relgraphApplyReview) && !options.runRelgraphRoutine) {
    throw new Error('relgraph apply flags require --run-relgraph-routine');
  }
  return options;
}

function loadState(statePath) {
  return readJson(statePath, {
    contract_version: 'pdp_quality_upgrade_loop.state.v1',
    processed_product_ids: [],
    category_patched_product_ids: [],
    cycles: [],
  });
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const options = parseOptions();
  fs.mkdirSync(options.outDir, { recursive: true });
  const statePath = path.join(options.outDir, 'state.json');
  const state = loadState(statePath);
  const processed = new Set(state.processed_product_ids || []);
  const categoryPatched = new Set(state.category_patched_product_ids || []);
  const finalSummary = {
    status: 'ok',
    mode: options.write ? 'write' : 'dry_run',
    out_dir: options.outDir,
    cycles: [],
    total_selected: 0,
    total_published: 0,
    stopped_reason: '',
  };

  for (let cycle = 1; cycle <= options.maxCycles; cycle += 1) {
    const cycleId = String(cycle).padStart(3, '0');
    const cycleDir = path.join(options.outDir, `cycle_${cycleId}`);
    const auditDir = path.join(cycleDir, 'audit');
    fs.mkdirSync(cycleDir, { recursive: true });

    log(`cycle ${cycleId}: audit market=${options.market}${options.domain ? ` domain=${options.domain}` : ''}`);
    const auditRun = runNodeScript(
      path.join(rootDir, 'scripts/audit-kb-commerce-index-readiness.cjs'),
      buildAuditArgs(options, auditDir),
      {
        cwd: rootDir,
        stdoutPath: path.join(cycleDir, 'audit.stdout.json'),
        stderrPath: path.join(cycleDir, 'audit.stderr.log'),
      },
    );
    const inventoryPath = path.join(auditDir, 'commerce_index_kb_readiness_inventory.json');
    const inventoryRows = readJson(inventoryPath, []);
    const planRows = buildPlanRows(inventoryRows);
    const planSummary = summarizePlan(planRows);
    writeJson(path.join(cycleDir, 'upgrade_plan.json'), { summary: planSummary, rows: planRows });
    writeCsv(path.join(cycleDir, 'upgrade_plan.csv'), planRows, [
      'external_product_id',
      'title',
      'domain',
      'action',
      'lane',
      'reason',
      'main_blocker',
      'recommended_lane',
      'kb_status',
      'kb_quality_state',
      'kb_evidence_profile',
      'identity_status',
      'catalog_attached',
      'index_serving_eligible',
      'commerce_doc_public',
      'terminal_hold',
      'terminal_hold_reason',
      'seed_missing_fields',
    ]);

    const categoryPatchIds = planRows
      .filter((row) => row.action === 'category_patch')
      .map((row) => row.external_product_id)
      .filter((id) => id && !categoryPatched.has(id))
      .slice(0, options.batchSize);
    const categoryPatchRows = inventoryRows.filter((row) => categoryPatchIds.includes(asString(row.external_product_id)));

    const candidateIds = planRows
      .filter((row) => row.action === 'insight_rewrite')
      .map((row) => row.external_product_id)
      .filter((id) => id && !processed.has(id))
      .slice(0, options.batchSize);
    const selectedInventoryRows = inventoryRows.filter((row) => candidateIds.includes(asString(row.external_product_id)));
    writeJson(path.join(cycleDir, 'selected_inventory.json'), selectedInventoryRows);

    const cycleSummary = {
      cycle,
      audit_duration_ms: auditRun.duration_ms,
      scanned: inventoryRows.length,
      plan_summary: planSummary,
      selected_ids: candidateIds,
      category_patch_ids: categoryPatchIds,
      report_rows: 0,
      validated_entries: 0,
      published_entries: 0,
      category_patch_planned: categoryPatchIds.length,
      category_patch_applied: false,
      sync_applied: false,
      relgraph_routine_ran: false,
      artifacts: {
        audit_dir: auditDir,
        plan: path.join(cycleDir, 'upgrade_plan.json'),
        selected_inventory: path.join(cycleDir, 'selected_inventory.json'),
      },
    };

    if (categoryPatchIds.length) {
      const manifestPath = path.join(cycleDir, 'category_patch_manifest.json');
      const dryRunPath = path.join(cycleDir, 'category_patch_dry_run.json');
      writeJson(manifestPath, buildCategoryPatchManifest(categoryPatchRows, options));
      cycleSummary.artifacts.category_patch_manifest = manifestPath;

      log(`cycle ${cycleId}: validate category patches rows=${categoryPatchIds.length}`);
      runNodeScript(
        path.join(rootDir, 'scripts/apply-reviewed-external-seed-category-patch.cjs'),
        buildCategoryPatchArgs(manifestPath, dryRunPath, options, { write: false }),
        {
          cwd: rootDir,
          stdoutPath: path.join(cycleDir, 'category_patch_dry_run.stdout.json'),
          stderrPath: path.join(cycleDir, 'category_patch_dry_run.stderr.log'),
        },
      );
      cycleSummary.artifacts.category_patch_dry_run = dryRunPath;

      if (options.write) {
        const writePath = path.join(cycleDir, 'category_patch_write.json');
        log(`cycle ${cycleId}: write category patches rows=${categoryPatchIds.length}`);
        runNodeScript(
          path.join(rootDir, 'scripts/apply-reviewed-external-seed-category-patch.cjs'),
          buildCategoryPatchArgs(manifestPath, writePath, options, { write: true }),
          {
            cwd: rootDir,
            stdoutPath: path.join(cycleDir, 'category_patch_write.stdout.json'),
            stderrPath: path.join(cycleDir, 'category_patch_write.stderr.log'),
          },
        );
        cycleSummary.category_patch_applied = true;
        cycleSummary.artifacts.category_patch_write = writePath;

        if (options.syncServingState) {
          const syncPath = path.join(cycleDir, 'category_patch_serving_sync.json');
          const affectedProductsPath = path.join(cycleDir, 'category_patch_affected_products.json');
          log(`cycle ${cycleId}: sync serving state after category patches ids=${categoryPatchIds.length}`);
          runNodeScript(
            path.join(rootDir, 'scripts/sync-external-seeds-to-catalog.cjs'),
            buildSyncArgs(categoryPatchIds, syncPath, { affectedProductsOut: affectedProductsPath }),
            {
              cwd: rootDir,
              stdoutPath: path.join(cycleDir, 'category_patch_serving_sync.stdout.json'),
              stderrPath: path.join(cycleDir, 'category_patch_serving_sync.stderr.log'),
            },
          );
          cycleSummary.sync_applied = true;
          cycleSummary.artifacts.category_patch_serving_sync = syncPath;
          cycleSummary.artifacts.category_patch_affected_products = affectedProductsPath;

          if (options.runRelgraphRoutine) {
            const relgraphDir = path.join(cycleDir, 'category_patch_relationship_graph');
            log(`cycle ${cycleId}: run relationship graph routine after category patch sync`);
            runNodeScript(
              path.join(rootDir, 'scripts/run-relationship-graph-sync-routine.js'),
              buildRelgraphSyncRoutineArgs(affectedProductsPath, relgraphDir, options),
              {
                cwd: rootDir,
                stdoutPath: path.join(cycleDir, 'category_patch_relationship_graph.stdout.json'),
                stderrPath: path.join(cycleDir, 'category_patch_relationship_graph.stderr.log'),
              },
            );
            cycleSummary.relgraph_routine_ran = true;
            cycleSummary.artifacts.category_patch_relationship_graph = path.join(
              relgraphDir,
              'sync_routine_summary.json',
            );
          }
        }

        for (const id of categoryPatchIds) categoryPatched.add(id);
        state.category_patched_product_ids = Array.from(categoryPatched);
        state.cycles.push(cycleSummary);
        writeJson(statePath, state);
      } else {
        finalSummary.stopped_reason = 'dry_run_complete';
      }

      finalSummary.total_selected += categoryPatchIds.length;
      finalSummary.cycles.push(cycleSummary);
      if (!options.write) break;
      continue;
    }

    if (!candidateIds.length) {
      finalSummary.cycles.push(cycleSummary);
      finalSummary.stopped_reason = 'no_safe_auto_apply_candidates';
      break;
    }

    const reportPath = path.join(cycleDir, 'product_intel_report.json');
    const batchName = `${options.batchName}_cycle_${cycleId}`;
    log(`cycle ${cycleId}: generate reviewed insight report rows=${candidateIds.length}`);
    runNodeScript(
      path.join(rootDir, 'scripts/build-reviewed-official-seed-product-intel-report.cjs'),
      buildReportArgs(options, path.join(cycleDir, 'selected_inventory.json'), reportPath, batchName),
      {
        cwd: rootDir,
        stdoutPath: path.join(cycleDir, 'build_report.stdout.json'),
        stderrPath: path.join(cycleDir, 'build_report.stderr.log'),
      },
    );
    const report = readJson(reportPath, { rows: [] });
    cycleSummary.report_rows = Array.isArray(report.rows) ? report.rows.length : 0;
    cycleSummary.artifacts.report = reportPath;

    const validatePath = path.join(cycleDir, 'publish_validate.json');
    log(`cycle ${cycleId}: validate replacements`);
    runNodeScript(
      path.join(rootDir, 'scripts/publish_product_intel_pilot_to_kb.js'),
      buildPublishArgs(reportPath, validatePath, { write: false }),
      {
        cwd: rootDir,
        stdoutPath: path.join(cycleDir, 'publish_validate.stdout.json'),
        stderrPath: path.join(cycleDir, 'publish_validate.stderr.log'),
      },
    );
    const validate = readJson(validatePath, {});
    cycleSummary.validated_entries = Array.isArray(validate.entries) ? validate.entries.length : 0;
    cycleSummary.artifacts.publish_validate = validatePath;

    if (options.write) {
      const writePath = path.join(cycleDir, 'publish_write.json');
      log(`cycle ${cycleId}: write Product Intel entries=${cycleSummary.validated_entries}`);
      runNodeScript(
        path.join(rootDir, 'scripts/publish_product_intel_pilot_to_kb.js'),
        buildPublishArgs(reportPath, writePath, { write: true }),
        {
          cwd: rootDir,
          stdoutPath: path.join(cycleDir, 'publish_write.stdout.json'),
          stderrPath: path.join(cycleDir, 'publish_write.stderr.log'),
        },
      );
      const writeResult = readJson(writePath, {});
      cycleSummary.published_entries = Array.isArray(writeResult.entries) ? writeResult.entries.length : 0;
      cycleSummary.artifacts.publish_write = writePath;

      if (options.syncServingState && cycleSummary.published_entries > 0) {
        const syncPath = path.join(cycleDir, 'serving_sync.json');
        const affectedProductsPath = path.join(cycleDir, 'serving_sync_affected_products.json');
        log(`cycle ${cycleId}: sync catalog serving state ids=${candidateIds.length}`);
        runNodeScript(
          path.join(rootDir, 'scripts/sync-external-seeds-to-catalog.cjs'),
          buildSyncArgs(candidateIds, syncPath, { affectedProductsOut: affectedProductsPath }),
          {
            cwd: rootDir,
            stdoutPath: path.join(cycleDir, 'serving_sync.stdout.json'),
            stderrPath: path.join(cycleDir, 'serving_sync.stderr.log'),
          },
        );
        cycleSummary.sync_applied = true;
        cycleSummary.artifacts.serving_sync = syncPath;
        cycleSummary.artifacts.serving_sync_affected_products = affectedProductsPath;

        if (options.runRelgraphRoutine) {
          const relgraphDir = path.join(cycleDir, 'relationship_graph');
          log(`cycle ${cycleId}: run relationship graph routine after catalog serving sync`);
          runNodeScript(
            path.join(rootDir, 'scripts/run-relationship-graph-sync-routine.js'),
            buildRelgraphSyncRoutineArgs(affectedProductsPath, relgraphDir, options),
            {
              cwd: rootDir,
              stdoutPath: path.join(cycleDir, 'relationship_graph.stdout.json'),
              stderrPath: path.join(cycleDir, 'relationship_graph.stderr.log'),
            },
          );
          cycleSummary.relgraph_routine_ran = true;
          cycleSummary.artifacts.relationship_graph = path.join(relgraphDir, 'sync_routine_summary.json');
        }
      }

      for (const id of candidateIds) processed.add(id);
      state.processed_product_ids = Array.from(processed);
      state.cycles.push(cycleSummary);
      writeJson(statePath, state);
    } else {
      finalSummary.stopped_reason = 'dry_run_complete';
    }

    finalSummary.total_selected += candidateIds.length;
    finalSummary.total_published += cycleSummary.published_entries;
    finalSummary.cycles.push(cycleSummary);

    if (!options.write) break;
  }

  if (!finalSummary.stopped_reason) finalSummary.stopped_reason = 'max_cycles_reached';
  writeJson(path.join(options.outDir, 'summary.json'), finalSummary);
  process.stdout.write(`${JSON.stringify(finalSummary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const payload = {
      status: 'error',
      message: error?.message || String(error),
      run: error?.run
        ? {
            command: error.run.command,
            exit_code: error.run.exit_code,
            stderr: asString(error.run.stderr).slice(0, 4000),
            stdout: asString(error.run.stdout).slice(0, 2000),
          }
        : null,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRM_TOKEN,
  buildAuditArgs,
  buildCategoryPatchArgs,
  buildCategoryPatchManifest,
  buildPlanRows,
  buildPublishArgs,
  buildReportArgs,
  buildRelgraphSyncRoutineArgs,
  buildSyncArgs,
  classifyInventoryRow,
  hasOfficialBrandSource,
  inferReviewedCategoryPatch,
  isSafeCategoryPatchCandidate,
  isSafeInsightRewriteCandidate,
  summarizePlan,
};
