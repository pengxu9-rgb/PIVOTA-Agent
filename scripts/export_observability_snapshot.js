#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {
    inputJsonl: [],
    windows: ['24h', '7d'],
    sample: 1,
    outDir: '',
    casebookTop: 50,
    kMin: 6,
    maxSamplesPerQuery: 3,
    now: new Date(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = String(argv[i] || '');
    const next = argv[i + 1];
    if (key === '--input-jsonl' && next) args.inputJsonl.push(String(next));
    if (key === '--windows' && next) args.windows = String(next).split(',').map((v) => v.trim()).filter(Boolean);
    if (key === '--sample' && next) args.sample = Math.max(0, Math.min(1, Number(next) || 0));
    if (key === '--out-dir' && next) args.outDir = String(next);
    if (key === '--casebook-top' && next) args.casebookTop = Math.max(1, Number(next) || 50);
    if (key === '--k-min' && next) args.kMin = Math.max(1, Number(next) || 6);
    if (key === '--max-samples-per-query' && next) args.maxSamplesPerQuery = Math.max(1, Number(next) || 3);
    if (key === '--now' && next) {
      const parsedNow = new Date(next);
      if (!Number.isNaN(parsedNow.getTime())) args.now = parsedNow;
    }
  }

  if (!args.inputJsonl.length && process.env.OBS_SNAPSHOT_INPUT_JSONL) {
    args.inputJsonl = String(process.env.OBS_SNAPSHOT_INPUT_JSONL)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (!args.inputJsonl.length) {
    throw new Error('Missing --input-jsonl (one or more JSONL files containing debug_bundle logs).');
  }
  if (!args.outDir) {
    const stamp = nowIso().replace(/[:.]/g, '-');
    args.outDir = path.resolve('reports', `observability_snapshot_${stamp}`);
  } else {
    args.outDir = path.resolve(args.outDir);
  }
  return args;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMsHours(hours) {
  return Number(hours) * 60 * 60 * 1000;
}

function parseWindow(windowKey) {
  const key = String(windowKey || '').trim().toLowerCase();
  if (key === '24h') return { key: '24h', ms: toMsHours(24) };
  if (key === '7d') return { key: '7d', ms: toMsHours(24 * 7) };
  throw new Error(`Unsupported window: ${windowKey}`);
}

async function* readJsonLines(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch (_err) {
      // ignore malformed line
    }
  }
}

function isLikelyBundleObject(obj) {
  return obj && typeof obj === 'object' && obj.req_id && obj.result_type && obj.latency_ms;
}

function extractDebugBundle(record) {
  if (!record || typeof record !== 'object') return null;
  if (isLikelyBundleObject(record)) return record;
  if (isLikelyBundleObject(record.debug_bundle)) return record.debug_bundle;
  if (isLikelyBundleObject(record?.data?.debug_bundle)) return record.data.debug_bundle;
  return null;
}

function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const rank = Math.ceil((Number(p) / 100) * sortedValues.length) - 1;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, rank));
  return sortedValues[idx];
}

function anyDegrade(degrade) {
  return Boolean(degrade?.nlu_degraded || degrade?.vector_skipped || degrade?.behavior_skipped);
}

function normalizeDomain(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'sports_outdoor' || value === 'outdoor') return 'hiking';
  if (value === 'pet_supplies') return 'pet';
  return value;
}

function allowedDomainsBySlot(slotDomain) {
  const domain = normalizeDomain(slotDomain);
  if (!domain) return null;
  if (domain === 'beauty') return new Set(['beauty']);
  if (domain === 'pet') return new Set(['pet']);
  if (domain === 'travel') return new Set(['travel']);
  if (domain === 'hiking') return new Set(['hiking']);
  return null;
}

function calcCrossDomainRatio(bundle) {
  const expected = bundle?.nlu?.slots?.domain || null;
  const allow = allowedDomainsBySlot(expected);
  if (!allow) return null;
  const topItems = Array.isArray(bundle?.top_items) ? bundle.top_items : [];
  const domains = topItems
    .map((item) => normalizeDomain(item?.domain))
    .filter(Boolean);
  if (!domains.length) return null;
  const cross = domains.filter((domain) => !allow.has(domain)).length;
  return cross / domains.length;
}

