#!/usr/bin/env node

const DEFAULT_GATEWAY = 'https://agent.pivota.cc/api/gateway';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_ROUNDS = 2;
const DEFAULT_WARN_WARM_MS = 3000;
const DEFAULT_INCLUDE = Object.freeze([
  'offers',
  'variant_selector',
  'active_ingredients',
  'ingredients_inci',
  'how_to_use',
  'product_details',
  'reviews_preview',
  'similar',
]);

const CASES = Object.freeze([
  {
    key: 'tf_quad_canary',
    merchant_id: 'external_seed',
    product_id: 'ext_8e7b0abf06e2ebc11f1356ae',
    title: 'Runway Eye Color Quad Creme',
    min_similar: 6,
    allow_missing_similar: false,
  },
  {
    key: 'ordinary_uv_filters',
    merchant_id: 'external_seed',
    product_id: 'ext_bbe1ff8884f06d874bbccbd8',
    title: 'The Ordinary UV Filters SPF 45 Serum',
    min_similar: 6,
    allow_missing_similar: false,
  },
  {
    key: 'winona_serum',
    merchant_id: 'merch_efbc46b4619cfbdf',
    product_id: '9886500749640',
    title: 'Winona Soothing Repair Serum',
    min_similar: 1,
    allow_missing_similar: false,
  },
  {
    key: 'ipsa_reset_aqua',
    merchant_id: 'merch_efbc46b4619cfbdf',
    product_id: '9886500127048',
    title: 'IPSA Time Reset Aqua',
    min_similar: 0,
    allow_missing_similar: true,
  },
]);

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeTitle(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function timedFetchJson(url, body, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - startedAt,
      json,
      error: null,
    };
  } catch (err) {
    const message =
      err && err.name === 'AbortError'
        ? 'TIMEOUT'
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      json: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function getModule(payload, type) {
  if (!payload || !Array.isArray(payload.modules)) return null;
  return payload.modules.find((module) => module && module.type === type) || null;
}

function getCanonicalTitle(payload) {
  const canonical = getModule(payload, 'canonical');
  const product = canonical?.data?.pdp_payload?.product || null;
  const title = product?.title || product?.name || null;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

function getSimilarItems(payload) {
  const similar = getModule(payload, 'similar') || getModule(payload, 'recommendations');
  const items = similar?.data?.items;
  return Array.isArray(items) ? items : [];
}

function buildGetPdpBody(target) {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        merchant_id: target.merchant_id,
        product_id: target.product_id,
      },
      include: [...DEFAULT_INCLUDE],
      options: {
        debug: true,
      },
      capabilities: {
        client: 'standard_pdp_smoke',
      },
    },
  };
}

function buildFindSimilarBody(target, excludeItems = []) {
  return {
    operation: 'find_similar_products',
    payload: {
      similar: {
        merchant_id: target.merchant_id,
        product_id: target.product_id,
        limit: 6,
        ...(excludeItems.length ? { exclude_items: excludeItems } : {}),
      },
      options: {
        debug: true,
      },
      capabilities: {
        client: 'standard_pdp_smoke',
      },
    },
  };
}

function summarizePdpResponse(result, target) {
  const payload = result?.json || null;
  const similarModule = getModule(payload, 'similar');
  const similarItems = getSimilarItems(payload);
  const missingModules = Array.isArray(payload?.missing)
    ? payload.missing
        .map((item) => String(item?.type || '').trim())
        .filter(Boolean)
    : [];

  return {
    key: target.key,
    status: result.status,
    ok: Boolean(result.ok && payload?.status === 'success'),
    latency_ms: result.ms,
    build_id: payload?.build_id || null,
    title: getCanonicalTitle(payload),
    missing_modules: missingModules,
    has_offers: Boolean(getModule(payload, 'offers')?.data),
    has_reviews_preview: Boolean(getModule(payload, 'reviews_preview')),
    has_similar_module: Boolean(similarModule),
    similar_count: similarItems.length,
    similar_titles: similarItems.map((item) => String(item?.title || '').trim()).filter(Boolean),
    raw_error: result.error || null,
  };
}

function validateCase(target, summary, warmLatencyWarnMs) {
  const errors = [];
  const warnings = [];

  if (!summary.ok) {
    errors.push(`${target.key}: get_pdp_v2 failed (${summary.status || 0}) ${summary.raw_error || ''}`.trim());
    return { errors, warnings };
  }

  if (!summary.has_offers) {
    errors.push(`${target.key}: offers module missing data`);
  }

  if (!summary.has_reviews_preview) {
    errors.push(`${target.key}: reviews_preview module missing`);
  }

  if (!summary.title) {
    errors.push(`${target.key}: canonical title missing`);
  }

  if (!summary.has_similar_module && !target.allow_missing_similar) {
    errors.push(`${target.key}: similar module missing`);
  }

  if (summary.has_similar_module && summary.similar_count < target.min_similar) {
    errors.push(
      `${target.key}: similar items ${summary.similar_count} below expected minimum ${target.min_similar}`,
    );
  }

  if (summary.has_similar_module && summary.similar_titles.length) {
    const normalized = summary.similar_titles.map(normalizeTitle).filter(Boolean);
    const unique = new Set(normalized);
    if (unique.size !== normalized.length) {
      errors.push(`${target.key}: similar module contains duplicate titles`);
    }
  }

  if (summary.missing_modules.length) {
    const missing = summary.missing_modules.join(', ');
    if (summary.missing_modules.includes('similar') && target.allow_missing_similar) {
      warnings.push(`${target.key}: similar module unavailable for this sample`);
    } else {
      errors.push(`${target.key}: missing modules ${missing}`);
    }
  }

  if (summary.latency_ms > warmLatencyWarnMs) {
    warnings.push(`${target.key}: warm get_pdp_v2 latency ${summary.latency_ms}ms exceeds ${warmLatencyWarnMs}ms`);
  }

  return { errors, warnings };
}

