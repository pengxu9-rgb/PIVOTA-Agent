const path = require('node:path');

const DEFAULT_CONTRACT_VERSION = 'external_seed.locality_facts.v1';
const DEFAULT_BRAND_SEED_PATH = path.join(__dirname, '../../data/beauty/brand_locality_facts_seed.json');

let cachedDefaultBrandSeed = null;

const MARKET_ALIASES = new Map([
  ['KOREA', 'KR'],
  ['SOUTH KOREA', 'KR'],
  ['REPUBLIC OF KOREA', 'KR'],
  ['SEOUL', 'KR'],
  ['UNITED STATES', 'US'],
  ['UNITED STATES OF AMERICA', 'US'],
  ['USA', 'US'],
  ['U.S.', 'US'],
  ['US', 'US'],
  ['JAPAN', 'JP'],
  ['TOKYO', 'JP'],
  ['CHINA', 'CN'],
  ['SHANGHAI', 'CN'],
  ['FRANCE', 'FR'],
  ['UNITED KINGDOM', 'GB'],
  ['UK', 'GB'],
  ['SINGAPORE', 'SG'],
  ['THAILAND', 'TH'],
]);

const RETAIL_CHANNEL_PATTERNS = [
  ['olive_young', /\boliveyoung\b|oliveyoung\./i, 'KR'],
  ['beauty_box_korea', /\bbeautyboxkorea\b/i, 'KR'],
  ['stylekorean', /\bstylekorean\b/i, 'KR'],
  ['soko_glam', /\bsokoglam\b/i, 'US'],
  ['yesstyle', /\byesstyle\b/i, null],
  ['sephora', /\bsephora\b/i, null],
  ['ulta', /\bulta\b/i, 'US'],
  ['amazon', /\bamazon\./i, null],
  ['target', /\btarget\./i, 'US'],
  ['walmart', /\bwalmart\./i, 'US'],
  ['official_site', /\b(?:official|brand)\s+(?:site|store)\b/i, null],
];

const EXPLICIT_TRAVEL_SIZE_RE =
  /\b(travel[-\s]?size|travel[-\s]?friendly\s+size|mini(?:\s+size)?|deluxe\s+mini|trial[-\s]?size|sample[-\s]?size|pocket[-\s]?size)\b/i;
const EXPLICIT_FULL_SIZE_RE = /\b(full[-\s]?size|value\s+size|jumbo|refill)\b/i;
const OUT_OF_STOCK_RE = /\b(out\s+of\s+stock|sold\s+out|unavailable|not\s+available|discontinued)\b/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value, maxLen = 240) {
  if (value == null) return '';
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.slice(0, maxLen);
}

function normalizeKey(value) {
  return normalizeString(value, 160)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeMarket(value) {
  const raw = normalizeString(value, 80);
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return MARKET_ALIASES.get(upper) || '';
}

function uniqStrings(values, max = 24) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeString(value, 120);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function uniqMarkets(values, max = 16) {
  return uniqStrings(values.map(normalizeMarket).filter(Boolean), max);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = normalizeString(value);
    if (text) return text;
  }
  return '';
}

function isExplicitlyOutOfStock(value) {
  return OUT_OF_STOCK_RE.test(normalizeString(value, 120));
}

function loadDefaultBrandLocalitySeed() {
  if (!cachedDefaultBrandSeed) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    cachedDefaultBrandSeed = require(DEFAULT_BRAND_SEED_PATH);
  }
  return cachedDefaultBrandSeed;
}

function buildBrandLocalityIndex(seed = loadDefaultBrandLocalitySeed()) {
  const rows = Array.isArray(seed?.brands) ? seed.brands : [];
  const byAlias = new Map();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const aliases = [row.brand, ...(Array.isArray(row.aliases) ? row.aliases : [])];
    for (const alias of aliases) {
      const key = normalizeKey(alias);
      if (key && !byAlias.has(key)) byAlias.set(key, row);
    }
  }
  return byAlias;
}

function lookupBrandLocalityFacts(brand, seed = loadDefaultBrandLocalitySeed()) {
  const key = normalizeKey(brand);
  if (!key) return null;
  return buildBrandLocalityIndex(seed).get(key) || null;
}

