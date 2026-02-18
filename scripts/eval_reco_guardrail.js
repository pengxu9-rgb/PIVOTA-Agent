#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_OUT_JSON = 'artifacts/reco_guardrail_report.json';
const DEFAULT_OUT_MD = 'artifacts/reco_guardrail_report.md';
const DEFAULT_TOP_K = 5;

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normText(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function uniqStrings(values, max = 128) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const token = String(raw == null ? '' : raw).trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

function parseArgs(argv) {
  const out = {
    inPath: '',
    outJson: DEFAULT_OUT_JSON,
    outMd: DEFAULT_OUT_MD,
    k: DEFAULT_TOP_K,
    failOnRedline: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--in' && next) {
      out.inPath = next;
      i += 1;
      continue;
    }
    if (token === '--out-json' && next) {
      out.outJson = next;
      i += 1;
      continue;
    }
    if (token === '--out-md' && next) {
      out.outMd = next;
      i += 1;
      continue;
    }
    if (token === '--k' && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.k = Math.max(1, Math.min(20, Math.trunc(n)));
      i += 1;
      continue;
    }
    if (token === '--fail-on-redline') {
      out.failOnRedline = true;
      continue;
    }
    if (token === '--quiet') {
      out.quiet = true;
      continue;
    }
  }

  return out;
}

function extractProductAnalysisPayload(row) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    if (row.competitors || row.related_products || row.dupes) return row;
    if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
      const p = row.payload;
      if (p.competitors || p.related_products || p.dupes) return p;
    }
    const cards = Array.isArray(row.cards) ? row.cards : [];
    const productCard = cards.find((card) => String(card && card.type || '').trim().toLowerCase() === 'product_analysis');
    if (productCard && productCard.payload && typeof productCard.payload === 'object' && !Array.isArray(productCard.payload)) {
      return productCard.payload;
    }
    if (row.envelope && typeof row.envelope === 'object' && !Array.isArray(row.envelope)) {
      return extractProductAnalysisPayload(row.envelope);
    }
  }
  return null;
}

function extractArrayFromKnownPaths(row, paths) {
  for (const parts of paths) {
    let current = row;
    let ok = true;
    for (const key of parts) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        ok = false;
        break;
      }
      current = current[key];
    }
    if (ok && Array.isArray(current)) {
      return current;
    }
  }
  return [];
}

function extractLabels(row, payload) {
  if (row && typeof row === 'object' && row.labels && typeof row.labels === 'object') return row.labels;
  if (payload && typeof payload === 'object' && payload.labels && typeof payload.labels === 'object') return payload.labels;
  return {};
}

function collectImplicitRelevantIds(row) {
  const ids = [];
  const knownArrayPaths = [
    ['implicit_feedback', 'clicked_ids'],
    ['implicit_feedback', 'selected_ids'],
    ['implicit_feedback', 'compared_ids'],
    ['clicked_product_ids'],
    ['selected_product_ids'],
    ['compared_product_ids'],
    ['feedback', 'clicked_ids'],
    ['feedback', 'selected_ids'],
  ];
  for (const arr of extractArrayFromKnownPaths(row, knownArrayPaths)) {
    ids.push(arr);
  }

  const events = Array.isArray(row && row.events) ? row.events : [];
  for (const event of events) {
    const eventName = normText(event && event.event_name);
    if (!eventName) continue;
    const data = event && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
    if (/clicked|selected|compare|outbound_opened|dupe_compare/.test(eventName)) {
      ids.push(
        data.product_id,
        data.productId,
        data.sku_id,
        data.skuId,
        data.anchor_product_id,
      );
      const list = Array.isArray(data.product_ids) ? data.product_ids : [];
      for (const item of list) ids.push(item);
    }
  }

  return uniqStrings(ids, 64);
}

