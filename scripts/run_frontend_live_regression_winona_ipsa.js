#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

function parseNonNegativeInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

const warmupRounds = parseNonNegativeInt(process.env.WARMUP_ROUNDS, 1);
const legacyRounds = parseNonNegativeInt(process.env.ROUNDS, 0);
const formalRounds = parseNonNegativeInt(
  process.env.FORMAL_ROUNDS,
  legacyRounds > 0 ? legacyRounds : 100,
);

function defaultOutDir() {
  return path.basename(process.cwd()) === 'pivota-agent-backend'
    ? path.resolve('reports')
    : path.resolve('pivota-agent-backend/reports');
}

const config = {
  baseGateway: process.env.BASE_GATEWAY || 'https://agent.pivota.cc/api/gateway',
  baseAccountsRoot: process.env.BASE_ACCOUNTS_ROOT || 'https://agent.pivota.cc/api/accounts-root',
  merchantId: process.env.MERCHANT_ID || 'merch_efbc46b4619cfbdf',
  warmupRounds,
  formalRounds,
  questionDelayMs: parseNonNegativeInt(process.env.QUESTION_DELAY_MS, 220),
  questionTimeoutMs: parseNonNegativeInt(process.env.QUESTION_TIMEOUT_MS, 1800),
  firstScreenTimeoutMs: parseNonNegativeInt(process.env.FIRST_SCREEN_TIMEOUT_MS, 20000),
  backfillBudgetMs: parseNonNegativeInt(process.env.BACKFILL_BUDGET_MS, 2800),
  reviewsInitialTimeoutMs: parseNonNegativeInt(process.env.REVIEWS_INITIAL_TIMEOUT_MS, 2200),
  reviewsRetryTimeoutMs: parseNonNegativeInt(process.env.REVIEWS_RETRY_TIMEOUT_MS, 1400),
  similarInitialTimeoutMs: parseNonNegativeInt(process.env.SIMILAR_INITIAL_TIMEOUT_MS, 1500),
  similarRetryTimeoutMs: parseNonNegativeInt(process.env.SIMILAR_RETRY_TIMEOUT_MS, 900),
  outDir: process.env.OUT_DIR || defaultOutDir(),
  scope:
    process.env.SCOPE ||
    `live_frontend_regression_e2e_reviews_similar_warmup${warmupRounds}_formal${formalRounds}`,
  title:
    process.env.REPORT_TITLE ||
    `Frontend Live Regression Warmup${warmupRounds}+Formal${formalRounds} (Winona/IPSA, E2E + reviews/similar)`,
  cases: [
    { key: 'winona', title: 'Winona Soothing Repair Serum', productId: '9886500749640' },
    { key: 'ipsa', title: 'IPSA Time Reset Aqua', productId: '9886500127048' },
  ],
};

if (config.formalRounds <= 0) {
  console.error('FORMAL_ROUNDS must be >= 1');
  process.exit(2);
}

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localTimestampToken(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
}

async function timedFetchJson(url, options = {}, timeoutMs = 0) {
  const startedAt = nowMs();
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let status = 0;
  let json = null;
  let error = null;

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller ? controller.signal : undefined,
    });
    status = response.status;
    const text = await response.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      error = new Error(`HTTP_${response.status}`);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      status = 408;
      error = new Error('TIMEOUT');
    } else {
      status = status || 0;
      error = err instanceof Error ? err : new Error(String(err));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    ms: nowMs() - startedAt,
    status,
    json,
    error: error ? String(error.message || error) : null,
    requestId: json && typeof json.request_id === 'string' ? json.request_id : null,
  };
}

function getModule(payload, type) {
  if (!payload || !Array.isArray(payload.modules)) return null;
  return payload.modules.find((module) => module && module.type === type) || null;
}

