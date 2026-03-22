#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { summaryPath: '', outPath: '' };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--summary') {
      out.summaryPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeHttpUrl(value) {
  const next = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(next) ? next : '';
}

function isLikelyProductImageUrl(value) {
  const url = normalizeHttpUrl(value);
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.endsWith('.svg')) return false;
  if (lower.includes('/brands-logo/')) return false;
  if (lower.includes('/images/icons/')) return false;
  if (lower.includes('/navbar-')) return false;
  if (lower.includes('/logo')) return false;
  return true;
}

function parsePrice(value) {
  const raw = normalizeNonEmptyString(value);
  if (!raw) return null;
  if (/[a-z]/i.test(raw.replace(/\$/g, ''))) return null;
  const parsed = Number(raw.replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAvailability(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  if (!normalized) return '';
  if (['in stock', 'instock', 'in_stock', 'available'].includes(normalized)) return 'in_stock';
  if (['out of stock', 'outofstock', 'out_of_stock', 'oos'].includes(normalized)) return 'out_of_stock';
  return normalized.replace(/\s+/g, '_');
}

function collectImageUrls(...sources) {
  const out = [];
  for (const source of sources) {
    if (!source) continue;
    if (typeof source === 'string') {
      const url = normalizeHttpUrl(source);
      if (url && isLikelyProductImageUrl(url) && !out.includes(url)) out.push(url);
      continue;
    }
    if (Array.isArray(source)) {
      for (const item of source) {
        const url = normalizeHttpUrl(item);
        if (url && isLikelyProductImageUrl(url) && !out.includes(url)) out.push(url);
      }
      continue;
    }
  }
  return out;
}

function stableExternalProductId(url) {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return '';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `ext_${hash}`;
}

function pickPrimaryVariant(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return null;
  return variants.find((variant) => normalizeHttpUrl(variant?.url || variant?.product_url)) || variants[0];
}

function mapVariants(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  return variants
    .map((variant, idx) => {
      const url = normalizeHttpUrl(variant?.url || variant?.product_url);
      const sku = normalizeNonEmptyString(variant?.sku || variant?.sku_id || variant?.id || `variant-${idx + 1}`);
      const imageUrls = collectImageUrls(variant?.image_urls, variant?.images, variant?.image_url);
      const price = parsePrice(variant?.price);
      return {
        sku,
        variant_id: normalizeNonEmptyString(variant?.id || variant?.variant_id || sku),
        url,
        option_name: normalizeNonEmptyString(variant?.option_name),
        option_value: normalizeNonEmptyString(variant?.option_value),
        price: price != null ? String(price) : normalizeNonEmptyString(variant?.price),
        currency: normalizeNonEmptyString(variant?.currency || 'USD') || 'USD',
        stock: normalizeNonEmptyString(variant?.stock),
        description: normalizeNonEmptyString(variant?.description),
        image_url: imageUrls[0] || '',
        image_urls: imageUrls,
      };
    })
    .filter((variant) => variant.sku || variant.url);
}

function buildSeedRow(item, extractDoc) {
  const products = Array.isArray(extractDoc?.products) ? extractDoc.products : [];
  const product = products[0];
  if (!product || typeof product !== 'object') return null;

  const primaryVariant = pickPrimaryVariant(product);
  const mappedVariants = mapVariants(product);
  const canonicalUrl =
    normalizeHttpUrl(primaryVariant?.url || primaryVariant?.product_url) ||
    normalizeHttpUrl(product?.canonical_url) ||
    normalizeHttpUrl(product?.url) ||
    normalizeHttpUrl(item?.target_url);
  const destinationUrl = canonicalUrl;
  const externalProductId = stableExternalProductId(canonicalUrl || destinationUrl);
  if (!externalProductId) return null;

  const imageUrls = collectImageUrls(
    primaryVariant?.image_urls,
    primaryVariant?.images,
    primaryVariant?.image_url,
    product?.image_urls,
    product?.images,
    product?.image_url,
  );
  const title =
    normalizeNonEmptyString(product?.title || product?.name || item?.ingredient_name || externalProductId) ||
    externalProductId;
  const description = normalizeNonEmptyString(primaryVariant?.description || product?.description);
  const priceAmount =
    parsePrice(primaryVariant?.price) ??
    parsePrice(product?.price_amount) ??
    parsePrice(product?.price) ??
    null;
  const priceCurrency =
    normalizeNonEmptyString(primaryVariant?.currency || product?.price_currency || product?.currency || 'USD') || 'USD';
  const availability = normalizeAvailability(primaryVariant?.stock || product?.availability || 'in_stock') || 'in_stock';
  let domain = '';
  try {
    domain = new URL(canonicalUrl).hostname.replace(/^www\./i, '');
  } catch {
    domain = '';
  }

  const snapshot = {
    source: 'catalog_intelligence_seed_creation_manifest',
    extracted_at: new Date().toISOString(),
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    title,
    description,
    image_url: imageUrls[0] || '',
    image_urls: imageUrls,
    images: imageUrls,
    variants: mappedVariants,
    diagnostics: ensureObject(extractDoc?.diagnostics),
  };

  return {
    ingredient_id: item?.ingredient_id || null,
    ingredient_name: item?.ingredient_name || null,
    brand: item?.target_brand || null,
    market: 'US',
    tool: 'creator_agents',
    status: 'active',
    domain: domain || null,
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    title,
    image_url: imageUrls[0] || null,
    price_amount: priceAmount,
    price_currency: priceCurrency,
    availability,
    attached_product_key: null,
    requires_seed_correction: item?.extract_status === 'usable_with_correction',
    seed_data: {
      brand: item?.target_brand || undefined,
      title,
      description,
      external_product_id: externalProductId,
      canonical_url: canonicalUrl,
      destination_url: destinationUrl,
      price_amount: priceAmount,
      price_currency: priceCurrency,
      availability,
      image_url: imageUrls[0] || undefined,
      image_urls: imageUrls,
      images: imageUrls,
      variants: mappedVariants,
      snapshot,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = normalizePath(args.summaryPath);
  if (!summaryPath) throw new Error('Missing required --summary <extract-summary.json>');
  const resolvedSummary = path.isAbsolute(summaryPath) ? summaryPath : path.join(process.cwd(), summaryPath);
  const summary = JSON.parse(fs.readFileSync(resolvedSummary, 'utf8'));
  const items = Array.isArray(summary?.items) ? summary.items : [];
  const manifestItems = [];
  for (const item of items) {
    if (!item?.safe_to_create_seed) continue;
    const artifactPath = normalizePath(item?.artifact_path);
    if (!artifactPath) continue;
    const resolvedArtifact = path.isAbsolute(artifactPath) ? artifactPath : path.join(process.cwd(), artifactPath);
    const extractDoc = JSON.parse(fs.readFileSync(resolvedArtifact, 'utf8'));
    const seedRow = buildSeedRow(item, extractDoc);
    if (!seedRow) continue;
    manifestItems.push({
      ingredient_id: item.ingredient_id || null,
      ingredient_name: item.ingredient_name || null,
      target_brand: item.target_brand || null,
      target_url: item.target_url || null,
      extract_status: item.extract_status || null,
      seed_row: seedRow,
    });
  }

  const outputDoc = {
    generated_at: new Date().toISOString(),
    source_summary: resolvedSummary,
    item_count: manifestItems.length,
    items: manifestItems,
  };
  const output = `${JSON.stringify(outputDoc, null, 2)}\n`;
  process.stdout.write(output);
  if (args.outPath) {
    const resolvedOut = path.isAbsolute(args.outPath) ? args.outPath : path.join(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, output, 'utf8');
  }
}

try {
  main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
}
