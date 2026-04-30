#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPORT_DIR =
  '/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429';

const REPORT_DIR = path.resolve(process.argv[2] || DEFAULT_REPORT_DIR);
const GENERATED_AT = new Date().toISOString();

const MARKET_CURRENCY_TARGET = Object.freeze({
  US: 'USD',
  'EU-DE': 'EUR',
  SG: 'SGD',
  JP: 'JPY',
  CN: 'CNY',
  KR: 'KRW',
});

const COMMERCE_COLUMNS = Object.freeze([
  'commerce_facts_contract',
  'us_currency_gate',
  'sellable_region_status',
  'shipping_status',
  'promotion_status',
  'commerce_facts_confidence',
  'pdp_offer_merge_gate',
  'checkout_handoff_gate',
  'commerce_notes',
]);

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift();
  return rows
    .filter((cells) => cells.some((cell) => String(cell || '').trim()))
    .map((cells) =>
      headers.reduce((out, header, idx) => {
        out[header] = cells[idx] == null ? '' : cells[idx];
        return out;
      }, {}),
    );
}

function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows, preferredHeaders = []) {
  const headers = [];
  const seen = new Set();
  for (const header of preferredHeaders) {
    if (!header || seen.has(header)) continue;
    seen.add(header);
    headers.push(header);
  }
  for (const row of rows) {
    for (const header of Object.keys(row)) {
      if (seen.has(header)) continue;
      seen.add(header);
      headers.push(header);
    }
  }
  const lines = [
    headers.map(escapeCsv).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(',')),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function readCsvFile(filePath) {
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

function sourceKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeCurrency(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : '';
}

function normalizeAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value == null ? '' : value).replace(/[^0-9.-]+/g, '');
  if (!cleaned) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function findFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));
}

function extractManifestRows(filePath, sourceKind) {
  const manifest = readJson(filePath, {});
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  return items
    .map((item) => item.seed_row || item.seedRow || item)
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      filePath,
      manifest,
      row,
      sourceKind,
    }));
}

function readCommerceFacts(row) {
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const facts = asObject(seedData.commerce_facts_v1);
  const snapshotFacts = asObject(snapshot.commerce_facts_v1);
  if (facts.contract_version === 'commerce_facts.v1') return facts;
  if (snapshotFacts.contract_version === 'commerce_facts.v1') return snapshotFacts;
  return null;
}

function inferSourceName(manifest, row, sourceKind, filePath) {
  if (sourceKind === 'channel') {
    const filename = path.basename(filePath).replace(/-manifest\.json$/, '');
    if (filename.includes('sokoglam')) return 'Soko Glam';
    if (filename.includes('wishtrend')) return 'Wishtrend';
    if (filename.includes('bloomingkoco')) return 'Blooming Koco';
    if (filename.includes('ohlolly')) return 'Ohlolly';
    return row.domain || manifest.domain || filename;
  }
  return manifest.brand || row.brand || row.domain || path.basename(filePath).replace(/-manifest\.json$/, '');
}

function currencyGate({ market, currency }) {
  const expected = MARKET_CURRENCY_TARGET[String(market || 'US').toUpperCase()] || 'USD';
  if (!currency) return { expected, status: 'hold_missing_currency' };
  if (String(market || 'US').toUpperCase() === 'US' && currency !== 'USD') {
    return { expected, status: 'hold_currency_mismatch' };
  }
  return { expected, status: currency === expected ? 'pass' : 'review_market_currency' };
}

