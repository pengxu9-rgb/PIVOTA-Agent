#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const MARKET_GUARDRAIL = Object.freeze({
  US: {
    countryPatterns: [/\bindia\b/i, /\bnoida\b/i, /\buttar pradesh\b/i],
    currencyPatterns: [/₹/i, /\bINR\b/i, /\bRs\.?\s*\d/gi],
    phonePatterns: [/\+91[-\s]?\d{6,}/i],
  },
});

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

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeNonEmptyString(value);
    if (normalized) return normalized;
  }
  return '';
}

function isLikelyProductImageUrl(value) {
  const url = normalizeHttpUrl(value);
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.endsWith('.svg')) return false;
  if (lower.includes('ivborw0')) return false;
  if (lower.includes('base64,')) return false;
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
  return out.slice(0, 12);
}

function uniqueNormalizedMatches(html, patterns) {
  const out = [];
  const source = String(html || '');
  for (const pattern of patterns || []) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const nextPattern = new RegExp(pattern.source, flags);
    for (const match of source.matchAll(nextPattern)) {
      const value = normalizeNonEmptyString(match?.[0]);
      if (!value || out.includes(value)) continue;
      out.push(value);
    }
  }
  return out;
}

function buildSnippet(html, token) {
  const source = String(html || '');
  const needle = normalizeNonEmptyString(token);
  if (!source || !needle) return '';
  const idx = source.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - 120);
  const end = Math.min(source.length, idx + needle.length + 120);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

function fetchHtml(url, redirects = 0) {
  const normalizedUrl = normalizeHttpUrl(url);
  if (!normalizedUrl) return Promise.resolve({ ok: false, final_url: '', html: '', error: 'missing_url' });
  if (redirects > 3) {
    return Promise.resolve({ ok: false, final_url: normalizedUrl, html: '', error: 'too_many_redirects' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const onDone = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let parsed;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      onDone({ ok: false, final_url: normalizedUrl, html: '', error: 'invalid_url' });
      return;
    }

    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.get(
      normalizedUrl,
      {
        headers: {
          'user-agent': 'Mozilla/5.0 (Codex seed creation guardrail)',
          accept: 'text/html,application/xhtml+xml',
        },
      },
      (res) => {
        const statusCode = Number(res.statusCode || 0);
        const location = normalizeNonEmptyString(res.headers?.location);
        if (statusCode >= 300 && statusCode < 400 && location) {
          const redirectUrl = new URL(location, normalizedUrl).toString();
          res.resume();
          fetchHtml(redirectUrl, redirects + 1).then(onDone);
          return;
        }

        const chunks = [];
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (typeof chunk === 'string' && chunks.join('').length < 1024 * 1024) {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          onDone({
            ok: statusCode >= 200 && statusCode < 300,
            final_url: normalizedUrl,
            html: chunks.join(''),
            status_code: statusCode,
          });
        });
      },
    );

    req.setTimeout(8000, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      onDone({
        ok: false,
        final_url: normalizedUrl,
        html: '',
        error: normalizeNonEmptyString(error?.message || error),
      });
    });
  });
}

function detectMarketSignalMismatch({ market, html, url }) {
  const profile = MARKET_GUARDRAIL[normalizeNonEmptyString(market).toUpperCase()];
  if (!profile) return null;
  const source = String(html || '');
  if (!source) return null;

  const countryMatches = uniqueNormalizedMatches(source, profile.countryPatterns);
  const currencyMatches = uniqueNormalizedMatches(source, profile.currencyPatterns);
  const phoneMatches = uniqueNormalizedMatches(source, profile.phonePatterns);
  if (countryMatches.length === 0 && currencyMatches.length === 0 && phoneMatches.length === 0) return null;
  const signalBuckets =
    (countryMatches.length > 0 ? 1 : 0) +
    (currencyMatches.length > 0 ? 1 : 0) +
    (phoneMatches.length > 0 ? 1 : 0);
  const hasStrongMarketSignal = currencyMatches.length > 0 || phoneMatches.length > 0;
  if (!hasStrongMarketSignal && signalBuckets < 2) return null;

  const firstSignal = firstNonEmpty(countryMatches[0], currencyMatches[0], phoneMatches[0]);
  return {
    rejection_reason: 'market_signal_mismatch',
    evidence: {
      market: normalizeNonEmptyString(market).toUpperCase(),
      target_url: normalizeHttpUrl(url),
      country_matches: countryMatches,
      currency_matches: currencyMatches,
      phone_matches: phoneMatches,
      html_snippet: buildSnippet(source, firstSignal),
    },
  };
}

