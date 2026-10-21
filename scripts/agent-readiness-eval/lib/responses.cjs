'use strict';

// Reading what a tool answered — the way a partner's client has to: from the wire, not from our internals.
//
// Two doors answer the same tools in two shapes:
//   * commerce /mcp      -> result.content[0].text is JSON of the sanitized internal envelope
//                           (search: { status, success, products:[~40 fields], total, metadata:{…} }).
//   * public /public/mcp -> result.structuredContent is the slim projection
//                           (search: { products:[{product_id, brand, title, category, price:{amount,currency},
//                           availability, key_actives, pivota_url}], returned, total, empty_reason, note }).
// Both are normalized here onto one product shape so every scorer reads one thing.
//
// A "failed" envelope can still carry hits (status != success but products non-empty): a partner that reads
// only the status throws good rows away, one that reads only the rows serves a degraded answer as healthy.
// Both facts are kept: `degraded` AND the products.

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function finiteNum(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The tool-level payload of a tools/call record.
 * @returns {{ isError: boolean, value: any, text: string|null, errorCode: string|null, errorMessage: string|null, retriable: boolean|null }}
 */
function toolPayload(record) {
  const result = record && record.rpc && isObj(record.rpc.result) ? record.rpc.result : null;
  if (!result) return { isError: false, value: null, text: null, errorCode: null, errorMessage: null, retriable: null };
  const text = arr(result.content)
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n') || null;
  let value = result.structuredContent !== undefined ? result.structuredContent : undefined;
  if (value === undefined && text != null) {
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
  }
  const isError = result.isError === true;
  let errorCode = null;
  let errorMessage = null;
  let retriable = null;
  if (isError) {
    const err = isObj(value) && isObj(value.error) ? value.error : null;
    errorCode = err && str(err.code) ? err.code : 'UNSPECIFIED_TOOL_ERROR';
    errorMessage = err && str(err.message) ? err.message.slice(0, 200) : null;
    retriable = err && typeof err.retriable === 'boolean' ? err.retriable : null;
  }
  return { isError, value: value === undefined ? null : value, text, errorCode, errorMessage, retriable };
}

// ---- currency / price -------------------------------------------------------------------------------------

const MARKET_CURRENCY = Object.freeze({
  US: 'USD',
  SG: 'SGD',
  GB: 'GBP',
  JP: 'JPY',
  KR: 'KRW',
  AU: 'AUD',
  CA: 'CAD',
  FR: 'EUR',
  DE: 'EUR',
  ES: 'EUR',
  HK: 'HKD',
  TW: 'TWD',
  CN: 'CNY',
});

function currencyForMarket(market) {
  return market ? MARKET_CURRENCY[String(market).toUpperCase()] || null : null;
}

/** Lenient price read: returns { amount, currency, currencyValid } or null when no amount is stated. */
function readPrice(p) {
  if (!isObj(p)) return null;
  let amount = null;
  let currency = null;
  if (isObj(p.price)) {
    amount = finiteNum(p.price.amount);
    currency = str(p.price.currency);
  }
  if (amount == null && !isObj(p.price)) amount = finiteNum(p.price);
  if (amount == null) amount = finiteNum(p.price_amount);
  if (currency == null) currency = str(p.currency) || str(p.currency_code) || str(p.price_currency);
  if (amount == null) return null;
  const code = currency ? currency.toUpperCase() : null;
  return { amount, currency: code, currencyValid: Boolean(code && /^[A-Z]{3}$/.test(code)) };
}

// ---- links (never fetched) --------------------------------------------------------------------------------

/** Syntactic well-formedness only. The harness NEVER fetches a link. */
function linkProblem(url) {
  const s = str(url);
  if (!s) return 'missing';
  if (/\s/.test(s)) return 'whitespace';
  let u;
  try {
    u = new URL(s);
  } catch {
    return 'unparseable';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'bad_scheme';
  if (!u.hostname || !u.hostname.includes('.')) return 'bad_host';
  if (/(^|\/)(undefined|null|NaN|\[object%20Object\]|\[object Object\])(\/|$|\?)/i.test(u.pathname + u.search)) {
    return 'placeholder_segment';
  }
  return null;
}

// ---- product normalization --------------------------------------------------------------------------------

const SHADE_OPTION_RE = /shade|colou?r|tone|tint|hue|teinte|couleur|色|색|tono/i;

function variantNamesOf(p) {
  const names = [];
  for (const v of arr(p.variants)) {
    if (typeof v === 'string') names.push(v);
    else if (isObj(v)) {
      const n = str(v.shade) || str(v.color) || str(v.colour) || str(v.title) || str(v.name) || str(v.option1) || str(v.option_value);
      if (n) names.push(n);
    }
  }
  for (const s of arr(p.shades)) {
    if (typeof s === 'string') names.push(s);
    else if (isObj(s) && str(s.name)) names.push(s.name);
  }
  for (const opt of arr(p.options)) {
    if (isObj(opt) && SHADE_OPTION_RE.test(String(opt.name || ''))) {
      for (const v of arr(opt.values)) if (str(typeof v === 'string' ? v : v && v.value)) names.push(typeof v === 'string' ? v : v.value);
    }
  }
  const shade = str(p.shade) || str(p.shade_name) || str(p.color);
  if (shade) names.push(shade);
  return [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
}

function listOfStrings(v) {
  return arr(v).map((x) => (typeof x === 'string' ? x : isObj(x) ? str(x.name) || str(x.inci) || str(x.label) : null)).filter(Boolean);
}

function normalizeProduct(p) {
  if (!isObj(p)) return null;
  const intel = isObj(p.ingredient_intel) ? p.ingredient_intel : {};
  const actives = [
    ...listOfStrings(p.key_actives),
    ...listOfStrings(p.active_ingredients),
    ...listOfStrings(intel.active_ingredients),
    ...listOfStrings(intel.key_ingredients),
  ];
  const ingredients = [...listOfStrings(p.ingredients), ...listOfStrings(intel.inci_list)];
  const link = str(p.pivota_url) || str(p.pdp_url) || str(p.url) || str(p.canonical_url) || str(p.pivota_canonical_url) || null;
  return {
    id: str(p.product_id) || str(p.pivota_signature_id) || str(p.id) || null,
    merchant_id: str(p.merchant_id),
    title: str(p.title) || str(p.name) || '',
    brand: str(p.brand) || str(p.vendor) || '',
    category: [str(p.category), str(p.product_type), ...arr(p.category_path).map(str)].filter(Boolean).join(' / '),
    description: str(p.description) || '',
    price: readPrice(p),
    availability: str(p.availability) || (p.in_stock === true ? 'in_stock' : p.in_stock === false ? 'out_of_stock' : 'unknown'),
    link,
    actives: [...new Set(actives)],
    ingredients: [...new Set(ingredients)],
    variants: variantNamesOf(p),
    has_variant_field: Array.isArray(p.variants) || Array.isArray(p.shades) || Array.isArray(p.options),
  };
}

// ---- per-tool readers --------------------------------------------------------------------------------------

function envelopeDegraded(v) {
  if (!isObj(v)) return false;
  if (typeof v.status === 'string' && !['success', 'ok'].includes(v.status.trim().toLowerCase())) return true;
  if (v.success === false || v.ok === false) return true;
  if (v.error) return true;
  return false;
}

/** The empty-result class a response states, wherever it states it. null when the page is not empty. */
function emptyClassOf(v, productCount) {
  if (productCount > 0) return null;
  if (!isObj(v)) return 'unspecified';
  const m = isObj(v.metadata) ? v.metadata : {};
  return (
    str(v.empty_class) || str(v.empty_reason) || str(v.emptyReason) ||
    str(m.empty_class) || str(m.empty_reason) || str(m.emptyReason) ||
    str(m.strict_empty_reason) || str(m.products_empty_reason) || str(m.reason) ||
    'unspecified'
  );
}

function readSearch(payload) {
  const v = payload.value;
  const rows = isObj(v) ? arr(v.products).length ? arr(v.products) : arr(v.items).length ? arr(v.items) : arr(v.results) : [];
  const products = rows.map(normalizeProduct).filter(Boolean);
  const degraded = envelopeDegraded(v);
  return {
    products,
    total: isObj(v) ? finiteNum(v.total) : null,
    degraded,
    failed_with_hits: degraded && products.length > 0,
    empty_class: emptyClassOf(v, products.length),
  };
}

function readProduct(payload) {
  const v = payload.value;
  if (!isObj(v)) return { found: false, product: null };
  const raw = isObj(v.product) ? v.product : v;
  const product = normalizeProduct(raw);
  const found = Boolean(product && (product.id || product.title) && !(str(v.note) && !product.id));
  return { found, product: found ? product : null, degraded: envelopeDegraded(v) };
}

function normalizeOfferSignal(sig) {
  const val = isObj(sig) && isObj(sig.value) ? sig.value : isObj(sig) ? sig : {};
  const price = readPrice(val);
  return {
    merchant_id: str(val.merchant_id) || str(val.seller_id),
    price,
    in_stock: val.in_stock === true ? true : val.in_stock === false ? false : null,
    availability: str(val.availability),
    link: str(val.affiliate_url) || str(val.cart_url) || str(val.url) || str(val.pdp_url),
    price_stale: val.price_stale === true,
  };
}

function readOffers(payload) {
  const v = isObj(payload.value) ? payload.value : {};
  const offers = arr(v.signals).map(normalizeOfferSignal);
  const best = isObj(v.best_offer) ? normalizeOfferSignal(v.best_offer) : null;
  const m = isObj(v.metadata) ? v.metadata : {};
  return {
    offers,
    best_offer: best,
    market_currency: str(m.market_currency),
    empty_class: offers.length === 0 ? str(m.reason) || 'unspecified' : null,
  };
}

function readAlternatives(payload) {
  const v = isObj(payload.value) ? payload.value : {};
  let items = [];
  if (Array.isArray(v.alternatives)) {
    items = v.alternatives.map(normalizeProduct).filter(Boolean);
  } else {
    items = arr(v.signals)
      .map((sig) => {
        const val = isObj(sig) && isObj(sig.value) ? sig.value : {};
        const related = isObj(val.related) ? val.related : {};
        return normalizeProduct({ ...related, product_id: related.product_id || related.ref });
      })
      .filter(Boolean);
  }
  const m = isObj(v.metadata) ? v.metadata : {};
  return { items, empty_class: items.length === 0 ? str(v.note) ? 'no_reviewed_alternatives' : str(m.reason) || str(m.empty_reason) || 'unspecified' : null };
}

function readRecommendations(payload) {
  const v = isObj(payload.value) ? payload.value : {};
  const rows = arr(v.signals).length ? arr(v.signals) : arr(v.recommendations).length ? arr(v.recommendations) : arr(v.products);
  const items = rows
    .map((r) => {
      const val = isObj(r) && isObj(r.value) ? r.value : r;
      return normalizeProduct(isObj(val) && isObj(val.product) ? val.product : val);
    })
    .filter(Boolean);
  const m = isObj(v.metadata) ? v.metadata : {};
  return {
    items,
    empty_class: items.length === 0 ? str(m.products_empty_reason) || str(m.reason) || 'unspecified' : null,
    confidence_basis: str(m.confidence_basis),
  };
}

module.exports = {
  MARKET_CURRENCY,
  currencyForMarket,
  toolPayload,
  readPrice,
  linkProblem,
  normalizeProduct,
  emptyClassOf,
  envelopeDegraded,
  readSearch,
  readProduct,
  readOffers,
  readAlternatives,
  readRecommendations,
};