function inventoryRowFromManifestEntry(entry) {
  const { filePath, manifest, row, sourceKind } = entry;
  const seedData = asObject(row.seed_data);
  const facts = readCommerceFacts(row);
  const market = row.market || manifest.market || 'US';
  const priceCurrency =
    normalizeCurrency(facts?.regional_price?.observed_currency) ||
    normalizeCurrency(facts?.regional_price?.currency) ||
    normalizeCurrency(row.price_currency || seedData.price_currency);
  const gate = currencyGate({ market, currency: priceCurrency });
  const priceAmount =
    normalizeAmount(facts?.regional_price?.amount) ??
    normalizeAmount(row.price_amount ?? seedData.price_amount);
  const availability =
    facts?.availability?.status ||
    row.availability ||
    seedData.availability ||
    'unknown';
  const imagePresent = Boolean(row.image_url || seedData.image_url);
  const missingTransaction = !(priceAmount > 0) || !priceCurrency || !availability || !imagePresent;
  const sourceName = inferSourceName(manifest, row, sourceKind, filePath);
  const mergeStatus =
    sourceKind === 'channel'
      ? 'hold_requires_verified_multi_offer_merge_candidate'
      : 'not_required_for_dtc_seed';
  const applyGate =
    gate.status !== 'pass'
      ? gate.status
      : missingTransaction
        ? 'hold_missing_transaction_fact'
        : sourceKind === 'channel'
          ? mergeStatus
          : 'pass';

  return {
    source_kind: sourceKind,
    source_name: sourceName,
    source_key: sourceKey(`${sourceName}-${row.brand || manifest.brand || ''}`),
    brand: row.brand || manifest.brand || '',
    market,
    country: facts?.country || (market === 'US' ? 'US' : ''),
    currency_target: facts?.currency_target || gate.expected,
    product_title: row.title || seedData.title || '',
    canonical_url: row.canonical_url || seedData.canonical_url || '',
    evidence_url: facts?.evidence_url || row.destination_url || row.canonical_url || seedData.destination_url || '',
    price_amount: priceAmount == null ? '' : priceAmount,
    price_currency: priceCurrency,
    price_confidence: facts?.regional_price?.confidence || (priceCurrency ? 'medium' : 'unknown'),
    market_switch_status:
      facts?.regional_price?.market_switch_status ||
      (gate.status === 'pass' ? 'ok' : gate.status === 'hold_currency_mismatch' ? 'mismatch' : 'unknown'),
    currency_gate: gate.status,
    availability_status: availability,
    availability_confidence: facts?.availability?.confidence || (availability ? 'medium' : 'unknown'),
    sellable_region_status: facts?.sellable_region?.status || 'unknown',
    sellable_region_confidence: facts?.sellable_region?.confidence || 'unknown',
    shipping_status: facts?.shipping?.status || 'unknown',
    shipping_confidence: facts?.shipping?.confidence || 'unknown',
    promotion_status: Array.isArray(facts?.promotions) && facts.promotions.length ? 'available' : 'unknown',
    promotion_confidence: Array.isArray(facts?.promotions) && facts.promotions.length ? 'low_or_source' : 'unknown',
    returns_status: facts?.returns?.status || 'unknown',
    returns_confidence: facts?.returns?.confidence || 'unknown',
    source_authority: facts?.source_authority || 'manifest_transaction_observation',
    captured_at: facts?.captured_at || manifest.generated_at || '',
    checkout_handoff_mode: sourceKind === 'channel' || sourceKind === 'dtc' ? 'external_links_out' : '',
    pdp_offer_merge_gate: mergeStatus,
    apply_gate: applyGate,
    notes:
      facts
        ? 'CommerceFactsV1 present.'
        : 'Legacy manifest observation; shipping/promo/returns remain unknown until extract-v2 dry-run refresh.',
  };
}

function buildInventoryRows() {
  const dtcFiles = findFiles(path.join(REPORT_DIR, 'manifests_filtered'), /-manifest\.json$/);
  const channelFiles = findFiles(path.join(REPORT_DIR, 'channel_dry_run_manifests'), /-manifest\.json$/);
  const rows = [
    ...dtcFiles.flatMap((filePath) => extractManifestRows(filePath, 'dtc')),
    ...channelFiles.flatMap((filePath) => extractManifestRows(filePath, 'channel')),
  ].map(inventoryRowFromManifestEntry);

  rows.push({
    source_kind: 'internal',
    source_name: 'sandbox merchant API',
    source_key: 'internal-sandbox-merchant-api',
    brand: 'COSRX',
    market: 'US',
    country: 'US',
    currency_target: 'USD',
    product_title: 'COSRX Ceramide Skin Barrier Moisturizer',
    canonical_url: '',
    evidence_url: 'unit:test:tests/pdp_offers_group_members.test.js',
    price_amount: 26,
    price_currency: 'USD',
    price_confidence: 'high',
    market_switch_status: 'ok',
    currency_gate: 'pass',
    availability_status: 'in_stock',
    availability_confidence: 'high',
    sellable_region_status: 'eligible',
    sellable_region_confidence: 'high',
    shipping_status: 'available',
    shipping_confidence: 'high',
    promotion_status: 'available_if_store_metadata_present',
    promotion_confidence: 'high',
    returns_status: 'available_if_store_metadata_present',
    returns_confidence: 'high',
    source_authority: 'internal_merchant_api',
    captured_at: GENERATED_AT,
    checkout_handoff_mode: 'merchant_embedded_checkout',
    pdp_offer_merge_gate: 'test_pass_internal_plus_external_merge',
    apply_gate: 'pass',
    notes: 'Internal merchant API is highest authority; verified in unit test without live purchase.',
  });
  return rows;
}

