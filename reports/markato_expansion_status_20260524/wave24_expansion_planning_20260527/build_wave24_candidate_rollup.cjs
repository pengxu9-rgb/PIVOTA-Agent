#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../../../src/db');

const REPORT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = __dirname;

const CURATED_MARKATO_DOMAINS = [
  '7journeys.com',
  '786cosmetics.com',
  'abyssianhaircare.com',
  'activedrip.com',
  'advancedcosmetica.com',
  'aetaswellness.com',
  'afrakari.com',
  'anaya.com',
  'apiceuticals.com',
  'baiebotanique.com',
  'bonjourlavie.com',
  'borntobio.fr',
  'byrabeauty.com',
  'coconutmatter.com',
  'cosmydor.com',
  'daeby.com',
  'daebynature.com',
  'delicatedaisys.com',
  'en.limecosmetic.com',
  'gingingers.com',
  'ginzai.com',
  'hellomims.com',
  'illmabeauty.com',
  'joujoubotanicals.com',
  'khus-khus.com',
  'lazy-society.com',
  'lhamour.com',
  'limecosmetic.com',
  'linhart.nyc',
  'lovemasami.com',
  'lucamarskincare.com',
  'manisante.com',
  'medicube.us',
  'merindahbotanicals.com',
  'missnella.com',
  'nalacare.com',
  'nimbusco.com',
  'nourwish.com',
  'nubest.com',
  'oiluj.com',
  'orora.co',
  'ouate-paris.com',
  'rmsbeauty.com',
  'rohrremedy.com',
  'rutines.com',
  'scentedlife.com',
  'seresilk.com.au',
  'serich.com',
  'suntribesunscreen.com',
  'terraandco.com',
  'upcirclebeauty.com',
  'us.oiolab.co',
  'veganfox.com',
  'youthlab.com',
];

const BLOCKED_DOMAINS = new Set([
  'api.markato.com',
  'cdn.shopify.com',
  'example.com',
  'example.test',
  'facebook.com',
  'instagram.com',
  'localhost',
  'markato.com',
  'pinterest.com',
  'shopify.com',
  'tiktok.com',
  'youtube.com',
]);