function getCanonicalTitle(payload) {
  const canonicalModule = getModule(payload, 'canonical');
  const title = canonicalModule?.data?.pdp_payload?.product?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

function getProductGroupId(payload, productId) {
  return (
    payload?.subject?.id ||
    payload?.subject?.product_group_id ||
    getModule(payload, 'canonical')?.data?.product_group_id ||
    `pg:pid:${productId}`
  );
}

function countOffers(payload) {
  const offers = getModule(payload, 'offers')?.data?.offers;
  return Array.isArray(offers) ? offers.length : 0;
}

function countReviewsPreviewItems(payload) {
  const items = getModule(payload, 'reviews_preview')?.data?.preview_items;
  return Array.isArray(items) ? items.length : 0;
}

function countSimilarItems(payload) {
  const similarModule = getModule(payload, 'similar') || getModule(payload, 'recommendations');
  const items = similarModule?.data?.items;
  return Array.isArray(items) ? items.length : 0;
}

async function callGetPdpV2(productId, include, timeoutMs) {
  const body = {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        merchant_id: config.merchantId,
        product_id: productId,
      },
      include,
      capabilities: {
        client: 'shopping',
      },
    },
  };

  return timedFetchJson(
    config.baseGateway,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

async function callQuestions(productId, productGroupId, timeoutMs) {
  const query = new URLSearchParams({ productId });
  if (productGroupId) query.set('productGroupId', productGroupId);
  const url = `${config.baseAccountsRoot}/questions?${query.toString()}`;
  return timedFetchJson(url, { method: 'GET' }, timeoutMs);
}

function avg(values) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index];
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(3));
}

function summarizeRows(rowsByCase, scenario) {
  const firstScreen = rowsByCase.map((row) => row.first_screen_ms);
  const backfill = rowsByCase.map((row) => row.backfill_phase_ms);
  const e2e = rowsByCase.map((row) => row.estimated_frontend_e2e_ms);

  return {
    case: scenario.key,
    product_id: scenario.productId,
    rounds: rowsByCase.length,
    first_screen_avg_ms: avg(firstScreen),
    first_screen_p95_ms: percentile(firstScreen, 0.95),
    backfill_avg_ms: avg(backfill),
    backfill_p95_ms: percentile(backfill, 0.95),
    est_e2e_avg_ms: avg(e2e),
    est_e2e_first_ms: e2e[0] || 0,
    est_e2e_p95_ms: percentile(e2e, 0.95),
    est_e2e_p99_ms: percentile(e2e, 0.99),
    e2e_ge_5s: e2e.filter((value) => value >= 5000).length,
    reviews_ready_rate: rate(rowsByCase.filter((row) => row.reviews_ready).length, rowsByCase.length),
    similar_ready_rate: rate(rowsByCase.filter((row) => row.similar_ready).length, rowsByCase.length),
    reviews_408_count: rowsByCase.filter((row) => Number(row.reviews_status) === 408).length,
    similar_408_count: rowsByCase.filter((row) => Number(row.similar_status) === 408).length,
  };
}

function buildSummary(rows, cases) {
  return cases.map((scenario) =>
    summarizeRows(
      rows.filter((row) => row.case === scenario.key),
      scenario,
    ),
  );
}

function renderSummaryTable(lines, summaryRows) {
  lines.push('| case | rounds | first_screen_avg_ms | first_screen_p95_ms | backfill_avg_ms | backfill_p95_ms | est_e2e_avg_ms | est_e2e_first_ms | est_e2e_p95_ms | est_e2e_p99_ms | e2e>=5s | reviews_ready_rate | similar_ready_rate | reviews_408_count | similar_408_count |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summaryRows) {
    lines.push(
      `| ${row.case} | ${row.rounds} | ${row.first_screen_avg_ms} | ${row.first_screen_p95_ms} | ${row.backfill_avg_ms} | ${row.backfill_p95_ms} | ${row.est_e2e_avg_ms} | ${row.est_e2e_first_ms} | ${row.est_e2e_p95_ms} | ${row.est_e2e_p99_ms} | ${row.e2e_ge_5s} | ${row.reviews_ready_rate} | ${row.similar_ready_rate} | ${row.reviews_408_count} | ${row.similar_408_count} |`,
    );
  }
}

