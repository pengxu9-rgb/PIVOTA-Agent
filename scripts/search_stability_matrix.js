#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  AUTHORITATIVE_COMMERCE,
  normalizeRailMode,
  normalizeEndpoint,
  resolveBaseUrl,
  assertRailAuth,
} = require('./lib/commerce_invoke_contract');
const { evaluatePrimaryPathContract } = require('./lib/commerce_primary_path');
const { loadProdGateCases } = require('./lib/commerce_shared_acceptance_corpus');

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseArgs(argv) {
  const railMode = normalizeRailMode(process.env.SEARCH_MATRIX_RAIL_MODE || '');
  const args = {
    railMode,
    baseUrl: resolveBaseUrl(process.env.SEARCH_MATRIX_BASE_URL || '', railMode),
    endpoint: normalizeEndpoint(process.env.SEARCH_MATRIX_ENDPOINT || '', railMode),
    rounds: Number(process.env.SEARCH_MATRIX_ROUNDS || 20),
    timeoutMs: Number(process.env.SEARCH_MATRIX_TIMEOUT_MS || 10000),
    outDir: process.env.SEARCH_MATRIX_OUT_DIR || 'reports',
    queryFile: process.env.SEARCH_MATRIX_QUERY_FILE || '',
    source: process.env.SEARCH_MATRIX_SOURCE || 'shopping_agent',
    evalMode:
      String(process.env.SEARCH_MATRIX_EVAL_MODE || '').trim().toLowerCase() === 'true',
    evalHeader: process.env.SEARCH_MATRIX_EVAL_HEADER || 'X-Eval',
    evalHeaderValue: process.env.SEARCH_MATRIX_EVAL_HEADER_VALUE || '1',
    authToken: process.env.SEARCH_MATRIX_AUTH_TOKEN || '',
    agentApiKey: process.env.SEARCH_MATRIX_AGENT_API_KEY || '',
    failOnGateFailures:
      String(process.env.SEARCH_MATRIX_FAIL_ON_GATE_FAILURES || '').trim().toLowerCase() === 'true',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--rail-mode' && next) args.railMode = normalizeRailMode(next);
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--rounds' && next) args.rounds = Math.max(1, Number(next) || 1);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(500, Number(next) || 10000);
    if (token === '--out-dir' && next) args.outDir = String(next);
    if (token === '--query-file' && next) args.queryFile = String(next);
    if (token === '--source' && next) args.source = String(next);
    if (token === '--eval-mode') args.evalMode = true;
    if (token === '--eval-header' && next) args.evalHeader = String(next);
    if (token === '--eval-header-value' && next) args.evalHeaderValue = String(next);
    if (token === '--auth-token' && next) args.authToken = String(next);
    if (token === '--agent-api-key' && next) args.agentApiKey = String(next);
    if (token === '--fail-on-gate-failures') args.failOnGateFailures = true;
  }
  args.baseUrl = resolveBaseUrl(args.baseUrl, args.railMode);
  args.endpoint = normalizeEndpoint(args.endpoint, args.railMode);
  return args;
}

function defaultQueries() {
  return [
    'ipsa',
    '薇诺娜',
    'Winona products',
    'IPSA Time Reset Aqua',
    '推荐化妆刷',
    '我今晚有个约会，要化妆，要推荐点商品吧？',
    'foundation brush recommendation',
    '有没有狗链推荐？',
    'dog leash recommendation',
    '宠物背带推荐',
    '随便推荐点商品',
    '有什么适合今晚约会的',
  ];
}

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCurrency(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return String(fallback || '').trim().toUpperCase();
  const upper = text.toUpperCase();
  if (upper === '$' || upper === 'USD' || /USD|DOLLAR|美元|美金/.test(upper)) return 'USD';
  if (upper === '€' || upper === 'EUR' || /EUR|EURO|欧元/.test(upper)) return 'EUR';
  if (upper === '£' || upper === 'GBP' || /GBP|POUND|英镑/.test(upper)) return 'GBP';
  if (
    upper === '¥' ||
    upper === '￥' ||
    upper === 'CNY' ||
    upper === 'RMB' ||
    /人民币|元/.test(String(value || ''))
  ) {
    return 'CNY';
  }
  if (upper === 'JPY' || /YEN|円|日元|日圆/.test(String(value || ''))) return 'JPY';
  return upper || String(fallback || '').trim().toUpperCase();
}