function toCsv(rows, headers) {
  const esc = (value) => {
    if (value == null) return '';
    const text = String(value);
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((key) => esc(row[key])).join(',')),
  ].join('\n');
}

function mean(values) {
  const list = values.filter((v) => Number.isFinite(Number(v))).map(Number);
  if (!list.length) return null;
  return list.reduce((sum, v) => sum + v, 0) / list.length;
}

function summarizeGroup(bundles, opts = {}) {
  const kMin = Number(opts.kMin || 6);
  const reqCnt = bundles.length;
  const latTotal = bundles.map((b) => Number(b?.latency_ms?.total || 0)).sort((a, b) => a - b);
  const nluLat = bundles.map((b) => Number(b?.latency_ms?.nlu || 0)).sort((a, b) => a - b);
  const lexicalLat = bundles.map((b) => Number(b?.latency_ms?.lexical || 0)).sort((a, b) => a - b);
  const vectorLat = bundles.map((b) => Number(b?.latency_ms?.vector || 0)).sort((a, b) => a - b);
  const behaviorLat = bundles.map((b) => Number(b?.latency_ms?.behavior || 0)).sort((a, b) => a - b);
  const rankLat = bundles.map((b) => Number(b?.latency_ms?.rank || 0)).sort((a, b) => a - b);

  const reqWithExternal = bundles.filter((bundle) => {
    const topItems = Array.isArray(bundle?.top_items) ? bundle.top_items : [];
    if (topItems.some((item) => String(item?.source || '') === 'external')) return true;
    return Number(bundle?.recall?.counts_raw?.external_seed || 0) > 0;
  }).length;
  const reqNoCandidates = bundles.filter((bundle) => Number(bundle?.post?.candidates || 0) < kMin).length;
  const reqPreFilterCandidates = bundles.filter(
    (bundle) => Number(bundle?.recall?.pre_filter_candidates ?? bundle?.recall?.counts_after_dedup ?? 0) > 0,
  ).length;
  const reqFilteredToEmpty = bundles.filter((bundle) => {
    const pre = Number(bundle?.recall?.pre_filter_candidates ?? bundle?.recall?.counts_after_dedup ?? 0);
    const post = Number(bundle?.post?.candidates || 0);
    return pre > 0 && post === 0;
  }).length;
  const reqTimeoutLike = bundles.filter((bundle) => String(bundle?.reason_code || '') === 'UPSTREAM_DEGRADED').length;
  const reqVectorSkipped = bundles.filter((bundle) => Boolean(bundle?.degrade?.vector_skipped)).length;
  const reqNluDegraded = bundles.filter((bundle) => Boolean(bundle?.degrade?.nlu_degraded)).length;
  const reqBehaviorSkipped = bundles.filter((bundle) => Boolean(bundle?.degrade?.behavior_skipped)).length;
  const reqFallback = bundles.filter((bundle) => anyDegrade(bundle?.degrade)).length;
  const reqProductList = bundles.filter((bundle) => String(bundle?.result_type || '') === 'product_list').length;
  const reqClarify = bundles.filter((bundle) => String(bundle?.result_type || '') === 'clarify').length;
  const reqStrictEmpty = bundles.filter((bundle) => String(bundle?.result_type || '') === 'strict_empty').length;
  const domainEntropy = bundles.map((bundle) => safeNumber(bundle?.post?.domain_entropy_topK)).filter((v) => v != null);
  const anchorRatio = bundles.map((bundle) => safeNumber(bundle?.post?.lexical_anchor_ratio_topK)).filter((v) => v != null);
  const crossDomainRatios = bundles.map(calcCrossDomainRatio).filter((v) => v != null);
  const domainDropRatios = bundles
    .map((bundle) => {
      const pre = Number(bundle?.recall?.pre_filter_candidates ?? bundle?.recall?.counts_after_dedup ?? 0);
      if (!Number.isFinite(pre) || pre <= 0) return null;
      return Number(bundle?.recall?.drops?.domain_filter || 0) / pre;
    })
    .filter((v) => v != null);
  const inventoryDropRatios = bundles
    .map((bundle) => {
      const pre = Number(bundle?.recall?.pre_filter_candidates ?? bundle?.recall?.counts_after_dedup ?? 0);
      if (!Number.isFinite(pre) || pre <= 0) return null;
      return Number(bundle?.recall?.drops?.inventory_filter || 0) / pre;
    })
    .filter((v) => v != null);
  const constraintDropRatios = bundles
    .map((bundle) => {
      const pre = Number(bundle?.recall?.pre_filter_candidates ?? bundle?.recall?.counts_after_dedup ?? 0);
      if (!Number.isFinite(pre) || pre <= 0) return null;
      return Number(bundle?.recall?.drops?.constraints_filter || 0) / pre;
    })
    .filter((v) => v != null);

  return {
    req_cnt: reqCnt,
    p50_total_latency_ms: percentile(latTotal, 50),
    p95_total_latency_ms: percentile(latTotal, 95),
    p99_total_latency_ms: percentile(latTotal, 99),
    p95_nlu_latency_ms: percentile(nluLat, 95),
    p95_lexical_latency_ms: percentile(lexicalLat, 95),
    p95_vector_latency_ms: percentile(vectorLat, 95),
    p95_behavior_latency_ms: percentile(behaviorLat, 95),
    p95_rank_latency_ms: percentile(rankLat, 95),
    timeout_rate_upstream: reqCnt ? reqTimeoutLike / reqCnt : 0,
    timeout_rate_vector_skipped: reqCnt ? reqVectorSkipped / reqCnt : 0,
    timeout_rate_nlu_degraded: reqCnt ? reqNluDegraded / reqCnt : 0,
    timeout_rate_behavior_skipped: reqCnt ? reqBehaviorSkipped / reqCnt : 0,
    fallback_rate: reqCnt ? reqFallback / reqCnt : 0,
    product_list_rate: reqCnt ? reqProductList / reqCnt : 0,
    clarify_rate: reqCnt ? reqClarify / reqCnt : 0,
    strict_empty_rate: reqCnt ? reqStrictEmpty / reqCnt : 0,
    external_fill_rate: reqCnt ? reqWithExternal / reqCnt : 0,
    no_candidate_rate: reqCnt ? reqNoCandidates / reqCnt : 0,
    pre_filter_candidate_rate: reqCnt ? reqPreFilterCandidates / reqCnt : 0,
    filtered_to_empty_rate: reqCnt ? reqFilteredToEmpty / reqCnt : 0,
    domain_drop_ratio: mean(domainDropRatios),
    inventory_drop_ratio: mean(inventoryDropRatios),
    constraint_drop_ratio: mean(constraintDropRatios),
    non_empty_rate: reqCnt ? reqProductList / reqCnt : 0,
    domain_entropy_topk_avg: mean(domainEntropy),
    domain_entropy_topk_p95: domainEntropy.length
      ? percentile([...domainEntropy].sort((a, b) => a - b), 95)
      : null,
    cross_domain_in_topk_rate: mean(crossDomainRatios),
    lexical_anchor_ratio_topk: mean(anchorRatio),
  };
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = String(keyFn(item) ?? 'unknown');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

function buildHealthRows(bundles, windowKey, kMin) {
  const rows = [];
  const pushRows = (groupType, grouped) => {
    for (const [groupKey, list] of grouped.entries()) {
      rows.push({
        window: windowKey,
        group_type: groupType,
        group_key: groupKey,
        ...summarizeGroup(list, { kMin }),
      });
    }
  };
  pushRows('overall', new Map([['all', bundles]]));
  pushRows('intent', groupBy(bundles, (bundle) => bundle?.nlu?.intent_top1 || 'unknown'));
  pushRows('domain', groupBy(bundles, (bundle) => bundle?.nlu?.slots?.domain || 'unknown'));
  pushRows('result_type', groupBy(bundles, (bundle) => bundle?.result_type || 'unknown'));
  pushRows(
    'degrade',
    groupBy(bundles, (bundle) => (anyDegrade(bundle?.degrade) ? 'degraded' : 'clean')),
  );
  return rows;
}

function buildQualityRows(healthRows) {
  return healthRows.map((row) => ({
    window: row.window,
    group_type: row.group_type,
    group_key: row.group_key,
    req_cnt: row.req_cnt,
    non_empty_rate: row.non_empty_rate,
    domain_entropy_topk_avg: row.domain_entropy_topk_avg,
    domain_entropy_topk_p95: row.domain_entropy_topk_p95,
    cross_domain_in_topk_rate: row.cross_domain_in_topk_rate,
    lexical_anchor_ratio_topk: row.lexical_anchor_ratio_topk,
  }));
}

function mode(values) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value || 'unknown');
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }
  let bestKey = 'unknown';
  let bestCnt = 0;
  for (const [key, count] of counts.entries()) {
    if (count > bestCnt) {
      bestCnt = count;
      bestKey = key;
    }
  }
  return bestKey;
}