function extractRelevance(row, payload) {
  const labels = extractLabels(row, payload);
  const relevantIds = uniqStrings(
    labels.relevant_ids || labels.relevantIds || labels.positive_ids || labels.positiveIds,
    64,
  );

  const relevanceMap = {};
  if (labels.relevance_map && typeof labels.relevance_map === 'object' && !Array.isArray(labels.relevance_map)) {
    for (const [key, value] of Object.entries(labels.relevance_map)) {
      const id = String(key || '').trim();
      if (!id) continue;
      const rel = toNumber(value, 0);
      if (!Number.isFinite(rel) || rel <= 0) continue;
      relevanceMap[id.toLowerCase()] = rel;
    }
  }

  if (Object.keys(relevanceMap).length) {
    return { map: relevanceMap, source: 'labels.relevance_map' };
  }
  if (relevantIds.length) {
    const map = {};
    for (const id of relevantIds) map[id.toLowerCase()] = 1;
    return { map, source: 'labels.relevant_ids' };
  }

  const implicit = collectImplicitRelevantIds(row);
  if (implicit.length) {
    const map = {};
    for (const id of implicit) map[String(id).toLowerCase()] = 1;
    return { map, source: 'implicit_feedback' };
  }

  return { map: null, source: 'missing' };
}

function candidateId(candidate, index) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const id = row.product_id || row.productId || row.sku_id || row.skuId || row.id || row.name || `idx:${index}`;
  return String(id || '').trim();
}

function candidateBrand(candidate) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  return String(row.brand_id || row.brandId || row.brand || row.brand_name || row.brandName || '').trim();
}

function candidateSourceType(candidate) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  return String((row.source && row.source.type) || row.source_type || row.sourceType || '').trim();
}

function getAnchorBrand(payload, row) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const assessment = p.assessment && typeof p.assessment === 'object' && !Array.isArray(p.assessment) ? p.assessment : {};
  const anchor = assessment.anchor_product && typeof assessment.anchor_product === 'object' && !Array.isArray(assessment.anchor_product)
    ? assessment.anchor_product
    : {};
  const direct = anchor.brand_id || anchor.brandId || anchor.brand || p.anchor_brand_id || p.anchorBrandId;
  if (String(direct || '').trim()) return String(direct).trim();

  const rowAnchor = row && typeof row === 'object' && !Array.isArray(row) ? row.anchor || row.anchor_product || null : null;
  if (rowAnchor && typeof rowAnchor === 'object') {
    return String(rowAnchor.brand_id || rowAnchor.brandId || rowAnchor.brand || '').trim();
  }
  return '';
}

function computeRecallAtK(predictedIds, relevanceMap, k) {
  const relevant = Object.entries(relevanceMap || {}).filter(([, rel]) => Number(rel) > 0).map(([id]) => id);
  if (!relevant.length) return null;
  const topK = new Set((Array.isArray(predictedIds) ? predictedIds : []).slice(0, k).map((id) => String(id || '').toLowerCase()));
  let hit = 0;
  for (const id of relevant) {
    if (topK.has(String(id).toLowerCase())) hit += 1;
  }
  return hit / relevant.length;
}