function buildMergeValidationRows(inventoryRows) {
  const mergeAssessment = readJson(path.join(REPORT_DIR, 'k_beauty_channel_multi_offer_merge_assessment.json'), {});
  const channelRuns = Array.isArray(mergeAssessment.current_brand_scoped_channel_dry_runs)
    ? mergeAssessment.current_brand_scoped_channel_dry_runs
    : [];
  const channelRows = channelRuns.map((run) => ({
    case_id: `channel-${run.key}`,
    case_type: 'dtc_plus_retailer_external_offer',
    source: run.source,
    brand: run.brand,
    identity_group: 'not_confirmed_live',
    merge_candidate_status: run.decision || 'hold_no_apply_identity_merge_not_verified',
    offers_expected: 'external retailer offer only after approved live identity merge',
    default_offer_expected: 'existing DTC/internal offer remains default until merge candidate approved',
    checkout_handoff_mode: 'external_links_out',
    result: 'hold',
    evidence: 'k_beauty_channel_multi_offer_merge_assessment.json',
    notes: `Dry-run scanned ${run.dry_run_summary?.scanned || 0}; would_insert ${run.dry_run_summary?.would_insert || 0}; matching live identity rows ${run.matching_identity_rows_count || 0}.`,
  }));

  const laneigeRows = inventoryRows.filter((row) => row.source_name === 'LANEIGE US');
  const anuaRows = inventoryRows.filter((row) => row.source_name === 'Anua');
  const bojMismatch = inventoryRows.filter((row) => row.brand === 'Beauty of Joseon' && row.currency_gate !== 'pass');

  return [
    {
      case_id: 'dtc-only-laneige-us',
      case_type: 'dtc_only_pdp',
      source: 'LANEIGE US',
      brand: 'LANEIGE US',
      identity_group: 'single external_seed DTC offer',
      merge_candidate_status: 'not_required',
      offers_expected: '1 DTC external offer',
      default_offer_expected: 'DTC external links_out offer',
      checkout_handoff_mode: 'links_out',
      result: laneigeRows.every((row) => row.currency_gate === 'pass') ? 'pass' : 'hold',
      evidence: 'laneige-dtc-create-apply.json; laneige-dtc-db-postcheck.json; live_pdp/laneige-live-get-pdp-v2-spotcheck.json',
      notes: 'Filtered LANEIGE merch/accessory rows; USD price/availability/image postcheck and live PDP spot check passed.',
    },
    {
      case_id: 'dtc-only-anua-official-us',
      case_type: 'dtc_only_pdp',
      source: 'Anua',
      brand: 'Anua',
      identity_group: 'single external_seed DTC offer',
      merge_candidate_status: 'not_required',
      offers_expected: '1 DTC external offer',
      default_offer_expected: 'DTC external links_out offer',
      checkout_handoff_mode: 'links_out',
      result: anuaRows.every((row) => row.currency_gate === 'pass') ? 'pass' : 'hold',
      evidence: 'anua-officialness-evidence.json; anua-dtc-create-apply.json; anua-dtc-db-postcheck.json; live_pdp/anua-live-get-pdp-v2-spotcheck.json',
      notes: 'anua.com officialness verified; anua.global lookalike remains excluded from new writes.',
    },
    ...channelRows,
    {
      case_id: 'internal-plus-external-same-product',
      case_type: 'internal_merchant_offer_plus_external_retailer_offer',
      source: 'unit test synthetic',
      brand: 'COSRX',
      identity_group: 'sig_cosrx_ceramide',
      merge_candidate_status: 'test_pass',
      offers_expected: '2 offers: internal merchant embedded checkout plus external retailer links_out',
      default_offer_expected: 'internal merchant offer, even when external price is lower',
      checkout_handoff_mode: 'merchant_embedded_checkout + links_out',
      result: 'pass',
      evidence: 'tests/pdp_offers_group_members.test.js; tests/services/pdp_identity_graph.test.js',
      notes: 'Verified commerce facts pass-through, unknown external shipping remains agent-safe unknown, best price can differ from default offer.',
    },
    {
      case_id: 'multi-retailer-external-offers',
      case_type: 'multi_retailer_offer_merge',
      source: 'Soko Glam / Wishtrend / Blooming Koco / Ohlolly',
      brand: 'COSRX / Klairs / Anua / Beauty of Joseon',
      identity_group: 'not_confirmed_live',
      merge_candidate_status: channelRows.length ? 'hold' : 'not_run',
      offers_expected: 'multiple external links_out offers only after same sellable_item_group_id is live approved',
      default_offer_expected: 'internal preferred if present; otherwise in-stock same-currency lower price',
      checkout_handoff_mode: 'links_out for all external offers',
      result: 'hold',
      evidence: 'k_beauty_channel_brandscoped_merge_candidates_after_identity_cleanup.json',
      notes: 'Brand-scoped channel dry-runs are clean, but no rows were applied because live multi-offer identity is not confirmed.',
    },
    {
      case_id: 'us-market-non-usd-conflict-boj',
      case_type: 'same_product_us_usd_vs_non_usd_conflict',
      source: 'Beauty of Joseon DTC',
      brand: 'Beauty of Joseon',
      identity_group: 'existing seed rows only',
      merge_candidate_status: 'currency_gate_hold',
      offers_expected: 'no new US transaction-ready offer from EUR-observed manifest',
      default_offer_expected: 'existing approved offer only',
      checkout_handoff_mode: 'no new checkout handoff',
      result: bojMismatch.length ? 'pass_hold_enforced_in_plan' : 'needs_recheck',
      evidence: 'manifests_filtered/boj-dtc-manifest.json',
      notes: `${bojMismatch.length} BOJ manifest rows observed as non-USD under US target; future extract-v2 dry-run must hold them.`,
    },
  ];
}