async function runFindSimilarPaginationCheck(baseGateway, timeoutMs, target) {
  const page1 = await timedFetchJson(baseGateway, buildFindSimilarBody(target), timeoutMs);
  const payload1 = page1.json || null;
  const items1 = Array.isArray(payload1?.products)
    ? payload1.products
    : Array.isArray(payload1?.items)
      ? payload1.items
      : [];
  const firstTitles = items1.map((item) => normalizeTitle(item?.title)).filter(Boolean);
  const firstKeySet = new Set(
    items1.map((item) => `${String(item?.merchant_id || '').trim()}::${String(item?.product_id || '').trim()}`),
  );

  if (!page1.ok || payload1?.status !== 'success') {
    return {
      errors: [`find_similar_products page1 failed (${page1.status || 0}) ${page1.error || ''}`.trim()],
      warnings: [],
      page1_count: items1.length,
      page2_count: 0,
    };
  }

  const excludeItems = items1
    .map((item) => ({
      product_id: String(item?.product_id || '').trim(),
      merchant_id: String(item?.merchant_id || '').trim() || undefined,
      title: String(item?.title || '').trim() || undefined,
    }))
    .filter((item) => item.product_id);

  const page2 = await timedFetchJson(baseGateway, buildFindSimilarBody(target, excludeItems), timeoutMs);
  const payload2 = page2.json || null;
  const items2 = Array.isArray(payload2?.products)
    ? payload2.products
    : Array.isArray(payload2?.items)
      ? payload2.items
      : [];
  const errors = [];
  const warnings = [];

  if (!page2.ok || payload2?.status !== 'success') {
    errors.push(`find_similar_products page2 failed (${page2.status || 0}) ${page2.error || ''}`.trim());
    return {
      errors,
      warnings,
      page1_count: items1.length,
      page2_count: items2.length,
    };
  }

  if (items1.length < 6) {
    errors.push(`find_similar_products page1 returned only ${items1.length} items`);
  }

  if (items2.length < 3) {
    warnings.push(`find_similar_products page2 returned only ${items2.length} items after exclusions`);
  }

  const overlapByKey = items2.some((item) =>
    firstKeySet.has(`${String(item?.merchant_id || '').trim()}::${String(item?.product_id || '').trim()}`),
  );
  if (overlapByKey) {
    errors.push('find_similar_products page2 overlaps page1 by merchant/product key');
  }

  const page2Titles = items2.map((item) => normalizeTitle(item?.title)).filter(Boolean);
  const overlapByTitle = page2Titles.some((title) => firstTitles.includes(title));
  if (overlapByTitle) {
    errors.push('find_similar_products page2 overlaps page1 by normalized title');
  }

  return {
    errors,
    warnings,
    page1_count: items1.length,
    page2_count: items2.length,
  };
}

async function main() {
  const baseGateway = String(process.env.PDP_SMOKE_GATEWAY || DEFAULT_GATEWAY).trim();
  const timeoutMs = parsePositiveInt(process.env.PDP_SMOKE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const rounds = parsePositiveInt(process.env.PDP_SMOKE_ROUNDS, DEFAULT_ROUNDS);
  const warmLatencyWarnMs = parsePositiveInt(
    process.env.PDP_SMOKE_WARN_WARM_MS,
    DEFAULT_WARN_WARM_MS,
  );

  const allErrors = [];
  const allWarnings = [];
  const perCaseResults = new Map();

  for (let round = 1; round <= rounds; round += 1) {
    for (const target of CASES) {
      const result = await timedFetchJson(baseGateway, buildGetPdpBody(target), timeoutMs);
      const summary = summarizePdpResponse(result, target);
      const current = perCaseResults.get(target.key) || [];
      current.push({ round, summary });
      perCaseResults.set(target.key, current);
    }
  }

  for (const target of CASES) {
    const roundsForTarget = perCaseResults.get(target.key) || [];
    const cold = roundsForTarget[0]?.summary || null;
    const warm = roundsForTarget[roundsForTarget.length - 1]?.summary || null;
    const validation = validateCase(target, warm, warmLatencyWarnMs);
    allErrors.push(...validation.errors);
    allWarnings.push(...validation.warnings);

    console.log(
      JSON.stringify({
        key: target.key,
        cold_latency_ms: cold?.latency_ms ?? null,
        warm_latency_ms: warm?.latency_ms ?? null,
        build_id: warm?.build_id ?? null,
        title: warm?.title ?? null,
        similar_count: warm?.similar_count ?? null,
        missing_modules: warm?.missing_modules ?? [],
      }),
    );
  }

  const pagination = await runFindSimilarPaginationCheck(baseGateway, timeoutMs, CASES[0]);
  allErrors.push(...pagination.errors);
  allWarnings.push(...pagination.warnings);
  console.log(
    JSON.stringify({
      key: 'find_similar_pagination',
      page1_count: pagination.page1_count,
      page2_count: pagination.page2_count,
    }),
  );

  if (allWarnings.length) {
    console.error('WARNINGS:');
    for (const warning of allWarnings) console.error(`- ${warning}`);
  }

  if (allErrors.length) {
    console.error('FAILURES:');
    for (const error of allErrors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log('OK: standard PDP production smoke passed');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