function computeNdcgAtK(predictedIds, relevanceMap, k) {
  const gains = [];
  const predicted = Array.isArray(predictedIds) ? predictedIds.slice(0, k) : [];
  for (let i = 0; i < predicted.length; i += 1) {
    const id = String(predicted[i] || '').toLowerCase();
    const rel = Number((relevanceMap && relevanceMap[id]) || 0);
    const dcg = (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    gains.push(dcg);
  }
  const dcg = gains.reduce((sum, value) => sum + value, 0);

  const idealRels = Object.values(relevanceMap || {})
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  if (!idealRels.length) return null;

  const idcg = idealRels.reduce((sum, rel, index) => sum + ((Math.pow(2, rel) - 1) / Math.log2(index + 2)), 0);
  if (!(idcg > 0)) return null;
  return dcg / idcg;
}

function scoreKeysForBlock(block) {
  const token = normText(block);
  if (token === 'related_products') return ['brand_affinity', 'co_view', 'kb_routine'];
  if (token === 'dupes') {
    return [
      'category_use_case_match',
      'ingredient_functional_similarity',
      'skin_fit_similarity',
      'social_reference_strength',
      'price_distance',
      'brand_constraint',
    ];
  }
  return [
    'category_use_case_match',
    'ingredient_functional_similarity',
    'skin_fit_similarity',
    'social_reference_strength',
    'price_distance',
    'quality',
    'brand_constraint',
  ];
}

const FEATURE_REASON_KEYWORDS = {
  category_use_case_match: ['category', 'use-case', 'scenario', '品类', '场景'],
  ingredient_functional_similarity: ['ingredient', 'active', '成分', '活性'],
  skin_fit_similarity: ['skin profile', 'skin type', 'sensitive', '肤质', '敏感'],
  social_reference_strength: ['social', 'public', 'community', '社交', '反馈'],
  price_distance: ['price', 'budget', 'cost', '价格', '预算'],
  quality: ['source quality', 'evidence coverage', '证据', '来源质量'],
  brand_constraint: ['cross-brand', '品牌'],
  brand_affinity: ['brand affinity', '品牌关联'],
  co_view: ['co-view', '共现'],
  kb_routine: ['routine', '组合', '搭配'],
};

function normalizeReasonsText(whyCandidate) {
  if (!whyCandidate) return '';
  if (Array.isArray(whyCandidate)) {
    return whyCandidate.map((item) => String(item || '').toLowerCase()).join(' | ');
  }
  if (typeof whyCandidate === 'object') {
    const reasons = Array.isArray(whyCandidate.reasons_user_visible) ? whyCandidate.reasons_user_visible : [];
    const summary = typeof whyCandidate.summary === 'string' ? whyCandidate.summary : '';
    return [summary, ...reasons].map((item) => String(item || '').toLowerCase()).join(' | ');
  }
  return String(whyCandidate || '').toLowerCase();
}

function explanationAlignedAt3(candidate, block) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const breakdown = row.score_breakdown && typeof row.score_breakdown === 'object' && !Array.isArray(row.score_breakdown)
    ? row.score_breakdown
    : {};

  const scored = [];
  for (const key of scoreKeysForBlock(block)) {
    const value = Number(breakdown[key]);
    if (!Number.isFinite(value)) continue;
    scored.push({ key, value });
  }
  if (!scored.length) return false;

  scored.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.key.localeCompare(b.key);
  });

  const top3 = scored.slice(0, 3);
  const reasonsText = normalizeReasonsText(row.why_candidate);
  if (!reasonsText.trim()) return false;

  for (const item of top3) {
    const keywords = FEATURE_REASON_KEYWORDS[item.key] || [];
    const matched = keywords.some((keyword) => reasonsText.includes(normText(keyword)));
    if (!matched) return false;
  }
  return true;
}

function getBlockCandidates(payload, block) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const blockObj = p[block] && typeof p[block] === 'object' && !Array.isArray(p[block]) ? p[block] : {};
  return Array.isArray(blockObj.candidates) ? blockObj.candidates : [];
}

function safeRate(numerator, denominator) {
  if (!(denominator > 0)) return null;
  return numerator / denominator;
}