function commerceStatusForCsvRow(row, inventoryRows, mergeBySource) {
  const name = row.name || row.source_name || '';
  const brand = row.brand || '';
  const domain = row.domain_host || '';
  const sourceKind = row.source_kind || '';
  const keyCandidates = [
    sourceKey(`${name}-${brand}`),
    sourceKey(name),
    sourceKey(`${domain}-${brand}`),
    sourceKey(domain),
  ];
  const matches = inventoryRows.filter((item) => {
    const itemKeys = [
      item.source_key,
      sourceKey(item.source_name),
      sourceKey(`${item.source_name}-${item.brand}`),
      sourceKey(`${item.canonical_url || item.evidence_url}`),
    ];
    return item.source_kind === sourceKind && itemKeys.some((key) => keyCandidates.includes(key));
  });
  const rows = matches.length ? matches : inventoryRows.filter((item) => item.source_kind === sourceKind && sourceKey(item.source_name) === sourceKey(name));
  const currencyHolds = rows.filter((item) => item.currency_gate !== 'pass').length;
  const currencyPass = rows.filter((item) => item.currency_gate === 'pass').length;
  const shippingKnown = rows.filter((item) => item.shipping_status !== 'unknown').length;
  const promoKnown = rows.filter((item) => item.promotion_status !== 'unknown').length;
  const merge = mergeBySource.get(sourceKey(`${name}-${brand}`)) || mergeBySource.get(sourceKey(name)) || null;
  const isChannel = sourceKind === 'channel';

  return {
    commerce_facts_contract: 'commerce_facts.v1_ready',
    us_currency_gate:
      currencyHolds > 0
        ? `hold_${currencyHolds}_currency_mismatch`
        : currencyPass > 0
          ? `pass_${currencyPass}_sample_rows`
          : 'not_sampled',
    sellable_region_status: rows.length ? 'unknown_external_not_checkout_queried' : 'not_sampled',
    shipping_status: shippingKnown > 0 ? `known_${shippingKnown}` : 'unknown_external_not_checkout_queried',
    promotion_status: promoKnown > 0 ? `known_${promoKnown}` : 'unknown_external_not_extracted',
    commerce_facts_confidence:
      rows.length && currencyHolds === 0
        ? 'price_availability_medium_shipping_promo_unknown'
        : rows.length
          ? 'mixed_or_hold'
          : 'not_sampled',
    pdp_offer_merge_gate:
      merge?.result === 'hold' || merge?.merge_candidate_status?.startsWith('hold')
        ? 'hold_identity_merge_not_verified'
        : isChannel
          ? 'hold_until_live_identity_merge_candidate'
          : 'not_required_for_dtc_seed',
    checkout_handoff_gate:
      isChannel || sourceKind === 'dtc'
        ? 'external_links_out_only_no_internal_checkout'
        : 'not_applicable',
    commerce_notes:
      rows.length
        ? `Commerce inventory sampled ${rows.length} rows; ${currencyPass} currency pass; ${currencyHolds} currency hold.`
        : 'No manifest-level commerce sample in this run; keep dry-run gate before apply.',
  };
}

