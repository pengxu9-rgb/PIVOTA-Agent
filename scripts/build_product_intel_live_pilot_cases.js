#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

function parseArgs(argv) {
  const out = {
    gatewayUrl: process.env.PIVOTA_GATEWAY_URL || 'https://agent.pivota.cc/api/gateway',
    productIds: [],
    limit: 10,
    seed: String(process.env.PRODUCT_INTEL_PILOT_SEED || '20260408'),
    out: '',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--gateway-url' && next) {
      out.gatewayUrl = next;
      i += 1;
    } else if (token === '--product-ids' && next) {
      out.productIds = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Number(next) || 10);
      i += 1;
    } else if (token === '--seed' && next) {
      out.seed = String(next);
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    }
  }

  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function createSeededRandom(seedText) {
  let h = 2166136261 >>> 0;
  const seed = asString(seedText) || '20260408';
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function random() {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement(values, limit, seed) {
  const list = Array.from(new Set(asArray(values).map((item) => asString(item)).filter(Boolean)));
  if (list.length <= limit) return list;
  const random = createSeededRandom(seed);
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, limit);
}

function normalizeBrandName(rawBrand) {
  if (!rawBrand) return '';
  if (typeof rawBrand === 'string') return rawBrand.trim();
  if (typeof rawBrand === 'object') {
    return asString(rawBrand.name || rawBrand.brand_name || rawBrand.brandName);
  }
  return '';
}

function findModule(modules, type) {
  return asArray(modules).find((module) => module && module.type === type) || null;
}

function extractDetailsText(detailsModule, pattern) {
  const sections = asArray(detailsModule?.data?.sections);
  for (const section of sections) {
    const heading = asString(section?.heading || section?.title);
    if (!pattern.test(heading)) continue;
    return asString(section?.body || section?.text || section?.content);
  }
  return '';
}

function extractCanonicalProduct(response) {
  const canonicalModule = findModule(response?.modules, 'canonical');
  return canonicalModule?.data?.pdp_payload?.product || canonicalModule?.data?.product || null;
}

function buildPilotCaseFromPdpResponse(response) {
  const subject = response?.subject || {};
  const canonicalRef = subject?.canonical_product_ref || null;
  const product = extractCanonicalProduct(response);
  if (!product || !canonicalRef?.product_id) return null;

  const detailsModule = findModule(response?.modules, 'product_details');
  const ingredientsModule = findModule(response?.modules, 'ingredients_inci');

  const brand = normalizeBrandName(product.brand);
  const categoryPath = asArray(product.category_path).map((item) => asString(item)).filter(Boolean);
  const category = categoryPath.length ? categoryPath.join('/') : asString(product.category || product.product_type);
  const howToUse = extractDetailsText(detailsModule, /how to use|directions/i);
  const overview = extractDetailsText(detailsModule, /overview|details|description/i);
  const ingredients = asArray(
    ingredientsModule?.data?.ingredients_inci ||
      ingredientsModule?.data?.ingredients ||
      product.ingredients_inci ||
      product.ingredients,
  )
    .map((item) => asString(item?.inci || item))
    .filter(Boolean);

  return {
    case_id: `live_${canonicalRef.product_id}`,
    notes: `Live pilot case sampled from public /products listing (${brand || 'unknown brand'}).`,
    canonical_product_ref: canonicalRef,
    product: {
      merchant_id: canonicalRef.merchant_id,
      product_id: canonicalRef.product_id,
      brand,
      title: asString(product.title || product.name),
      category,
      description: asString(product.description || overview),
      tags: categoryPath,
      texture: asString(product.texture),
      finish: asString(product.finish),
      ingredients_inci: ingredients,
      how_to_use: howToUse,
      review_summary:
        typeof product.rating === 'number' || typeof product.review_count === 'number'
          ? {
              rating: product.rating ?? null,
              review_count: product.review_count ?? product.reviewCount ?? null,
            }
          : undefined,
    },
  };
}

async function fetchPdpResponse(gatewayUrl, productId) {
  const body = {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        product_id: productId,
      },
      include: ['canonical', 'product_details', 'ingredients_inci', 'offers'],
      options: {
        debug: false,
      },
    },
    metadata: {
      source: 'product_intel_live_pilot_builder',
    },
  };

  const response = await axios.post(gatewayUrl, body, {
    timeout: 20000,
    headers: {
      'content-type': 'application/json',
    },
  });
  return response.data;
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const selectedIds = sampleWithoutReplacement(args.productIds, args.limit, args.seed);
  if (!selectedIds.length) {
    throw new Error('missing_product_ids');
  }

  const cases = [];
  for (const productId of selectedIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchPdpResponse(args.gatewayUrl, productId);
      const row = buildPilotCaseFromPdpResponse(response);
      if (row) cases.push(row);
    } catch (err) {
      cases.push({
        case_id: `live_${productId}`,
        notes: `Pilot fetch failed: ${asString(err?.message || err)}`,
        canonical_product_ref: {
          merchant_id: 'unknown',
          product_id: productId,
        },
        error: asString(err?.message || err),
      });
    }
  }

  const outputPath = resolvePath(
    rootDir,
    args.out || `reports/product_intel_live_pilot_cases_${args.seed}.json`,
  );
  writeJson(outputPath, cases);

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      requested: selectedIds.length,
      built: cases.filter((row) => !row.error).length,
      out: outputPath,
      product_ids: selectedIds,
    })}\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildPilotCaseFromPdpResponse,
  sampleWithoutReplacement,
};