function computeMetrics(rows, { k }) {
  const blockStats = {
    competitors: {
      samples: 0,
      candidates: 0,
      source_type_breakdown: {},
      same_brand_hits: 0,
      on_page_hits: 0,
      alignment: { aligned: 0, total: 0 },
    },
    related_products: {
      samples: 0,
      candidates: 0,
      source_type_breakdown: {},
      alignment: { aligned: 0, total: 0 },
    },
    dupes: {
      samples: 0,
      candidates: 0,
      source_type_breakdown: {},
      alignment: { aligned: 0, total: 0 },
    },
  };

  const recallScores = [];
  const ndcgScores = [];
  let relevanceEvaluatedSamples = 0;
  let skippedNoPayload = 0;
  let skippedNoRelevance = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = extractProductAnalysisPayload(row);
    if (!payload) {
      skippedNoPayload += 1;
      continue;
    }

    const anchorBrand = normText(getAnchorBrand(payload, row));

    for (const block of ['competitors', 'related_products', 'dupes']) {
      const candidates = getBlockCandidates(payload, block);
      const stat = blockStats[block];
      stat.samples += 1;
      stat.candidates += candidates.length;

      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const sourceType = normText(candidateSourceType(candidate)) || 'unknown';
        stat.source_type_breakdown[sourceType] = Number(stat.source_type_breakdown[sourceType] || 0) + 1;

        const aligned = explanationAlignedAt3(candidate, block);
        stat.alignment.total += 1;
        if (aligned) stat.alignment.aligned += 1;

        if (block === 'competitors') {
          const cBrand = normText(candidateBrand(candidate));
          if (anchorBrand && cBrand && anchorBrand === cBrand) stat.same_brand_hits += 1;
          if (sourceType === 'on_page_related') stat.on_page_hits += 1;
        }
      }
    }

    const relevance = extractRelevance(row, payload);
    if (!relevance.map) {
      skippedNoRelevance += 1;
      continue;
    }

    const competitorCandidates = getBlockCandidates(payload, 'competitors');
    const predictedIds = competitorCandidates.slice(0, k).map((candidate, index) => candidateId(candidate, index));
    const recall = computeRecallAtK(predictedIds, relevance.map, k);
    const ndcg = computeNdcgAtK(predictedIds, relevance.map, k);
    if (recall != null) recallScores.push(recall);
    if (ndcg != null) ndcgScores.push(ndcg);
    relevanceEvaluatedSamples += 1;
  }

  const comp = blockStats.competitors;
  const compSameBrandRate = safeRate(comp.same_brand_hits, comp.candidates);
  const compOnPageRate = safeRate(comp.on_page_hits, comp.candidates);

  const alignmentTotal =
    blockStats.competitors.alignment.total
    + blockStats.related_products.alignment.total
    + blockStats.dupes.alignment.total;
  const alignmentAligned =
    blockStats.competitors.alignment.aligned
    + blockStats.related_products.alignment.aligned
    + blockStats.dupes.alignment.aligned;

  const metrics = {
    recall_at_k: recallScores.length
      ? recallScores.reduce((sum, value) => sum + value, 0) / recallScores.length
      : null,
    ndcg_at_k: ndcgScores.length
      ? ndcgScores.reduce((sum, value) => sum + value, 0) / ndcgScores.length
      : null,
    competitors_same_brand_rate: compSameBrandRate,
    competitors_on_page_source_rate: compOnPageRate,
    explanation_alignment_at_3: safeRate(alignmentAligned, alignmentTotal),
  };

  for (const key of Object.keys(blockStats)) {
    const stat = blockStats[key];
    stat.alignment.rate = safeRate(stat.alignment.aligned, stat.alignment.total);
  }

  return {
    metrics,
    by_block: blockStats,
    samples: {
      total: Array.isArray(rows) ? rows.length : 0,
      relevance_evaluated: relevanceEvaluatedSamples,
      skipped_no_payload: skippedNoPayload,
      skipped_no_relevance: skippedNoRelevance,
    },
  };
}

function readThresholds() {
  const thresholds = {
    explanation_alignment_min: toNumber(process.env.RECO_GUARDRAIL_ALIGNMENT_MIN, 0.95),
    recall_at_k_min: toNumber(process.env.RECO_GUARDRAIL_RECALL_MIN, null),
    ndcg_at_k_min: toNumber(process.env.RECO_GUARDRAIL_NDCG_MIN, null),
  };
  return thresholds;
}

function evaluateGates(metrics, thresholds) {
  const violations = [];
  const warnings = [];

  if (Number(metrics.competitors_same_brand_rate || 0) > 0) {
    violations.push('competitors_same_brand_rate_gt_zero');
  }
  if (Number(metrics.competitors_on_page_source_rate || 0) > 0) {
    violations.push('competitors_on_page_source_rate_gt_zero');
  }

  if (metrics.explanation_alignment_at_3 != null && thresholds.explanation_alignment_min != null) {
    if (metrics.explanation_alignment_at_3 < thresholds.explanation_alignment_min) {
      warnings.push('explanation_alignment_below_threshold');
    }
  }
  if (thresholds.recall_at_k_min != null && metrics.recall_at_k != null && metrics.recall_at_k < thresholds.recall_at_k_min) {
    warnings.push('recall_at_k_below_threshold');
  }
  if (thresholds.ndcg_at_k_min != null && metrics.ndcg_at_k != null && metrics.ndcg_at_k < thresholds.ndcg_at_k_min) {
    warnings.push('ndcg_at_k_below_threshold');
  }

  return {
    hard_fail: violations.length > 0,
    violations,
    warnings,
    thresholds,
  };
}