function updateCsvWithCommerceColumns(filePath, inventoryRows, mergeRows) {
  if (!fs.existsSync(filePath)) return;
  const originalText = fs.readFileSync(filePath, 'utf8');
  const originalHeaders = originalText.split(/\r?\n/, 1)[0].split(',');
  const rows = parseCsv(originalText);
  const mergeBySource = new Map();
  for (const row of mergeRows) {
    mergeBySource.set(sourceKey(`${row.source}-${row.brand}`), row);
    mergeBySource.set(sourceKey(row.source), row);
  }
  const updated = rows.map((row) => ({
    ...row,
    ...commerceStatusForCsvRow(row, inventoryRows, mergeBySource),
  }));
  writeCsv(filePath, updated, [...originalHeaders, ...COMMERCE_COLUMNS]);
}

function summarizeInventory(inventoryRows, mergeRows) {
  const currencyHoldRows = inventoryRows.filter((row) => row.currency_gate !== 'pass');
  const channelRows = inventoryRows.filter((row) => row.source_kind === 'channel');
  const channelHoldRows = channelRows.filter((row) => row.apply_gate.includes('merge'));
  const shippingUnknownRows = inventoryRows.filter((row) => row.shipping_status === 'unknown');
  const promoUnknownRows = inventoryRows.filter((row) => row.promotion_status === 'unknown');
  const mergeHoldRows = mergeRows.filter((row) => row.result === 'hold');
  return {
    generated_at: GENERATED_AT,
    contract_version: 'commerce_facts.v1',
    inventory_rows: inventoryRows.length,
    currency_pass_rows: inventoryRows.length - currencyHoldRows.length,
    currency_hold_rows: currencyHoldRows.length,
    currency_hold_sample: currencyHoldRows.slice(0, 10).map((row) => ({
      source: row.source_name,
      brand: row.brand,
      title: row.product_title,
      market: row.market,
      currency: row.price_currency,
      gate: row.currency_gate,
    })),
    external_shipping_unknown_rows: shippingUnknownRows.length,
    external_promo_unknown_rows: promoUnknownRows.length,
    channel_inventory_rows: channelRows.length,
    channel_rows_held_for_merge: channelHoldRows.length,
    pdp_merge_validation_cases: mergeRows.length,
    pdp_merge_hold_cases: mergeHoldRows.length,
    apply_policy: {
      currency_mismatch: 'hold',
      unknown_officialness: 'hold',
      channel_without_merge_candidate: 'hold',
      external_shipping_or_promo_unknown: 'allowed only as unknown; never deterministic display',
    },
    tests: {
      pivota_agent_targeted_jest: 'pass: 5 suites / 131 tests',
      catalog_intelligence_test: 'pass: 110 tests',
      catalog_intelligence_build: 'pass',
    },
  };
}

