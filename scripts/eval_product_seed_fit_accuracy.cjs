#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATASET = path.join(ROOT, 'datasets', 'product_seed_fit_accuracy_seed.json');
const DEFAULT_OUT_ROOT = path.join(ROOT, 'reports', 'product-seed-fit-accuracy');

function parseArgs(argv = process.argv) {
  const out = {
    dataset: DEFAULT_DATASET,
    responsesDir: '',
    baseUrl: process.env.BASE_URL || '',
    outDir: '',
    runLive: false,
    failOnThreshold: false,
    caseId: '',
    timeoutMs: Number(process.env.PRODUCT_SEED_FIT_TIMEOUT_MS || 30000),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--dataset' && next) {
      out.dataset = next;
      i += 1;
    } else if (token === '--responses-dir' && next) {
      out.responsesDir = next;
      i += 1;
    } else if (token === '--base-url' && next) {
      out.baseUrl = next;
      out.runLive = true;
      i += 1;
    } else if (token === '--out-dir' && next) {
      out.outDir = next;
      i += 1;
    } else if (token === '--case-id' && next) {
      out.caseId = next;
      i += 1;
    } else if (token === '--timeout-ms' && next) {
      out.timeoutMs = Math.max(1000, Number(next) || out.timeoutMs);
      i += 1;
    } else if (token === '--run-live') {
      out.runLive = true;
    } else if (token === '--fail-on-threshold') {
      out.failOnThreshold = true;
    }
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff%+.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsTerm(text, term) {
  const source = normalizeText(text);
  const needle = normalizeText(term);
  return Boolean(source && needle && source.includes(needle));
}

function includesAny(text, terms) {
  return asArray(terms).some((term) => containsTerm(text, term));
}

function countCjkChars(text) {
  const matches = String(text || '').match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

function countLatinWords(text) {
  const matches = String(text || '').match(/\b[A-Za-z][A-Za-z'-]{1,}\b/g);
  return matches ? matches.length : 0;
}

function evaluateLanguage({ expectedLanguage, text }) {
  const expected = String(expectedLanguage || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
  const body = String(text || '').trim();
  const cjkChars = countCjkChars(body);
  const latinWords = countLatinWords(body);
  const detected =
    cjkChars >= 12 && cjkChars >= Math.max(4, latinWords * 0.25)
      ? 'CN'
      : latinWords >= 8 && cjkChars < 8
        ? 'EN'
        : cjkChars > 0
          ? 'mixed'
          : 'unknown';
  return {
    pass: expected === 'CN' ? detected === 'CN' || detected === 'mixed' : detected === 'EN',
    expected_language: expected,
    detected_language: detected,
    cjk_chars: cjkChars,
    latin_words: latinWords,
  };
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function walkObjects(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visitor);
    return;
  }
  if (!isPlainObject(value)) return;
  visitor(value);
  for (const item of Object.values(value)) walkObjects(item, visitor);
}

function unwrapResponse(raw) {
  if (isPlainObject(raw) && isPlainObject(raw.body)) return { status: raw.status || raw.statusCode || 200, body: raw.body };
  if (isPlainObject(raw) && isPlainObject(raw.response)) return { status: raw.response.status || raw.status || 200, body: raw.response.body || raw.response };
  return { status: isPlainObject(raw) ? raw.status || raw.statusCode || 200 : 0, body: raw };
}

function extractVisibleText(body) {
  return pickFirstString(body?.assistant_message?.content, body?.assistant_text, body?.reply)
    || collectStrings(body).join(' ').trim();
}

function extractProducts(body) {
  const products = [];
  const pushProduct = (item) => {
    if (!isPlainObject(item)) return;
    const title = pickFirstString(item.title, item.name, item.display_name, item.displayName, item.product_name, item.productName, item.sku?.title, item.sku?.name);
    const productId = pickFirstString(item.product_id, item.productId, item.sku_id, item.skuId, item.sku?.product_id, item.sku?.productId);
    const text = collectStrings(item).join(' ');
    if (!title && !productId) return;
    products.push({
      product_id: productId || null,
      title: title || productId,
      category: pickFirstString(item.category, item.product_type, item.productType, item.sku?.category, item.sku?.product_type) || null,
      text,
    });
  };
  if (Array.isArray(body?.products)) body.products.forEach(pushProduct);
  if (Array.isArray(body?.results)) body.results.forEach(pushProduct);
  for (const card of asArray(body?.cards)) {
    if (Array.isArray(card?.products)) card.products.forEach(pushProduct);
    if (Array.isArray(card?.payload?.products)) card.payload.products.forEach(pushProduct);
    for (const section of asArray(card?.sections)) {
      if (Array.isArray(section?.products)) section.products.forEach(pushProduct);
    }
  }
  walkObjects(body, (obj) => {
    if (Array.isArray(obj.product_cards)) obj.product_cards.forEach(pushProduct);
    if (Array.isArray(obj.recommendations)) obj.recommendations.forEach(pushProduct);
  });
  const seen = new Set();
  return products.filter((product) => {
    const key = `${product.product_id || ''}:${normalizeText(product.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function responsePathFor(responsesDir, caseId, step) {
  const candidates = [
    path.join(responsesDir, caseId, `${step}.json`),
    path.join(responsesDir, `${caseId}_${step}.json`),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function validateDataset(dataset) {
  const errors = [];
  if (!isPlainObject(dataset)) return ['dataset_not_object'];
  if (dataset.schema_version !== 'product_seed_fit_accuracy.v1') errors.push('schema_version_invalid');
  const cases = asArray(dataset.cases);
  if (!cases.length) errors.push('cases_empty');
  const seen = new Set();
  for (const [idx, testCase] of cases.entries()) {
    const prefix = `cases[${idx}]`;
    const id = pickFirstString(testCase.case_id);
    if (!id) errors.push(`${prefix}.case_id_missing`);
    if (seen.has(id)) errors.push(`${prefix}.case_id_duplicate`);
    seen.add(id);
    if (!['CN', 'EN'].includes(String(testCase.language || '').toUpperCase())) errors.push(`${prefix}.language_invalid`);
    if (!isPlainObject(testCase.seed_product)) errors.push(`${prefix}.seed_product_missing`);
    if (!isPlainObject(testCase.expected)) errors.push(`${prefix}.expected_missing`);
  }
  return errors;
}

function scoreProductList(products, expected = {}) {
  const top = products.slice(0, 6);
  const relevant = top.filter((product) => includesAny([product.title, product.category, product.text].join(' '), expected.product_class_terms));
  const contraindicated = top.filter((product) => includesAny([product.title, product.category, product.text].join(' '), expected.contraindicated_terms));
  const blocked = top.filter((product) => includesAny([product.title, product.category, product.text].join(' '), expected.blocked_terms));
  return {
    top_count: top.length,
    relevant_count: relevant.length,
    contraindicated_count: contraindicated.length,
    blocked_count: blocked.length,
    relevant_titles: relevant.map((product) => product.title).slice(0, 6),
    contraindicated_titles: contraindicated.map((product) => product.title).slice(0, 6),
    pass:
      top.length > 0 &&
      relevant.length >= Number(expected.min_relevant_top6 || 1) &&
      contraindicated.length === 0,
  };
}

function scoreTextResponse({ body, status, testCase, step }) {
  const expected = testCase.expected || {};
  const text = extractVisibleText(body);
  const checks = [];
  const add = (name, pass, detail = {}) => checks.push({ name, pass: Boolean(pass), ...detail });
  add('http_2xx', Number(status) >= 200 && Number(status) < 300, { status });
  add('body_object', isPlainObject(body), {});
  const language = evaluateLanguage({ expectedLanguage: testCase.language, text });
  add('language_matches', language.pass, language);
  add('seed_identity_mentioned', includesAny(text, [testCase.seed_product?.title, testCase.seed_product?.brand].filter(Boolean)), {});
  add('fit_terms_present', includesAny(text, expected.fit_terms), {});
  for (const group of asArray(expected.must_include_any)) {
    add(`must_include_any:${asArray(group).join('|')}`, includesAny(text, group), {});
  }
  for (const term of asArray(expected.must_not_claim_any)) {
    add(`must_not_claim:${term}`, !containsTerm(text, term), {});
  }
  const contraindicatedText = includesAny(text, expected.contraindicated_terms)
    && !/\b(?:avoid|do not|not recommended|contraindicated|pregnancy|doctor|clinician|free)\b/i.test(text)
    && !/避免|不建议|不適合|不适合|医生|醫生|孕|无|無/.test(text);
  add('no_unguarded_contraindicated_claim', !contraindicatedText, {});
  const failed = checks.filter((check) => !check.pass);
  return {
    step,
    pass: failed.length === 0,
    checks,
    failed_checks: failed.map((check) => check.name),
    text_chars: text.length,
  };
}

function scoreCase(testCase, rawByStep) {
  const expected = testCase.expected || {};
  const stepResults = {};
  const allChecks = [];
  for (const step of ['product_analyze', 'chat']) {
    if (!rawByStep[step]) continue;
    const { status, body } = unwrapResponse(rawByStep[step]);
    const scored = scoreTextResponse({ body, status, testCase, step });
    stepResults[step] = scored;
    allChecks.push(...scored.checks.map((check) => ({ ...check, step })));
  }
  for (const step of ['shopping', 'creator']) {
    if (!rawByStep[step]) continue;
    const { status, body } = unwrapResponse(rawByStep[step]);
    const products = extractProducts(body);
    const assessment = scoreProductList(products, expected);
    const checks = [
      { name: 'http_2xx', pass: Number(status) >= 200 && Number(status) < 300, status },
      { name: 'products_non_empty', pass: products.length > 0, product_count: products.length },
      { name: 'top6_relevant', pass: assessment.relevant_count >= Number(expected.min_relevant_top6 || 1), ...assessment },
      { name: 'no_contraindicated_products', pass: assessment.contraindicated_count === 0, ...assessment },
    ];
    stepResults[step] = {
      step,
      pass: checks.every((check) => check.pass),
      checks,
      failed_checks: checks.filter((check) => !check.pass).map((check) => check.name),
      product_titles: products.map((product) => product.title).slice(0, 8),
      assessment,
    };
    allChecks.push(...checks.map((check) => ({ ...check, step })));
  }
  const failed = allChecks.filter((check) => !check.pass);
  return {
    case_id: testCase.case_id,
    pass: failed.length === 0,
    failed_checks: failed.map((check) => `${check.step}:${check.name}`),
    steps: stepResults,
    metrics: {
      contraindicated_product_count: ['shopping', 'creator'].reduce((sum, step) => sum + Number(stepResults[step]?.assessment?.contraindicated_count || 0), 0),
      product_relevance_checks: ['shopping', 'creator'].filter((step) => stepResults[step]),
      product_relevance_passes: ['shopping', 'creator'].filter((step) => stepResults[step]?.assessment?.pass).length,
    },
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders() {
  const key = pickFirstString(process.env.AGENT_API_KEY, process.env.PIVOTA_AGENT_API_KEY, process.env.PIVOTA_BACKEND_AGENT_API_KEY);
  if (!key) return {};
  return { 'X-Agent-API-Key': key, 'X-API-Key': key, Authorization: `Bearer ${key}` };
}

async function requestJson({ url, method = 'POST', headers = {}, payload = null, timeoutMs }) {
  const res = await fetchWithTimeout(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(payload == null ? {} : { body: JSON.stringify(payload) }),
  }, timeoutMs);
  let body = null;
  try {
    body = await res.json();
  } catch (_err) {
    body = { parse_error: true };
  }
  return { status: res.status, body };
}

function joinUrl(baseUrl, route) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${String(route || '').startsWith('/') ? route : `/${route}`}`;
}

function buildProductAnalyzePayload(testCase) {
  return {
    name: testCase.seed_product.title,
    product: {
      ...testCase.seed_product,
      name: testCase.seed_product.title,
    },
    profile_context: testCase.profile || {},
    language: testCase.language,
  };
}

function buildChatPayload(testCase) {
  const cn = String(testCase.language || '').toUpperCase() === 'CN';
  const title = testCase.seed_product.title;
  return {
    message: cn
      ? `请基于这个商品判断是否适合我：${title}。只根据商品信息和我的肤质回答。`
      : `Please judge whether this product fits me: ${title}. Use only the product record and my skin profile.`,
    language: testCase.language,
    profile: testCase.profile || {},
    product_context: testCase.seed_product,
  };
}

function buildInvokePayload(testCase, agent) {
  const query = pickFirstString(testCase.queries?.[agent], testCase.seed_product.title);
  const creatorId = pickFirstString(testCase.creator_id, 'nina-studio');
  return {
    operation: 'find_products_multi',
    payload: {
      search: {
        query,
        limit: 6,
        in_stock_only: true,
        market: 'US',
        ui_surface: 'product_seed_fit_accuracy',
        ...(agent === 'creator' ? { creator_id: creatorId } : {}),
      },
    },
    metadata: {
      source: agent === 'creator' ? 'creator_agent' : 'product_seed_fit_accuracy',
      test_suite: 'product_seed_fit_accuracy',
      case_id: testCase.case_id,
      seed_product_id: testCase.seed_product.product_id,
      ...(agent === 'creator' ? { creator_id: creatorId, creatorId } : {}),
    },
  };
}

async function runLiveCase(testCase, { baseUrl, timeoutMs }) {
  const headers = {
    'X-Lang': String(testCase.language || '').toUpperCase() === 'CN' ? 'CN' : 'EN',
    'X-Aurora-UID': `product-seed-fit-${testCase.case_id}`,
    ...authHeaders(),
  };
  const out = {};
  out.product_analyze = await requestJson({
    url: joinUrl(baseUrl, '/v1/product/analyze'),
    headers,
    payload: buildProductAnalyzePayload(testCase),
    timeoutMs,
  });
  out.chat = await requestJson({
    url: joinUrl(baseUrl, '/v1/chat'),
    headers,
    payload: buildChatPayload(testCase),
    timeoutMs,
  });
  out.shopping = await requestJson({
    url: joinUrl(baseUrl, '/agent/shop/v1/invoke'),
    headers,
    payload: buildInvokePayload(testCase, 'shopping'),
    timeoutMs,
  });
  out.creator = await requestJson({
    url: joinUrl(baseUrl, '/agent/creator/v1/invoke'),
    headers,
    payload: buildInvokePayload(testCase, 'creator'),
    timeoutMs,
  });
  return out;
}

function readOfflineCase(responsesDir, caseId) {
  const out = {};
  for (const step of ['product_analyze', 'chat', 'shopping', 'creator']) {
    const filePath = responsePathFor(responsesDir, caseId, step);
    if (filePath) out[step] = readJson(filePath);
  }
  return out;
}

function summarize(dataset, results) {
  const total = results.length;
  const passed = results.filter((row) => row.pass).length;
  const allStepChecks = results.flatMap((row) => Object.values(row.steps).flatMap((step) => step.checks || []));
  const httpChecks = allStepChecks.filter((check) => check.name === 'http_2xx');
  const languageChecks = allStepChecks.filter((check) => check.name === 'language_matches');
  const safetyChecks = allStepChecks.filter((check) => check.name === 'no_unguarded_contraindicated_claim' || check.name === 'no_contraindicated_products');
  const relevanceChecks = allStepChecks.filter((check) => check.name === 'top6_relevant');
  const contraindicated = results.reduce((sum, row) => sum + Number(row.metrics.contraindicated_product_count || 0), 0);
  const thresholds = dataset?.defaults?.thresholds || {};
  const rate = (checks) => (checks.length ? checks.filter((check) => check.pass).length / checks.length : 1);
  const summary = {
    schema_version: 'product_seed_fit_accuracy.report.v1',
    generated_at: new Date().toISOString(),
    total_cases: total,
    passed_cases: passed,
    case_pass_rate: total ? passed / total : 0,
    http_2xx_rate: rate(httpChecks),
    language_match_rate: rate(languageChecks),
    safety_pass_rate: rate(safetyChecks),
    product_relevance_rate: rate(relevanceChecks),
    contraindicated_product_count: contraindicated,
    thresholds,
  };
  summary.gate_pass =
    summary.case_pass_rate >= Number(thresholds.case_pass_rate_min ?? 0) &&
    summary.http_2xx_rate >= Number(thresholds.http_2xx_rate_min ?? 0) &&
    summary.language_match_rate >= Number(thresholds.language_match_rate_min ?? 0) &&
    summary.safety_pass_rate >= Number(thresholds.safety_pass_rate_min ?? 0) &&
    summary.product_relevance_rate >= Number(thresholds.product_relevance_rate_min ?? 0) &&
    summary.contraindicated_product_count <= Number(thresholds.contraindicated_product_max ?? 0);
  return summary;
}

function toMarkdown(summary, results) {
  const lines = [];
  lines.push('# Product Seed Fit Accuracy Report');
  lines.push('');
  lines.push(`- gate_pass: ${summary.gate_pass}`);
  lines.push(`- cases: ${summary.passed_cases}/${summary.total_cases} (${summary.case_pass_rate.toFixed(3)})`);
  lines.push(`- http_2xx_rate: ${summary.http_2xx_rate.toFixed(3)}`);
  lines.push(`- language_match_rate: ${summary.language_match_rate.toFixed(3)}`);
  lines.push(`- safety_pass_rate: ${summary.safety_pass_rate.toFixed(3)}`);
  lines.push(`- product_relevance_rate: ${summary.product_relevance_rate.toFixed(3)}`);
  lines.push(`- contraindicated_product_count: ${summary.contraindicated_product_count}`);
  lines.push('');
  lines.push('## Cases');
  for (const row of results) {
    lines.push(`- ${row.pass ? 'PASS' : 'FAIL'} ${row.case_id}: ${row.failed_checks.length ? row.failed_checks.join(', ') : 'ok'}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runBenchmark(args = parseArgs()) {
  const dataset = readJson(path.resolve(args.dataset));
  const validationErrors = validateDataset(dataset);
  if (validationErrors.length) throw new Error(`dataset validation failed: ${validationErrors.join(', ')}`);
  const outDir = args.outDir ? path.resolve(args.outDir) : path.join(DEFAULT_OUT_ROOT, nowStamp());
  ensureDir(outDir);
  ensureDir(path.join(outDir, 'raw'));
  const cases = asArray(dataset.cases).filter((testCase) => !args.caseId || testCase.case_id === args.caseId);
  const results = [];
  for (const testCase of cases) {
    const rawByStep = args.runLive
      ? await runLiveCase(testCase, { baseUrl: args.baseUrl, timeoutMs: args.timeoutMs || dataset.defaults?.timeout_ms || 30000 })
      : readOfflineCase(path.resolve(args.responsesDir), testCase.case_id);
    writeJson(path.join(outDir, 'raw', `${testCase.case_id}.json`), rawByStep);
    results.push(scoreCase(testCase, rawByStep));
  }
  const summary = summarize(dataset, results);
  const report = { summary, results };
  writeJson(path.join(outDir, 'summary.json'), report);
  fs.writeFileSync(path.join(outDir, 'report.md'), toMarkdown(summary, results));
  return { outDir, summary, results };
}

async function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.runLive && !args.baseUrl) throw new Error('missing --base-url or BASE_URL for live run');
    if (!args.runLive && !args.responsesDir) throw new Error('missing --responses-dir for offline run');
    const report = await runBenchmark(args);
    process.stdout.write(`${JSON.stringify({ out_dir: report.outDir, summary: report.summary }, null, 2)}\n`);
    if (args.failOnThreshold && !report.summary.gate_pass) process.exit(2);
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  validateDataset,
  scoreCase,
  scoreProductList,
  extractProducts,
  extractVisibleText,
  runBenchmark,
};
