#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_BASE = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_OUT_DIR = 'reports';
const DEFAULT_PHOTO_URL = 'https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama.jpg';
const DEFAULT_LANG = 'EN';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 3;
const DEFAULT_PER_CASE_WAIT_MS = 300;
const DEFAULT_MAX_RECO_RESOLVE_CHECK = 3;

const RECO_ACTION = {
  action_id: 'chip.start.reco_products',
  kind: 'chip',
};

const DEFAULT_CASES = [
  {
    case_id: 'redness_sensitive_budget',
    profile: {
      skinType: 'combination',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['reduce redness', 'barrier support'],
      budgetTier: 'drugstore',
    },
    prompt: 'Please recommend 3 products for redness and sensitive skin under $40. Prefer fragrance-free.',
    expected_keywords: ['panthenol', 'ceramide', 'centella', 'cica', 'allantoin', 'niacinamide'],
  },
  {
    case_id: 'acne_oily_blackheads',
    profile: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'healthy',
      goals: ['acne control', 'blackhead reduction'],
      budgetTier: 'drugstore',
    },
    prompt: 'Recommend 4 acne-control products for oily skin with blackheads, with short reasons and key actives.',
    expected_keywords: ['salicylic', 'bha', 'azelaic', 'niacinamide', 'retinol', 'adapalene', 'benzoyl'],
  },
  {
    case_id: 'dry_barrier_repair',
    profile: {
      skinType: 'dry',
      sensitivity: 'medium',
      barrierStatus: 'impaired',
      goals: ['barrier repair', 'hydration'],
      budgetTier: 'mid',
    },
    prompt: 'My skin is dry and sensitive with a weak barrier. Recommend products for repair and hydration.',
    expected_keywords: ['ceramide', 'hyaluronic', 'glycerin', 'squalane', 'panthenol', 'beta-glucan'],
  },
  {
    case_id: 'dark_spots_brightening',
    profile: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'healthy',
      goals: ['dark spot fading', 'tone evening'],
      budgetTier: 'mid',
    },
    prompt: 'I want products to fade dark spots and brighten uneven tone, but avoid irritation.',
    expected_keywords: ['vitamin c', 'niacinamide', 'tranexamic', 'arbutin', 'kojic'],
  },
  {
    case_id: 'anti_aging_beginner',
    profile: {
      skinType: 'normal',
      sensitivity: 'low',
      barrierStatus: 'healthy',
      goals: ['anti aging', 'fine lines'],
      budgetTier: 'mid',
    },
    prompt: 'I am a beginner in anti-aging. Recommend products for fine lines with low irritation risk.',
    expected_keywords: ['retinol', 'retinal', 'peptide', 'bakuchiol', 'coenzyme', 'ascorb'],
  },
  {
    case_id: 'daily_uv_protection',
    profile: {
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'healthy',
      goals: ['daily uv protection', 'prevent pigmentation'],
      budgetTier: 'drugstore',
    },
    prompt: 'Please recommend daily sunscreen-focused products for high UV commute, suitable for sensitive skin.',
    expected_keywords: ['spf', 'sunscreen', 'uv', 'zinc', 'titanium', 'sun'],
  },
];

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE,
    outDir: DEFAULT_OUT_DIR,
    photoUrl: DEFAULT_PHOTO_URL,
    lang: DEFAULT_LANG,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    waitMs: DEFAULT_PER_CASE_WAIT_MS,
    maxRecoResolveCheck: DEFAULT_MAX_RECO_RESOLVE_CHECK,
    casesFile: '',
    limit: 0,
    skipResolveCheck: false,
  };

  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (token === '--base' && next) {
      out.base = next;
      i += 1;
      continue;
    }
    if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
      continue;
    }
    if (token === '--photo-url' && next) {
      out.photoUrl = next;
      i += 1;
      continue;
    }
    if (token === '--lang' && next) {
      out.lang = String(next || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
      i += 1;
      continue;
    }
    if (token === '--timeout-ms' && next) {
      const v = Number(next);
      if (Number.isFinite(v) && v > 0) out.timeoutMs = Math.trunc(v);
      i += 1;
      continue;
    }
    if (token === '--retries' && next) {
      const v = Number(next);
      if (Number.isFinite(v) && v >= 0) out.retries = Math.trunc(v);
      i += 1;
      continue;
    }
    if (token === '--wait-ms' && next) {
      const v = Number(next);
      if (Number.isFinite(v) && v >= 0) out.waitMs = Math.trunc(v);
      i += 1;
      continue;
    }
    if (token === '--cases' && next) {
      out.casesFile = next;
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      const v = Number(next);
      if (Number.isFinite(v) && v > 0) out.limit = Math.trunc(v);
      i += 1;
      continue;
    }
    if (token === '--max-reco-resolve-check' && next) {
      const v = Number(next);
      if (Number.isFinite(v) && v >= 0) out.maxRecoResolveCheck = Math.trunc(v);
      i += 1;
      continue;
    }
    if (token === '--skip-resolve-check') {
      out.skipResolveCheck = true;
      continue;
    }
  }

  return out;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function lower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function nowIsoCompact() {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function sanitizeUidPart(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function cardByType(envelope, type) {
  const cards = envelope && Array.isArray(envelope.cards) ? envelope.cards : [];
  return cards.find((card) => String(card && card.type) === String(type)) || null;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout_${timeoutMs}ms`)), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function requestJson(base, endpoint, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
} = {}) {
  const url = `${String(base || '').replace(/\/$/, '')}${endpoint}`;

  let attempt = 0;
  let lastError = null;
  while (attempt <= retries) {
    attempt += 1;
    try {
      const reqHeaders = { ...headers };
      let reqBody = body;

      if (body && !(body instanceof FormData)) {
        reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
        reqBody = JSON.stringify(body);
      }

      const response = await fetchWithTimeout(url, {
        method,
        headers: reqHeaders,
        body: reqBody,
      }, timeoutMs);

      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (_err) {
          json = null;
        }
      }

      if (!response.ok) {
        const retriable = response.status >= 500 || response.status === 429;
        const error = new Error(`HTTP_${response.status} ${method} ${endpoint}`);
        error.httpStatus = response.status;
        error.responseBody = text.slice(0, 1200);
        if (retriable && attempt <= retries) {
          await sleep(Math.min(1500, 200 * attempt));
          lastError = error;
          continue;
        }
        throw error;
      }

      if (!json || typeof json !== 'object') {
        const error = new Error(`INVALID_JSON ${method} ${endpoint}`);
        error.responseBody = text.slice(0, 1200);
        throw error;
      }

      return json;
    } catch (error) {
      lastError = error;
      const retryableByMessage = /timeout_|network|fetch failed|aborted/i.test(String(error && error.message));
      if (attempt <= retries && retryableByMessage) {
        await sleep(Math.min(1500, 200 * attempt));
        continue;
      }
      break;
    }
  }

  throw lastError || new Error(`REQUEST_FAILED ${method} ${endpoint}`);
}

async function loadCases(casesFile, limit) {
  let cases = DEFAULT_CASES;
  if (casesFile) {
    const abs = path.resolve(casesFile);
    const raw = await fs.readFile(abs, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('cases file must be a non-empty JSON array');
    }
    cases = parsed;
  }

  const normalized = cases.map((item, index) => {
    const caseId = String(item.case_id || item.id || `case_${index + 1}`).trim() || `case_${index + 1}`;
    const prompt = String(item.prompt || item.message || '').trim();
    if (!prompt) {
      throw new Error(`case ${caseId} missing prompt`);
    }
    const profile = item.profile && typeof item.profile === 'object' ? item.profile : {};
    const expectedKeywords = Array.isArray(item.expected_keywords)
      ? item.expected_keywords.map((it) => String(it || '').trim().toLowerCase()).filter(Boolean)
      : [];

    return {
      case_id: caseId,
      prompt,
      profile,
      expected_keywords: expectedKeywords,
    };
  });

  if (limit > 0) return normalized.slice(0, limit);
  return normalized;
}

async function downloadPhoto(photoUrl, timeoutMs) {
  const response = await fetchWithTimeout(photoUrl, { method: 'GET' }, timeoutMs);
  if (!response.ok) {
    throw new Error(`photo download failed: HTTP_${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error('photo download returned empty bytes');
  }
  return buffer;
}

function extractPhotoConfirm(uploadEnvelope) {
  const card = cardByType(uploadEnvelope, 'photo_confirm');
  const payload = card && card.payload && typeof card.payload === 'object' ? card.payload : {};
  const photoId = String(payload.photo_id || '').trim();
  const qcStatus = String(payload.qc_status || 'passed').trim() || 'passed';
  if (!photoId) {
    const error = new Error('photo_confirm_missing');
    error.details = uploadEnvelope;
    throw error;
  }
  return { photoId, qcStatus };
}

function extractAnalysisMetrics(analysisEnvelope) {
  const card = cardByType(analysisEnvelope, 'analysis_summary');
  const payload = card && card.payload && typeof card.payload === 'object' ? card.payload : {};
  const analysis = payload.analysis && typeof payload.analysis === 'object' ? payload.analysis : {};
  const findings = Array.isArray(analysis.findings)
    ? analysis.findings
    : Array.isArray(payload.findings)
      ? payload.findings
      : [];

  const usedPhotos = Boolean(payload.used_photos);
  const analysisSource = String(payload.analysis_source || '').trim();
  const qualityGrade = String((((payload.quality_report || {}).photo_quality || {}).grade) || '').trim();

  return {
    usedPhotos,
    analysisSource,
    qualityGrade,
    findingsCount: findings.length,
  };
}

function textFromRecoItem(item) {
  const reasons = Array.isArray(item && item.reasons) ? item.reasons : [];
  const notes = Array.isArray(item && item.notes) ? item.notes : [];
  const keyActives = Array.isArray(item && item.evidence_pack && item.evidence_pack.keyActives)
    ? item.evidence_pack.keyActives
    : [];
  return [
    ...reasons,
    ...notes,
    ...keyActives,
    item && item.step,
    item && item.slot,
    item && item.sku && item.sku.name,
    item && item.sku && item.sku.brand,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
}

function extractRecommendationMetrics(chatEnvelope, expectedKeywords) {
  const cards = Array.isArray(chatEnvelope && chatEnvelope.cards) ? chatEnvelope.cards : [];
  const cardTypes = cards
    .map((card) => String(card && card.type ? card.type : '').trim())
    .filter(Boolean);
  const recoCard = cards.find((card) => String(card && card.type) === 'recommendations') || null;
  const gateCard = cards.find((card) => String(card && card.type) === 'diagnosis_gate') || null;

  const payload = recoCard && recoCard.payload && typeof recoCard.payload === 'object' ? recoCard.payload : {};
  const recs = Array.isArray(payload.recommendations) ? payload.recommendations : [];

  const groundedCount = recs.filter((item) => {
    const sku = item && item.sku && typeof item.sku === 'object' ? item.sku : {};
    const skuId = String(sku.sku_id || item.sku_id || '').trim();
    const productId = String(sku.product_id || item.product_id || '').trim();
    return Boolean(skuId || productId);
  }).length;

  const evidenceCount = recs.filter((item) => {
    const list = item && item.evidence_pack && Array.isArray(item.evidence_pack.keyActives)
      ? item.evidence_pack.keyActives
      : [];
    return list.length > 0;
  }).length;

  const combinedText = recs.map((item) => textFromRecoItem(item)).join(' || ');
  const keywords = Array.isArray(expectedKeywords) ? expectedKeywords : [];
  const matchedKeywords = keywords.filter((keyword) => combinedText.includes(String(keyword).toLowerCase()));

  return {
    cardTypes,
    hasRecoCard: Boolean(recoCard),
    hasDiagnosisGate: Boolean(gateCard),
    recommendationCount: recs.length,
    groundedCount,
    groundedRatio: recs.length ? groundedCount / recs.length : 0,
    evidenceCount,
    evidenceRatio: recs.length ? evidenceCount / recs.length : 0,
    keywordMatchCount: matchedKeywords.length,
    keywordHit: matchedKeywords.length > 0,
    matchedKeywords,
    recoItems: recs,
  };
}

async function resolveRecoMatches(base, uid, lang, recoItems, maxChecks, timeoutMs, retries) {
  const limited = Array.isArray(recoItems) ? recoItems.slice(0, maxChecks) : [];
  if (!limited.length) {
    return {
      checked: 0,
      resolved: 0,
      matched: 0,
      resolvedRatio: 0,
      ratio: 0,
      details: [],
    };
  }

  const details = [];
  for (const item of limited) {
    const sku = item && item.sku && typeof item.sku === 'object' ? item.sku : {};
    const expectedProductId = String(sku.product_id || item.product_id || '').trim();
    const query = String(sku.display_name || sku.name || '').trim();
    if (!expectedProductId || !query) {
      details.push({ query, expected_product_id: expectedProductId, resolved: false, matched: false, reason: 'missing_query_or_expected_id' });
      continue;
    }

    let resolved = false;
    let matched = false;
    let resolvedProductId = '';
    let reason = '';

    try {
      const resp = await requestJson(base, '/agent/v1/products/resolve', {
        method: 'POST',
        headers: {
          'X-Aurora-UID': uid,
          'X-Lang': lang,
        },
        body: {
          query,
          lang: lower(lang) === 'cn' ? 'zh-CN' : 'en',
          caller: 'aurora_chatbox',
          options: {
            search_all_merchants: true,
            timeout_ms: 2200,
            upstream_retries: 1,
          },
        },
        timeoutMs,
        retries,
      });

      resolved = Boolean(resp && resp.resolved);
      resolvedProductId = String((resp && resp.product_ref && resp.product_ref.product_id) || '').trim();
      matched = Boolean(resolved && resolvedProductId && resolvedProductId === expectedProductId);
      reason = String((resp && resp.reason) || '').trim();
    } catch (error) {
      reason = String(error && error.message ? error.message : error);
    }

    details.push({
      query,
      expected_product_id: expectedProductId,
      resolved,
      matched,
      resolved_product_id: resolvedProductId,
      reason,
    });
  }

  const checked = details.length;
  const resolved = details.filter((row) => row.resolved).length;
  const matched = details.filter((row) => row.matched).length;
  return {
    checked,
    resolved,
    matched,
    resolvedRatio: checked ? resolved / checked : 0,
    ratio: checked ? matched / checked : 0,
    details,
  };
}

function scoreCase(metrics) {
  let score = 0;

  if (metrics.usedPhotos) score += 15;
  if (metrics.analysisSource && metrics.analysisSource.startsWith('vision')) score += 10;
  if (metrics.qualityGrade && metrics.qualityGrade !== 'fail') score += 5;
  if (metrics.findingsCount >= 1) score += 10;

  if (metrics.recommendationCount >= 3) score += 15;
  if (metrics.groundedRatio >= 0.8) score += 15;
  else if (metrics.groundedRatio >= 0.5) score += 8;
  if (metrics.evidenceRatio >= 0.8) score += 10;
  else if (metrics.evidenceRatio >= 0.5) score += 5;
  if (metrics.keywordHit) score += 20;

  return Math.max(0, Math.min(100, score));
}

function toPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Number((value * 100).toFixed(1));
}

function csvEscape(value) {
  const text = String(value == null ? '' : value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeReports(outDir, runId, report) {
  await fs.mkdir(outDir, { recursive: true });

  const jsonPath = path.join(outDir, `skin_reco_baseline_${runId}.json`);
  const mdPath = path.join(outDir, `skin_reco_baseline_${runId}.md`);
  const csvPath = path.join(outDir, `skin_reco_baseline_${runId}.csv`);

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const lines = [];
  lines.push('# Skin + Recommendation Baseline Report');
  lines.push('');
  lines.push(`- generated_at_utc: ${report.generated_at_utc}`);
  lines.push(`- base: \`${report.config.base}\``);
  lines.push(`- total_cases: ${report.summary.total_cases}`);
  lines.push(`- completed_cases: ${report.summary.completed_cases}`);
  lines.push(`- avg_score: ${report.summary.avg_score}`);
  lines.push(`- photo_used_rate: ${report.summary.photo_used_rate_pct}%`);
  lines.push(`- vision_source_rate: ${report.summary.vision_source_rate_pct}%`);
  lines.push(`- recommendation_card_rate: ${report.summary.recommendation_card_rate_pct}%`);
  lines.push(`- keyword_hit_rate: ${report.summary.keyword_hit_rate_pct}%`);
  lines.push(`- grounded_reco_rate: ${report.summary.grounded_reco_rate_pct}%`);
  lines.push(`- resolve_success_rate: ${report.summary.resolve_success_rate_pct == null ? 'n/a' : `${report.summary.resolve_success_rate_pct}%`}`);
  lines.push(`- resolve_exact_match_rate: ${report.summary.resolve_exact_match_rate_pct == null ? 'n/a' : `${report.summary.resolve_exact_match_rate_pct}%`}`);
  lines.push('');
  lines.push('## Case Results');
  lines.push('');
  lines.push('| case_id | score | used_photos | source | quality | findings | reco_count | chat_cards | has_gate | grounded_ratio | keyword_hit | resolve_success_ratio | resolve_exact_ratio | error |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const row of report.rows) {
    lines.push(
      `| ${row.case_id} | ${row.score} | ${row.used_photos} | ${row.analysis_source || 'n/a'} | ${row.quality_grade || 'n/a'} | ${row.findings_count} | ${row.reco_count} | ${(row.chat_card_types || []).join(',') || 'n/a'} | ${row.has_diagnosis_gate} | ${row.grounded_ratio_pct}% | ${row.keyword_hit} | ${row.resolve_checked > 0 ? `${row.resolve_success_ratio_pct}%` : 'n/a'} | ${row.resolve_checked > 0 ? `${row.resolve_exact_match_ratio_pct}%` : 'n/a'} | ${row.error || ''} |`,
    );
  }

  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');

  const csvHeader = [
    'case_id',
    'score',
    'used_photos',
    'analysis_source',
    'quality_grade',
    'findings_count',
    'reco_count',
    'chat_card_types',
    'has_diagnosis_gate',
    'grounded_ratio_pct',
    'evidence_ratio_pct',
    'keyword_hit',
    'matched_keywords',
    'resolve_checked',
    'resolve_resolved',
    'resolve_success_ratio_pct',
    'resolve_matched',
    'resolve_exact_match_ratio_pct',
    'error',
  ];
  const csvRows = [csvHeader.join(',')];
  for (const row of report.rows) {
    csvRows.push([
      csvEscape(row.case_id),
      row.score,
      row.used_photos,
      csvEscape(row.analysis_source || ''),
      csvEscape(row.quality_grade || ''),
      row.findings_count,
      row.reco_count,
      csvEscape((row.chat_card_types || []).join('|')),
      row.has_diagnosis_gate,
      row.grounded_ratio_pct,
      row.evidence_ratio_pct,
      row.keyword_hit,
      csvEscape((row.matched_keywords || []).join('|')),
      row.resolve_checked,
      row.resolve_resolved,
      row.resolve_success_ratio_pct,
      row.resolve_matched,
      row.resolve_exact_match_ratio_pct,
      csvEscape(row.error || ''),
    ].join(','));
  }
  await fs.writeFile(csvPath, `${csvRows.join('\n')}\n`, 'utf8');

  return { jsonPath, mdPath, csvPath };
}

async function run() {
  if (typeof fetch !== 'function' || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('Node runtime requires fetch/FormData/Blob support (Node 18+)');
  }

  const args = parseArgs(process.argv.slice(2));
  const base = String(args.base || DEFAULT_BASE).replace(/\/$/, '');
  const outDir = path.resolve(args.outDir || DEFAULT_OUT_DIR);

  const cases = await loadCases(args.casesFile, args.limit);
  const photoBytes = await downloadPhoto(args.photoUrl, args.timeoutMs);

  const runId = nowIsoCompact();
  const rows = [];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const uid = `uid_skin_reco_eval_${runId}_${String(index + 1).padStart(2, '0')}_${sanitizeUidPart(testCase.case_id)}`;

    const baseRow = {
      case_id: testCase.case_id,
      prompt: testCase.prompt,
      expected_keywords: testCase.expected_keywords,
      used_photos: false,
      analysis_source: '',
      quality_grade: '',
      findings_count: 0,
      reco_count: 0,
      grounded_ratio_pct: 0,
      evidence_ratio_pct: 0,
      keyword_hit: false,
      matched_keywords: [],
      chat_card_types: [],
      has_diagnosis_gate: false,
      resolve_checked: 0,
      resolve_resolved: 0,
      resolve_success_ratio_pct: 0,
      resolve_matched: 0,
      resolve_exact_match_ratio_pct: 0,
      score: 0,
      error: '',
    };

    try {
      await requestJson(base, '/v1/profile/update', {
        method: 'POST',
        headers: {
          'X-Aurora-UID': uid,
          'X-Lang': args.lang,
        },
        body: testCase.profile,
        timeoutMs: args.timeoutMs,
        retries: args.retries,
      });

      const form = new FormData();
      form.set('slot_id', 'daylight');
      form.set('consent', 'true');
      form.set('photo', new Blob([photoBytes], { type: 'image/jpeg' }), 'probe.jpg');

      const uploadEnvelope = await requestJson(base, '/v1/photos/upload', {
        method: 'POST',
        headers: {
          'X-Aurora-UID': uid,
          'X-Lang': args.lang,
        },
        body: form,
        timeoutMs: args.timeoutMs,
        retries: args.retries,
      });

      const { photoId, qcStatus } = extractPhotoConfirm(uploadEnvelope);

      const analysisEnvelope = await requestJson(base, '/v1/analysis/skin', {
        method: 'POST',
        headers: {
          'X-Aurora-UID': uid,
          'X-Lang': args.lang,
        },
        body: {
          use_photo: true,
          currentRoutine: {
            am: [{ step: 'cleanser', product: 'gentle cleanser' }],
            pm: [{ step: 'moisturizer', product: 'barrier cream' }],
          },
          photos: [{ photo_id: photoId, slot_id: 'daylight', qc_status: qcStatus || 'passed' }],
        },
        timeoutMs: args.timeoutMs,
        retries: args.retries,
      });

      const analysisMetrics = extractAnalysisMetrics(analysisEnvelope);

      const chatEnvelope = await requestJson(base, '/v1/chat', {
        method: 'POST',
        headers: {
          'X-Aurora-UID': uid,
          'X-Lang': args.lang,
        },
        body: {
          message: testCase.prompt,
          action: RECO_ACTION,
        },
        timeoutMs: args.timeoutMs,
        retries: args.retries,
      });

      const recoMetrics = extractRecommendationMetrics(chatEnvelope, testCase.expected_keywords);

      let resolveCheck = { checked: 0, resolved: 0, matched: 0, resolvedRatio: 0, ratio: 0, details: [] };
      if (!args.skipResolveCheck && recoMetrics.recommendationCount > 0) {
        resolveCheck = await resolveRecoMatches(
          base,
          uid,
          args.lang,
          recoMetrics.recoItems,
          args.maxRecoResolveCheck,
          args.timeoutMs,
          args.retries,
        );
      }

      const metricsForScore = {
        usedPhotos: analysisMetrics.usedPhotos,
        analysisSource: analysisMetrics.analysisSource,
        qualityGrade: analysisMetrics.qualityGrade,
        findingsCount: analysisMetrics.findingsCount,
        recommendationCount: recoMetrics.recommendationCount,
        groundedRatio: recoMetrics.groundedRatio,
        evidenceRatio: recoMetrics.evidenceRatio,
        keywordHit: recoMetrics.keywordHit,
      };

      const score = scoreCase(metricsForScore);

      rows.push({
        ...baseRow,
        used_photos: analysisMetrics.usedPhotos,
        analysis_source: analysisMetrics.analysisSource,
        quality_grade: analysisMetrics.qualityGrade,
        findings_count: analysisMetrics.findingsCount,
        reco_count: recoMetrics.recommendationCount,
        chat_card_types: recoMetrics.cardTypes,
        has_diagnosis_gate: recoMetrics.hasDiagnosisGate,
        grounded_ratio_pct: toPercent(recoMetrics.groundedRatio) ?? 0,
        evidence_ratio_pct: toPercent(recoMetrics.evidenceRatio) ?? 0,
        keyword_hit: recoMetrics.keywordHit,
        matched_keywords: recoMetrics.matchedKeywords,
        resolve_checked: resolveCheck.checked,
        resolve_resolved: resolveCheck.resolved,
        resolve_success_ratio_pct: toPercent(resolveCheck.resolvedRatio) ?? 0,
        resolve_matched: resolveCheck.matched,
        resolve_exact_match_ratio_pct: toPercent(resolveCheck.ratio) ?? 0,
        score,
      });
    } catch (error) {
      rows.push({
        ...baseRow,
        error: String(error && error.message ? error.message : error).slice(0, 300),
      });
    }

    if (args.waitMs > 0 && index < cases.length - 1) {
      await sleep(args.waitMs);
    }
  }

  const completed = rows.filter((row) => !row.error);
  const sum = (fn) => completed.reduce((acc, row) => acc + fn(row), 0);

  const avgScore = completed.length ? Number((sum((row) => row.score) / completed.length).toFixed(1)) : 0;
  const photoUsedRate = completed.length ? sum((row) => (row.used_photos ? 1 : 0)) / completed.length : 0;
  const visionRate = completed.length ? sum((row) => (String(row.analysis_source || '').startsWith('vision') ? 1 : 0)) / completed.length : 0;
  const recoCardRate = completed.length ? sum((row) => (row.reco_count > 0 ? 1 : 0)) / completed.length : 0;
  const keywordHitRate = completed.length ? sum((row) => (row.keyword_hit ? 1 : 0)) / completed.length : 0;
  const groundedRecoRate = completed.length ? sum((row) => row.grounded_ratio_pct / 100) / completed.length : 0;
  const resolveSuccessRate = completed.length
    ? sum((row) => (row.resolve_checked > 0 ? row.resolve_success_ratio_pct / 100 : 0)) / completed.length
    : 0;
  const resolveExactMatchRate = completed.length
    ? sum((row) => (row.resolve_checked > 0 ? row.resolve_exact_match_ratio_pct / 100 : 0)) / completed.length
    : 0;

  const report = {
    schema_version: 'aurora.skin_reco_baseline.v2',
    generated_at_utc: new Date().toISOString(),
    config: {
      base,
      lang: args.lang,
      timeout_ms: args.timeoutMs,
      retries: args.retries,
      photo_url: args.photoUrl,
      total_cases: cases.length,
      skip_resolve_check: args.skipResolveCheck,
      max_reco_resolve_check: args.maxRecoResolveCheck,
      cases_file: args.casesFile ? path.resolve(args.casesFile) : null,
    },
    summary: {
      total_cases: cases.length,
      completed_cases: completed.length,
      failed_cases: rows.length - completed.length,
      avg_score: avgScore,
      photo_used_rate_pct: toPercent(photoUsedRate) ?? 0,
      vision_source_rate_pct: toPercent(visionRate) ?? 0,
      recommendation_card_rate_pct: toPercent(recoCardRate) ?? 0,
      keyword_hit_rate_pct: toPercent(keywordHitRate) ?? 0,
      grounded_reco_rate_pct: toPercent(groundedRecoRate) ?? 0,
      resolve_success_rate_pct: args.skipResolveCheck ? null : (toPercent(resolveSuccessRate) ?? 0),
      resolve_exact_match_rate_pct: args.skipResolveCheck ? null : (toPercent(resolveExactMatchRate) ?? 0),
    },
    rows,
  };

  const artifacts = await writeReports(outDir, runId, report);

  process.stdout.write(`${JSON.stringify({ summary: report.summary, artifacts }, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exit(1);
});