function getProductPriceMajor(product) {
  if (!product || typeof product !== 'object') return NaN;
  const majorCandidates = [
    product.price,
    product.sale_price,
    product.salePrice,
    product.unit_price,
    product.unitPrice,
    product.price_amount,
    product.priceAmount,
    product.pricing?.current?.amount,
  ];
  for (const raw of majorCandidates) {
    const n = typeof raw === 'number' ? raw : Number(String(raw || '').trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  const minorCandidates = [
    product.price_cents,
    product.priceCents,
    product.amount_minor,
    product.amountMinor,
  ];
  for (const raw of minorCandidates) {
    const n = typeof raw === 'number' ? raw : Number(String(raw || '').trim());
    if (Number.isFinite(n) && n > 0) return n / 100;
  }
  return NaN;
}

function getProductPriceCurrency(product, fallback = '') {
  if (!product || typeof product !== 'object') {
    return normalizeCurrency(fallback, '') || '';
  }
  return normalizeCurrency(
    product.currency ||
      product.price_currency ||
      product.priceCurrency ||
      product.pricing?.current?.currency,
    fallback,
  );
}

function parseBudgetConstraintFromQuery(query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const patterns = [
    /\b(?:under|below|less than|up to|max(?:imum)?|<=?)\s*(\$|€|£|¥|￥)\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\b(?:under|below|less than|up to|max(?:imum)?|<=?)\s*([0-9]+(?:\.[0-9]+)?)\s*(usd|eur|gbp|cny|jpy)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const [, left, right] = match;
    const symbolOrCurrency = pattern === patterns[0] ? left : right;
    const amountText = pattern === patterns[0] ? right : left;
    const amount = Number(amountText);
    const currency = normalizeCurrency(symbolOrCurrency, '');
    if (Number.isFinite(amount) && amount > 0 && currency) {
      return { max: amount, currency };
    }
  }
  return null;
}

function resolveBudgetMaxForCurrency(budgetConstraint, candidateCurrency, metadata = {}) {
  if (!budgetConstraint || !(Number(budgetConstraint.max) > 0)) return null;
  const sourceCurrency = normalizeCurrency(budgetConstraint.currency, '');
  const targetCurrency = normalizeCurrency(candidateCurrency, sourceCurrency);
  if (!sourceCurrency || !targetCurrency) return null;
  if (sourceCurrency === targetCurrency) return Number(budgetConstraint.max);
  const metadataCurrency = normalizeCurrency(metadata.budget_fx_candidate_currency, '');
  const fxRate = Number(metadata.budget_fx_rate);
  if (metadataCurrency === targetCurrency && Number.isFinite(fxRate) && fxRate > 0) {
    return Math.round(Number(budgetConstraint.max) * fxRate * 100) / 100;
  }
  return null;
}

function normalizeCase(rawCase, defaultSource, fallbackId = '') {
  if (typeof rawCase === 'string') {
    return {
      id: fallbackId || normalizeText(rawCase).replace(/\s+/g, '_') || 'query_case',
      query: rawCase,
      source: defaultSource,
      request_metadata: {},
      request_search: {},
      allow_zero_results: true,
      must_have_metadata: [],
      must_not_return_titles: [],
      must_return_titles: [],
      must_return_one_of_titles: [],
      must_return_one_of_title_token_sets: [],
      must_respect_budget: false,
      must_have_reason_codes: [],
      must_equal_metadata: {},
      must_be_positive_metadata: [],
      must_have_clarification: null,
      expected_contract_path: null,
      catalog_surface: null,
      require_primary_path: true,
      allow_strict_empty: false,
      allowed_query_sources: [],
      must_not_match_fallback_sources: [],
    };
  }
  const query = String(rawCase?.query || '').trim();
  if (!query) return null;
  return {
    id:
      String(rawCase?.id || '').trim() ||
      fallbackId ||
      normalizeText(query).replace(/\s+/g, '_') ||
      'query_case',
    family: String(rawCase?.family || '').trim() || null,
    query,
    source: String(rawCase?.source || '').trim() || defaultSource,
    catalog_surface: String(rawCase?.catalog_surface || rawCase?.catalogSurface || '').trim() || null,
    request_metadata:
      rawCase?.request_metadata && typeof rawCase.request_metadata === 'object' && !Array.isArray(rawCase.request_metadata)
        ? { ...rawCase.request_metadata }
        : {},
    request_search:
      rawCase?.request_search && typeof rawCase.request_search === 'object' && !Array.isArray(rawCase.request_search)
        ? { ...rawCase.request_search }
        : {},
    allow_zero_results: rawCase?.allow_zero_results !== false,
    must_have_metadata: Array.isArray(rawCase?.must_have_metadata)
      ? rawCase.must_have_metadata.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    must_not_return_titles: Array.isArray(rawCase?.must_not_return_titles)
      ? rawCase.must_not_return_titles.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    must_return_titles: Array.isArray(rawCase?.must_return_titles)
      ? rawCase.must_return_titles.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    must_return_one_of_titles: Array.isArray(rawCase?.must_return_one_of_titles)
      ? rawCase.must_return_one_of_titles.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    must_return_one_of_title_token_sets: Array.isArray(rawCase?.must_return_one_of_title_token_sets)
      ? rawCase.must_return_one_of_title_token_sets
          .map((tokenSet) =>
            Array.isArray(tokenSet)
              ? tokenSet.map((item) => String(item || '').trim()).filter(Boolean)
              : [String(tokenSet || '').trim()].filter(Boolean),
          )
          .filter((tokenSet) => tokenSet.length > 0)
      : [],
    must_respect_budget: rawCase?.must_respect_budget === true,
    must_have_reason_codes: Array.isArray(rawCase?.must_have_reason_codes)
      ? rawCase.must_have_reason_codes.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    must_equal_metadata:
      rawCase?.must_equal_metadata && typeof rawCase.must_equal_metadata === 'object'
        ? Object.fromEntries(
            Object.entries(rawCase.must_equal_metadata)
              .map(([key, value]) => [String(key || '').trim(), value])
              .filter(([key]) => key),
          )
        : {},
    must_be_positive_metadata: Array.isArray(rawCase?.must_be_positive_metadata)
      ? rawCase.must_be_positive_metadata.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    must_have_clarification:
      typeof rawCase?.must_have_clarification === 'boolean'
        ? rawCase.must_have_clarification
        : null,
    expected_contract_path: String(rawCase?.expected_contract_path || '').trim() || null,
    limit: Math.max(1, Number(rawCase?.limit || 10) || 10),
    in_stock_only: rawCase?.in_stock_only !== false,
    require_primary_path: rawCase?.require_primary_path !== false,
    allow_strict_empty: rawCase?.allow_strict_empty === true,
    allowed_query_sources: Array.isArray(rawCase?.allowed_query_sources)
      ? rawCase.allowed_query_sources.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    must_not_match_fallback_sources: Array.isArray(rawCase?.must_not_match_fallback_sources)
      ? rawCase.must_not_match_fallback_sources
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
  };
}

function defaultQueryCases(defaultSource) {
  return defaultQueries().map((query, index) =>
    normalizeCase(query, defaultSource, `default_${index + 1}`),
  );
}

function loadQueryCases(queryFile, defaultSource) {
  if (!queryFile) return defaultQueryCases(defaultSource);
  try {
    const list = loadProdGateCases(queryFile);
    const cases = list
      .map((item, index) => normalizeCase(item, defaultSource, `case_${index + 1}`))
      .filter(Boolean);
    return cases.length ? cases : defaultQueryCases(defaultSource);
  } catch (_error) {
    const fullPath = path.resolve(queryFile);
    const text = fs.readFileSync(fullPath, 'utf8');
    const trimmed = text.trim();
    if (!trimmed) return defaultQueryCases(defaultSource);

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cases)
        ? parsed.cases
        : [];
      const cases = list
        .map((item, index) => normalizeCase(item, defaultSource, `case_${index + 1}`))
        .filter(Boolean);
      return cases.length ? cases : defaultQueryCases(defaultSource);
    }

    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const cases = lines
      .map((line, index) => normalizeCase(line, defaultSource, `line_${index + 1}`))
      .filter(Boolean);
    return cases.length ? cases : defaultQueryCases(defaultSource);
  }
}