async function buildMarketGuardrailDecision(item, extractDoc, seedRow) {
  const market = normalizeNonEmptyString(seedRow?.market || item?.market || 'US').toUpperCase() || 'US';
  const targetUrl =
    normalizeHttpUrl(item?.target_url) ||
    normalizeHttpUrl(seedRow?.canonical_url) ||
    normalizeHttpUrl(seedRow?.destination_url);
  if (!targetUrl) return { blocked: false, market, checked: false, reason: 'missing_target_url' };

  const page = await fetchHtml(targetUrl);
  if (!page.ok || !page.html) {
    return {
      blocked: false,
      market,
      checked: false,
      reason: page.error || `status_${page.status_code || 0}`,
    };
  }

  const mismatch = detectMarketSignalMismatch({ market, html: page.html, url: page.final_url || targetUrl });
  if (!mismatch) {
    return { blocked: false, market, checked: true, reason: null };
  }
  return {
    blocked: true,
    market,
    checked: true,
    reason: mismatch.rejection_reason,
    evidence: mismatch.evidence,
  };
}

function stableExternalProductId(url) {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return '';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `ext_${hash}`;
}

function stableSeedId(url) {
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return '';
  const hash = crypto.createHash('sha256').update(`external-seed::${normalized}`).digest('hex').slice(0, 24);
  return `eps_${hash}`;
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
  const seedId = stableSeedId(canonicalUrl || destinationUrl);
  if (!externalProductId) return null;
  if (!seedId) return null;

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
    seed_id: seedId,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = normalizePath(args.summaryPath);
  if (!summaryPath) throw new Error('Missing required --summary <extract-summary.json>');
  const resolvedSummary = path.isAbsolute(summaryPath) ? summaryPath : path.join(process.cwd(), summaryPath);
  const summary = JSON.parse(fs.readFileSync(resolvedSummary, 'utf8'));
  const items = Array.isArray(summary?.items) ? summary.items : [];
  const manifestItems = [];
  const rejectedItems = [];
  for (const item of items) {
    if (!item?.safe_to_create_seed) continue;
    const artifactPath = normalizePath(item?.artifact_path);
    if (!artifactPath) continue;
    const resolvedArtifact = path.isAbsolute(artifactPath) ? artifactPath : path.join(process.cwd(), artifactPath);
    const extractDoc = JSON.parse(fs.readFileSync(resolvedArtifact, 'utf8'));
    const seedRow = buildSeedRow(item, extractDoc);
    if (!seedRow) continue;
    const guardrail = await buildMarketGuardrailDecision(item, extractDoc, seedRow);
    if (guardrail.blocked) {
      rejectedItems.push({
        ingredient_id: item.ingredient_id || null,
        ingredient_name: item.ingredient_name || null,
        target_brand: item.target_brand || null,
        target_url: item.target_url || null,
        extract_status: item.extract_status || null,
        rejection_reason: guardrail.reason || 'market_signal_mismatch',
        rejection_evidence: guardrail.evidence || null,
      });
      continue;
    }
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
    rejected_count: rejectedItems.length,
    items: manifestItems,
    rejected_items: rejectedItems,
  };
  const output = `${JSON.stringify(outputDoc, null, 2)}\n`;
  process.stdout.write(output);
  if (args.outPath) {
    const resolvedOut = path.isAbsolute(args.outPath) ? args.outPath : path.join(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, output, 'utf8');
  }
}

if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}

module.exports = {
  _internals: {
    parseArgs,
    normalizeHttpUrl,
    parsePrice,
    buildSeedRow,
    fetchHtml,
    detectMarketSignalMismatch,
    buildMarketGuardrailDecision,
  },
};
