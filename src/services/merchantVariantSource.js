'use strict';

// MERCHANT-SOURCED VARIANT IDENTITY — ask the storefront for the id our crawl cannot carry.
//
// THE PROBLEM. Pivota's seed cohort publishes no real variant identity: `src/pdpBuilder.js buildVariants`
// manufactures `variant_id: product.product_id` (or `${product_id}-${n}`) for a crawled row, and
// `buyerIntake`'s resolver correctly refuses those — a forged variant id does not fail loudly, it PRICES A
// DIFFERENT CART. So every seed row hits `no_real_variant_identity` at intake and cannot open a checkout.
//
// THE OBSERVATION (probed live 2026-08-27, murad.com — a plain referral seed with zero Pivota onboarding).
// The merchant's OWN storefront publishes exactly what we lack:
//   * `GET https://<host>/.well-known/ucp` -> service `dev.ucp.shopping`, transport mcp, an endpoint URL;
//   * `tools/call search_catalog` on that endpoint returns products carrying `url`, `handle`, and
//     `variants[] { id: "gid://shopify/ProductVariant/…", sku, title, price, availability }`.
// Every tool requires `meta["ucp-agent"].profile`; anonymous calls are refused `invalid_profile_url`.
// Pivota already publishes such a profile and the buyer-agent client already sends it.
//
// THE JOIN IS THE WHOLE SAFETY ARGUMENT. We do NOT match on title — a fuzzy match would silently buy the
// wrong product, which is the same class of defect as a forged id. We match on the MERCHANT PDP URL the seed
// row was crawled from, compared origin+path only (query/fragment/case/trailing-slash normalised away).
// `search_catalog` is only a way to enumerate candidates; the URL is what selects one. Anything other than
// EXACTLY ONE URL-matching product returns null, and null means the caller refuses.
//
// WHICH DOORS GET THIS, DELIBERATELY. It is threaded into both `createDefaultVariantResolver` call sites in
// mcp-server/src/commerceToolSurface.js — native `create_checkout_session` and the UCP checkout door (UCP
// needs it MOST: a UCP `item.id` carries a product id and no variant carrier at all). safety-kernel's
// acpRestAdapter.js is NOT threaded and that is a choice, not an oversight: safety-kernel is a package with
// no business reaching into a gateway service, and wiring it would put a gateway dependency on the ACP
// door's constructor. The ACP door keeps today's refusal until a door-side composition point exists.
//
// WHAT THIS DOES NOT DO. It returns identity, not a price and not a purchase. The seed cohort still cannot be
// priced by pivota-backend's quote engine (Shopify-only, needs the SELLER's own store — see the SCOPE note in
// buyerIntake's resolver). The payoff of a real GID is the merchant's OWN UCP cart/checkout, which is where
// an agentic card would pay. Multi-variant products still refuse as `ambiguous` upstream — correctly: this
// module's job is to make that refusal about REAL options instead of about missing identity.

const DEFAULT_TIMEOUT_MS = 6000;
// A storefront search can page; we only ever want the entry whose URL is ours, so a small window is enough
// and bounds what one intake costs. If the row is not in the first page by title, we refuse rather than page
// the merchant's catalogue on a checkout path.
// The ONLY budget on the walk. There was also a 25-node candidate cap, and once a truncated walk correctly
// began REFUSING (it cannot prove uniqueness from a partial view) that cap stopped buying safety and started
// converting answerable lookups into refusals: a routine response of 9 products each nesting 2
// `related_products` is 27 product-shaped nodes, so the feature would have been armed and refused almost
// everything, with no test showing it. A visit budget bounds the work; uniqueness stays guarded by
// `truncated` either way.
const MAX_VISITS = 5000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** The product node inside whatever envelope the canonical read used (mirrors buyerIntake.productOfRead). */
function productOfRead(result) {
  const r = isPlainObject(result) ? result : {};
  if (isPlainObject(r.product)) return r.product;
  if (isPlainObject(r.data) && isPlainObject(r.data.product)) return r.data.product;
  return r;
}

/**
 * Compare two storefront URLs as IDENTITY: scheme-insensitive, host lowercased and `www.`-insensitive, path
 * without a trailing slash, and query/fragment ignored (our crawled url carries utm_* the merchant's does
 * not). Returns null for anything unparseable so a bad url can never match a bad url.
 */