function buildAnchorTokens(query) {
  const normalized = normalizeText(query);
  const tokens = normalized.split(' ').filter(Boolean);
  const blacklist = new Set([
    '有',
    '有没有',
    '推荐',
    '商品',
    'products',
    'recommendation',
    'recommend',
    'please',
    'what',
    'with',
    'for',
    'the',
  ]);
  return tokens.filter((tok) => tok.length >= 2 && !blacklist.has(tok)).slice(0, 8);
}

function isRelevantResult(query, products) {
  if (!Array.isArray(products) || products.length === 0) return true;
  const anchors = buildAnchorTokens(query);
  if (!anchors.length) return true;
  const top = products.slice(0, 5);
  return top.some((item) => {
    const text = normalizeText(
      [
        item?.title,
        item?.name,
        item?.brand,
        item?.vendor,
        item?.description,
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (!text) return false;
    if (anchors.length === 1) return text.includes(anchors[0]);
    const overlap = anchors.filter((tok) => text.includes(tok)).length;
    return overlap >= 2;
  });
}

function inferQueryClassFromQuery(query) {
  const text = normalizeText(query);
  if (!text) return 'exploratory';
  if (/gift|礼物|送礼|送禮/.test(text)) return 'gift';
  if (/how to|guide|教程|攻略|退货|退貨/.test(text)) return 'non_shopping';
  if (/date|约会|約會|travel|出差|hiking|徒步|登山|scenario/.test(text)) return 'scenario';
  if (/budget|预算|price|under|above|以内|以上|防水|无香/.test(text)) return 'attribute';
  if (/ipsa|winona|tom ford|fenty|sku|model|型号|型號|\b[a-z]{1,6}\d{2,}\b/.test(text)) {
    return 'lookup';
  }
  if (/recommend|推荐|products|商品/.test(text)) return 'category';
  return 'exploratory';
}

function getPath(obj, rawPath) {
  const pathText = String(rawPath || '').trim();
  if (!pathText) return undefined;
  return pathText
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function normalizeTitles(products) {
  return (Array.isArray(products) ? products : [])
    .map((item) => String(item?.title || item?.name || '').trim())
    .filter(Boolean);
}

function valuesEqual(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    return Number(left) === Number(right);
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Boolean(left) === Boolean(right);
  }
  return String(left) === String(right);
}

function buildAuthHeaders(args = {}) {
  const headers = {};
  const authToken = String(args.authToken || '').trim();
  const agentApiKey = String(args.agentApiKey || '').trim();
  if (authToken) {
    headers.Authorization = /^Bearer\s+/i.test(authToken)
      ? authToken
      : `Bearer ${authToken}`;
  }
  if (agentApiKey) {
    headers['X-Agent-API-Key'] = agentApiKey;
  }
  return headers;
}

function evaluateCase(row) {
  const spec = row?.caseSpec || {};
  const data = row?.data || {};
  const metadata =
    data && typeof data === 'object' && data.metadata && typeof data.metadata === 'object'
      ? data.metadata
      : {};
  const products = Array.isArray(data.products) ? data.products : [];
  const contractBridge =
    metadata && typeof metadata.contract_bridge === 'object' && !Array.isArray(metadata.contract_bridge)
      ? metadata.contract_bridge
      : {};
  const titles = normalizeTitles(products);
  const reasonCodes = Array.isArray(data.reason_codes) ? data.reason_codes.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const hasClarification = Boolean(data?.clarification && data.clarification.question);
  const reasons = [];
  const primaryPath = evaluatePrimaryPathContract(data, {
    require_primary_path: spec.require_primary_path !== false,
    allow_strict_empty: spec.allow_strict_empty === true,
    allowed_query_sources: spec.allowed_query_sources,
    must_not_match_fallback_sources: spec.must_not_match_fallback_sources,
  });

  if (spec.expected_contract_path) {
    const actualContract = String(contractBridge.resolved_contract || '').trim();
    if (actualContract !== String(spec.expected_contract_path)) {
      reasons.push(
        `expected_contract_path=${spec.expected_contract_path} actual=${actualContract || 'null'}`,
      );
    }
  }

  if (spec.allow_zero_results === false && products.length === 0) {
    reasons.push('expected_non_empty_results');
  }

  const metadataPaths = Array.isArray(spec.must_have_metadata) ? spec.must_have_metadata : [];
  for (const rawPath of metadataPaths) {
    const pathText = String(rawPath || '').trim();
    const resolvedValue = pathText.startsWith('metadata.')
      ? getPath(data, pathText)
      : getPath(metadata, pathText) ?? getPath(data, pathText);
    const missing =
      resolvedValue == null ||
      (typeof resolvedValue === 'string' && resolvedValue.trim().length === 0);
    if (missing) {
      reasons.push(`missing_metadata:${pathText}`);
    }
  }

  const mustNotReturn = Array.isArray(spec.must_not_return_titles) ? spec.must_not_return_titles : [];
  for (const forbiddenTitle of mustNotReturn) {
    const normalizedForbidden = normalizeText(forbiddenTitle);
    if (!normalizedForbidden) continue;
    if (titles.some((title) => normalizeText(title).includes(normalizedForbidden))) {
      reasons.push(`forbidden_title:${forbiddenTitle}`);
    }
  }

  const mustReturn = Array.isArray(spec.must_return_titles) ? spec.must_return_titles : [];
  for (const requiredTitle of mustReturn) {
    const normalizedRequired = normalizeText(requiredTitle);
    if (!normalizedRequired) continue;
    if (!titles.some((title) => normalizeText(title).includes(normalizedRequired))) {
      reasons.push(`missing_exact_required_title:${requiredTitle}`);
    }
  }

  const mustReturnOneOf = Array.isArray(spec.must_return_one_of_titles)
    ? spec.must_return_one_of_titles
    : [];
  if (mustReturnOneOf.length > 0) {
    const hasAllowedTitle = mustReturnOneOf.some((candidate) => {
      const normalizedCandidate = normalizeText(candidate);
      return normalizedCandidate
        ? titles.some((title) => normalizeText(title).includes(normalizedCandidate))
        : false;
    });
    if (!hasAllowedTitle) {
      reasons.push(`missing_required_title:${mustReturnOneOf.join(' | ')}`);
    }
  }

  const mustReturnOneOfTitleTokenSets = Array.isArray(spec.must_return_one_of_title_token_sets)
    ? spec.must_return_one_of_title_token_sets
    : [];
  if (mustReturnOneOfTitleTokenSets.length > 0) {
    const hasAllowedTokenSet = mustReturnOneOfTitleTokenSets.some((tokenSet) => {
      const normalizedTokens = (Array.isArray(tokenSet) ? tokenSet : [])
        .map((token) => normalizeText(token))
        .filter(Boolean);
      if (normalizedTokens.length === 0) return false;
      return titles.some((title) => {
        const normalizedTitle = normalizeText(title);
        return normalizedTokens.every((token) => normalizedTitle.includes(token));
      });
    });
    if (!hasAllowedTokenSet) {
      const serializedTokenSets = mustReturnOneOfTitleTokenSets
        .map((tokenSet) => (Array.isArray(tokenSet) ? tokenSet.join(' & ') : ''))
        .filter(Boolean);
      reasons.push(`missing_required_title_tokens:${serializedTokenSets.join(' | ')}`);
    }
  }

  if (spec.must_respect_budget === true) {
    const budgetConstraint = parseBudgetConstraintFromQuery(spec.query);
    if (!budgetConstraint) {
      reasons.push('budget_constraint_unparsed');
    } else {
      for (const product of products) {
        const price = getProductPriceMajor(product);
        if (!Number.isFinite(price)) continue;
        const currency = getProductPriceCurrency(
          product,
          metadata.budget_fx_candidate_currency || budgetConstraint.currency,
        );
        const resolvedMax = resolveBudgetMaxForCurrency(budgetConstraint, currency, metadata);
        if (!(Number.isFinite(resolvedMax) && resolvedMax > 0)) {
          reasons.push(`budget_constraint_unresolved:${currency || 'unknown_currency'}`);
          continue;
        }
        if (price - resolvedMax > 1e-9) {
          const title =
            String(product?.title || product?.name || product?.display_name || product?.product_id || 'unknown').trim() ||
            'unknown';
          reasons.push(
            `over_budget_product:${title}@${price}${currency || ''}:max=${resolvedMax}${currency || ''}`,
          );
        }
      }
    }
  }

  if (typeof spec.must_have_clarification === 'boolean') {
    if (hasClarification !== spec.must_have_clarification) {
      reasons.push(
        `clarification_mismatch:expected=${JSON.stringify(spec.must_have_clarification)} actual=${JSON.stringify(hasClarification)}`,
      );
    }
  }

  const mustHaveReasonCodes = Array.isArray(spec.must_have_reason_codes)
    ? spec.must_have_reason_codes
    : [];
  for (const requiredCode of mustHaveReasonCodes) {
    const normalizedRequiredCode = String(requiredCode || '').trim();
    if (!normalizedRequiredCode) continue;
    if (!reasonCodes.includes(normalizedRequiredCode)) {
      reasons.push(`missing_reason_code:${normalizedRequiredCode}`);
    }
  }

  const mustEqualMetadata =
    spec.must_equal_metadata && typeof spec.must_equal_metadata === 'object'
      ? spec.must_equal_metadata
      : {};
  for (const [rawPath, expectedValue] of Object.entries(mustEqualMetadata)) {
    const pathText = String(rawPath || '').trim();
    if (!pathText) continue;
    const actualValue = pathText.startsWith('metadata.')
      ? getPath(data, pathText)
      : getPath(metadata, pathText) ?? getPath(data, pathText);
    if (!valuesEqual(actualValue, expectedValue)) {
      reasons.push(
        `metadata_mismatch:${pathText}:expected=${JSON.stringify(expectedValue)} actual=${JSON.stringify(actualValue)}`,
      );
    }
  }

  const mustBePositive = Array.isArray(spec.must_be_positive_metadata)
    ? spec.must_be_positive_metadata
    : [];
  for (const rawPath of mustBePositive) {
    const pathText = String(rawPath || '').trim();
    if (!pathText) continue;
    const actualValue = pathText.startsWith('metadata.')
      ? getPath(data, pathText)
      : getPath(metadata, pathText) ?? getPath(data, pathText);
    if (!(Number(actualValue) > 0)) {
      reasons.push(`metadata_not_positive:${pathText}:actual=${JSON.stringify(actualValue)}`);
    }
  }

  if (!primaryPath.passed) {
    reasons.push(...primaryPath.reasons);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    primaryPath: primaryPath.assessment,
  };
}

function classifyRow(row) {
  const requestError = !row?.ok;
  const errorText = String(row?.error || '');
  const requestTimeout = /timeout|etimedout|econnaborted/i.test(errorText);
  if (requestError) {
    return {
      timeout: requestTimeout,
      strictEmpty: false,
      fallback: false,
      irrelevant: false,
      querySource: 'request_error',
      productCount: 0,
      queryClass: inferQueryClassFromQuery(row?.query),
      finalDecision: 'request_error',
      clarifyTriggered: false,
      requestError: true,
      resolvedContract: '',
      strictConstraintQuery: false,
      strictConstraintReason: '',
    };
  }

  const data = row?.data || {};
  const metadata = (data && typeof data === 'object' && data.metadata && typeof data.metadata === 'object')
    ? data.metadata
    : {};
  const routeDebug =
    metadata && typeof metadata.route_debug === 'object' && !Array.isArray(metadata.route_debug)
      ? metadata.route_debug
      : {};
  const crossMerchantDebug =
    routeDebug && typeof routeDebug.cross_merchant_cache === 'object' && !Array.isArray(routeDebug.cross_merchant_cache)
      ? routeDebug.cross_merchant_cache
      : {};
  const policyAmbiguity =
    routeDebug &&
    routeDebug.policy &&
    typeof routeDebug.policy === 'object' &&
    routeDebug.policy.ambiguity &&
    typeof routeDebug.policy.ambiguity === 'object'
      ? routeDebug.policy.ambiguity
      : {};
  const policyPostQuality =
    policyAmbiguity &&
    policyAmbiguity.post_quality &&
    typeof policyAmbiguity.post_quality === 'object'
      ? policyAmbiguity.post_quality
      : {};
  const decisionPostQuality =
    metadata &&
    metadata.search_decision &&
    typeof metadata.search_decision === 'object' &&
    metadata.search_decision.post_quality &&
    typeof metadata.search_decision.post_quality === 'object'
      ? metadata.search_decision.post_quality
      : {};
  const postQuality = Object.keys(policyPostQuality).length
    ? policyPostQuality
    : decisionPostQuality;
  const routeHealth =
    metadata && typeof metadata.route_health === 'object' && !Array.isArray(metadata.route_health)
      ? metadata.route_health
      : {};
  const searchTrace =
    metadata && typeof metadata.search_trace === 'object' && !Array.isArray(metadata.search_trace)
      ? metadata.search_trace
      : {};
  const contractBridge =
    metadata && typeof metadata.contract_bridge === 'object' && !Array.isArray(metadata.contract_bridge)
      ? metadata.contract_bridge
      : {};
  const serviceVersion =
    metadata && typeof metadata.service_version === 'object' && !Array.isArray(metadata.service_version)
      ? metadata.service_version
      : {};
  const routeTrace =
    metadata && typeof metadata.route_trace === 'object' && !Array.isArray(metadata.route_trace)
      ? metadata.route_trace
      : {};
  const gatewayGovernance =
    metadata && typeof metadata.gateway_governance === 'object' && !Array.isArray(metadata.gateway_governance)
      ? metadata.gateway_governance
      : {};
  const gatewayInvocation =
    metadata && typeof metadata.gateway_invocation === 'object' && !Array.isArray(metadata.gateway_invocation)
      ? metadata.gateway_invocation
      : {};
  const gatewayQueryGovernance =
    gatewayGovernance.query_governance &&
    typeof gatewayGovernance.query_governance === 'object' &&
    !Array.isArray(gatewayGovernance.query_governance)
      ? gatewayGovernance.query_governance
      : {};
  const products = Array.isArray(data.products) ? data.products : [];
  const primaryPath = evaluatePrimaryPathContract(data, {
    require_primary_path: false,
    allow_strict_empty: true,
  }).assessment;
  const querySource = String(primaryPath.querySource || metadata.query_source || '');
  const upstreamCode = String(
    metadata.upstream_error_code || metadata?.proxy_search_fallback?.upstream_error_code || '',
  );
  const timeout = upstreamCode.toUpperCase() === 'ECONNABORTED';
  const strictEmpty =
    Boolean(primaryPath.strictEmpty) ||
    (Boolean(metadata.strict_empty) || (products.length === 0 && !data.clarification));
  const fallback = primaryPath.degraded;
  const irrelevant = !isRelevantResult(row.query, products);
  const queryClass = String(
    searchTrace.query_class || metadata?.search_decision?.query_class || inferQueryClassFromQuery(row.query),
  );
  const gatewayGovernanceMode = String(gatewayGovernance.mode || '').trim() || null;
  const gatewayObservedAction =
    String(
      gatewayGovernance.observed_action ||
        gatewayQueryGovernance.action ||
        '',
    ).trim() || 'allow';
  const gatewayEffectiveAction =
    String(gatewayGovernance.effective_action || '').trim() ||
    (gatewayGovernanceMode === 'shadow' ? 'allow' : gatewayObservedAction);
  const gatewayInvocationSurface = String(gatewayInvocation.surface || '').trim() || null;
  const gatewayReasonCodes = Array.isArray(gatewayGovernance.reason_codes)
    ? gatewayGovernance.reason_codes.map((item) => String(item || '').trim()).filter(Boolean)
    : Array.isArray(gatewayQueryGovernance.reason_codes)
      ? gatewayQueryGovernance.reason_codes.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
  const gatewayObservedPhase = String(gatewayGovernance.observed_phase || '').trim() || null;
  const gatewayEntryLayer = String(gatewayGovernance.entry_layer || '').trim() || null;
  const gatewayWouldEnforce = gatewayGovernance.would_enforce === true;
  return {
    timeout,
    strictEmpty,
    fallback,
    irrelevant,
    querySource,
    productCount: products.length,
    queryClass,
    finalDecision: String(searchTrace.final_decision || metadata?.search_decision?.final_decision || ''),
    clarifyTriggered: Boolean(routeHealth?.clarify_triggered || data?.clarification),
    postCandidates: Number.isFinite(
      Number(postQuality?.candidates ?? crossMerchantDebug?.products_count),
    )
      ? Number(postQuality?.candidates ?? crossMerchantDebug?.products_count)
      : null,
    postAnchorRatio: Number.isFinite(Number(postQuality?.anchor_ratio))
      ? Number(postQuality.anchor_ratio)
      : null,
    postDomainEntropy: Number.isFinite(Number(postQuality?.domain_entropy))
      ? Number(postQuality.domain_entropy)
      : null,
    postAnchorBasisSize: Number.isFinite(Number(postQuality?.anchor_basis_size))
      ? Number(postQuality.anchor_basis_size)
      : null,
    requestError: false,
    resolvedContract: String(contractBridge.resolved_contract || ''),
    strictConstraintQuery: Boolean(metadata.strict_constraint_query),
    strictConstraintReason: String(metadata.strict_constraint_reason || ''),
    ingredientIntents: Array.isArray(metadata.ingredient_intents) ? metadata.ingredient_intents : [],
    matchedIngredientIds: Array.isArray(metadata.matched_ingredient_ids)
      ? metadata.matched_ingredient_ids
      : [],
    serviceCommit: String(serviceVersion.commit || ''),
    visibleOptionIntents: Array.isArray(metadata.visible_option_intents)
      ? metadata.visible_option_intents
      : [],
    matchedVisibleOptionLabels: Array.isArray(metadata.matched_visible_option_labels)
      ? metadata.matched_visible_option_labels
      : [],
    serviceVersionCommitPresent: Boolean(String(serviceVersion.commit || '').trim()),
    failureStage: String(routeTrace.failure_stage || '').trim() || null,
    nodeTimingsMs:
      routeTrace.node_timings_ms &&
      typeof routeTrace.node_timings_ms === 'object' &&
      !Array.isArray(routeTrace.node_timings_ms)
        ? routeTrace.node_timings_ms
        : null,
    fallbackUsed: primaryPath.degraded,
    mainPathPass: !requestError && Boolean(String(serviceVersion.commit || '').trim()) && !primaryPath.degraded,
    primaryPathDegraded: primaryPath.degraded,
    primaryPathDegradedReasons: primaryPath.reasons,
    decisionAuthority: primaryPath.decisionAuthority || null,
    decisionLocked: primaryPath.decisionLocked === true,
    decisionLockReason: primaryPath.decisionLockReason || null,
    observerNodes: Array.isArray(primaryPath.observerNodes) ? primaryPath.observerNodes : [],
    primaryPathUsed: primaryPath.primaryPathUsed,
    fallbackReason: primaryPath.fallbackReason,
    gatewayGovernanceEvent:
      gatewayGovernanceMode || gatewayInvocationSurface || gatewayReasonCodes.length > 0
        ? {
            mode: gatewayGovernanceMode || 'unknown',
            invocation_surface: gatewayInvocationSurface,
            observed_action: gatewayObservedAction,
            effective_action: gatewayEffectiveAction,
            would_enforce: gatewayWouldEnforce,
            reason_codes: gatewayReasonCodes,
            observed_phase: gatewayObservedPhase,
            entry_layer: gatewayEntryLayer,
          }
        : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertRailAuth({
    railMode: args.railMode,
    authToken: args.authToken,
    agentApiKey: args.agentApiKey,
    context: 'search_stability_matrix',
  });
  const cases = loadQueryCases(args.queryFile, args.source);
  const runTs = timestamp();
  const baseUrl = resolveBaseUrl(args.baseUrl, args.railMode);
  const endpoint = normalizeEndpoint(args.endpoint, args.railMode);
  const url = `${baseUrl}${endpoint}`;
  const results = [];
  const startedAt = Date.now();
  const authHeaders = buildAuthHeaders(args);
  const authMode = authHeaders.Authorization && authHeaders['X-Agent-API-Key']
    ? 'bearer_and_agent_api_key'
    : authHeaders.Authorization
      ? 'bearer'
      : authHeaders['X-Agent-API-Key']
        ? 'x-agent-api-key'
        : 'none';

  for (let round = 1; round <= args.rounds; round += 1) {
    for (const caseSpec of cases) {
      const started = Date.now();
      let row = {
        round,
        case_id: caseSpec.id,
        family: caseSpec.family || null,
        query: caseSpec.query,
        caseSpec,
        ok: false,
        status: 0,
        latency_ms: 0,
        data: null,
        error: null,
      };
      try {
        const metadata = {
          ...(caseSpec.request_metadata && typeof caseSpec.request_metadata === 'object'
            ? caseSpec.request_metadata
            : {}),
          source: caseSpec.source || args.source,
          ...(caseSpec.catalog_surface ? { catalog_surface: caseSpec.catalog_surface } : {}),
          ...(args.evalMode ? { eval_mode: true } : {}),
        };
        const search = {
          ...(caseSpec.request_search && typeof caseSpec.request_search === 'object'
            ? caseSpec.request_search
            : {}),
          query: caseSpec.query,
          limit: caseSpec.limit || 10,
          in_stock_only: caseSpec.in_stock_only !== false,
          ...(caseSpec.catalog_surface ? { catalog_surface: caseSpec.catalog_surface } : {}),
        };
        const resp = await axios.post(
          url,
          {
            operation: 'find_products_multi',
            payload: {
              search,
            },
            metadata,
          },
          {
            timeout: args.timeoutMs,
            validateStatus: () => true,
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders,
              ...(args.evalMode
                ? { [String(args.evalHeader || 'X-Eval')]: String(args.evalHeaderValue || '1') }
                : {}),
            },
          },
        );
        row = {
          ...row,
          ok: resp.status >= 200 && resp.status < 300,
          status: Number(resp.status || 0) || 0,
          latency_ms: Math.max(0, Date.now() - started),
          data: resp.data,
        };
      } catch (err) {
        row = {
          ...row,
          ok: false,
          status: 0,
          latency_ms: Math.max(0, Date.now() - started),
          error: String(err?.message || err),
        };
      }
      results.push(row);
    }
  }

  const classified = results.map((row) => {
    const metrics = classifyRow(row);
    const gate = evaluateCase(row);
    return { ...row, metrics, gate };
  });
  const total = classified.length;
  const timeoutCount = classified.filter((row) => row.metrics.timeout).length;
  const requestErrorCount = classified.filter((row) => row.metrics.requestError).length;
  const fallbackCount = classified.filter((row) => row.metrics.fallback).length;
  const primaryPathDegradedCount = classified.filter((row) => row.metrics.primaryPathDegraded).length;
  const mainPathPassCount = classified.filter((row) => row.metrics.mainPathPass).length;
  const serviceVersionCommitMissingCount = classified.filter(
    (row) => !row.metrics.serviceVersionCommitPresent,
  ).length;
  const strictEmptyCount = classified.filter((row) => row.metrics.strictEmpty).length;
  const irrelevantCount = classified.filter((row) => row.metrics.irrelevant).length;
  const nonEmptyCount = classified.filter((row) => row.metrics.productCount > 0).length;
  const clarifyCount = classified.filter((row) => row.metrics.clarifyTriggered).length;
  const gateFailureCount = classified.filter((row) => !row.gate.passed).length;
  const strictPrecisionFailureCount = classified.filter(
    (row) => row.family === 'external_false_positive_sentinel' && !row.gate.passed,
  ).length;
  const strictParserGapCount = classified.filter(
    (row) => row.family === 'query_parse_gap' && !row.gate.passed,
  ).length;
  const strictCoverageGapCount = classified.filter(
    (row) => row.family === 'external_coverage_gap' && row.metrics.strictEmpty,
  ).length;
  const falsePositiveTitleCount = classified.reduce(
    (count, row) =>
      count +
      (Array.isArray(row.gate.reasons)
        ? row.gate.reasons.filter((reason) => String(reason || '').startsWith('forbidden_title:')).length
        : 0),
    0,
  );
  const perQueryClass = {};
  const perCase = {};

  for (const row of classified) {
    const key = String(row.metrics.queryClass || 'unknown');
    if (!perQueryClass[key]) {
      perQueryClass[key] = {
        total: 0,
        timeout: 0,
        fallback: 0,
        strict_empty: 0,
        irrelevant: 0,
        non_empty: 0,
        clarify: 0,
        gate_fail: 0,
      };
    }
    perQueryClass[key].total += 1;
    if (row.metrics.timeout) perQueryClass[key].timeout += 1;
    if (row.metrics.fallback) perQueryClass[key].fallback += 1;
    if (row.metrics.strictEmpty) perQueryClass[key].strict_empty += 1;
    if (row.metrics.irrelevant) perQueryClass[key].irrelevant += 1;
    if (row.metrics.productCount > 0) perQueryClass[key].non_empty += 1;
    if (row.metrics.clarifyTriggered) perQueryClass[key].clarify += 1;
    if (!row.gate.passed) perQueryClass[key].gate_fail += 1;

    const caseKey = String(row.case_id || row.query);
    if (!perCase[caseKey]) {
      perCase[caseKey] = {
        id: row.case_id,
        family: row.family || null,
        query: row.query,
        total: 0,
        pass: 0,
        fail: 0,
        latest_reasons: [],
      };
    }
    perCase[caseKey].total += 1;
    if (row.gate.passed) {
      perCase[caseKey].pass += 1;
    } else {
      perCase[caseKey].fail += 1;
      perCase[caseKey].latest_reasons = row.gate.reasons;
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    endpoint,
    rail_mode: args.railMode,
    authoritative_endpoint:
      args.railMode === AUTHORITATIVE_COMMERCE ? `${baseUrl}${endpoint}` : null,
    authoritative_mode: args.railMode === AUTHORITATIVE_COMMERCE ? AUTHORITATIVE_COMMERCE : null,
    public_probe_non_authoritative: args.railMode !== AUTHORITATIVE_COMMERCE,
    auth_mode: authMode,
    eval_mode: Boolean(args.evalMode),
    rounds: args.rounds,
    total_requests: total,
    total_duration_ms: Math.max(0, Date.now() - startedAt),
    timeout_rate: total ? timeoutCount / total : 0,
    request_error_rate: total ? requestErrorCount / total : 0,
    fallback_rate: total ? fallbackCount / total : 0,
    primary_path_degraded_count: primaryPathDegradedCount,
    main_path_pass_count: mainPathPassCount,
    service_version_commit_missing_count: serviceVersionCommitMissingCount,
    strict_empty_rate: total ? strictEmptyCount / total : 0,
    irrelevant_result_rate: total ? irrelevantCount / total : 0,
    non_empty_rate: total ? nonEmptyCount / total : 0,
    clarify_rate: total ? clarifyCount / total : 0,
    gate_failure_rate: total ? gateFailureCount / total : 0,
    strict_precision_failure_rate: total ? strictPrecisionFailureCount / total : 0,
    strict_parser_gap_rate: total ? strictParserGapCount / total : 0,
    strict_coverage_gap_rate: total ? strictCoverageGapCount / total : 0,
    false_positive_title_count: falsePositiveTitleCount,
    per_query_class: perQueryClass,
    cases: cases.map((item) => ({
      id: item.id,
      family: item.family || null,
      query: item.query,
      expected_contract_path: item.expected_contract_path,
    })),
  };

  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `search_stability_matrix_${runTs}`;
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const mdPath = path.join(outDir, `${baseName}.md`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        summary,
        per_case: perCase,
        rows: classified.map((row) => ({
          round: row.round,
          case_id: row.case_id,
          family: row.family,
          query: row.query,
          ok: row.ok,
          status: row.status,
          latency_ms: row.latency_ms,
          query_source: row.metrics.querySource,
          product_count: row.metrics.productCount,
          timeout: row.metrics.timeout,
          fallback: row.metrics.fallback,
          fallback_used: row.metrics.fallbackUsed,
          main_path_pass: row.metrics.mainPathPass,
          primary_path_degraded: row.metrics.primaryPathDegraded,
          primary_path_degraded_reasons: row.metrics.primaryPathDegradedReasons,
          decision_authority: row.metrics.decisionAuthority,
          decision_locked: row.metrics.decisionLocked,
          decision_lock_reason: row.metrics.decisionLockReason,
          observer_nodes: row.metrics.observerNodes,
          primary_path_used: row.metrics.primaryPathUsed,
          fallback_reason: row.metrics.fallbackReason,
          gateway_governance: row.metrics.gatewayGovernanceEvent,
          failure_stage: row.metrics.failureStage,
          node_timings_ms: row.metrics.nodeTimingsMs,
          strict_empty: row.metrics.strictEmpty,
          irrelevant: row.metrics.irrelevant,
          query_class: row.metrics.queryClass,
          final_decision: row.metrics.finalDecision,
          clarify_triggered: row.metrics.clarifyTriggered,
          post_candidates: row.metrics.postCandidates,
          post_anchor_ratio: row.metrics.postAnchorRatio,
          post_domain_entropy: row.metrics.postDomainEntropy,
          post_anchor_basis_size: row.metrics.postAnchorBasisSize,
          resolved_contract: row.metrics.resolvedContract,
          strict_constraint_query: row.metrics.strictConstraintQuery,
          strict_constraint_reason: row.metrics.strictConstraintReason,
          service_commit: row.metrics.serviceCommit,
          service_version_commit_present: row.metrics.serviceVersionCommitPresent,
          ingredient_intents: row.metrics.ingredientIntents,
          matched_ingredient_ids: row.metrics.matchedIngredientIds,
          visible_option_intents: row.metrics.visibleOptionIntents,
          matched_visible_option_labels: row.metrics.matchedVisibleOptionLabels,
          gate_passed: row.gate.passed,
          gate_reasons: row.gate.reasons,
          error: row.error,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  const failingCases = Object.values(perCase).filter((item) => item.fail > 0);
  const md = [
    '# Search Stability Matrix',
    '',
    `- generated_at: ${summary.generated_at}`,
    `- base_url: ${summary.base_url}`,
    `- endpoint: ${summary.endpoint}`,
    `- rail_mode: ${summary.rail_mode}`,
    `- authoritative_endpoint: ${summary.authoritative_endpoint || 'n/a'}`,
    `- public_probe_non_authoritative: ${summary.public_probe_non_authoritative}`,
    `- rounds: ${summary.rounds}`,
    `- total_requests: ${summary.total_requests}`,
    `- timeout_rate: ${summary.timeout_rate.toFixed(4)}`,
    `- request_error_rate: ${summary.request_error_rate.toFixed(4)}`,
    `- fallback_rate: ${summary.fallback_rate.toFixed(4)}`,
    `- primary_path_degraded_count: ${summary.primary_path_degraded_count}`,
    `- main_path_pass_count: ${summary.main_path_pass_count}`,
    `- service_version_commit_missing_count: ${summary.service_version_commit_missing_count}`,
    `- strict_empty_rate: ${summary.strict_empty_rate.toFixed(4)}`,
    `- irrelevant_result_rate: ${summary.irrelevant_result_rate.toFixed(4)}`,
    `- non_empty_rate: ${summary.non_empty_rate.toFixed(4)}`,
    `- clarify_rate: ${summary.clarify_rate.toFixed(4)}`,
    `- gate_failure_rate: ${summary.gate_failure_rate.toFixed(4)}`,
    `- strict_precision_failure_rate: ${summary.strict_precision_failure_rate.toFixed(4)}`,
    `- strict_parser_gap_rate: ${summary.strict_parser_gap_rate.toFixed(4)}`,
    `- strict_coverage_gap_rate: ${summary.strict_coverage_gap_rate.toFixed(4)}`,
    `- false_positive_title_count: ${summary.false_positive_title_count}`,
    '',
    '| metric | value |',
    '|---|---:|',
    `| timeout_count | ${timeoutCount} |`,
    `| request_error_count | ${requestErrorCount} |`,
    `| fallback_count | ${fallbackCount} |`,
    `| primary_path_degraded_count | ${primaryPathDegradedCount} |`,
    `| main_path_pass_count | ${mainPathPassCount} |`,
    `| service_version_commit_missing_count | ${serviceVersionCommitMissingCount} |`,
    `| strict_empty_count | ${strictEmptyCount} |`,
    `| irrelevant_count | ${irrelevantCount} |`,
    `| non_empty_count | ${nonEmptyCount} |`,
    `| clarify_count | ${clarifyCount} |`,
    `| gate_failure_count | ${gateFailureCount} |`,
    `| strict_precision_failure_count | ${strictPrecisionFailureCount} |`,
    `| strict_parser_gap_count | ${strictParserGapCount} |`,
    `| strict_coverage_gap_count | ${strictCoverageGapCount} |`,
    `| false_positive_title_count | ${falsePositiveTitleCount} |`,
    '',
    '## Per Query Class',
    '',
    '| query_class | total | timeout | fallback | strict_empty | irrelevant | non_empty | clarify | gate_fail |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(perQueryClass)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([queryClass, metrics]) =>
          `| ${queryClass} | ${metrics.total} | ${metrics.timeout} | ${metrics.fallback} | ${metrics.strict_empty} | ${metrics.irrelevant} | ${metrics.non_empty} | ${metrics.clarify} | ${metrics.gate_fail} |`,
      ),
    '',
    '## Per Case',
    '',
    '| case_id | family | total | pass | fail | latest_reasons |',
    '|---|---|---:|---:|---:|---|',
    ...Object.values(perCase)
      .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
      .map(
        (item) =>
          `| ${item.id} | ${item.family || ''} | ${item.total} | ${item.pass} | ${item.fail} | ${item.latest_reasons.join('; ') || ''} |`,
      ),
    '',
    ...(failingCases.length > 0
      ? [
          '## Failing Cases',
          '',
          '| case_id | query | reasons |',
          '|---|---|---|',
          ...failingCases.map(
            (item) => `| ${item.id} | ${item.query} | ${item.latest_reasons.join('; ')} |`,
          ),
          '',
        ]
      : []),
    `JSON: ${path.relative(process.cwd(), jsonPath)}`,
  ].join('\n');
  fs.writeFileSync(mdPath, md, 'utf8');

  const result = {
    ok: !(args.failOnGateFailures && gateFailureCount > 0),
    summary,
    json: jsonPath,
    markdown: mdPath,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