function asText(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return asText(value).toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonMaybe(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const joined = value.map((item) => asText(item)).filter(Boolean).join('; ');
      if (joined) return joined;
      continue;
    }
    const text = asText(value);
    if (text) return text;
  }
  return '';
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeDomain(value) {
  let text = lower(value);
  if (!text) return '';
  text = text.replace(/^https?:\/\//, '').replace(/^www\./, '');
  text = text.split('/')[0].split('?')[0].split('#')[0];
  return text.replace(/:\d+$/, '');
}

function normalizeCanonicalUrl(value) {
  const raw = asText(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${url.pathname.toLowerCase()}`;
  } catch {
    return raw.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = asText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function walkFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkFiles(filePath, files);
    } else {
      files.push(filePath);
    }
  }
  return files;
}

function discoverArtifactDomains() {
  const roots = [
    'agent_wave6_batch_1',
    'agent_wave6_batch_2',
    'agent_wave6_batch_3',
    'agent_wave6_batch_4',
    'agent_wave6_batch_5',
    'agent_wave7_batch_1',
    'agent_wave7_batch_2',
    'agent_wave7_batch_3',
    'agent_wave7_batch_4',
    'agent_wave7_batch_5',
    'markato_us_brand_opportunity_holistic_plan_20260524.md',
  ].map((item) => path.join(REPORT_ROOT, item));

  const domains = [];
  for (const root of roots) {
    const files = fs.existsSync(root) && fs.statSync(root).isDirectory() ? walkFiles(root) : [root];
    for (const filePath of files) {
      if (!fs.existsSync(filePath)) continue;
      if (!/\.(csv|json|md|txt)$/i.test(filePath)) continue;
      const text = fs.readFileSync(filePath, 'utf8');
      for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#][^\s"',)>\]]*)?/gi)) {
        const domain = normalizeDomain(match[1]);
        if (domain && !BLOCKED_DOMAINS.has(domain)) domains.push(domain);
      }
      for (const match of text.matchAll(/\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b/gi)) {
        const domain = normalizeDomain(match[1]);
        if (!domain || BLOCKED_DOMAINS.has(domain)) continue;
        if (!/[a-z]/.test(domain) || domain.endsWith('.json')) continue;
        domains.push(domain);
      }
    }
  }
  return unique(domains);
}

function discoverArtifactExternalIds() {
  const ids = [];
  for (const filePath of walkFiles(REPORT_ROOT)) {
    if (!/\.(csv|json|md|txt)$/i.test(filePath)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(/\bext_[a-f0-9]{16,}\b/g)) {
      ids.push(match[0]);
    }
  }
  return unique(ids);
}

function seedFacts(row) {
  const seedData = asObject(readJsonMaybe(row.seed_data));
  const snapshot = asObject(seedData.snapshot);
  const normalized = asObject(seedData.normalized);
  const product = asObject(seedData.product);
  const offer = asObject(seedData.offer);
  const priceObject = asObject(seedData.price || snapshot.price || product.price || offer.price);
  const images = [
    ...asArray(seedData.images),
    ...asArray(seedData.image_urls),
    ...asArray(snapshot.images),
    ...asArray(snapshot.image_urls),
    ...asArray(product.images),
  ];
  const primaryImage = images
    .map((item) => firstText(item, asObject(item).src, asObject(item).url, asObject(item).image_url))
    .find(Boolean);
  const title = firstText(row.title, seedData.title, normalized.title, snapshot.title, product.title);
  const description = firstText(
    seedData.description,
    seedData.pdp_description_raw,
    seedData.product_description,
    normalized.description,
    snapshot.description,
    snapshot.pdp_description_raw,
    snapshot.product_description,
    snapshot.body_html,
    product.description,
  );
  const ingredients = firstText(
    seedData.pdp_ingredients_raw,
    seedData.raw_ingredient_text_clean,
    seedData.ingredients_inci,
    seedData.inci_list,
    asObject(seedData.ingredient_intel).raw_ingredient_text_clean,
    asObject(seedData.ingredient_intel).inci_raw,
    asObject(seedData.ingredient_intel).inci_list,
    seedData.full_ingredients,
    seedData.ingredients,
    normalized.ingredients_inci,
    normalized.full_ingredients,
    snapshot.pdp_ingredients_raw,
    snapshot.raw_ingredient_text_clean,
    snapshot.ingredients_inci,
    snapshot.inci_list,
    asObject(snapshot.ingredient_intel).raw_ingredient_text_clean,
    asObject(snapshot.ingredient_intel).inci_raw,
    asObject(snapshot.ingredient_intel).inci_list,
    snapshot.full_ingredients,
    snapshot.ingredients,
    product.ingredients,
  );
  const howTo = firstText(
    seedData.pdp_how_to_use_raw,
    seedData.how_to_use,
    seedData.directions,
    seedData.usage,
    normalized.how_to_use,
    snapshot.pdp_how_to_use_raw,
    snapshot.how_to_use,
    snapshot.directions,
    snapshot.usage,
    product.how_to_use,
  );
  const brand = firstText(
    asObject(seedData.brand).name,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    normalized.brand,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
    row.catalog_brand,
    row.domain,
  );
  const price = firstNumber(
    row.price_amount,
    seedData.price_amount,
    snapshot.price_amount,
    priceObject.amount,
    priceObject.value,
    product.price_amount,
    offer.price_amount,
  );
  const currency = firstText(
    row.price_currency,
    seedData.price_currency,
    snapshot.price_currency,
    priceObject.currency,
    product.price_currency,
    offer.price_currency,
  ).toUpperCase();
  const availability = firstText(
    row.availability,
    seedData.availability,
    snapshot.availability,
    product.availability,
    offer.availability,
  );
  const image = firstText(
    row.image_url,
    seedData.image_url,
    seedData.primary_image_url,
    normalized.image_url,
    snapshot.image_url,
    snapshot.primary_image_url,
    primaryImage,
    product.image_url,
  );
  const category = firstText(
    seedData.category,
    seedData.product_type,
    normalized.category,
    snapshot.category,
    snapshot.product_type,
    product.category,
    product.product_type,
  );
  return {
    brand,
    title,
    description,
    description_len: description.length,
    ingredients,
    how_to_use: howTo,
    image_url: image,
    price_amount: price,
    price_currency: currency,
    availability,
    category,
    content_evidence_hold: firstText(
      asObject(seedData.content_evidence_hold_v1).status,
      asObject(snapshot.content_evidence_hold_v1).status,
    ),
    canonical_url: firstText(row.canonical_url, seedData.canonical_url, snapshot.canonical_url, product.canonical_url),
    destination_url: firstText(row.destination_url, seedData.destination_url, snapshot.destination_url, product.destination_url),
  };
}

function productKind(facts) {
  const text = lower(`${facts.title} ${facts.category} ${facts.description}`);
  if (/\b(sponge|brush|comb|gua sha|roller|tool|cloth|pouch|bag|mirror|towel|applicator|accessory)\b/.test(text)) {
    return 'accessory_or_tool';
  }
  if (/\b(gift card|sample|mini|travel size|set|kit|bundle|duo|trio|subscription)\b/.test(text)) {
    return 'bundle_or_sample';
  }
  if (/\b(supplement|capsule|tablet|gummy|vitamin|mineral|probiotic|collagen powder|drink mix|tincture|cbd|hemp)\b/.test(text)) {
    return 'wellness_or_supplement';
  }
  if (/\b(spf|sunscreen|sun screen|broad spectrum|uv protection)\b/.test(text)) {
    return 'sunscreen_regulated';
  }
  return 'beauty_formula';
}

function contentFlags(facts, kind) {
  const flags = [];
  const availability = lower(facts.availability);
  const text = lower(`${facts.title} ${facts.description} ${facts.category}`);
  if (!facts.title) flags.push('missing_title');
  if (!facts.image_url) flags.push('missing_image');
  if (!facts.description || facts.description.length < 80) flags.push('missing_or_short_description');
  if (facts.price_amount == null) flags.push('missing_price');
  if (facts.price_currency && facts.price_currency !== 'USD') flags.push('non_usd_price');
  if (!facts.price_currency) flags.push('missing_currency');
  if (facts.price_amount != null && facts.price_amount > 250) flags.push('high_price_review');
  if (!facts.availability) flags.push('missing_availability');
  if (/\b(out of stock|sold out|unavailable|not available|discontinued)\b/.test(availability)) flags.push('not_in_stock');
  if (/medical|treat|cure|heal|eczema|psoriasis|rosacea|fungal|infection|scar|wound|hormone|pain relief|anti[- ]?inflammatory/.test(text)) {
    flags.push('regulated_claim_review');
  }
  if (kind === 'beauty_formula' && !facts.ingredients) flags.push('missing_full_inci');
  if (kind === 'beauty_formula' && !facts.how_to_use) flags.push('missing_how_to');
  if (facts.content_evidence_hold) flags.push('content_evidence_hold');
  if (kind !== 'beauty_formula') flags.push(kind);
  return unique(flags);
}

function productIntelStatus(row) {
  const analysis = asObject(readJsonMaybe(row.kb_analysis));
  const bundle = Object.keys(asObject(analysis.product_intel_v1)).length
    ? asObject(analysis.product_intel_v1)
    : asObject(analysis.product_intel);
  const core = asObject(bundle.product_intel_core);
  const quality = lower(firstText(bundle.quality_state, core.quality_state));
  const evidence = lower(firstText(bundle.evidence_profile, core.evidence_profile));
  const why = asArray(core.why_it_stands_out || bundle.why_it_stands_out);
  const headline = firstText(asObject(core.what_it_is).headline, asObject(bundle.what_it_is).headline);
  const reviewed = ['reviewed', 'verified', 'published'].includes(quality);
  const sellerOnly = evidence === 'seller_only';
  return {
    exists: Boolean(row.kb_key),
    reviewed,
    high_quality: Boolean(row.kb_key && reviewed && !sellerOnly && headline && why.length),
    quality_state: quality,
    evidence_profile: evidence,
  };
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join('|') : asText(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((Number(numerator || 0) / denominator) * 100).toFixed(1));
}

function increment(object, key, count = 1) {
  const normalized = asText(key) || 'unknown';
  object[normalized] = Number(object[normalized] || 0) + count;
}

function classifyLane(row) {
  if (row.hard_risk) return 'hold_risk_review';
  if (row.source_gap) return 'hold_source_gap';
  if (!row.catalog_attached) return 'catalog_identity_sync';
  if (!row.identity_ready) return 'identity_refresh';
  if (!row.index_serving_eligible) return 'serving_index_sync';
  if (!row.product_intel_high_quality) return 'product_intel_review';
  return 'ready_or_covered';
}

function laneRank(lane) {
  const ranks = {
    catalog_identity_sync: 1,
    serving_index_sync: 2,
    identity_refresh: 3,
    product_intel_review: 4,
    hold_source_gap: 8,
    hold_risk_review: 9,
    ready_or_covered: 10,
  };
  return ranks[lane] || 99;
}

function buildDuplicateCanonicalPendingIdSet(entries) {
  const byCanonical = new Map();
  for (const entry of entries) {
    const canonical = normalizeCanonicalUrl(entry.facts.canonical_url || entry.facts.destination_url);
    if (!canonical) continue;
    const group = byCanonical.get(canonical) || [];
    group.push({
      externalProductId: asText(entry.row.external_product_id),
      indexServingEligible: entry.row.serving_eligible === true,
    });
    byCanonical.set(canonical, group);
  }

  const pending = new Set();
  for (const group of byCanonical.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      if (!item.indexServingEligible && item.externalProductId) pending.add(item.externalProductId);
    }
  }
  return pending;
}

function isHardRisk(flags) {
  return flags.some((flag) => (
    flag === 'non_usd_price' ||
    flag === 'high_price_review' ||
    flag === 'not_in_stock' ||
    flag === 'duplicate_canonical_identity_review' ||
    flag === 'regulated_claim_review' ||
    flag === 'wellness_or_supplement' ||
    flag === 'sunscreen_regulated' ||
    flag === 'accessory_or_tool' ||
    flag === 'bundle_or_sample'
  ));
}

function hasSourceGap(flags) {
  return flags.some((flag) => (
    flag === 'missing_title' ||
    flag === 'missing_image' ||
    flag === 'missing_or_short_description' ||
    flag === 'missing_price' ||
    flag === 'missing_currency' ||
    flag === 'missing_availability' ||
    flag === 'missing_full_inci' ||
    flag === 'missing_how_to' ||
    flag === 'content_evidence_hold'
  ));
}

async function fetchRows(domains, externalIds) {
  const result = await query(
    `
      WITH seed_rows AS (
        SELECT
          eps.id AS seed_id,
          eps.external_product_id,
          eps.domain,
          eps.market,
          eps.status,
          eps.tool,
          eps.title,
          eps.image_url,
          eps.price_amount,
          eps.price_currency,
          eps.availability,
          eps.canonical_url,
          eps.destination_url,
          eps.attached_product_key,
          eps.partner_type,
          eps.content_lock,
          eps.updated_at,
          eps.seed_data
        FROM external_product_seeds eps
        WHERE eps.status = 'active'
          AND eps.market = 'US'
          AND (
            eps.domain = ANY($1::text[])
            OR eps.external_product_id = ANY($2::text[])
          )
      ),
      catalog_one AS (
        SELECT DISTINCT ON (cp.source_product_id)
          cp.source_product_id,
          cp.product_key,
          cp.content_key,
          cp.brand AS catalog_brand,
          cp.title AS catalog_title,
          cp.updated_at AS catalog_updated_at
        FROM catalog_products cp
        WHERE cp.merchant_id = 'external_seed'
          AND cp.platform = 'external_seed'
          AND cp.source_system = 'external_product_seeds_mirror_v1'
        ORDER BY cp.source_product_id, cp.updated_at DESC NULLS LAST, cp.product_key DESC NULLS LAST
      )
      SELECT
        s.*,
        c.product_key AS catalog_product_key,
        c.content_key,
        c.catalog_brand,
        c.catalog_title,
        c.catalog_updated_at,
        ips.serving_eligible,
        ips.blocker_code,
        pil.identity_status,
        pil.live_read_enabled,
        pil.review_required,
        pil.sellable_item_group_id,
        pil.source_tier,
        pil.updated_at AS identity_updated_at,
        kb.kb_key,
        kb.last_success_at AS kb_last_success_at,
        kb.last_error AS kb_last_error,
        kb.updated_at AS kb_updated_at,
        kb.analysis AS kb_analysis
      FROM seed_rows s
      LEFT JOIN catalog_one c
        ON c.source_product_id = s.external_product_id
      LEFT JOIN index_pipeline_state ips
        ON ips.content_key = c.content_key
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = 'external_seed'
       AND pil.product_id = s.external_product_id
      LEFT JOIN aurora_product_intel_kb kb
        ON kb.kb_key = ('product:' || s.external_product_id)
      ORDER BY s.domain, s.external_product_id
    `,
    [domains, externalIds],
  );
  return result.rows || [];
}

function buildMarkdown(summary, domainRows, recommendedRows, sourceGapRows, outDir) {
  const lines = [];
  lines.push('# Wave24 Markato Expansion Candidate Rollup');
  lines.push('');
  lines.push(`Generated: ${summary.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Production active US seed rows scanned: ${summary.production_rows}`);
  lines.push(`- Domains with active production rows: ${summary.domains_with_rows}`);
  lines.push(`- Catalog attached: ${summary.catalog_attached}/${summary.production_rows} (${summary.catalog_attached_pct}%)`);
  lines.push(`- DB serving eligible: ${summary.index_serving_eligible}/${summary.production_rows} (${summary.index_serving_eligible_pct}%)`);
  lines.push(`- Identity ready: ${summary.identity_ready}/${summary.production_rows} (${summary.identity_ready_pct}%)`);
  lines.push(`- High-quality reviewed product intel: ${summary.product_intel_high_quality}/${summary.production_rows} (${summary.product_intel_high_quality_pct}%)`);
  lines.push(`- Recommended next-batch rows: ${recommendedRows.length}`);
  lines.push(`- Source-gap hold rows: ${sourceGapRows.length}`);
  lines.push('');
  lines.push('## Recommended Next Batch');
  lines.push('');
  if (!recommendedRows.length) {
    lines.push('- No production rows passed the conservative source-quality gate for immediate expansion.');
  } else {
    for (const row of recommendedRows.slice(0, 20)) {
      lines.push(`- ${row.domain} | ${row.brand} | ${row.external_product_id} | ${row.title} | ${row.recommended_lane}`);
    }
  }
  lines.push('');
  lines.push('## Domain Rollup');
  lines.push('');
  for (const row of domainRows.slice(0, 30)) {
    lines.push(`- ${row.domain}: rows=${row.rows}, ready=${row.ready_or_covered}, catalog=${row.catalog_attached}, serving=${row.index_serving_eligible}, intel_hq=${row.product_intel_high_quality}, source_gap=${row.hold_source_gap}, risk=${row.hold_risk_review}`);
  }
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- ${path.join(outDir, 'wave24_candidate_rollup.json')}`);
  lines.push(`- ${path.join(outDir, 'wave24_domain_rollup.csv')}`);
  lines.push(`- ${path.join(outDir, 'wave24_product_gaps.csv')}`);
  lines.push(`- ${path.join(outDir, 'wave24_recommended_next_batch.csv')}`);
  lines.push(`- ${path.join(outDir, 'wave24_source_gap_backlog.csv')}`);
  lines.push('');
  lines.push('## Guardrails');
  lines.push('');
  lines.push('- This report is read-only against production DB.');
  lines.push('- Rows with missing full INCI/how-to, non-USD/high price, stock gaps, regulated claims, sunscreen, supplements, bundles, or non-formula products are held out of immediate PDP expansion.');
  lines.push('- Next write step should be an exact-SKU dry-run before any production apply.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const outDir = path.resolve(process.argv[2] || DEFAULT_OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  const domains = unique([
    ...CURATED_MARKATO_DOMAINS,
    ...discoverArtifactDomains(),
  ].map(normalizeDomain)).filter((domain) => domain && !BLOCKED_DOMAINS.has(domain)).sort();
  const externalIds = discoverArtifactExternalIds().sort();
  const rows = await fetchRows(domains, externalIds);
  const rowEntries = rows.map((row) => ({ row, facts: seedFacts(row) }));
  const duplicateCanonicalPendingIds = buildDuplicateCanonicalPendingIdSet(rowEntries);

  const productRows = rowEntries.map(({ row, facts }) => {
    const kind = productKind(facts);
    const flags = contentFlags(facts, kind);
    const duplicateCanonicalIdentityReview = duplicateCanonicalPendingIds.has(asText(row.external_product_id));
    if (duplicateCanonicalIdentityReview) flags.push('duplicate_canonical_identity_review');
    const hardRisk = isHardRisk(flags);
    const sourceGap = hasSourceGap(flags);
    const intel = productIntelStatus(row);
    const identityReady = Boolean(
      row.identity_status === 'approved' &&
        row.live_read_enabled === true &&
        row.review_required !== true &&
        asText(row.sellable_item_group_id)
    );
    const catalogAttached = Boolean(row.catalog_product_key || row.attached_product_key);
    const indexServingEligible = row.serving_eligible === true;
    const base = {
      domain: normalizeDomain(row.domain),
      brand: facts.brand,
      external_product_id: row.external_product_id,
      title: facts.title,
      product_kind: kind,
      catalog_attached: catalogAttached,
      catalog_product_key: row.catalog_product_key || row.attached_product_key || '',
      content_key: row.content_key || '',
      index_serving_eligible: indexServingEligible,
      blocker_code: row.blocker_code || '',
      identity_ready: identityReady,
      identity_status: row.identity_status || '',
      identity_live_read_enabled: row.live_read_enabled === true,
      identity_review_required: row.review_required === true,
      product_intel_exists: intel.exists,
      product_intel_reviewed: intel.reviewed,
      product_intel_high_quality: intel.high_quality,
      product_intel_quality_state: intel.quality_state,
      product_intel_evidence_profile: intel.evidence_profile,
      price_amount: facts.price_amount == null ? '' : facts.price_amount,
      price_currency: facts.price_currency,
      availability: facts.availability,
      description_len: facts.description_len,
      has_image: Boolean(facts.image_url),
      has_full_inci: Boolean(facts.ingredients),
      has_how_to: Boolean(facts.how_to_use),
      duplicate_canonical_identity_review: duplicateCanonicalIdentityReview,
      hard_risk: hardRisk,
      source_gap: sourceGap,
      quality_flags: flags.join('|'),
      canonical_url: facts.canonical_url,
      destination_url: facts.destination_url,
      seed_updated_at: row.updated_at || '',
      kb_last_success_at: row.kb_last_success_at || '',
    };
    return {
      ...base,
      recommended_lane: classifyLane(base),
    };
  });

  const domainMap = new Map();
  for (const row of productRows) {
    if (!domainMap.has(row.domain)) {
      domainMap.set(row.domain, {
        domain: row.domain,
        brand_examples: new Set(),
        rows: 0,
        catalog_attached: 0,
        index_serving_eligible: 0,
        identity_ready: 0,
        product_intel_high_quality: 0,
        ready_or_covered: 0,
        catalog_identity_sync: 0,
        serving_index_sync: 0,
        identity_refresh: 0,
        product_intel_review: 0,
        hold_source_gap: 0,
        hold_risk_review: 0,
        quality_flag_counts: {},
      });
    }
    const item = domainMap.get(row.domain);
    item.rows += 1;
    if (row.brand) item.brand_examples.add(row.brand);
    if (row.catalog_attached) item.catalog_attached += 1;
    if (row.index_serving_eligible) item.index_serving_eligible += 1;
    if (row.identity_ready) item.identity_ready += 1;
    if (row.product_intel_high_quality) item.product_intel_high_quality += 1;
    if (row.recommended_lane === 'ready_or_covered') item.ready_or_covered += 1;
    if (row.recommended_lane === 'catalog_identity_sync') item.catalog_identity_sync += 1;
    if (row.recommended_lane === 'serving_index_sync') item.serving_index_sync += 1;
    if (row.recommended_lane === 'identity_refresh') item.identity_refresh += 1;
    if (row.recommended_lane === 'product_intel_review') item.product_intel_review += 1;
    if (row.recommended_lane === 'hold_source_gap') item.hold_source_gap += 1;
    if (row.recommended_lane === 'hold_risk_review') item.hold_risk_review += 1;
    for (const flag of row.quality_flags.split('|').filter(Boolean)) increment(item.quality_flag_counts, flag);
  }

  const domainRows = Array.from(domainMap.values()).map((item) => {
    const flagSummary = Object.entries(item.quality_flag_counts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([flag, count]) => `${flag}:${count}`)
      .join(' | ');
    return {
      ...item,
      brand_examples: Array.from(item.brand_examples).slice(0, 4).join(' | '),
      catalog_attached_pct: pct(item.catalog_attached, item.rows),
      index_serving_eligible_pct: pct(item.index_serving_eligible, item.rows),
      identity_ready_pct: pct(item.identity_ready, item.rows),
      product_intel_high_quality_pct: pct(item.product_intel_high_quality, item.rows),
      quality_flag_summary: flagSummary,
      quality_flag_counts: undefined,
    };
  }).sort((left, right) => {
    const actionableLeft = left.catalog_identity_sync + left.serving_index_sync + left.identity_refresh + left.product_intel_review;
    const actionableRight = right.catalog_identity_sync + right.serving_index_sync + right.identity_refresh + right.product_intel_review;
    return actionableRight - actionableLeft || right.rows - left.rows || left.domain.localeCompare(right.domain);
  });

  const recommendedRows = productRows
    .filter((row) => ['catalog_identity_sync', 'serving_index_sync', 'identity_refresh', 'product_intel_review'].includes(row.recommended_lane))
    .sort((left, right) => laneRank(left.recommended_lane) - laneRank(right.recommended_lane) || left.domain.localeCompare(right.domain) || left.title.localeCompare(right.title));
  const sourceGapRows = productRows
    .filter((row) => row.recommended_lane === 'hold_source_gap')
    .sort((left, right) => left.domain.localeCompare(right.domain) || left.title.localeCompare(right.title));
  const riskRows = productRows
    .filter((row) => row.recommended_lane === 'hold_risk_review')
    .sort((left, right) => left.domain.localeCompare(right.domain) || left.title.localeCompare(right.title));

  const summary = {
    generated_at: new Date().toISOString(),
    production_rows: productRows.length,
    queried_domains: domains.length,
    artifact_external_ids: externalIds.length,
    domains_with_rows: domainRows.length,
    catalog_attached: productRows.filter((row) => row.catalog_attached).length,
    catalog_attached_pct: pct(productRows.filter((row) => row.catalog_attached).length, productRows.length),
    index_serving_eligible: productRows.filter((row) => row.index_serving_eligible).length,
    index_serving_eligible_pct: pct(productRows.filter((row) => row.index_serving_eligible).length, productRows.length),
    identity_ready: productRows.filter((row) => row.identity_ready).length,
    identity_ready_pct: pct(productRows.filter((row) => row.identity_ready).length, productRows.length),
    product_intel_high_quality: productRows.filter((row) => row.product_intel_high_quality).length,
    product_intel_high_quality_pct: pct(productRows.filter((row) => row.product_intel_high_quality).length, productRows.length),
    lane_counts: productRows.reduce((acc, row) => {
      increment(acc, row.recommended_lane);
      return acc;
    }, {}),
    recommended_next_batch_rows: recommendedRows.length,
    source_gap_rows: sourceGapRows.length,
    risk_hold_rows: riskRows.length,
  };

  const productColumns = [
    'domain',
    'brand',
    'external_product_id',
    'title',
    'product_kind',
    'recommended_lane',
    'catalog_attached',
    'index_serving_eligible',
    'identity_ready',
    'product_intel_high_quality',
    'price_amount',
    'price_currency',
    'availability',
    'description_len',
    'has_image',
    'has_full_inci',
    'has_how_to',
    'duplicate_canonical_identity_review',
    'hard_risk',
    'source_gap',
    'quality_flags',
    'canonical_url',
  ];
  const domainColumns = [
    'domain',
    'brand_examples',
    'rows',
    'catalog_attached',
    'catalog_attached_pct',
    'index_serving_eligible',
    'index_serving_eligible_pct',
    'identity_ready',
    'identity_ready_pct',
    'product_intel_high_quality',
    'product_intel_high_quality_pct',
    'ready_or_covered',
    'catalog_identity_sync',
    'serving_index_sync',
    'identity_refresh',
    'product_intel_review',
    'hold_source_gap',
    'hold_risk_review',
    'quality_flag_summary',
  ];

  writeJson(path.join(outDir, 'wave24_candidate_rollup.json'), {
    summary,
    domains: domainRows,
    products: productRows,
    recommended_next_batch: recommendedRows,
    source_gap_backlog: sourceGapRows,
    risk_hold: riskRows,
    queried_domains: domains,
  });
  writeCsv(path.join(outDir, 'wave24_domain_rollup.csv'), domainRows, domainColumns);
  writeCsv(path.join(outDir, 'wave24_product_gaps.csv'), productRows, productColumns);
  writeCsv(path.join(outDir, 'wave24_recommended_next_batch.csv'), recommendedRows, productColumns);
  writeCsv(path.join(outDir, 'wave24_source_gap_backlog.csv'), sourceGapRows, productColumns);
  writeCsv(path.join(outDir, 'wave24_risk_hold.csv'), riskRows, productColumns);
  fs.writeFileSync(
    path.join(outDir, 'wave24_candidate_rollup.md'),
    buildMarkdown(summary, domainRows, recommendedRows, sourceGapRows, outDir),
    'utf8',
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    out_dir: outDir,
    summary,
    top_domains: domainRows.slice(0, 12),
    recommended_next_batch: recommendedRows.slice(0, 20).map((row) => ({
      domain: row.domain,
      external_product_id: row.external_product_id,
      title: row.title,
      lane: row.recommended_lane,
      flags: row.quality_flags,
    })),
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