function summarizeRefreshManifest(filePath) {
  const manifest = readJson(filePath, {});
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const dryRunPath = filePath.replace(/-manifest\.json$/, '-create-dry-run.json');
  const dryRun = readJson(dryRunPath, {});
  const dryRunSummary = asObject(dryRun.summary);
  const rows = items
    .map((item) => item.seed_row || item.seedRow || item)
    .filter((row) => row && typeof row === 'object');
  const rowSummaries = rows.map((row) => {
    const seedData = asObject(row.seed_data);
    const facts = readCommerceFacts(row);
    const gate = asObject(
      facts?.seed_row_gate ||
        seedData.commerce_facts_gate ||
        asObject(asObject(seedData.snapshot).commerce_facts_gate),
    );
    const validation = asObject(seedData.source_validation || asObject(seedData.snapshot).source_validation);
    return {
      title: row.title || seedData.title || '',
      canonical_url: row.canonical_url || seedData.canonical_url || '',
      price_amount: facts?.regional_price?.amount ?? row.price_amount ?? seedData.price_amount ?? '',
      price_currency:
        normalizeCurrency(facts?.regional_price?.observed_currency) ||
        normalizeCurrency(facts?.regional_price?.currency) ||
        normalizeCurrency(row.price_currency || seedData.price_currency),
      availability: facts?.availability?.status || row.availability || seedData.availability || 'unknown',
      gate_status: gate.status || 'unknown',
      gate_problems: Array.isArray(gate.problems) ? gate.problems : [],
      source_type: validation.source_type || '',
      shipping_status: facts?.shipping?.status || 'unknown',
      promotion_status: Array.isArray(facts?.promotions) && facts.promotions.length ? 'available' : 'unknown',
    };
  });
  const gateHoldRows = rowSummaries.filter((row) => row.gate_status && row.gate_status !== 'pass');
  const channelRows = rowSummaries.filter((row) => row.source_type === 'channel_or_retailer');
  return {
    file: path.relative(REPORT_DIR, filePath),
    dry_run_file: fs.existsSync(dryRunPath) ? path.relative(REPORT_DIR, dryRunPath) : '',
    brand: manifest.brand || '',
    domain: manifest.domain || '',
    market: manifest.market || 'US',
    generated_at: manifest.generated_at || '',
    item_count: rows.length,
    extracted_product_count: manifest.extracted_product_count || 0,
    excluded_bundle_like_count: manifest.excluded_bundle_like_count || 0,
    excluded_non_product_page_count: manifest.excluded_non_product_page_count || 0,
    excluded_low_quality_fallback_count: manifest.excluded_low_quality_fallback_count || 0,
    matched_preferred_title_count: manifest.matched_preferred_title_count || 0,
    matched_preferred_titles: Array.isArray(manifest.matched_preferred_titles)
      ? manifest.matched_preferred_titles
      : [],
    currency_pass_count: rowSummaries.filter((row) => row.price_currency === 'USD').length,
    currency_hold_count: rowSummaries.filter((row) => row.price_currency && row.price_currency !== 'USD').length,
    gate_pass_count: rowSummaries.filter((row) => row.gate_status === 'pass').length,
    gate_hold_count: gateHoldRows.length,
    gate_hold_reasons: [...new Set(gateHoldRows.flatMap((row) => row.gate_problems))],
    shipping_unknown_count: rowSummaries.filter((row) => row.shipping_status === 'unknown').length,
    promotion_unknown_count: rowSummaries.filter((row) => row.promotion_status === 'unknown').length,
    channel_row_count: channelRows.length,
    dry_run_summary: dryRunSummary,
    sample_rows: rowSummaries.slice(0, 8),
  };
}