function summarizeCaseBundle(bundle) {
  return {
    req_id: bundle.req_id,
    ts: bundle.ts,
    result_type: bundle.result_type,
    reason_code: bundle.reason_code,
    summary: [
      `U_pre=${bundle?.nlu?.U_pre == null ? 'null' : Number(bundle.nlu.U_pre).toFixed(3)}`,
      `U_post=${bundle?.post?.U_post == null ? 'null' : Number(bundle.post.U_post).toFixed(3)}`,
      `domain_entropy_topK=${
        bundle?.post?.domain_entropy_topK == null ? 'null' : Number(bundle.post.domain_entropy_topK).toFixed(3)
      }`,
      `anchor_ratio_topK=${
        bundle?.post?.lexical_anchor_ratio_topK == null
          ? 'null'
          : Number(bundle.post.lexical_anchor_ratio_topK).toFixed(3)
      }`,
      `drops.domain_filter=${Number(bundle?.recall?.drops?.domain_filter || 0)}`,
      `degrade.vector_skipped=${Boolean(bundle?.degrade?.vector_skipped)}`,
      `degrade.nlu_degraded=${Boolean(bundle?.degrade?.nlu_degraded)}`,
      `degrade.behavior_skipped=${Boolean(bundle?.degrade?.behavior_skipped)}`,
    ].join('; '),
    debug: {
      query: bundle.query,
      latency_ms: bundle.latency_ms,
      nlu: bundle.nlu,
      rewrite: bundle.rewrite,
      recall: bundle.recall,
      post: bundle.post,
      top_items: bundle.top_items,
    },
  };
}