function toPct(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Reco Guardrail Report');
  lines.push('');
  lines.push(`- generated_at: ${report.generated_at}`);
  lines.push(`- input: \`${report.input}\``);
  lines.push(`- top_k: ${report.top_k}`);
  lines.push(`- total_samples: ${report.samples.total}`);
  lines.push(`- relevance_evaluated: ${report.samples.relevance_evaluated}`);
  lines.push(`- hard_fail: ${report.gates.hard_fail}`);
  lines.push('');

  lines.push('## Metrics');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| recall_at_k | ${toPct(report.metrics.recall_at_k)} |`);
  lines.push(`| ndcg_at_k | ${toPct(report.metrics.ndcg_at_k)} |`);
  lines.push(`| competitors_same_brand_rate | ${toPct(report.metrics.competitors_same_brand_rate)} |`);
  lines.push(`| competitors_on_page_source_rate | ${toPct(report.metrics.competitors_on_page_source_rate)} |`);
  lines.push(`| explanation_alignment_at_3 | ${toPct(report.metrics.explanation_alignment_at_3)} |`);
  lines.push('');

  lines.push('## Gates');
  lines.push('');
  lines.push(`- hard_fail: ${report.gates.hard_fail}`);
  lines.push(`- violations: ${report.gates.violations.length ? report.gates.violations.join(', ') : 'none'}`);
  lines.push(`- warnings: ${report.gates.warnings.length ? report.gates.warnings.join(', ') : 'none'}`);
  lines.push('');

  lines.push('## By Block');
  lines.push('');
  lines.push('| block | samples | candidates | alignment@3 | same_brand_hits | on_page_hits |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const block of ['competitors', 'related_products', 'dupes']) {
    const stat = report.by_block[block] || { samples: 0, candidates: 0, alignment: { rate: null }, same_brand_hits: 0, on_page_hits: 0 };
    lines.push(`| ${block} | ${stat.samples} | ${stat.candidates} | ${toPct(stat.alignment.rate)} | ${stat.same_brand_hits || 0} | ${stat.on_page_hits || 0} |`);
  }

  lines.push('');
  lines.push('## Skip Stats');
  lines.push('');
  lines.push(`- skipped_no_payload: ${report.samples.skipped_no_payload}`);
  lines.push(`- skipped_no_relevance: ${report.samples.skipped_no_relevance}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function readRows(inputPath) {
  const absPath = path.resolve(inputPath);
  const raw = await fs.readFile(absPath, 'utf8');
  if (/\.jsonl$/i.test(absPath)) {
    const rows = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      rows.push(JSON.parse(text));
    }
    return rows;
  }

  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows)) return parsed.rows;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.samples)) return parsed.samples;
  return [parsed];
}

async function writeFileWithDir(filePath, content) {
  const absPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
  return absPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inPath) {
    console.error('missing required argument: --in <jsonl|json>');
    process.exit(2);
  }

  const rows = await readRows(args.inPath);
  const computed = computeMetrics(rows, { k: args.k });
  const thresholds = readThresholds();
  const gates = evaluateGates(computed.metrics, thresholds);

  const report = {
    generated_at: new Date().toISOString(),
    input: args.inPath,
    top_k: args.k,
    metrics: computed.metrics,
    gates,
    by_block: computed.by_block,
    samples: computed.samples,
  };

  const outJsonPath = await writeFileWithDir(args.outJson, `${JSON.stringify(report, null, 2)}\n`);
  const outMdPath = await writeFileWithDir(args.outMd, renderMarkdown(report));

  if (!args.quiet) {
    console.log(JSON.stringify({
      out_json: outJsonPath,
      out_md: outMdPath,
      hard_fail: gates.hard_fail,
      violations: gates.violations,
      warnings: gates.warnings,
    }, null, 2));
  }

  if (args.failOnRedline && gates.hard_fail) {
    process.exit(3);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