function readExistingFacts(seedData = {}, snapshot = {}) {
  const rootFacts = isPlainObject(seedData.locality_facts_v1)
    ? seedData.locality_facts_v1
    : isPlainObject(seedData.locality_facts)
      ? seedData.locality_facts
      : {};
  const snapshotFacts = isPlainObject(snapshot.locality_facts_v1)
    ? snapshot.locality_facts_v1
    : isPlainObject(snapshot.locality_facts)
      ? snapshot.locality_facts
      : {};
  return { rootFacts, snapshotFacts };
}

function normalizeRetailChannel(value, fallbackMarket = '') {
  if (!value) return null;
  if (typeof value === 'string') {
    const channel = normalizeString(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!channel) return null;
    return {
      channel,
      market: normalizeMarket(fallbackMarket) || null,
      source: 'existing',
    };
  }
  if (!isPlainObject(value)) return null;
  const channel = normalizeString(value.channel || value.name || value.retailer || value.store, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!channel) return null;
  return {
    channel,
    market: normalizeMarket(value.market || value.country || value.region || fallbackMarket) || null,
    source: normalizeString(value.source || 'existing', 80),
    ...(value.url ? { url: normalizeString(value.url, 500) } : {}),
    ...(value.confidence ? { confidence: normalizeString(value.confidence, 40) } : {}),
  };
}