function urlIdentity(raw) {
  const s = str(raw);
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (!host) return null;
  return `${host}${path}`;
}

/**
 * The `?variant=<n>` a crawled PDP deep link may carry — the merchant's own name for the exact SKU this row
 * was crawled as. `urlIdentity` deliberately drops the query (utm noise differs between our crawl and their
 * catalogue), so the one query field that carries IDENTITY is read separately, before it is discarded.
 */
function variantHintOf(raw) {
  const s = str(raw);
  if (!s) return null;
  try {
    const v = str(new URL(s).searchParams.get('variant'));
    // NUMERIC only — that is Shopify's variant id shape, and `variant` is otherwise a generic query name
    // (`?variant=large`, `?variant=us`, `?variant=mobile`). Treating those as a pin would refuse rows that
    // resolve fine, so a non-numeric value is no hint at all rather than an unmatchable one.
    return /^\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The MERCHANT's pdp url on our product read — never Pivota's own canonical url.
 *
 * `canonical_url`/`url` on a seed row point at agent.pivota.cc (verified live), so reading them would make us
 * "join" our own page against a merchant catalogue and match nothing — or worse, match a merchant who happens
 * to proxy us. Only the fields that are defined to carry the origin PDP are consulted, and a host that is one
 * of ours is refused outright.
 */
function merchantPdpUrlOf(product, selfHosts) {
  for (const field of ['destination_url', 'external_redirect_url', 'source_url']) {
    const identity = urlIdentity(product[field]);
    if (!identity) continue;
    const host = identity.split('/')[0];
    if (selfHosts.has(host)) continue;
    return { raw: str(product[field]), identity, host, variantHint: variantHintOf(product[field]) };
  }
  return null;
}

/** Variant ids published by a merchant catalogue product, de-duplicated, in order. */
function variantIdsOf(catalogProduct) {
  const out = [];
  for (const v of Array.isArray(catalogProduct.variants) ? catalogProduct.variants : []) {
    if (!isPlainObject(v)) continue;
    const id = str(v.id) || str(v.variant_id);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Walk an unwrapped UCP tool payload for product-shaped nodes carrying a `url`.
 *
 * Returns `{ nodes, truncated }`: `truncated` is what stops the visit budget from silently deciding the
 * uniqueness question above. A bounded walk that ran out of budget has NOT seen the whole catalogue, so it
 * cannot assert "exactly one entry carries this url" — the caller refuses instead of answering.
 */
function collectCatalogProducts(payload, state) {
  const st = state || { nodes: [], visits: 0, truncated: false };
  if (st.visits >= MAX_VISITS) {
    st.truncated = true;
    return st;
  }
  st.visits += 1;
  if (Array.isArray(payload)) {
    for (const v of payload) collectCatalogProducts(v, st);
    return st;
  }
  if (!isPlainObject(payload)) return st;
  if (str(payload.url) && (Array.isArray(payload.variants) || str(payload.handle))) st.nodes.push(payload);
  for (const v of Object.values(payload)) collectCatalogProducts(v, st);
  return st;
}

/**
 * Does this storefront variant id name the variant the crawled url pinned?
 *
 * Shopify publishes `gid://shopify/ProductVariant/<n>` while a PDP deep link carries the bare `<n>`, so the
 * comparison is on the id's trailing numeric segment — anchored, never a substring match (`…/51348961657135`
 * must not be satisfied by a hint of `1657135`).
 */
function idNamesVariant(variantId, hint) {
  const id = str(variantId);
  const h = str(hint);
  if (!id || !h) return false;
  if (id === h) return true;
  const tail = id.split('/').pop();
  return tail === h;
}



/**
 * Is this variant id just the product id RESTATED?
 *
 * A DELIBERATE SECOND COPY of `safety-kernel/src/protocol/buyerIntake.isRestatedProductId`, and the copy is
 * structural, not laziness: safety-kernel is ESM (`"type": "module"`), src/server.js is CommonJS, and CI runs
 * Node 20 — which cannot `require()` an ESM module. There is no synchronous way to share the original.
 *
 * Two copies of a SAFETY predicate is exactly how they drift, so drift is made detectable rather than
 * trusted: tests/merchant_variant_source contract-tests this against the ESM original over a table of id
 * shapes via dynamic `import()`. If either side changes, that test fails.
 *
 * Byte-for-byte semantics of the original: equal, or the product id followed by a NON-alphanumeric
 * separator. `sig_abc123` is NOT a restatement of `sig_abc` (it continues alphanumerically, so it carries
 * identity of its own); `sig_abc-1` is.
 */
function isRestatedProductId(candidate, product_id) {
  const c = typeof candidate === 'string' ? candidate.trim() : '';
  const p = typeof product_id === 'string' ? product_id.trim() : '';
  if (!c || !p) return false;
  if (c === p) return true;
  if (!c.startsWith(p)) return false;
  return /[^A-Za-z0-9]/.test(c.charAt(p.length));
}

// ---- publishing the merchant's variants on the PDP -------------------------------------------------------
//
// Resolving identity at checkout is not enough on its own: a product with two real variants is correctly
// REFUSED as `ambiguous`, and an agent cannot break that tie unless it can SEE the options. So the same
// join publishes them on the product read.
//
// MONEY IS THE DANGEROUS PART. UCP amounts are in MINOR units (`{"amount": 4800, "currency": "USD"}` is
// $48.00), while the PDP's own prices are major units. Writing 4800 through would publish a $4,800 product —
// a fabricated number of exactly the kind this repo has been bitten by. And omitting price is not a safe
// default either once MULTIPLE variants are shown: One-Pack and Two-Pack displayed at one product-level
// price is also a wrong number, just a quieter one. So the conversion is explicit, and a currency we cannot
// verify yields NO price rather than a guessed one.

/** ISO-4217 minor-unit exponent, or null when the code is not a real currency (`Intl` answers 2 for junk). */
function currencyExponent(code) {
  const c = str(code).toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return null;
  try {
    if (typeof Intl.supportedValuesOf === 'function' && !Intl.supportedValuesOf('currency').includes(c)) return null;
    return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits;
  } catch {
    return null;
  }
}

/**
 * `{amount: 4800, currency: 'USD'}` (minor) -> `{ amount: 48, currency: 'USD' }` (major), or null.
 * Null on: a non-finite/negative amount, or a currency whose exponent we cannot establish. Never a guess —
 * the caller omits the price instead, which is honest, where a wrong number is not.
 */
function majorUnitsOf(money) {
  if (!isPlainObject(money)) return null;
  const raw = money.amount;
  // `Number()` is too permissive for a function that promises never to guess: it reads '0x10' as 16 (-> a
  // published $0.16) and '1e3' as 1000. A minor-unit amount is an integer string or a number, nothing else.
  let amount;
  if (typeof raw === 'number') amount = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) amount = Number(raw.trim());
  else return null;
  // `<= 0` rather than `< 0`: a zero price is a broken offer row, not a free product, and publishing "$0.00"
  // on a PDP is a wrong number. pdpBuilder's `toVariantPrice` also drops <= 0, but relying on that would
  // leave this module's promise ("never a guessed price") true only by a downstream accident.
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // A storefront that answers a nonsense magnitude is not a price we publish. MAX_SAFE_INTEGER keeps the
  // division exact; the practical ceiling is far below it.
  if (amount > Number.MAX_SAFE_INTEGER) return null;
  const currency = str(money.currency).toUpperCase();
  const exp = currencyExponent(currency);
  if (exp === null) return null;
  return { amount: amount / 10 ** exp, currency };
}

/**
 * A merchant catalogue variant -> the raw-variant shape `pdpBuilder.buildVariants` already consumes
 * (`variant_id` / `sku_id` / `title` / `options` / `in_stock` / `price`). Nothing is invented: a field the
 * storefront did not publish is simply absent, and an unconvertible price is omitted rather than approximated.
 */
function merchantVariantToRaw(v) {
  if (!isPlainObject(v)) return null;
  const variantId = str(v.id) || str(v.variant_id);
  if (!variantId) return null;
  const out = { variant_id: variantId };
  const sku = str(v.sku) || str(v.sku_id);
  if (sku) out.sku_id = sku;
  const title = str(v.title) || str(v.name);
  if (title) out.title = title;
  const options = (Array.isArray(v.options) ? v.options : [])
    .map((o) => (isPlainObject(o) ? { name: str(o.name), value: str(o.label) || str(o.value) } : null))
    .filter((o) => o && o.name && o.value);
  if (options.length) out.options = options;
  if (isPlainObject(v.availability) && typeof v.availability.available === 'boolean') {
    out.in_stock = v.availability.available;
  }
  const price = majorUnitsOf(v.price);
  if (price) {
    // ONLY the flat pair — deliberately NOT a nested `price` object.
    //
    // pdpBuilder resolves a variant price as `toVariantPrice(v.price || v.pricing || {amount:
    // v.price_amount, currency: v.price_currency}, productCurrency)`, and its `normalizeCurrency` reads
    // `value.currency` — one level SHALLOWER than a `{current:{amount,currency}}` shape. So setting `price`
    // made the merchant's currency invisible and substituted the PRODUCT's: a EUR variant published as USD
    // at the same number (€86.00 -> $86.00). The amount was right, which is what makes that error hard to
    // see. Leaving `price` unset takes the fallback branch, where `price_currency` IS read.
    out.price_amount = price.amount;
    out.price_currency = price.currency;
  }
  return out;
}

/**
 * Build the merchant-variant source for `createDefaultVariantResolver`'s optional fallback.
 *
 * @param {{ ucpClient: object, isEnabled?: () => boolean, isBrandAllowed?: (host:string) => boolean,
 *           selfHosts?: string[], logger?: object, timeoutMs?: number,
 *           unwrap?: (toolResult:any)=>any }} deps
 * @returns {(productRead:object, product_id:string, ctx:object)=>Promise<string[]|null>}
 */
function createMerchantVariantSource(deps = {}) {
  const { ucpClient, isEnabled, isBrandAllowed, logger, unwrap } = deps;
  if (!ucpClient || typeof ucpClient.discoverEndpoint !== 'function' || typeof ucpClient.searchCatalog !== 'function') {
    throw new Error('createMerchantVariantSource requires a ucp client with discoverEndpoint() and searchCatalog()');
  }
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const selfHosts = new Set(
    (Array.isArray(deps.selfHosts) ? deps.selfHosts : [])
      .map((h) => str(h).toLowerCase().replace(/^www\./, ''))
      .filter(Boolean),
  );

  // Collapse genuinely CONCURRENT lookups for one (product, pdp url) onto a single round trip. Stated
  // precisely because the first revision's comment claimed more than the code delivered: the resolver calls
  // this SEQUENTIALLY, so on that path nothing is ever in flight when the next line arrives and this memo
  // never hits. Per-cart deduplication is therefore done where the loop is, in buyerIntake's
  // `merchantByProduct`. This map is for other callers (and future concurrent ones), and is dropped on
  // settle so a checkout never serves a stale catalogue.
  const inflight = new Map();
  function memoKeyFor(product_id, identity) { return `${product_id}\u0000${identity}`; }

  // SHORT-TTL RESULT CACHE. The in-flight memo above collapses CONCURRENT callers only; the PDP renders
  // sequentially, so without this every product view is a live search against the merchant (measured by
  // review: 5 renders -> 5 searches, and discovery is not cached in the client either, so ~2 outbound
  // requests per view). That is render traffic aimed at a storefront that never agreed to serve it. The TTL
  // is deliberately short — a catalogue answer held too long is a stale SKU on a checkout — and the cache is
  // bounded so a wide crawl cannot grow it without limit.
  const resultTtlMs = Number.isFinite(deps.resultTtlMs) && deps.resultTtlMs >= 0 ? deps.resultTtlMs : 120000;
  const resultMax = Number.isFinite(deps.resultCacheMax) && deps.resultCacheMax > 0 ? deps.resultCacheMax : 500;
  const results = new Map();
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now();
  function cacheGet(key) {
    if (resultTtlMs === 0) return undefined;
    const hit = results.get(key);
    if (!hit) return undefined;
    if (clock() >= hit.expiresAt) { results.delete(key); return undefined; }
    return hit.value;
  }
  function cacheSet(key, value) {
    if (resultTtlMs === 0) return;
    if (results.size >= resultMax) results.delete(results.keys().next().value);
    results.set(key, { value, expiresAt: clock() + resultTtlMs });
  }

  /** Shared gate + network path: -> the ONE catalogue product whose url is ours, or null. */
  async function matchedCatalogProduct(productRead, product_id) {
    if (typeof isEnabled === 'function' && !isEnabled()) return { pdp: null, match: null };
    const product = productOfRead(productRead);
    const pdp = merchantPdpUrlOf(product, selfHosts);
    if (!pdp) return { pdp: null, match: null };
    // SCOPE BEFORE CONTACT. A pilot names the storefronts it has actually been exercised against; every
    // other merchant keeps today's behaviour and, crucially, receives no traffic from us at all. Checked
    // here — before discovery — so a non-piloted brand costs zero outbound requests rather than a
    // well-known fetch we then discard.
    if (typeof isBrandAllowed === 'function' && !isBrandAllowed(pdp.host)) return { pdp, match: null };

    // The search term is the merchant's OWN handle when their url gives us one (the most selective text we
    // hold), else the crawled title. Neither SELECTS the product — the url match below does — so a poor term
    // costs a miss, never a wrong answer.
    const handle = pdp.identity.split('/').pop();
    const query = handle && handle !== '/' ? handle.replace(/[-_]+/g, ' ') : str(product.title);
    if (!query) return { pdp, match: null };

    const memoKey = memoKeyFor(product_id, pdp.identity);
    const cached = cacheGet(memoKey);
    if (cached !== undefined) return { pdp, match: cached };
    if (inflight.has(memoKey)) return { pdp, match: await inflight.get(memoKey) };

    let match = null;
    const lookup = withTimeout(async () => {
        // `discoverEndpoint` answers `{ mcpEndpoint, businessProfile, wellKnownUrl, status }` — the key is
        // `mcpEndpoint`, as ucpWarmHandoff and ucpStoreAuditProbe both read it. An earlier revision read a
        // `.endpoint` key the client has never emitted, which made this whole source a silent no-op in
        // production while every test passed on a hand-written double that invented that shape. A bare string
        // is still accepted so a caller may pass a known endpoint directly.
        const discovery = await ucpClient.discoverEndpoint(`https://${pdp.host}`);
        const mcpEndpoint = typeof discovery === 'string'
          ? str(discovery)
          : str(discovery && discovery.mcpEndpoint);
        if (!mcpEndpoint) return null;
        const raw = await ucpClient.searchCatalog(mcpEndpoint, { query });
        const payload = typeof unwrap === 'function' ? unwrap(raw) : raw;
        const walk = collectCatalogProducts(payload);
        const matches = walk.nodes.filter((p) => urlIdentity(p.url) === pdp.identity);
        // EXACTLY ONE. Zero means the storefront did not surface the row we crawled; more than one means the
        // catalogue publishes the same url twice and we cannot tell which is the purchasable one. Both are
        // refusals, because the only thing worse than no variant id is a confidently wrong one.
        //
        // AND THE BUDGET MUST NEVER DECIDE UNIQUENESS. The walk is bounded so one checkout cannot traverse an
        // unbounded response, but a truncated walk cannot prove "exactly one" — a second entry carrying our
        // url may sit just past the cut. So an exhausted budget REFUSES whatever it was holding rather than
        // answering from a partial view (a merchant re-publishing a product, a common archived-listing
        // pattern, is precisely how two entries share one url).
        if (walk.truncated) return null;
        if (matches.length !== 1) return null;
        return matches[0];
      }, timeoutMs);

    // Memoize the IN-FLIGHT lookup so concurrent callers for one (product, url) share a single round trip,
    // and drop it once settled — a cart is short, and holding a catalogue answer past it would serve a stale
    // SKU. Per-cart dedup for the SEQUENTIAL resolver path lives in buyerIntake; this covers concurrency.
    inflight.set(memoKey, lookup.catch(() => null));
    try {
      match = await lookup;
    } catch (err) {
      // Fail closed. The merchant's error text is never surfaced — it can carry their internal detail —
      // only that the lookup did not answer.
      logger?.warn?.({ product_id, merchant_host: pdp.host, err: err?.message || String(err) },
        'merchant variant source did not answer');
      return { pdp, match: null };
    } finally {
      inflight.delete(memoKey);
    }
    // Cache the REFUSAL too (null): a storefront that did not surface this row will not surface it on the
    // next render either, and re-asking turns every view into another outbound request.
    cacheSet(memoKey, match ?? null);
    return { pdp, match };
  }

  /**
   * The matched catalogue product -> the variant ids the RESOLVER may accept.
   *
   * THE CRAWLED URL MAY ITSELF NAME A VARIANT. Shopify PDP deep links carry `?variant=<n>`, and the row was
   * crawled, priced and displayed as THAT variant — resolving it to a sibling would open a checkout on a
   * different SKU than the shopper was shown, the exact "prices a different cart" harm this join exists to
   * prevent. When the crawl names one, only that variant may be returned; if the catalogue no longer
   * publishes it, refuse rather than substitute.
   */
  function variantIdsFromMatch(match, pdp) {
    if (!isPlainObject(match)) return null;
    const variantIds = variantIdsOf(match);
    if (variantIds.length === 0) return null;
    if (pdp && pdp.variantHint) {
      const pinned = variantIds.filter((id) => idNamesVariant(id, pdp.variantHint));
      return pinned.length === 1 ? pinned : null;
    }
    return variantIds;
  }

  /** The resolver's fallback: ids only, unchanged contract. */
  async function sourceMerchantVariants(productRead, product_id) {
    const { pdp, match } = await matchedCatalogProduct(productRead, product_id);
    const ids = variantIdsFromMatch(match, pdp);
    if (ids && logger?.info) {
      logger.info({ product_id, merchant_host: pdp.host, variant_count: ids.length },
        'merchant variant source resolved storefront variants');
    }
    return ids;
  }

  /**
   * The PDP's publisher: the merchant's variants in the raw shape `pdpBuilder.buildVariants` consumes.
   *
   * Deliberately NOT pinned by `?variant=`: the resolver must not GUESS between siblings, but a shopper
   * being shown the product should see every option the storefront sells — that is what lets an agent break
   * the `ambiguous` tie by naming one. Prices are converted minor->major and omitted when unconvertible.
   */
  async function sourceMerchantVariantDetails(productRead, product_id) {
    const { pdp, match } = await matchedCatalogProduct(productRead, product_id);
    if (!isPlainObject(match)) return null;
    const raws = (Array.isArray(match.variants) ? match.variants : [])
      .map(merchantVariantToRaw)
      .filter(Boolean);
    if (raws.length === 0) return null;
    logger?.info?.({ product_id, merchant_host: pdp.host, variant_count: raws.length },
      'merchant variant source published storefront variants on the pdp');
    return raws;
  }

  sourceMerchantVariants.details = sourceMerchantVariantDetails;
  return sourceMerchantVariants;
}

/**
 * Bound the whole lookup: discovery + search share one deadline, so intake cost stays predictable.
 *
 * The timer is deliberately NOT `unref()`d. An unref'd timer does not hold the event loop open, so when the
 * merchant call is the only pending work the loop drains and the deadline NEVER FIRES — the lookup then hangs
 * for as long as the socket does, and the caller's refusal never arrives. (Caught by CI, which runs this file
 * with a quiet loop: node:test reported "Promise resolution is still pending but the event loop has already
 * resolved". It passed locally only because other handles happened to keep the loop alive.) Both exits clear
 * the timer, so a ref'd timer cannot outlive the call it bounds.
 */
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('merchant variant source timed out')), ms);
    Promise.resolve()
      .then(fn)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Host-allowlist matcher, sharing `urlIdentity`'s host rules (lowercased, `www.` stripped) so a brand can be
 * written the way anyone would type it. An entry matches the host itself or any SUBDOMAIN of it — a pilot
 * naming `murad.com` covers the `www.murad.com` its PDPs use — and never a suffix that is not a dot boundary
 * (`notmurad.com` must not match `murad.com`).
 */
function hostMatchesBrand(host, brand) {
  const h = str(host).toLowerCase().replace(/^www\./, '');
  const b = str(brand).toLowerCase().replace(/^\./, '').replace(/^www\./, '');
  if (!h || !b) return false;
  return h === b || h.endsWith(`.${b}`);
}

/** Parse a comma-separated brand list (the OUTBOUND_WARM_HANDOFF_BRANDS shape) into a matcher. */
function brandAllowlistMatcher(raw) {
  const brands = String(raw || '')
    .split(',')
    .map((b) => str(b).toLowerCase().replace(/^\./, '').replace(/^www\./, ''))
    .filter(Boolean);
  return { brands, isAllowed: (host) => brands.some((b) => hostMatchesBrand(host, b)) };
}

module.exports = { createMerchantVariantSource, urlIdentity, variantIdsOf, collectCatalogProducts, variantHintOf, idNamesVariant, hostMatchesBrand, brandAllowlistMatcher, currencyExponent, majorUnitsOf, merchantVariantToRaw, isRestatedProductId };
