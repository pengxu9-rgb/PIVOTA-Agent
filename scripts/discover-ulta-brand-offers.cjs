#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  attachCommerceFactsToSeedRow,
  validateCommerceFactsGateForSeedRow,
} = require('../src/commerce/commerceFacts');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';

const DEFAULT_BRANDS = [
  'Clinique',
  'Estée Lauder',
  'MAC',
  'Maybelline',
  "L'Oreal Paris",
  'NYX',
  'La Roche-Posay',
  'Benefit Cosmetics',
  'Ariana Grande',
  'Dior',
  'The Ordinary',
  'Tarte',
  'Urban Decay',
  'Too Faced',
  'Lancôme',
  'Bobbi Brown',
  'NARS',
  'Rare Beauty',
  'e.l.f. Cosmetics',
  'CeraVe',
  'Neutrogena',
  'Olay',
  'Supergoop!',
  'COSRX',
  'Peach & Lily',
  "Kiehl's Since 1851",
  'Sol de Janeiro',
  'Drunk Elephant',
  'Sunday Riley',
  'TULA',
  'Dermalogica',
  'First Aid Beauty',
  'Peach Slices',
  'OPI',
];

const BRAND_SLUG_OVERRIDES = {
  'benefit cosmetics': 'benefit-cosmetics',
  'bobbi brown': 'bobbi-brown',
  cerave: 'cerave',
  clinique: 'clinique',
  cosrx: 'cosrx',
  dermalogica: 'dermalogica',
  dior: 'dior',
  'drunk elephant': 'drunk-elephant',
  'e l f cosmetics': 'elf-cosmetics',
  'e.l.f. cosmetics': 'elf-cosmetics',
  'estée lauder': 'estee-lauder',
  'estee lauder': 'estee-lauder',
  'fenty beauty': 'fenty-beauty',
  'first aid beauty': 'first-aid-beauty',
  "kiehl's since 1851": 'kiehls-since-1851',
  'l oreal paris': 'loreal',
  "l'oreal paris": 'loreal',
  lancome: 'lancome',
  'lancôme': 'lancome',
  'la roche-posay': 'la-roche-posay',
  mac: 'mac',
  maybelline: 'maybelline',
  nars: 'nars',
  neutrogena: 'neutrogena',
  nyx: 'nyx-professional-makeup',
  olay: 'olay',
  opi: 'opi',
  'peach & lily': 'peach-lily',
  'peach slices': 'peach-slices',
  'rare beauty': 'rare-beauty',
  'sol de janeiro': 'sol-de-janeiro',
  sunday: 'sunday-riley',
  'sunday riley': 'sunday-riley',
  supergoop: 'supergoop',
  'supergoop!': 'supergoop',
  tarte: 'tarte',
  'the ordinary': 'ordinary',
  'too faced': 'too-faced',
  tula: 'tula',
  'urban decay': 'urban-decay-cosmetics',
};

