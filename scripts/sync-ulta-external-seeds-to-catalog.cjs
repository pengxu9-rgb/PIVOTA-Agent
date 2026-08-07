#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');
const {
  buildAgentSafeCommerceFacts,
  readCommerceFactsV1,
  validateCommerceFactsGateForSeedRow,
} = require('../src/commerce/commerceFacts');
// Fix Plan D · T1 — resolve retailer offers against existing catalog identity
// BEFORE minting a self product/group. That resolve-first reuse is what collapses a
// retailer offer onto its D2C product; the minter below is only for genuinely new ones.
const {
  buildCatalogIdentityIndex,
  resolveAgainstIndex,
} = require('../src/services/retailerOfferIdentity');
// #1916 — the ONE content_key minter (Node mirror of the pivota-backend authority).
const { makeContentKey } = require('../src/services/contentKey');

const RETAILER_FUZZY_THRESHOLD = 0.72;

const MERCHANT_ID = 'external_seed';
const PLATFORM = 'external_seed';
const SOURCE_SYSTEM = 'external_product_seeds_mirror_v1';

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

function readDelimitedIds(value) {
  return Array.from(
    new Set(
      asString(value)
        .split(/[\s,]+/g)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function readIdsFile(filePath) {
  const target = asString(filePath);
  if (!target) return [];
  const resolved = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
  return readDelimitedIds(fs.readFileSync(resolved, 'utf8'));
}

function resolveOutPath(filePath) {
  const target = asString(filePath);
  if (!target) return '';
  return path.isAbsolute(target) ? target : path.join(process.cwd(), target);
}

function stableHash(prefix, parts, length = 32) {
  const hash = crypto.createHash('sha256').update(parts.map(asString).join('\n')).digest('hex').slice(0, length);
  return `${prefix}_${hash}`;
}

function normalizeText(value) {
  return asString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = asString(value).replace(/[^0-9.-]+/g, '');
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCurrency(value) {
  const currency = asString(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

function normalizeAvailability(value) {
  const normalized = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['available', 'instock'].includes(normalized)) return 'in_stock';
  if (['outofstock', 'unavailable'].includes(normalized)) return 'out_of_stock';
  return normalized || 'unknown';
}

function normalizeUrl(value) {
  const raw = asString(value);
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function host(value) {
  try {
    return new URL(normalizeUrl(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pickBrand(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return (
    asString(seedData.brand) ||
    asString(snapshot.brand) ||
    asString(seedData.vendor) ||
    asString(snapshot.vendor) ||
    ''
  );
}

function pickDescription(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return asString(seedData.description || snapshot.description);
}

function pickVariantSku(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const variants = [...asArray(seedData.variants), ...asArray(snapshot.variants)];
  return (
    asString(seedData.variant_sku) ||
    asString(snapshot.variant_sku) ||
    asString(variants[0]?.variant_sku) ||
    asString(variants[0]?.sku) ||
    asString(row.external_product_id)
  );
}

function pickImageUrl(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return (
    normalizeUrl(row.image_url) ||
    normalizeUrl(seedData.image_url) ||
    normalizeUrl(snapshot.image_url) ||
    normalizeUrl(asArray(seedData.image_urls)[0]) ||
    normalizeUrl(asArray(snapshot.image_urls)[0]) ||
    ''
  );
}

function pickCanonicalUrl(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return (
    normalizeUrl(row.canonical_url) ||
    normalizeUrl(row.destination_url) ||
    normalizeUrl(seedData.canonical_url) ||
    normalizeUrl(seedData.destination_url) ||
    normalizeUrl(snapshot.canonical_url) ||
    normalizeUrl(snapshot.destination_url) ||
    ''
  );
}

function isUltaSeed(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const urls = [
    row.canonical_url,
    row.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    seedData.external_redirect_url,
    snapshot.canonical_url,
    snapshot.destination_url,
    snapshot.external_redirect_url,
  ];
  return (
    asString(row.external_product_id).startsWith('ulta:') ||
    asString(row.external_product_id).startsWith('ulta-beauty:') ||
    asString(row.domain).toLowerCase().includes('ulta') ||
    urls.some((url) => host(url) === 'ulta.com')
  );
}

function buildMirror(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const externalProductId = asString(row.external_product_id);
  const seedId = asString(row.id);
  // ADR-009 R1: an existing catalog row keeps ITS OWN key; the template is
  // only for genuinely new rows (which are currently blocked, see
  // annotateUltaMirrorMerchants). Keys are opaque plumbing — look up, never
  // parse or reconstruct.
  const productKey = asString(row.existing_product_key)
    || `prod::external_seed::external_seed::${externalProductId}`;
  const skuKey = `${productKey}::canonical`;
  const sourceVariantId = productKey;
  const mirrorMerchantId = asString(row.mirror_merchant_id);
  if (!mirrorMerchantId) {
    throw new Error(`buildMirror: row ${externalProductId} has no resolved mirror_merchant_id — run annotateUltaMirrorMerchants first`);
  }
  const canonicalUrl = pickCanonicalUrl(row);
  const imageUrl = pickImageUrl(row);
  const title = asString(row.title || seedData.title || snapshot.title || externalProductId);
  const brand = pickBrand(row);
  const description = pickDescription(row);
  const variantSku = pickVariantSku(row);
  const priceAmount =
    normalizeAmount(row.price_amount) ??
    normalizeAmount(seedData.price_amount) ??
    normalizeAmount(snapshot.price_amount) ??
    normalizeAmount(readCommerceFactsV1(row)?.regional_price?.amount);
  const priceCurrency = normalizeCurrency(row.price_currency || seedData.price_currency || snapshot.price_currency);
  const availability = normalizeAvailability(row.availability || seedData.availability || snapshot.availability);
  const facts = readCommerceFactsV1(row);
  const agentSafeCommerceFacts = buildAgentSafeCommerceFacts(row);
  const gate = validateCommerceFactsGateForSeedRow(row);
  // Self-mint content_key for a genuinely new product, via the ONE minter that the
  // pivota-backend authority also uses — so a Node-minted key lands in the same
  // keyspace as the 12k keys already there (issue #1916). Resolve-first (run())
  // overrides this whenever an existing D2C product matches exactly; that reuse, not
  // this hash, is what makes a retailer offer share its D2C product's identity.
  // Null when brand/title normalize to empty — the caller skips such rows.
  const contentKey = makeContentKey(brand, title, null);
  const sigId = stableHash('sig', ['external_seed_catalog_sig', externalProductId], 32);
  const productGroupId = stableHash('pg', ['external_seed_self_group', externalProductId], 32);
  const offerId = `offer:external_seed:${crypto
    .createHash('md5')
    .update([externalProductId, canonicalUrl, variantSku].join('\n'))
    .digest('hex')}`;
  const freshness = {
    source: SOURCE_SYSTEM,
    mirrored_at: new Date().toISOString(),
    external_seed_updated_at: row.updated_at || null,
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
    external_redirect_url: canonicalUrl,
  };
  const productPayload = {
    ...seedData,
    ...retailerFields,
    brand,
    title,
    description,
    product_name: title,
    external_product_id: externalProductId,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    image_url: imageUrl,
    image_urls: imageUrl ? [imageUrl] : asArray(seedData.image_urls),
    images: imageUrl ? [imageUrl] : asArray(seedData.images),
    price_amount: priceAmount,
    price_currency: priceCurrency,
    availability,
    category_path: asString(seedData.category_path || snapshot.category_path) || 'beauty',
    commerce_facts_v1: facts || seedData.commerce_facts_v1 || snapshot.commerce_facts_v1 || null,
    ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
    commerce_facts_gate: gate,
    snapshot: {
      ...snapshot,
      ...retailerFields,
      brand,
      title,
      description,
      product_name: title,
      external_product_id: externalProductId,
      canonical_url: canonicalUrl,
      destination_url: canonicalUrl,
      image_url: imageUrl,
      image_urls: imageUrl ? [imageUrl] : asArray(snapshot.image_urls),
      images: imageUrl ? [imageUrl] : asArray(snapshot.images),
      price_amount: priceAmount,
      price_currency: priceCurrency,
      availability,
      commerce_facts_v1: facts || snapshot.commerce_facts_v1 || seedData.commerce_facts_v1 || null,
      ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
      commerce_facts_gate: gate,
    },
  };
  const skuPayload = {
    source: SOURCE_SYSTEM,
    external_product_id: externalProductId,
    variant_sku: variantSku,
    synthetic_canonical_variant: true,
    source_url: canonicalUrl,
    external_redirect_url: canonicalUrl,
    price: priceAmount != null ? String(priceAmount) : '',
    price_amount: priceAmount,
    currency: priceCurrency,
    availability,
    image_url: imageUrl,
  };
  const offerPayload = {
    source: SOURCE_SYSTEM,
    external_seed_id: seedId,
    external_product_id: externalProductId,
    domain: 'ulta.com',
    market: row.market || 'US',
    product_title: title,
    variant_sku: variantSku,
    url: canonicalUrl,
    offer_url: canonicalUrl,
    canonical_url: canonicalUrl,
    destination_url: canonicalUrl,
    external_redirect_url: canonicalUrl,
    merchant_display_name: 'Ulta Beauty',
    price: priceAmount != null ? String(priceAmount) : '',
    price_amount: priceAmount,
    price_currency: priceCurrency,
    availability,
    commerce_facts_v1: facts || null,
    ...(agentSafeCommerceFacts ? { agent_safe_commerce_facts: agentSafeCommerceFacts } : {}),
  };
  return {
    row,
    productKey,
    skuKey,
    sourceVariantId,
    offerId,
    productGroupId,
    product: {
      product_key: productKey,
      merchant_id: mirrorMerchantId,
      platform: PLATFORM,
      source_product_id: externalProductId,
      catalog_track: 'external_referral',
      truth_tier: 'observed',
      readiness_tier: 'referral_only',
      source_system: SOURCE_SYSTEM,
      source_ref: seedId,
      title,
      description,
      brand,
      product_type: 'retailer_offer',
      category: 'beauty',
      canonical_url: canonicalUrl,
      image_url: imageUrl,
      product_payload: productPayload,
      freshness_json: freshness,
      category_path: asString(seedData.category_path || snapshot.category_path) || 'beauty',
      category_confidence: 0.8,
      category_label_source: 'ulta_brand_offer_discovery',
      // pdp_scope / pdp_scope_source / pdp_scope_set_at are DELIBERATELY not
      // written by this lane. The classifier (pivota-backend
      // services/pdp_scope_classifier) is the only authority on the column;
      // rows land on the DB default 'unverified' (NOT NULL, migration 070) and
      // are promoted by the classifier-backed writers. This lane used to stamp
      // 'multi_merchant_canonical' unconditionally and re-assert it on every
      // conflict: measured 2026-08-04, 3,182 of its 3,400 canonical rows had
      // <2 sellers, each wrongly carrying a +200 rank term and the
      // market-filter exemption (canonicalCatalogSearch.js). See
      // pivota-backend docs/PDP_SCOPE_REDESIGN.md (P1).
      pivota_signature_id: sigId,
      pivota_canonical_url: canonicalUrl,
      tags: ['external_seed', 'ulta', 'retailer_offer'],
      pdp_lifecycle_stage: 'published',
      content_key: contentKey,
      sync_status: 'live',
    },
    sku: {
      sku_key: skuKey,
      product_key: productKey,
      merchant_id: mirrorMerchantId,
      platform: PLATFORM,
      source_product_id: externalProductId,
      source_variant_id: sourceVariantId,
      sku: externalProductId,
      title,
      currency: priceCurrency,
      image_url: imageUrl,
      visible_attributes: {},
      visible_option_labels: {},
      ingredient_ids: [],
      sku_payload: skuPayload,
      readiness_tier: 'referral_only',
    },
    offer: {
      offer_id: offerId,
      sku_key: skuKey,
      product_key: productKey,
      merchant_id: mirrorMerchantId,
      catalog_track: 'external_referral',
      truth_tier: 'observed',
      readiness_tier: 'referral_only',
      offer_mode: 'redirect',
      channel: 'external_referral',
      availability,
      currency: priceCurrency,
      list_price: priceAmount,
      merchant_effective_price: priceAmount,
      estimated_best_price: priceAmount,
      price_confidence: priceAmount > 0 ? 1 : null,
      source_system: SOURCE_SYSTEM,
      source_ref: seedId,
      offer_payload: offerPayload,
    },
  };
}

// ADR-009 R1 — resolve the merchant each ulta mirror row is written under.
// This is a RETAILER lane: current external_product_seeds.seller_ref values for
// ulta seeds are per-BRAND observed sellers, which fragments one retailer into
// hundreds of merchants — the mirror image of the bug ADR-009 fixes. The
// retailer seller model (W2) decides the real identity, so until it lands:
//   - an EXISTING catalog row keeps its own merchant (derive from the row);
//   - a NEW self-mint is BLOCKED (skipped + retried), never landed in the
//     legacy bucket and never minted under a wrong per-brand identity.
function annotateUltaMirrorMerchants(rows) {
  const counts = { existing: 0, blocked_pending_w2: 0 };
  for (const row of rows || []) {
    const existing = asString(row.existing_merchant_id);
    if (existing) {
      row.mirror_merchant_id = existing;
      counts.existing += 1;
    } else {
      row.mirror_mint_blocked_reason = 'retailer_seller_model_pending_w2';
      counts.blocked_pending_w2 += 1;
    }
  }
  if (counts.blocked_pending_w2 > 0) {
    console.error(JSON.stringify({ event: 'mirror_merchant_mint_blocked', lane: 'ulta_retailer', ...counts }));
  }
  return counts;
}

async function fetchRows(ids, market) {
  const res = await query(
    `
      SELECT
        e.id,
        e.external_product_id,
        e.market,
        e.tool,
        e.domain,
        e.title,
        e.image_url,
        e.price_amount,
        e.price_currency,
        e.availability,
        e.canonical_url,
        e.destination_url,
        e.seed_data,
        e.status,
        e.updated_at,
        e.seller_ref,
        cp.merchant_id AS existing_merchant_id,
        cp.product_key AS existing_product_key
      FROM external_product_seeds e
      -- ADR-009 R1: join by SOURCE IDENTITY, never by merchant literal or a
      -- reconstructed key template — re-keyed rows carry BOTH a different
      -- merchant_id and a rewritten product_key (prod::merch_obs_…), and a
      -- template upsert against them inserts a duplicate product.
      LEFT JOIN catalog_products cp
        ON cp.source_product_id = e.external_product_id
       AND cp.source_system = $3
      WHERE e.external_product_id = ANY($1::text[])
        AND ($2::text = '' OR e.market = $2::text)
      ORDER BY array_position($1::text[], e.external_product_id::text)
    `,
    [ids, market || '', SOURCE_SYSTEM],
  );
  return res.rows || [];
}

async function existingCounts(mirrors) {
  const productKeys = mirrors.map((item) => item.productKey);
  const skuKeys = mirrors.map((item) => item.skuKey);
  const offerIds = mirrors.map((item) => item.offerId);
  const productIds = mirrors.map((item) => item.row.external_product_id);
  const [products, skus, offers, groups] = await Promise.all([
    query('SELECT count(*)::int AS n FROM catalog_products WHERE product_key = ANY($1::text[])', [productKeys]),
    query('SELECT count(*)::int AS n FROM catalog_skus WHERE sku_key = ANY($1::text[])', [skuKeys]),
    query('SELECT count(*)::int AS n FROM catalog_offers WHERE offer_id = ANY($1::text[])', [offerIds]),
    query(
      `
        SELECT count(*)::int AS n
        FROM product_group_members
        WHERE platform = $1
          AND platform_product_id = ANY($2::text[])
      `,
      [PLATFORM, productIds],
    ),
  ]);
  return {
    catalog_products: products.rows[0]?.n || 0,
    catalog_skus: skus.rows[0]?.n || 0,
    catalog_offers: offers.rows[0]?.n || 0,
    product_group_members: groups.rows[0]?.n || 0,
  };
}

async function applyMirrors(mirrors, dryRun) {
  const existingBefore = await existingCounts(mirrors);
  if (dryRun) {
    return {
      mode: 'dry_run',
      existing_before: existingBefore,
      product_upserts: 0,
      sku_upserts: 0,
      offer_upserts: 0,
      group_member_upserts: 0,
      group_member_preserved_existing_merges: 0,
      seed_attachment_updates: 0,
    };
  }
  const totals = {
    mode: 'apply',
    existing_before: existingBefore,
    product_upserts: 0,
    sku_upserts: 0,
    offer_upserts: 0,
    group_member_upserts: 0,
    group_member_preserved_existing_merges: 0,
    seed_attachment_updates: 0,
  };
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '60s'`);
      for (const mirror of mirrors) {
        const p = mirror.product;
        const productRes = await client.query(
          `
            INSERT INTO catalog_products (
              product_key,
              merchant_id,
              platform,
              source_product_id,
              catalog_track,
              truth_tier,
              readiness_tier,
              source_system,
              source_ref,
              title,
              description,
              brand,
              product_type,
              category,
              canonical_url,
              image_url,
              product_payload,
              freshness_json,
              category_path,
              category_confidence,
              category_label_source,
              pivota_signature_id,
              pivota_canonical_url,
              pivota_signature_minted_at,
              tags,
              pdp_lifecycle_stage,
              content_key,
              last_seen_in_sync_at,
              sync_status,
              updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,
              $22,$23,now(),$24::jsonb,$25,$26,now(),$27,now()
            )
            ON CONFLICT (product_key) DO UPDATE SET
              catalog_track = EXCLUDED.catalog_track,
              truth_tier = EXCLUDED.truth_tier,
              readiness_tier = EXCLUDED.readiness_tier,
              source_system = EXCLUDED.source_system,
              source_ref = EXCLUDED.source_ref,
              title = EXCLUDED.title,
              description = EXCLUDED.description,
              brand = EXCLUDED.brand,
              product_type = EXCLUDED.product_type,
              category = EXCLUDED.category,
              canonical_url = EXCLUDED.canonical_url,
              image_url = EXCLUDED.image_url,
              product_payload = EXCLUDED.product_payload,
              freshness_json = EXCLUDED.freshness_json,
              category_path = EXCLUDED.category_path,
              category_confidence = EXCLUDED.category_confidence,
              category_label_source = EXCLUDED.category_label_source,
              pivota_signature_id = COALESCE(catalog_products.pivota_signature_id, EXCLUDED.pivota_signature_id),
              pivota_canonical_url = EXCLUDED.pivota_canonical_url,
              tags = EXCLUDED.tags,
              pdp_lifecycle_stage = EXCLUDED.pdp_lifecycle_stage,
              content_key = EXCLUDED.content_key,
              last_seen_in_sync_at = now(),
              sync_status = EXCLUDED.sync_status,
              updated_at = now()
          `,
          [
            p.product_key,
            p.merchant_id,
            p.platform,
            p.source_product_id,
            p.catalog_track,
            p.truth_tier,
            p.readiness_tier,
            p.source_system,
            p.source_ref,
            p.title,
            p.description,
            p.brand,
            p.product_type,
            p.category,
            p.canonical_url,
            p.image_url,
            JSON.stringify(p.product_payload),
            JSON.stringify(p.freshness_json),
            p.category_path,
            p.category_confidence,
            p.category_label_source,
            p.pivota_signature_id,
            p.pivota_canonical_url,
            JSON.stringify(p.tags),
            p.pdp_lifecycle_stage,
            p.content_key,
            p.sync_status,
          ],
        );
        totals.product_upserts += Number(productRes.rowCount || 0);

        const seedAttachmentRes = await client.query(
          `
            UPDATE external_product_seeds
            SET
              attached_product_key = $1,
              updated_at = now()
            WHERE id = $2
              AND status = 'active'
              AND coalesce(attached_product_key, '') = ''
            RETURNING id
          `,
          [p.product_key, mirror.row.id],
        );
        totals.seed_attachment_updates += Number(seedAttachmentRes.rowCount || 0);

        const s = mirror.sku;
        const skuRes = await client.query(
          `
            INSERT INTO catalog_skus (
              sku_key,
              product_key,
              merchant_id,
              platform,
              source_product_id,
              source_variant_id,
              sku,
              title,
              currency,
              image_url,
              visible_attributes,
              visible_option_labels,
              ingredient_ids,
              sku_payload,
              readiness_tier,
              updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,now())
            ON CONFLICT (sku_key) DO UPDATE SET
              title = EXCLUDED.title,
              currency = EXCLUDED.currency,
              image_url = EXCLUDED.image_url,
              visible_attributes = EXCLUDED.visible_attributes,
              visible_option_labels = EXCLUDED.visible_option_labels,
              ingredient_ids = EXCLUDED.ingredient_ids,
              sku_payload = EXCLUDED.sku_payload,
              readiness_tier = EXCLUDED.readiness_tier,
              updated_at = now()
          `,
          [
            s.sku_key,
            s.product_key,
            s.merchant_id,
            s.platform,
            s.source_product_id,
            s.source_variant_id,
            s.sku,
            s.title,
            s.currency,
            s.image_url,
            JSON.stringify(s.visible_attributes),
            JSON.stringify(s.visible_option_labels),
            JSON.stringify(s.ingredient_ids),
            JSON.stringify(s.sku_payload),
            s.readiness_tier,
          ],
        );
        totals.sku_upserts += Number(skuRes.rowCount || 0);

        const o = mirror.offer;
        const offerRes = await client.query(
          `
            INSERT INTO catalog_offers (
              offer_id,
              sku_key,
              product_key,
              merchant_id,
              catalog_track,
              truth_tier,
              readiness_tier,
              offer_mode,
              channel,
              availability,
              currency,
              list_price,
              merchant_effective_price,
              estimated_best_price,
              price_confidence,
              source_system,
              source_ref,
              offer_payload,
              updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,now())
            ON CONFLICT (offer_id) DO UPDATE SET
              availability = EXCLUDED.availability,
              currency = EXCLUDED.currency,
              list_price = EXCLUDED.list_price,
              merchant_effective_price = EXCLUDED.merchant_effective_price,
              estimated_best_price = EXCLUDED.estimated_best_price,
              price_confidence = EXCLUDED.price_confidence,
              source_system = EXCLUDED.source_system,
              source_ref = EXCLUDED.source_ref,
              offer_payload = EXCLUDED.offer_payload,
              updated_at = now()
          `,
          [
            o.offer_id,
            o.sku_key,
            o.product_key,
            o.merchant_id,
            o.catalog_track,
            o.truth_tier,
            o.readiness_tier,
            o.offer_mode,
            o.channel,
            o.availability,
            o.currency,
            o.list_price,
            o.merchant_effective_price,
            o.estimated_best_price,
            o.price_confidence,
            o.source_system,
            o.source_ref,
            JSON.stringify(o.offer_payload),
          ],
        );
        totals.offer_upserts += Number(offerRes.rowCount || 0);

        const groupRes = await client.query(
          `
            INSERT INTO product_group_members (
              product_group_id,
              merchant_id,
              platform,
              platform_product_id,
              is_primary,
              created_at,
              updated_at
            ) VALUES ($1,$2,$3,$4,true,now(),now())
            ON CONFLICT (merchant_id, platform, platform_product_id) DO UPDATE SET
              product_group_id = CASE
                WHEN product_group_members.product_group_id IS NULL
                  OR product_group_members.product_group_id = EXCLUDED.product_group_id
                THEN EXCLUDED.product_group_id
                ELSE product_group_members.product_group_id
              END,
              is_primary = CASE
                WHEN product_group_members.product_group_id IS NULL
                  OR product_group_members.product_group_id = EXCLUDED.product_group_id
                THEN EXCLUDED.is_primary
                ELSE product_group_members.is_primary
              END,
              updated_at = now()
            RETURNING product_group_id, product_group_id <> $1 AS preserved_existing_group
          `,
          [mirror.productGroupId, mirror.product.merchant_id, PLATFORM, mirror.row.external_product_id],
        );
        totals.group_member_upserts += Number(groupRes.rowCount || 0);
        if (groupRes.rows?.[0]?.preserved_existing_group) {
          totals.group_member_preserved_existing_merges += 1;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return totals;
}

async function run() {
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun') || !hasFlag('apply');
  const ids = Array.from(
    new Set([
      ...readDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds')),
      ...readIdsFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile')),
    ]),
  );
  const market = asString(argValue('market', 'US')).toUpperCase();
  const out = resolveOutPath(argValue('out'));
  if (!ids.length) throw new Error('missing_external_product_ids');
  const rows = await fetchRows(ids, market);
  const mirrorMerchantCounts = annotateUltaMirrorMerchants(rows);
  const missingIds = ids.filter((id) => !rows.some((row) => asString(row.external_product_id) === id));
  const skipped = [];
  let mirrors = [];
  for (const row of rows) {
    if (asString(row.status).toLowerCase() !== 'active') {
      skipped.push({ external_product_id: row.external_product_id, reason: 'inactive_seed' });
      continue;
    }
    if (!isUltaSeed(row)) {
      skipped.push({ external_product_id: row.external_product_id, reason: 'not_ulta_seed' });
      continue;
    }
    if (row.mirror_mint_blocked_reason) {
      skipped.push({
        external_product_id: row.external_product_id,
        reason: 'seller_of_record_unresolved',
        detail: row.mirror_mint_blocked_reason,
      });
      continue;
    }
    const mirror = buildMirror(row);
    if (!mirror.product.canonical_url) {
      skipped.push({ external_product_id: row.external_product_id, reason: 'missing_canonical_url' });
      continue;
    }
    mirrors.push(mirror);
  }

  // ---- Fix Plan D · T1: resolve-first against existing catalog identity --------
  // Before minting a self product/group, fold each retailer offer onto an existing
  // D2C/brand-direct product when (brandCore + strict titleCore) match EXACTLY.
  // Near matches are surfaced for review, never auto-merged. This is what makes a
  // dry-run report ZERO self-minted duplicates for products that already exist.
  const identity_resolution = {
    reuse_exact: 0,
    review_fuzzy: 0,
    self_mint: 0,
    fuzzy_candidates: [],
    reused: [],
  };
  if (mirrors.length) {
    const brands = Array.from(new Set(mirrors.map((m) => m.product.brand).filter(Boolean)));
    const excludeProductKeys = mirrors.map((m) => m.productKey);
    const index = await buildCatalogIdentityIndex(query, brands, { excludeProductKeys });
    for (const mirror of mirrors) {
      const r = resolveAgainstIndex(index, mirror.product.brand, mirror.product.title, {
        fuzzyThreshold: RETAILER_FUZZY_THRESHOLD,
      });
      if (r.decision === 'reuse_exact' && r.match.content_key) {
        if (r.match.content_key !== mirror.product.content_key) {
          identity_resolution.reused.push({
            external_product_id: mirror.row.external_product_id,
            brand: mirror.product.brand,
            title: mirror.product.title,
            from_content_key: mirror.product.content_key,
            into_content_key: r.match.content_key,
            d2c_product_key: r.match.product_key,
          });
        }
        // Reuse the matched product's identity instead of self-minting.
        mirror.product.content_key = r.match.content_key;
        if (r.match.product_group_id) mirror.productGroupId = r.match.product_group_id;
        mirror.resolved_identity = { rule: 'brand_title_core_exact', ...r.match };
        identity_resolution.reuse_exact += 1;
      } else if (r.decision === 'review_fuzzy') {
        identity_resolution.review_fuzzy += 1;
        identity_resolution.fuzzy_candidates.push({
          external_product_id: mirror.row.external_product_id,
          brand: mirror.product.brand,
          retailer_title: mirror.product.title,
          candidate_title: r.match.title,
          candidate_product_key: r.match.product_key,
          candidate_content_key: r.match.content_key,
          score: r.score,
        });
        // Conservative: keep the self-mint content_key; do NOT merge on a fuzzy hit.
      } else {
        identity_resolution.self_mint += 1;
      }
    }
  }
  // -----------------------------------------------------------------------------

  // #1916: a mirror still holding a null content_key after resolve-first has neither
  // a match to reuse nor mintable brand/title. index_pipeline_state.content_key is a
  // PRIMARY KEY, so it cannot be written; a placeholder would collide every such row
  // onto one serving decision. Drop it and retry next run. Checked here, not at build
  // time, because resolve-first legitimately fills the key in between.
  mirrors = mirrors.filter((mirror) => {
    if (mirror.product.content_key) return true;
    skipped.push({
      external_product_id: mirror.row?.external_product_id,
      reason: 'content_key_unmintable',
      brand: mirror.product.brand,
      title: mirror.product.title,
    });
    return false;
  });

  const applied = await applyMirrors(mirrors, dryRun);
  const byBrand = {};
  for (const mirror of mirrors) {
    const brand = mirror.product.brand || 'unknown';
    byBrand[brand] = (byBrand[brand] || 0) + 1;
  }
  const report = {
    generated_at: new Date().toISOString(),
    mode: dryRun ? 'dry_run' : 'apply',
    requested_ids: ids.length,
    fetched_rows: rows.length,
    mirror_rows: mirrors.length,
    mirror_merchant_resolution: mirrorMerchantCounts,
    missing_ids: missingIds,
    skipped,
    by_brand: Object.entries(byBrand)
      .map(([brand, rows]) => ({ brand, rows }))
      .sort((a, b) => b.rows - a.rows || a.brand.localeCompare(b.brand)),
    identity_resolution: {
      reuse_exact: identity_resolution.reuse_exact,
      review_fuzzy: identity_resolution.review_fuzzy,
      self_mint: identity_resolution.self_mint,
      reused_sample: identity_resolution.reused.slice(0, 15),
      fuzzy_sample: identity_resolution.fuzzy_candidates.slice(0, 15),
    },
    applied,
    sample: mirrors.slice(0, 10).map((mirror) => ({
      external_product_id: mirror.row.external_product_id,
      product_key: mirror.productKey,
      sku_key: mirror.skuKey,
      offer_id: mirror.offerId,
      product_group_id: mirror.productGroupId,
      title: mirror.product.title,
      brand: mirror.product.brand,
      price_amount: mirror.offer.list_price,
      image_url: mirror.product.image_url,
    })),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, serialized, 'utf8');
  }
}

if (require.main === module) {
  run()
    .catch((err) => {
      process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = {
  _internals: {
    annotateUltaMirrorMerchants,
    buildMirror,
  },
};