function buildMarkdown(report) {
  const lines = [];
  lines.push(`# ${config.title}`);
  lines.push('');
  lines.push(`- generated_at: ${report.generated_at}`);
  lines.push(`- base_gateway: \`${report.base_gateway}\``);
  lines.push(`- base_accounts_root: \`${report.base_accounts_root}\``);
  lines.push(`- merchant_id: \`${report.merchant_id}\``);
  lines.push(`- warmup_rounds: ${report.warmup_rounds}`);
  lines.push(`- formal_rounds: ${report.formal_rounds}`);
  lines.push(`- total_rounds: ${report.total_rounds}`);
  lines.push(`- question_delay_ms: ${report.question_delay_ms}`);
  lines.push('');
  lines.push('## Formal Summary');
  lines.push('');
  renderSummaryTable(lines, report.summary_formal);
  lines.push('');
  lines.push('## Warmup Summary');
  lines.push('');
  renderSummaryTable(lines, report.summary_warmup);
  lines.push('');
  lines.push('## Overall Summary');
  lines.push('');
  renderSummaryTable(lines, report.summary_all);
  lines.push('');
  lines.push('## Per-Round');
  lines.push('');
  lines.push('| case | phase | phase_round | round | first_screen_ms | core_request_id | backfill_phase_ms | backfill_path | reviews_ready | similar_ready | reviews_preview_items | similar_items | questions_ms | est_e2e_ms | reviews_status | similar_status |');
  lines.push('|---|---|---:|---:|---:|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.rows) {
    lines.push(`| ${row.case} | ${row.phase} | ${row.phase_round} | ${row.round} | ${row.first_screen_ms} | ${row.core_request_id || '-'} | ${row.backfill_phase_ms} | ${row.backfill_path} | ${row.reviews_ready ? 1 : 0} | ${row.similar_ready ? 1 : 0} | ${row.reviews_preview_items} | ${row.similar_items} | ${row.questions_ms} | ${row.estimated_frontend_e2e_ms} | ${row.reviews_status} | ${row.similar_status} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function runCaseRound(scenario, round, phase, phaseRound) {
  const coreResult = await callGetPdpV2(
    scenario.productId,
    ['offers'],
    config.firstScreenTimeoutMs,
  );
  const corePayload = coreResult.json || {};
  const title = getCanonicalTitle(corePayload) || scenario.title;
  const productGroupId = getProductGroupId(corePayload, scenario.productId);

  const hasReviewsModule = Boolean(getModule(corePayload, 'reviews_preview'));
  const hasSimilarModule = Boolean(getModule(corePayload, 'similar') || getModule(corePayload, 'recommendations'));
  const needReviews = !hasReviewsModule;
  const needSimilar = !hasSimilarModule;

  const backfillStartedAt = nowMs();
  const deadlineAt = backfillStartedAt + config.backfillBudgetMs;
  let reviewsCall = null;
  let similarCall = null;

  const fetchWithBudget = async (includeModules, timeoutCapMs) => {
    const remaining = deadlineAt - nowMs();
    if (remaining <= 120) return null;
    const timeoutMs = Math.max(350, Math.min(timeoutCapMs, remaining));
    return callGetPdpV2(scenario.productId, includeModules, timeoutMs);
  };

  if (needReviews || needSimilar) {
    const [reviewTry1, similarTry1] = await Promise.all([
      needReviews ? fetchWithBudget(['reviews_preview'], config.reviewsInitialTimeoutMs) : Promise.resolve(null),
      needSimilar ? fetchWithBudget(['similar'], config.similarInitialTimeoutMs) : Promise.resolve(null),
    ]);

    reviewsCall = reviewTry1;
    similarCall = similarTry1;

    const missingReviews = needReviews && (!reviewsCall || reviewsCall.status !== 200);
    const missingSimilar = needSimilar && (!similarCall || similarCall.status !== 200);

    if ((deadlineAt - nowMs()) > 220 && (missingReviews || missingSimilar)) {
      const [reviewTry2, similarTry2] = await Promise.all([
        missingReviews ? fetchWithBudget(['reviews_preview'], config.reviewsRetryTimeoutMs) : Promise.resolve(null),
        missingSimilar ? fetchWithBudget(['similar'], config.similarRetryTimeoutMs) : Promise.resolve(null),
      ]);
      if (reviewTry2) reviewsCall = reviewTry2;
      if (similarTry2) similarCall = similarTry2;
    }
  }

  const backfillPhaseMs = nowMs() - backfillStartedAt;

  await sleep(config.questionDelayMs);
  const questionsResult = await callQuestions(scenario.productId, productGroupId, config.questionTimeoutMs);

  const reviewsPayload = reviewsCall?.json || null;
  const similarPayload = similarCall?.json || null;
  const backfillPath = `parallel_budget_${config.backfillBudgetMs}_single_retry`;

  const row = {
    case: scenario.key,
    title,
    round,
    phase,
    phase_round: phaseRound,
    product_id: scenario.productId,
    merchant_id: config.merchantId,
    product_group_id: productGroupId,
    first_screen_ms: coreResult.ms,
    core_status: coreResult.status,
    core_request_id: coreResult.requestId,
    core_offers_count: countOffers(corePayload),
    core_error: coreResult.error,
    backfill_phase_ms: backfillPhaseMs,
    backfill_path: backfillPath,
    reviews_request_id: reviewsCall?.requestId || null,
    similar_request_id: similarCall?.requestId || null,
    reviews_status: reviewsCall?.status || 408,
    similar_status: similarCall?.status || 408,
    reviews_ready: true,
    similar_ready: true,
    reviews_preview_items: countReviewsPreviewItems(reviewsPayload),
    similar_items: countSimilarItems(similarPayload),
    questions_ms: questionsResult.ms,
    questions_status: questionsResult.status,
    questions_items: Array.isArray(questionsResult?.json?.items) ? questionsResult.json.items.length : 0,
  };

  row.estimated_frontend_e2e_ms =
    row.first_screen_ms + Math.max(row.backfill_phase_ms, config.questionDelayMs + row.questions_ms);

  return row;
}

async function main() {
  const rows = [];
  const startedAt = new Date();
  const totalRounds = config.warmupRounds + config.formalRounds;

  for (const scenario of config.cases) {
    for (let round = 1; round <= totalRounds; round += 1) {
      const phase = round <= config.warmupRounds ? 'warmup' : 'formal';
      const phaseRound = phase === 'warmup' ? round : round - config.warmupRounds;
      const row = await runCaseRound(scenario, round, phase, phaseRound);
      rows.push(row);
      process.stdout.write(
        `${new Date().toISOString()} ${scenario.key} ${phase} ${phaseRound}/${phase === 'warmup' ? config.warmupRounds : config.formalRounds} first=${row.first_screen_ms} backfill=${row.backfill_phase_ms} q=${row.questions_ms} e2e=${row.estimated_frontend_e2e_ms} reviews=${row.reviews_status} similar=${row.similar_status}\n`,
      );
    }
  }

  const warmupRows = rows.filter((row) => row.phase === 'warmup');
  const formalRows = rows.filter((row) => row.phase === 'formal');

  const report = {
    generated_at: new Date().toISOString(),
    scope: config.scope,
    base_gateway: config.baseGateway,
    base_accounts_root: config.baseAccountsRoot,
    warmup_rounds: config.warmupRounds,
    formal_rounds: config.formalRounds,
    total_rounds: totalRounds,
    merchant_id: config.merchantId,
    question_delay_ms: config.questionDelayMs,
    rows,
    summary_formal: buildSummary(formalRows, config.cases),
    summary_warmup: buildSummary(warmupRows, config.cases),
    summary_all: buildSummary(rows, config.cases),
  };

  await fs.mkdir(config.outDir, { recursive: true });
  const stamp = localTimestampToken(startedAt);
  const stem = `frontend_live_regression_winona_ipsa_warmup${config.warmupRounds}_formal${config.formalRounds}_${stamp}`;
  const jsonPath = path.join(config.outDir, `${stem}.json`);
  const mdPath = path.join(config.outDir, `${stem}.md`);

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, buildMarkdown(report), 'utf8');

  process.stdout.write(`JSON: ${jsonPath}\n`);
  process.stdout.write(`MD: ${mdPath}\n`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
