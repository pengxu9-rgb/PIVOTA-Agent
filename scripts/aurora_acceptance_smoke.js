#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

function parseArgs(argv) {
  const out = {
    frontend: 'https://aurora.pivota.cc',
    backend: 'https://pivota-agent-production.up.railway.app',
    productUrl: '',
    out: 'artifacts/aurora_acceptance_report.md',
    lang: 'EN',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = String(argv[i + 1] || '');
    if (token === '--frontend' && next) {
      out.frontend = next;
      i += 1;
      continue;
    }
    if (token === '--backend' && next) {
      out.backend = next;
      i += 1;
      continue;
    }
    if (token === '--product-url' && next) {
      out.productUrl = next;
      i += 1;
      continue;
    }
    if (token === '--out' && next) {
      out.out = next;
      i += 1;
      continue;
    }
    if (token === '--lang' && next) {
      out.lang = String(next || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
      i += 1;
      continue;
    }
  }

  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function toText(value) {
  return String(value == null ? '' : value).trim();
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function randomToken(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const INTERNAL_MISSING_INFO_RE = /^(reco_dag_|url_|upstream_|internal_|router\.|skin_fit\.profile\.|competitor_recall_)/i;

function collectFindings(payload) {
  const p = asObject(payload) || {};
  const assessment = asObject(p.assessment) || {};
  const anchor = asObject(assessment.anchor_product) || {};
  const anchorBrand = toText(anchor.brand_id || anchor.brand);

  const competitorsBlock = asObject(p.competitors) || {};
  const competitors = asArray(competitorsBlock.candidates);
  const sameBrandHits = competitors.filter((row) => {
    const brand = toText(row?.brand_id || row?.brand);
    return Boolean(anchorBrand && brand && brand.toLowerCase() === anchorBrand.toLowerCase());
  }).length;
  const onPageHits = competitors.filter((row) => toText(row?.source?.type).toLowerCase() === 'on_page_related').length;

  const missingInfo = asArray(p.missing_info).map((x) => toText(x).toLowerCase()).filter(Boolean);
  const internalGapLeaks = missingInfo.filter((token) => INTERNAL_MISSING_INFO_RE.test(token));
  const payloadText = JSON.stringify(p || {}).toLowerCase();
  const priceUnknownPhraseHits = (payloadText.match(/\bprice unknown\b/g) || []).length;

  return {
    verdict: toText(assessment.verdict),
    competitor_count: competitors.length,
    same_brand_hits: sameBrandHits,
    on_page_hits: onPageHits,
    missing_info: missingInfo,
    internal_missing_info_leaks: internalGapLeaks,
    price_unknown_phrase_hits: priceUnknownPhraseHits,
  };
}

function renderReport({ args, checks, findings, requestId, productAnalyzeStatus, feedbackStatus }) {
  const lines = [];
  lines.push('# Aurora Acceptance Smoke Report');
  lines.push('');
  lines.push(`- Time: ${nowIso()}`);
  lines.push(`- Frontend: ${args.frontend}`);
  lines.push(`- Backend: ${args.backend}`);
  lines.push(`- Product URL: ${args.productUrl || '(not provided)'}`);
  lines.push(`- Request ID: ${requestId || 'n/a'}`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  for (const check of checks) {
    lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  lines.push('');
  lines.push('## Product Analyze');
  lines.push('');
  lines.push(`- HTTP: ${productAnalyzeStatus}`);
  lines.push(`- Verdict: ${findings?.verdict || 'n/a'}`);
  lines.push(`- Competitors: ${findings?.competitor_count ?? 0}`);
  lines.push(`- Competitors same-brand hits: ${findings?.same_brand_hits ?? 0}`);
  lines.push(`- Competitors on-page hits: ${findings?.on_page_hits ?? 0}`);
  lines.push(`- Missing info: ${(findings?.missing_info || []).join(', ') || 'none'}`);
  lines.push(`- Internal missing_info leaks: ${(findings?.internal_missing_info_leaks || []).join(', ') || 'none'}`);
  lines.push(`- "Price unknown" phrase hits: ${findings?.price_unknown_phrase_hits ?? 0}`);
  lines.push('');
  lines.push('## Dogfood Endpoint');
  lines.push('');
  lines.push(`- POST /v1/reco/employee-feedback HTTP: ${feedbackStatus}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const frontend = normalizeBaseUrl(args.frontend);
  const backend = normalizeBaseUrl(args.backend);
  const uid = randomToken('uid_acceptance');
  const traceId = randomToken('trace');
  const requestChecks = [];
  let exitCode = 0;

  const frontendResp = await fetch(frontend, { method: 'GET' });
  requestChecks.push({
    name: 'frontend_reachable',
    ok: frontendResp.ok,
    detail: `status=${frontendResp.status}`,
  });

  const analyzeBody = args.productUrl ? { url: args.productUrl } : { name: 'The Ordinary Multi-Peptide + Copper Peptides 1% Serum' };
  const analyzeOut = await fetchJson(`${backend}/v1/product/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Aurora-UID': uid,
      'X-Lang': args.lang,
      'X-Trace-ID': traceId,
    },
    body: JSON.stringify(analyzeBody),
  });

  const cards = asArray(asObject(analyzeOut.json)?.cards);
  const productCard = cards.find((card) => toText(card?.type).toLowerCase() === 'product_analysis');
  const payload = asObject(productCard?.payload) || {};
  const findings = collectFindings(payload);
  const requestId = toText(asObject(analyzeOut.json)?.request_id);

  requestChecks.push({
    name: 'product_analyze_http_ok',
    ok: analyzeOut.res.ok,
    detail: `status=${analyzeOut.res.status}`,
  });
  requestChecks.push({
    name: 'product_analysis_card_present',
    ok: Boolean(productCard),
    detail: productCard ? '' : 'card missing',
  });
  requestChecks.push({
    name: 'verdict_present',
    ok: Boolean(findings.verdict),
    detail: findings.verdict ? findings.verdict : 'verdict missing',
  });
  requestChecks.push({
    name: 'redline_same_brand_zero',
    ok: findings.same_brand_hits === 0,
    detail: `hits=${findings.same_brand_hits}`,
  });
  requestChecks.push({
    name: 'redline_on_page_zero',
    ok: findings.on_page_hits === 0,
    detail: `hits=${findings.on_page_hits}`,
  });
  requestChecks.push({
    name: 'missing_info_internal_leak_zero',
    ok: findings.internal_missing_info_leaks.length === 0,
    detail: findings.internal_missing_info_leaks.length ? findings.internal_missing_info_leaks.join(', ') : '',
  });
  requestChecks.push({
    name: 'price_unknown_phrase_absent',
    ok: Number(findings.price_unknown_phrase_hits || 0) === 0,
    detail: `hits=${Number(findings.price_unknown_phrase_hits || 0)}`,
  });

  const anchorProductId = toText(
    asObject(payload?.assessment)?.anchor_product?.product_id ||
      asObject(payload?.assessment)?.anchor_product?.sku_id ||
      asObject(payload?.assessment)?.anchor_product?.name ||
      'unknown_anchor',
  );

  const feedbackOut = await fetchJson(`${backend}/v1/reco/employee-feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Aurora-UID': uid,
      'X-Lang': args.lang,
      'X-Trace-ID': traceId,
    },
    body: JSON.stringify({
      anchor_product_id: anchorProductId,
      block: 'competitors',
      candidate_name: 'smoke_candidate',
      feedback_type: 'relevant',
      reason_tags: ['other'],
      request_id: requestId || randomToken('req'),
      session_id: randomToken('sess'),
    }),
  });
  requestChecks.push({
    name: 'employee_feedback_endpoint_ok',
    ok: feedbackOut.res.ok,
    detail: `status=${feedbackOut.res.status}`,
  });

  for (const check of requestChecks) {
    if (!check.ok) exitCode = 1;
  }

  const report = renderReport({
    args,
    checks: requestChecks,
    findings,
    requestId,
    productAnalyzeStatus: analyzeOut.res.status,
    feedbackStatus: feedbackOut.res.status,
  });

  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, report, 'utf8');

  process.stdout.write(report);
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[aurora_acceptance_smoke] ${err?.message || String(err)}\n`);
  process.exit(1);
});