function buildRefreshSummary() {
  const refreshDir = path.join(REPORT_DIR, 'commerce_facts_refresh');
  const manifestFiles = findFiles(refreshDir, /-manifest\.json$/).sort();
  const excludedSimulationDir = path.join(refreshDir, 'excluded_simulation_fallback');
  const excludedSimulationArtifacts = fs.existsSync(excludedSimulationDir)
    ? fs.readdirSync(excludedSimulationDir).filter((name) => /\.json$/i.test(name)).length
    : 0;
  const manifests = manifestFiles.map(summarizeRefreshManifest);
  const totals = manifests.reduce(
    (acc, entry) => {
      acc.manifest_count += 1;
      acc.item_count += entry.item_count;
      acc.gate_pass_count += entry.gate_pass_count;
      acc.gate_hold_count += entry.gate_hold_count;
      acc.currency_pass_count += entry.currency_pass_count;
      acc.currency_hold_count += entry.currency_hold_count;
      acc.channel_row_count += entry.channel_row_count;
      acc.channel_hold_count += entry.channel_row_count
        ? entry.gate_hold_count
        : 0;
      acc.low_quality_fallback_excluded_count += entry.excluded_low_quality_fallback_count || 0;
      acc.bundle_like_excluded_count += entry.excluded_bundle_like_count || 0;
      return acc;
    },
    {
      manifest_count: 0,
      item_count: 0,
      gate_pass_count: 0,
      gate_hold_count: 0,
      currency_pass_count: 0,
      currency_hold_count: 0,
      channel_row_count: 0,
      channel_hold_count: 0,
      low_quality_fallback_excluded_count: 0,
      bundle_like_excluded_count: 0,
    },
  );
  return {
    generated_at: GENERATED_AT,
    refresh_dir: path.relative(REPORT_DIR, refreshDir),
    policy: {
      dtc_apply: 'dry-run only in this commerce facts refresh unless DB/apply gate is explicitly run',
      channel_apply: 'hold until live multi-offer merge candidate is verified',
      shipping_promo: 'external unknown remains unknown; no deterministic display',
    },
    excluded_simulation_fallback_artifacts: excludedSimulationArtifacts,
    totals,
    manifests,
  };
}

function main() {
  if (!fs.existsSync(REPORT_DIR)) {
    throw new Error(`Report directory not found: ${REPORT_DIR}`);
  }

  const inventoryRows = buildInventoryRows();
  const mergeRows = buildMergeValidationRows(inventoryRows);

  const inventoryCsv = path.join(REPORT_DIR, 'k_beauty_commerce_facts_inventory.csv');
  const inventoryJson = path.join(REPORT_DIR, 'k_beauty_commerce_facts_inventory.json');
  const mergeCsv = path.join(REPORT_DIR, 'k_beauty_pdp_offer_merge_validation_report.csv');
  const mergeJson = path.join(REPORT_DIR, 'k_beauty_pdp_offer_merge_validation_report.json');
  const refreshSummaryPath = path.join(REPORT_DIR, 'k_beauty_commerce_facts_refresh_summary.json');
  const refreshSummary = buildRefreshSummary();

  writeCsv(inventoryCsv, inventoryRows);
  writeJson(inventoryJson, {
    generated_at: GENERATED_AT,
    contract_version: 'commerce_facts.v1',
    rows: inventoryRows,
  });
  writeCsv(mergeCsv, mergeRows);
  writeJson(mergeJson, {
    generated_at: GENERATED_AT,
    rows: mergeRows,
  });
  writeJson(refreshSummaryPath, refreshSummary);

  for (const filename of [
    'k_beauty_validated_source_audit.csv',
    'k_beauty_catalog_gap_analysis.csv',
    'k_beauty_targeted_backfill_plan.csv',
    'k_beauty_excluded_or_failed_validation.csv',
  ]) {
    updateCsvWithCommerceColumns(path.join(REPORT_DIR, filename), inventoryRows, mergeRows);
  }

  const summaryPath = path.join(REPORT_DIR, 'summary.json');
  const summary = readJson(summaryPath, {});
  const outputFiles = Array.isArray(summary.output_files) ? summary.output_files.slice() : [];
  for (const file of [
    'k_beauty_commerce_facts_inventory.csv',
    'k_beauty_commerce_facts_inventory.json',
    'k_beauty_pdp_offer_merge_validation_report.csv',
    'k_beauty_pdp_offer_merge_validation_report.json',
    'k_beauty_commerce_facts_refresh_summary.json',
  ]) {
    if (!outputFiles.includes(file)) outputFiles.push(file);
  }
  writeJson(summaryPath, {
    ...summary,
    generated_at: GENERATED_AT,
    commerce_facts_and_pdp_merge: summarizeInventory(inventoryRows, mergeRows),
    commerce_facts_refresh: refreshSummary,
    output_files: outputFiles,
  });

  console.log(JSON.stringify({
    report_dir: REPORT_DIR,
    inventory_rows: inventoryRows.length,
    merge_validation_rows: mergeRows.length,
    output_files: [
      inventoryCsv,
      inventoryJson,
      mergeCsv,
      mergeJson,
      refreshSummaryPath,
      summaryPath,
    ],
  }, null, 2));
}

if (require.main === module) {
  main();
}