function normalizeRetailChannels(values, fallbackMarket = '') {
  const source = Array.isArray(values) ? values : values ? [values] : [];
  const out = [];
  const seen = new Set();
  for (const value of source) {
    const row = normalizeRetailChannel(value, fallbackMarket);
    if (!row) continue;
    const key = `${row.channel}::${row.market || ''}::${row.url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= 12) break;
  }
  return out;
}

function inferRetailChannelFromUrl({ url, domain, market } = {}) {
  const text = [url, domain].map((value) => normalizeString(value, 500)).filter(Boolean).join(' ');
  if (!text) return null;
  for (const [channel, pattern, defaultMarket] of RETAIL_CHANNEL_PATTERNS) {
    if (!pattern.test(text)) continue;
    return {
      channel,
      market: normalizeMarket(market) || normalizeMarket(defaultMarket) || null,
      source: 'url_domain_pattern',
    };
  }
  return null;
}

function collectSizeEvidence(row = {}, seedData = {}, snapshot = {}) {
  const variants = [
    ...(Array.isArray(seedData.variants) ? seedData.variants : []),
    ...(Array.isArray(snapshot.variants) ? snapshot.variants : []),
    ...(Array.isArray(seedData.skus) ? seedData.skus : []),
    ...(Array.isArray(snapshot.skus) ? snapshot.skus : []),
  ];
  return [
    row.title,
    seedData.title,
    snapshot.title,
    seedData.size,
    snapshot.size,
    seedData.volume,
    snapshot.volume,
    seedData.product_size,
    snapshot.product_size,
    seedData.product_volume,
    snapshot.product_volume,
    seedData.net_content,
    snapshot.net_content,
    seedData.net_size,
    snapshot.net_size,
    ...variants.flatMap((variant) => [
      variant?.title,
      variant?.name,
      variant?.option_name,
      variant?.option_value,
      variant?.size,
      variant?.volume,
    ]),
  ].map((value) => normalizeString(value, 160)).filter(Boolean);
}

function inferTravelSize(row = {}, seedData = {}, snapshot = {}) {
  const explicit = [
    seedData.travel_size,
    seedData.travelSize,
    snapshot.travel_size,
    snapshot.travelSize,
  ];
  for (const value of explicit) {
    if (typeof value === 'boolean') {
      return {
        value,
        source: 'existing_field',
        evidence: value ? 'existing travel_size=true' : 'existing travel_size=false',
      };
    }
  }
  const evidence = collectSizeEvidence(row, seedData, snapshot);
  const travelHit = evidence.find((item) => EXPLICIT_TRAVEL_SIZE_RE.test(item));
  if (travelHit) return { value: true, source: 'explicit_text', evidence: travelHit };
  const fullSizeHit = evidence.find((item) => EXPLICIT_FULL_SIZE_RE.test(item));
  if (fullSizeHit) return { value: false, source: 'explicit_text', evidence: fullSizeHit };
  return { value: null, source: 'unknown', evidence: '' };
}

function resolveExternalSeedLocalityFacts({ row = {}, seedData = {}, snapshot = {}, brandSeed } = {}) {
  const safeSeedData = isPlainObject(seedData) ? seedData : {};
  const safeSnapshot = isPlainObject(snapshot) ? snapshot : {};
  const existing = readExistingFacts(safeSeedData, safeSnapshot);
  const brand = firstNonEmptyString(
    safeSeedData.brand,
    safeSeedData.brand_name,
    safeSnapshot.brand,
    safeSnapshot.brand_name,
    row.seed_brand,
    row.brand,
  );
  const brandFacts = lookupBrandLocalityFacts(brand, brandSeed) || {};
  const rowMarket = normalizeMarket(row.market || safeSeedData.market || safeSnapshot.market);
  const existingBrandOrigin = firstNonEmptyString(
    existing.rootFacts.brand_origin?.country,
    existing.snapshotFacts.brand_origin?.country,
    safeSeedData.brand_origin?.country,
    safeSnapshot.brand_origin?.country,
    existing.rootFacts.brand_origin_country,
    existing.snapshotFacts.brand_origin_country,
    safeSeedData.brand_origin_country,
    safeSnapshot.brand_origin_country,
  );
  const existingHomeMarket = firstNonEmptyString(
    existing.rootFacts.brand_origin?.home_market,
    existing.snapshotFacts.brand_origin?.home_market,
    safeSeedData.brand_origin?.home_market,
    safeSnapshot.brand_origin?.home_market,
    existing.rootFacts.brand_home_market,
    existing.snapshotFacts.brand_home_market,
    safeSeedData.brand_home_market,
    safeSnapshot.brand_home_market,
  );
  const brandOriginCountry = normalizeMarket(existingBrandOrigin) || normalizeMarket(brandFacts.brand_origin_country) || null;
  const brandHomeMarket = normalizeMarket(existingHomeMarket) || normalizeMarket(brandFacts.brand_home_market) || brandOriginCountry || null;

  const inferredChannel = inferRetailChannelFromUrl({
    url: row.destination_url || safeSnapshot.destination_url || row.canonical_url || safeSnapshot.canonical_url,
    domain: row.domain,
    market: rowMarket,
  });
  const localRetailChannels = normalizeRetailChannels([
    existing.rootFacts.local_retail_channels,
    existing.rootFacts.local_retail_channel,
    existing.snapshotFacts.local_retail_channels,
    existing.snapshotFacts.local_retail_channel,
    safeSeedData.local_retail_channels,
    safeSeedData.local_retail_channel,
    safeSnapshot.local_retail_channels,
    safeSnapshot.local_retail_channel,
    ...(Array.isArray(brandFacts.local_retail_channels) ? brandFacts.local_retail_channels : []),
    inferredChannel,
  ].flat().filter(Boolean), rowMarket);
  const availabilityStatus = firstNonEmptyString(
    row.availability,
    safeSeedData.availability,
    safeSnapshot.availability,
  ) || null;
  const purchasableByAvailability = !isExplicitlyOutOfStock(availabilityStatus);

  const availableMarkets = uniqMarkets([
    ...(Array.isArray(existing.rootFacts.available_markets) ? existing.rootFacts.available_markets : []),
    ...(Array.isArray(existing.snapshotFacts.available_markets) ? existing.snapshotFacts.available_markets : []),
    ...(Array.isArray(existing.rootFacts.market_availability?.available_markets) ? existing.rootFacts.market_availability.available_markets : []),
    ...(Array.isArray(existing.snapshotFacts.market_availability?.available_markets) ? existing.snapshotFacts.market_availability.available_markets : []),
    ...(Array.isArray(safeSeedData.market_availability?.available_markets) ? safeSeedData.market_availability.available_markets : []),
    ...(Array.isArray(safeSnapshot.market_availability?.available_markets) ? safeSnapshot.market_availability.available_markets : []),
    ...(Array.isArray(safeSeedData.available_markets) ? safeSeedData.available_markets : []),
    ...(Array.isArray(safeSnapshot.available_markets) ? safeSnapshot.available_markets : []),
    rowMarket,
    ...localRetailChannels.map((channel) => channel.market),
  ]);
  const existingLocalMarkets = uniqMarkets([
    ...(Array.isArray(existing.rootFacts.local_purchase_markets) ? existing.rootFacts.local_purchase_markets : []),
    ...(Array.isArray(existing.snapshotFacts.local_purchase_markets) ? existing.snapshotFacts.local_purchase_markets : []),
    ...(Array.isArray(existing.rootFacts.market_availability?.local_purchase_markets) ? existing.rootFacts.market_availability.local_purchase_markets : []),
    ...(Array.isArray(existing.snapshotFacts.market_availability?.local_purchase_markets) ? existing.snapshotFacts.market_availability.local_purchase_markets : []),
    ...(Array.isArray(safeSeedData.market_availability?.local_purchase_markets) ? safeSeedData.market_availability.local_purchase_markets : []),
    ...(Array.isArray(safeSnapshot.market_availability?.local_purchase_markets) ? safeSnapshot.market_availability.local_purchase_markets : []),
    ...(Array.isArray(safeSeedData.local_purchase_markets) ? safeSeedData.local_purchase_markets : []),
    ...(Array.isArray(safeSnapshot.local_purchase_markets) ? safeSnapshot.local_purchase_markets : []),
  ]);
  const localPurchaseMarkets = uniqMarkets([
    ...existingLocalMarkets,
    ...(rowMarket && purchasableByAvailability ? [rowMarket] : []),
    ...(purchasableByAvailability ? localRetailChannels.map((channel) => channel.market) : []),
  ]);
  const travelSize = inferTravelSize(row, safeSeedData, safeSnapshot);
  const localAuthorityLevel =
    localPurchaseMarkets.length > 0
      ? 'product_market'
      : brandHomeMarket
        ? 'brand_home_market_only'
        : 'unknown';
  const creatorLocalReason = firstNonEmptyString(
    existing.rootFacts.creator_local_reason,
    existing.snapshotFacts.creator_local_reason,
    safeSeedData.creator_local_reason,
    safeSnapshot.creator_local_reason,
    localAuthorityLevel === 'product_market' && brandHomeMarket && localPurchaseMarkets.includes(brandHomeMarket)
      ? `${brand || 'Brand'} has ${brandHomeMarket} home-market/catalog retail evidence for this seed.`
      : '',
  ) || null;

  const facts = {
    contract_version: DEFAULT_CONTRACT_VERSION,
    brand: brand || null,
    brand_origin: {
      country: brandOriginCountry,
      home_market: brandHomeMarket,
      source: brandFacts.brand ? 'brand_seed_map' : existingBrandOrigin || existingHomeMarket ? 'existing_seed_data' : null,
    },
    brand_origin_country: brandOriginCountry,
    brand_home_market: brandHomeMarket,
    market_availability: {
      available_markets: availableMarkets,
      local_purchase_markets: localPurchaseMarkets,
      source_market: rowMarket || null,
      retail_channel_markets: uniqMarkets(localRetailChannels.map((channel) => channel.market)),
      availability_status: availabilityStatus,
    },
    available_markets: availableMarkets,
    local_purchase_markets: localPurchaseMarkets,
    local_retail_channels: localRetailChannels,
    travel_size: travelSize.value,
    travel_size_evidence: travelSize.evidence || null,
    creator_local_reason: creatorLocalReason,
    local_authority_level: localAuthorityLevel,
    sources: uniqStrings([
      Object.keys(existing.rootFacts).length || Object.keys(existing.snapshotFacts).length ? 'existing_seed_data' : null,
      brandFacts.brand ? 'brand_seed_map' : null,
      rowMarket ? 'seed_row_market' : null,
      inferredChannel ? 'url_domain_pattern' : null,
      travelSize.source !== 'unknown' ? `travel_size_${travelSize.source}` : null,
    ].filter(Boolean), 8),
  };
  return facts;
}

function hasLocalityFactsValue(facts) {
  if (!isPlainObject(facts)) return false;
  return Boolean(
    facts.brand_origin_country ||
      facts.brand_home_market ||
      (Array.isArray(facts.available_markets) && facts.available_markets.length) ||
      (Array.isArray(facts.local_purchase_markets) && facts.local_purchase_markets.length) ||
      (Array.isArray(facts.local_retail_channels) && facts.local_retail_channels.length) ||
      typeof facts.travel_size === 'boolean' ||
      facts.creator_local_reason,
  );
}

function applyLocalityFactsToSeedData(seedData = {}, facts = {}) {
  const next = cloneJsonValue(isPlainObject(seedData) ? seedData : {});
  const snapshot = cloneJsonValue(isPlainObject(next.snapshot) ? next.snapshot : {});
  const safeFacts = cloneJsonValue(facts);
  if (!hasLocalityFactsValue(safeFacts)) {
    next.snapshot = snapshot;
    return next;
  }
  const retailChannels = Array.isArray(safeFacts.local_retail_channels) ? safeFacts.local_retail_channels : [];
  const localRetailChannel = retailChannels.map((channel) => channel.channel).filter(Boolean);
  const convenience = {
    ...(safeFacts.brand_origin ? { brand_origin: safeFacts.brand_origin } : {}),
    ...(safeFacts.brand_origin_country ? { brand_origin_country: safeFacts.brand_origin_country } : {}),
    ...(safeFacts.brand_home_market ? { brand_home_market: safeFacts.brand_home_market } : {}),
    ...(safeFacts.market_availability ? { market_availability: safeFacts.market_availability } : {}),
    ...(safeFacts.available_markets?.length ? { available_markets: safeFacts.available_markets } : {}),
    ...(safeFacts.local_purchase_markets?.length ? { local_purchase_markets: safeFacts.local_purchase_markets } : {}),
    ...(retailChannels.length ? { local_retail_channels: retailChannels } : {}),
    ...(localRetailChannel.length ? { local_retail_channel: localRetailChannel } : {}),
    ...(typeof safeFacts.travel_size === 'boolean' ? { travel_size: safeFacts.travel_size } : {}),
    ...(safeFacts.creator_local_reason ? { creator_local_reason: safeFacts.creator_local_reason } : {}),
  };
  Object.assign(next, convenience, { locality_facts_v1: safeFacts });
  Object.assign(snapshot, convenience, { locality_facts_v1: safeFacts });
  next.snapshot = snapshot;
  return next;
}

function buildLocalityRecallTokens(facts = {}) {
  if (!hasLocalityFactsValue(facts)) return [];
  const channels = Array.isArray(facts.local_retail_channels) ? facts.local_retail_channels : [];
  return uniqStrings([
    facts.brand_origin_country ? `brand origin ${facts.brand_origin_country}` : null,
    facts.brand_home_market ? `brand home market ${facts.brand_home_market}` : null,
    ...((Array.isArray(facts.available_markets) ? facts.available_markets : []).map((market) => `available market ${market}`)),
    ...((Array.isArray(facts.local_purchase_markets) ? facts.local_purchase_markets : []).map((market) => `local purchase ${market}`)),
    ...channels.map((channel) => `${channel.channel} ${channel.market || ''}`.trim()),
    typeof facts.travel_size === 'boolean' ? `travel size ${facts.travel_size ? 'yes' : 'no'}` : null,
  ].filter(Boolean), 24);
}

module.exports = {
  DEFAULT_CONTRACT_VERSION,
  normalizeMarket,
  lookupBrandLocalityFacts,
  buildBrandLocalityIndex,
  resolveExternalSeedLocalityFacts,
  applyLocalityFactsToSeedData,
  buildLocalityRecallTokens,
  hasLocalityFactsValue,
  inferTravelSize,
  isExplicitlyOutOfStock,
  loadDefaultBrandLocalitySeed,
};