const BRAND_ALIASES = {
  'benefit cosmetics': ['benefit'],
  'e l f cosmetics': ['elf', 'e l f'],
  'e.l.f. cosmetics': ['elf', 'e l f'],
  'estée lauder': ['estee lauder', 'estée lauder', 'lauder'],
  'l oreal paris': ['loreal', "l'oreal", 'l oreal'],
  "l'oreal paris": ['loreal', "l'oreal", 'l oreal'],
  'lancôme': ['lancome', 'lancôme'],
  mac: ['mac'],
  nyx: ['nyx'],
  opi: ['opi'],
};

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value == null ? '' : value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sleep(ms) {
  const duration = Number(ms);
  if (!Number.isFinite(duration) || duration <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function resolveOutPath(value) {
  const target = asString(value);
  if (!target) return '';
  return path.isAbsolute(target) ? target : path.join(process.cwd(), target);
}

function parseDelimited(value) {
  return Array.from(
    new Set(
      asString(value)
        .split(/;;|,|\n/g)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function stripDiacritics(value) {
  return asString(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function brandKey(brand) {
  return normalizeText(brand);
}

function slugifyBrand(brand) {
  const key = brandKey(brand);
  if (BRAND_SLUG_OVERRIDES[key]) return BRAND_SLUG_OVERRIDES[key];
  return key.replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

function getBrandAliases(brand) {
  const key = brandKey(brand);
  const tokens = key.split(/\s+/).filter(Boolean);
  const distinctive = tokens.filter(
    (token) =>
      ![
        'beauty',
        'cosmetics',
        'professional',
        'makeup',
        'paris',
        'skin',
        'skincare',
        'since',
        'the',
        'and',
      ].includes(token),
  );
  return Array.from(
    new Set([
      key,
      compactText(key),
      ...(BRAND_ALIASES[key] || []),
      ...distinctive.filter((token) => token.length >= 3),
    ].map(normalizeText).filter(Boolean)),
  );
}

function offerText(offer) {
  return normalizeText(
    [
      offer.product_title,
      offer.title,
      offer.product_description,
      offer.description,
      offer.url_canonical,
      offer.url,
      offer.source_url,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function offerMatchesBrand(offer, brand) {
  const text = offerText(offer);
  if (!text) return false;
  const compact = text.replace(/\s+/g, '');
  const aliases = getBrandAliases(brand);
  return aliases.some((alias) => {
    if (!alias) return false;
    const normalizedAlias = normalizeText(alias);
    if (!normalizedAlias) return false;
    if (normalizedAlias.length <= 3) {
      return new RegExp(`(^|\\s)${normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(text);
    }
    return text.includes(normalizedAlias) || compact.includes(normalizedAlias.replace(/\s+/g, ''));
  });
}

function normalizeUrl(value) {
  const raw = asString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeUrlKey(value) {
  const url = normalizeUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.searchParams.sort();
    parsed.hostname = parsed.hostname.replace(/^www\./, '');
    return parsed.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.replace(/\/+$/, '').toLowerCase();
  }
}

function getHost(value) {
  try {
    return new URL(normalizeUrl(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function stableHash(prefix, parts, length = 16) {
  const hash = crypto.createHash('sha256').update(parts.map(asString).join('\n')).digest('hex').slice(0, length);
  return `${prefix}${hash}`;
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = asString(value).replace(/[^0-9.-]+/g, '');
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeAvailability(value) {
  const normalized = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['in_stock', 'instock', 'available'].includes(normalized)) return 'in_stock';
  if (['out_of_stock', 'outofstock', 'unavailable'].includes(normalized)) return 'out_of_stock';
  return normalized || 'unknown';
}

function buildUltaImageUrl(variantSku) {
  const sku = asString(variantSku).replace(/[^0-9A-Za-z_-]+/g, '');
  return sku ? `https://media.ulta.com/i/ulta/${sku}?w=720&h=720&fmt=auto` : '';
}

function offerImageUrls(offer, variantSku) {
  const candidates = [
    offer.image_url,
    offer.image,
    ...asArray(offer.image_urls),
    ...asArray(offer.images),
    ...asArray(offer.media).map((item) => item?.url || item?.src),
    buildUltaImageUrl(variantSku),
  ];
  const seen = new Set();
  const urls = [];
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function isSafeOffer(offer) {
  const url = normalizeUrl(offer.url_canonical || offer.url || offer.source_url);
  const host = getHost(url);
  const facts = asObject(offer.commerce_facts_v1);
  const regionalPrice = asObject(facts.regional_price);
  const amount = normalizeAmount(regionalPrice.amount || offer.price_amount);
  const currency = asString(regionalPrice.currency || regionalPrice.observed_currency || offer.price_currency).toUpperCase();
  const confidence = asString(regionalPrice.confidence || offer.currency_confidence).toLowerCase();
  const marketSwitch = asString(regionalPrice.market_switch_status || offer.market_switch_status).toLowerCase();
  return (
    host === 'ulta.com' &&
    amount > 0 &&
    currency === 'USD' &&
    ['high', 'medium'].includes(confidence || 'high') &&
    (!marketSwitch || marketSwitch === 'ok')
  );
}

function buildSeedRowFromOffer({ offer, brand, brandUrl, market }) {
  const url = normalizeUrl(offer.url_canonical || offer.url || offer.source_url);
  const variantSku = asString(offer.variant_sku || offer.sku);
  const priceAmount = normalizeAmount(offer.commerce_facts_v1?.regional_price?.amount || offer.price_amount);
  const priceCurrency = asString(
    offer.commerce_facts_v1?.regional_price?.currency ||
      offer.commerce_facts_v1?.regional_price?.observed_currency ||
      offer.price_currency ||
      'USD',
  ).toUpperCase();
  const availability = normalizeAvailability(offer.commerce_facts_v1?.availability?.status || offer.availability);
  const sourceProductId = asString(offer.source_product_id);
  const urlKey = normalizeUrlKey(url);
  const externalProductId = `ulta:${stableHash('', [urlKey, variantSku || sourceProductId], 16)}`;
  const seedId = stableHash('eps_', ['ulta-retailer-offer', externalProductId], 24);
  const title = asString(offer.product_title || offer.title || externalProductId);
  const description = asString(offer.product_description || offer.description);
  const imageUrls = offerImageUrls(offer, variantSku);
  const imageUrl = imageUrls[0] || '';
  const snapshot = {
    source: 'ulta_brand_offer_discovery_v1',
    extracted_at: new Date().toISOString(),
    brand,
    source_brand_url: brandUrl,
    source_site: 'www.ulta.com',
    source_product_id: sourceProductId,
    canonical_url: url,
    destination_url: url,
    external_redirect_url: url,
    title,
    description,
    price_amount: priceAmount,
    price_currency: priceCurrency,
    availability,
    image_url: imageUrl || '',
    image_urls: imageUrls,
    images: imageUrls,
    variant_sku: variantSku || null,
    variants: [
      {
        sku: variantSku || sourceProductId || externalProductId,
        variant_id: variantSku || sourceProductId || externalProductId,
        variant_sku: variantSku || null,
        url,
        price: priceAmount != null ? String(priceAmount) : '',
        price_amount: priceAmount,
        currency: priceCurrency,
        stock: availability,
        description,
        image_url: imageUrl || '',
        image_urls: imageUrls,
      },
    ],
    commerce_facts_v1: offer.commerce_facts_v1 || null,
  };
  const retailerFields = {
    source_role: 'retailer_offer',
    source_listing_scope: 'retailer_offer',
    merchant_display_name: 'Ulta Beauty',
    seller_or_retailer_name: 'Ulta Beauty',
    seller_name: 'Ulta Beauty',
    store_name: 'Ulta Beauty',
    purchase_route: 'external_link_out',
    commerce_mode: 'links_out',
    checkout_handoff: 'merchant_pdp',
    external_redirect_url: url,
  };
  let row = {
    seed_id: seedId,
    external_product_id: externalProductId,
    market,
    tool: 'creator_agents',
    destination_url: url,
    canonical_url: url,
    domain: 'ulta.com',
    title,
    image_url: imageUrl || null,
    price_amount: priceAmount,
    price_currency: priceCurrency,
    availability,
    status: 'active',
    attached_product_key: null,
    requires_seed_correction: false,
    seed_data: {
      ...retailerFields,
      brand,
      title,
      description,
      external_product_id: externalProductId,
      canonical_url: url,
      destination_url: url,
      price_amount: priceAmount,
      price_currency: priceCurrency,
      availability,
      image_url: imageUrl || null,
      image_urls: imageUrls,
      images: imageUrls,
      ulta_discovery: {
        contract_version: 'ulta_brand_offer_discovery.v1',
        brand,
        brand_url: brandUrl,
        source_product_id: sourceProductId || null,
        variant_sku: variantSku || null,
      },
      snapshot: {
        ...snapshot,
        ...retailerFields,
      },
    },
  };
  if (offer.commerce_facts_v1) {
    row = attachCommerceFactsToSeedRow(row, offer.commerce_facts_v1, {
      market,
      capturedAt:
        offer.commerce_facts_v1?.regional_price?.captured_at ||
        offer.commerce_facts_v1?.captured_at ||
        offer.captured_at ||
        new Date().toISOString(),
    });
  }
  row.seed_data.commerce_facts_gate = validateCommerceFactsGateForSeedRow(row);
  row.seed_data.snapshot.commerce_facts_gate = row.seed_data.commerce_facts_gate;
  return row;
}

async function fetchExtract({ catalogBaseUrl, brand, brandUrl, market, limit, offset, timeoutMs }) {
  const response = await fetch(`${catalogBaseUrl.replace(/\/+$/, '')}/api/extract-v2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      brand,
      domain: brandUrl,
      market,
      limit,
      offset,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      out[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function mapWithConcurrencyAndDelay(items, concurrency, requestDelayMs, mapper) {
  const startedAtByWorker = new Array(Math.max(1, concurrency)).fill(0);
  const out = new Array(items.length);
  let index = 0;
  async function worker(workerIndex) {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      const elapsed = Date.now() - startedAtByWorker[workerIndex];
      if (startedAtByWorker[workerIndex] && requestDelayMs > elapsed) {
        await sleep(requestDelayMs - elapsed);
      }
      startedAtByWorker[workerIndex] = Date.now();
      out[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, idx) => worker(idx)));
  return out;
}

function normalizeCategoryPath(value) {
  const raw = asString(value).replace(/^https?:\/\/(?:www\.)?ulta\.com\//i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return raw || '';
}

function buildTasks({ brands, pagesPerBrand, pageSize, startPage, market, categoryPaths }) {
  const tasks = [];
  for (const brand of brands) {
    const targets = categoryPaths.length
      ? categoryPaths.map((categoryPath) => ({
          slug: categoryPath,
          brandUrl: `https://www.ulta.com/${categoryPath}?brand=${encodeURIComponent(brand)}`,
        }))
      : (() => {
          const slug = slugifyBrand(brand);
          return slug
            ? [
                {
                  slug,
                  brandUrl: `https://www.ulta.com/brand/${slug}`,
                },
              ]
            : [];
        })();
    for (const target of targets) {
      for (let page = 0; page < pagesPerBrand; page += 1) {
        tasks.push({
          brand,
          slug: target.slug,
          brandUrl: target.brandUrl,
          market,
          limit: pageSize,
          offset: (startPage + page) * pageSize,
        });
      }
    }
  }
  return tasks;
}

function dedupeOffers(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const row = item?.seed_row;
    const key = normalizeUrlKey(row?.canonical_url) || row?.external_product_id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function run() {
  const market = asString(argValue('market', 'US')).toUpperCase() || 'US';
  const brands = parseDelimited(argValue('brands')).length
    ? parseDelimited(argValue('brands'))
    : DEFAULT_BRANDS.slice(0, Math.max(1, Math.min(Number(argValue('brand-limit', DEFAULT_BRANDS.length)) || DEFAULT_BRANDS.length, DEFAULT_BRANDS.length)));
  const pageSize = Math.max(1, Math.min(Number(argValue('page-size', 5)) || 5, 10));
  const pagesPerBrand = Math.max(1, Math.min(Number(argValue('pages-per-brand', 2)) || 2, 20));
  const startPage = Math.max(0, Number(argValue('start-page', 0)) || 0);
  const categoryPaths = parseDelimited(argValue('category-paths')).map(normalizeCategoryPath).filter(Boolean);
  const concurrency = Math.max(1, Math.min(Number(argValue('concurrency', 2)) || 2, 4));
  const requestDelayMs = Math.max(0, Math.min(Number(argValue('request-delay-ms', 0)) || 0, 120_000));
  const timeoutMs = Math.max(10_000, Math.min(Number(argValue('timeout-ms', 90_000)) || 90_000, 180_000));
  const catalogBaseUrl = asString(argValue('catalog-base-url', DEFAULT_CATALOG_BASE_URL)) || DEFAULT_CATALOG_BASE_URL;
  const out = resolveOutPath(argValue('out'));
  const manifestOut = resolveOutPath(argValue('manifest-out'));
  const tasks = buildTasks({ brands, pagesPerBrand, pageSize, startPage, market, categoryPaths });

  const taskMapper = async (task) => {
    process.stderr.write(
      JSON.stringify({
        at: new Date().toISOString(),
        event: 'ulta_extract_start',
        brand: task.brand,
        offset: task.offset,
        limit: task.limit,
      }) + '\n',
    );
    try {
      const extract = await fetchExtract({
        catalogBaseUrl,
        brand: task.brand,
        brandUrl: task.brandUrl,
        market,
        limit: task.limit,
        offset: task.offset,
        timeoutMs,
      });
      const offers = Array.isArray(extract.json?.offers_v2) ? extract.json.offers_v2 : [];
      const accepted = [];
      const rejected = [];
      for (const offer of offers) {
        const problems = [];
        if (!isSafeOffer(offer)) problems.push('unsafe_commerce_or_host');
        if (!offerMatchesBrand(offer, task.brand)) problems.push('missing_brand_signal');
        if (problems.length) {
          rejected.push({
            title: asString(offer.product_title || offer.title),
            url: asString(offer.url_canonical || offer.url || offer.source_url),
            problems,
          });
          continue;
        }
        const seedRow = buildSeedRowFromOffer({
          offer,
          brand: task.brand,
          brandUrl: task.brandUrl,
          market,
        });
        const gate = validateCommerceFactsGateForSeedRow({
          ...seedRow,
          id: seedRow.seed_id,
        });
        if (gate.status === 'hold') {
          rejected.push({
            title: seedRow.title,
            url: seedRow.canonical_url,
            problems: gate.problems || ['commerce_facts_gate_hold'],
          });
          continue;
        }
        accepted.push({
          ingredient_id: null,
          ingredient_name: null,
          target_brand: task.brand,
          target_url: seedRow.canonical_url,
          extract_status: 'accepted_ulta_brand_offer',
          seed_row: seedRow,
        });
      }
      process.stderr.write(
        JSON.stringify({
          at: new Date().toISOString(),
          event: 'ulta_extract_done',
          brand: task.brand,
          offset: task.offset,
          status: extract.status,
          offers: offers.length,
          accepted: accepted.length,
          rejected: rejected.length,
          has_more: Boolean(extract.json?.pagination?.has_more),
        }) + '\n',
      );
      return {
        task,
        status: 'ok',
        http_status: extract.status,
        accepted,
        rejected,
        pagination: extract.json?.pagination || null,
        diagnostics: extract.json?.diagnostics || null,
        counters_by_site_market: extract.json?.counters_by_site_market || [],
      };
    } catch (error) {
      process.stderr.write(
        JSON.stringify({
          at: new Date().toISOString(),
          event: 'ulta_extract_failed',
          brand: task.brand,
          offset: task.offset,
          error: String(error?.message || error),
        }) + '\n',
      );
      return {
        task,
        status: 'failed',
        error: String(error?.message || error),
        accepted: [],
        rejected: [],
      };
    }
  };
  const taskResults =
    requestDelayMs > 0
      ? await mapWithConcurrencyAndDelay(tasks, concurrency, requestDelayMs, taskMapper)
      : await mapWithConcurrency(tasks, concurrency, taskMapper);

  const acceptedItems = dedupeOffers(taskResults.flatMap((result) => result.accepted || []));
  const manifest = {
    generated_at: new Date().toISOString(),
    source: 'ulta_brand_offer_discovery_v1',
    market,
    item_count: acceptedItems.length,
    items: acceptedItems,
  };
  const report = {
    generated_at: new Date().toISOString(),
    market,
    brand_count: brands.length,
    task_count: tasks.length,
    start_page: startPage,
    category_paths: categoryPaths,
    request_delay_ms: requestDelayMs,
    accepted_seed_rows: acceptedItems.length,
    rejected_offer_count: taskResults.reduce((sum, result) => sum + (result.rejected || []).length, 0),
    failed_task_count: taskResults.filter((result) => result.status === 'failed').length,
    by_brand: brands.map((brand) => ({
      brand,
      accepted: acceptedItems.filter((item) => item.target_brand === brand).length,
      rejected: taskResults
        .filter((result) => result.task?.brand === brand)
        .reduce((sum, result) => sum + (result.rejected || []).length, 0),
      failed_tasks: taskResults.filter((result) => result.task?.brand === brand && result.status === 'failed').length,
    })),
    task_results: taskResults,
    manifest_path: manifestOut || null,
  };

  if (manifestOut) {
    fs.mkdirSync(path.dirname(manifestOut), { recursive: true });
    fs.writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  const stdoutReport = {
    ...report,
    task_results: taskResults.map((result) => ({
      task: result.task,
      status: result.status,
      http_status: result.http_status,
      accepted_count: (result.accepted || []).length,
      rejected_count: (result.rejected || []).length,
      failed_error: result.error || null,
      pagination: result.pagination || null,
    })),
  };
  process.stdout.write(`${JSON.stringify(stdoutReport, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