function buildCasebookForWindow(bundles, opts = {}) {
  const topN = Number(opts.casebookTop || 50);
  const sampleLimit = Number(opts.maxSamplesPerQuery || 3);

  const byQuery = groupBy(bundles, (bundle) => bundle?.query || 'unknown');

  const strictRows = Array.from(byQuery.entries())
    .map(([query, list]) => ({
      query,
      count: list.length,
      strict_count: list.filter((bundle) => bundle.result_type === 'strict_empty').length,
      rows: list,
    }))
    .filter((item) => item.strict_count > 0)
    .sort((a, b) => b.strict_count - a.strict_count || b.count - a.count)
    .slice(0, topN)
    .map((item) => {
      const samples = item.rows
        .filter((bundle) => bundle.result_type === 'strict_empty')
        .slice(0, sampleLimit)
        .map(summarizeCaseBundle);
      return {
        query: item.query,
        count: item.strict_count,
        intent_top1: mode(item.rows.map((row) => row?.nlu?.intent_top1)),
        domain: mode(item.rows.map((row) => row?.nlu?.slots?.domain)),
        result_type: 'strict_empty',
        reason_code: mode(item.rows.map((row) => row?.reason_code)),
        samples,
      };
    });

  const qualityRows = Array.from(byQuery.entries())
    .map(([query, list]) => {
      const entropy = mean(
        list.map((bundle) => safeNumber(bundle?.post?.domain_entropy_topK)).filter((v) => v != null),
      );
      const anchor = mean(
        list.map((bundle) => safeNumber(bundle?.post?.lexical_anchor_ratio_topK)).filter((v) => v != null),
      );
      const crossDomain = mean(list.map(calcCrossDomainRatio).filter((v) => v != null));
      const anchorPenalty = anchor == null ? 0.5 : 1 - anchor;
      const entropyScore = entropy == null ? 0 : Math.min(1, entropy / 3);
      const crossScore = crossDomain == null ? 0 : crossDomain;
      const riskScore = entropyScore + anchorPenalty + crossScore;
      return {
        query,
        count: list.length,
        rows: list,
        entropy,
        anchor,
        crossDomain,
        riskScore,
      };
    })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.riskScore - a.riskScore || b.count - a.count)
    .slice(0, topN)
    .map((item) => ({
      query: item.query,
      count: item.count,
      intent_top1: mode(item.rows.map((row) => row?.nlu?.intent_top1)),
      domain: mode(item.rows.map((row) => row?.nlu?.slots?.domain)),
      result_type: mode(item.rows.map((row) => row?.result_type)),
      reason_code: mode(item.rows.map((row) => row?.reason_code)),
      risk_score: Number(item.riskScore.toFixed(4)),
      avg_domain_entropy_topk: item.entropy,
      avg_anchor_ratio_topk: item.anchor,
      avg_cross_domain_ratio_topk: item.crossDomain,
      samples: item.rows.slice(0, sampleLimit).map(summarizeCaseBundle),
    }));

  const degradeRows = Array.from(byQuery.entries())
    .map(([query, list]) => ({
      query,
      count: list.length,
      degrade_count: list.filter((bundle) => anyDegrade(bundle?.degrade)).length,
      rows: list,
    }))
    .filter((item) => item.degrade_count > 0)
    .sort((a, b) => b.degrade_count - a.degrade_count || b.count - a.count)
    .slice(0, topN)
    .map((item) => {
      const picked = item.rows
        .filter((bundle) => anyDegrade(bundle?.degrade))
        .slice(0, sampleLimit)
        .map(summarizeCaseBundle);
      return {
        query: item.query,
        count: item.degrade_count,
        intent_top1: mode(item.rows.map((row) => row?.nlu?.intent_top1)),
        domain: mode(item.rows.map((row) => row?.nlu?.slots?.domain)),
        result_type: mode(item.rows.map((row) => row?.result_type)),
        reason_code: mode(item.rows.map((row) => row?.reason_code)),
        samples: picked,
      };
    });

  return {
    strict_empty_top_queries: strictRows,
    quality_risk_top_queries: qualityRows,
    degrade_top_queries: degradeRows,
  };
}

function renderCasebookMarkdown(windowKey, casebook) {
  const lines = [];
  lines.push(`# Casebook (${windowKey})`);
  lines.push('');

  const writeSection = (title, rows) => {
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| query | count | intent_top1 | domain | result_type | reason_code |');
    lines.push('|---|---:|---|---|---|---|');
    for (const row of rows) {
      lines.push(
        `| ${row.query} | ${row.count} | ${row.intent_top1 || 'unknown'} | ${
          row.domain || 'unknown'
        } | ${row.result_type || 'unknown'} | ${row.reason_code || 'UNKNOWN'} |`,
      );
    }
    lines.push('');
  };

  writeSection('Strict-empty Top Queries', casebook.strict_empty_top_queries);
  writeSection('Quality-risk Top Queries', casebook.quality_risk_top_queries);
  writeSection('Degrade Top Queries', casebook.degrade_top_queries);

  const appendSamples = (title, rows) => {
    lines.push(`## ${title} Samples`);
    lines.push('');
    for (const row of rows.slice(0, 10)) {
      lines.push(`### ${row.query} (${row.count})`);
      for (const sample of row.samples || []) {
        lines.push(`- req_id=${sample.req_id} reason=${sample.reason_code} ${sample.summary}`);
      }
      lines.push('');
    }
  };

  appendSamples('Strict-empty', casebook.strict_empty_top_queries);
  appendSamples('Quality-risk', casebook.quality_risk_top_queries);
  appendSamples('Degrade', casebook.degrade_top_queries);

  return lines.join('\n');
}

async function loadBundles(inputFiles, sampleRatio) {
  const bundles = [];
  for (const file of inputFiles) {
    const full = path.resolve(file);
    if (!fs.existsSync(full)) continue;
    // eslint-disable-next-line no-await-in-loop
    for await (const record of readJsonLines(full)) {
      const bundle = extractDebugBundle(record);
      if (!bundle) continue;
      if (sampleRatio < 1 && Math.random() > sampleRatio) continue;
      const ts = new Date(bundle.ts || record.ts || record.time || 0);
      if (Number.isNaN(ts.getTime())) continue;
      bundles.push({ ...bundle, ts: ts.toISOString() });
    }
  }
  return bundles;
}

function filterByWindow(bundles, now, windowMs) {
  const nowTs = now.getTime();
  return bundles.filter((bundle) => {
    const ts = new Date(bundle.ts).getTime();
    return Number.isFinite(ts) && nowTs - ts <= windowMs;
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeWindowOutputs({ outDir, windowKey, bundles, kMin, casebookTop, maxSamplesPerQuery }) {
  const windowDir = path.join(outDir, windowKey);
  ensureDir(windowDir);
  const healthRows = buildHealthRows(bundles, windowKey, kMin);
  const qualityRows = buildQualityRows(healthRows);
  const casebook = buildCasebookForWindow(bundles, {
    casebookTop,
    maxSamplesPerQuery,
  });

  const healthHeaders = [
    'window',
    'group_type',
    'group_key',
    'req_cnt',
    'p50_total_latency_ms',
    'p95_total_latency_ms',
    'p99_total_latency_ms',
    'p95_nlu_latency_ms',
    'p95_lexical_latency_ms',
    'p95_vector_latency_ms',
    'p95_behavior_latency_ms',
    'p95_rank_latency_ms',
    'timeout_rate_upstream',
    'timeout_rate_vector_skipped',
    'timeout_rate_nlu_degraded',
    'timeout_rate_behavior_skipped',
    'fallback_rate',
    'product_list_rate',
    'clarify_rate',
    'strict_empty_rate',
    'external_fill_rate',
    'no_candidate_rate',
    'pre_filter_candidate_rate',
    'filtered_to_empty_rate',
    'domain_drop_ratio',
    'inventory_drop_ratio',
    'constraint_drop_ratio',
  ];
  const qualityHeaders = [
    'window',
    'group_type',
    'group_key',
    'req_cnt',
    'non_empty_rate',
    'domain_entropy_topk_avg',
    'domain_entropy_topk_p95',
    'cross_domain_in_topk_rate',
    'lexical_anchor_ratio_topk',
  ];

  const healthCsvPath = path.join(windowDir, 'health.csv');
  const qualityCsvPath = path.join(windowDir, 'quality.csv');
  const casebookJsonPath = path.join(windowDir, 'casebook.json');
  const casebookMdPath = path.join(windowDir, 'casebook.md');

  fs.writeFileSync(healthCsvPath, toCsv(healthRows, healthHeaders), 'utf8');
  fs.writeFileSync(qualityCsvPath, toCsv(qualityRows, qualityHeaders), 'utf8');
  fs.writeFileSync(casebookJsonPath, JSON.stringify(casebook, null, 2), 'utf8');
  fs.writeFileSync(casebookMdPath, renderCasebookMarkdown(windowKey, casebook), 'utf8');

  return {
    window: windowKey,
    req_cnt: bundles.length,
    health_csv: healthCsvPath,
    quality_csv: qualityCsvPath,
    casebook_json: casebookJsonPath,
    casebook_md: casebookMdPath,
  };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const windows = args.windows.map(parseWindow);
  const bundles = await loadBundles(args.inputJsonl, args.sample);
  ensureDir(args.outDir);

  const manifest = {
    generated_at: nowIso(),
    now: args.now.toISOString(),
    input_files: args.inputJsonl.map((file) => path.resolve(file)),
    total_bundles_loaded: bundles.length,
    sample_ratio: args.sample,
    windows: [],
  };

  for (const windowSpec of windows) {
    const scoped = filterByWindow(bundles, args.now, windowSpec.ms);
    const out = writeWindowOutputs({
      outDir: args.outDir,
      windowKey: windowSpec.key,
      bundles: scoped,
      kMin: args.kMin,
      casebookTop: args.casebookTop,
      maxSamplesPerQuery: args.maxSamplesPerQuery,
    });
    manifest.windows.push(out);
  }

  const manifestPath = path.join(args.outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        manifest: manifestPath,
        out_dir: args.outDir,
        windows: manifest.windows,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  summarizeGroup,
  buildHealthRows,
  buildQualityRows,
  buildCasebookForWindow,
  run,
};
