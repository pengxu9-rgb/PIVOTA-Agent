'use strict';

// recommend_products — a NEED in natural language → a reasoned shortlist, as agent-facing Signals.
//
// This is the bridge from Pivota's prompt-level recommendation lane (the Aurora BFF's
// `generateProductRecommendations`, the engine behind POST /v1/reco/generate) to the commerce doors. The
// lane is injected, not imported: it is a large closure over the Aurora routes module, so this file owns
// only (a) the agent-side contract (what the model sends, what it gets back) and (b) the projection of the
// lane's UI envelope into the `{ subject, signals[], metadata }` shape every other insights tool uses.
//
// HONEST LIMITS, stated in the tool description too:
//  - the lane is the Aurora BEAUTY engine today: its prompts, catalog grounding and guardrails are tuned for
//    skincare/beauty. An off-vertical need answers with an empty shortlist + `missing_info`, not with
//    fabricated products — and that is now ENFORCED here (offVerticalMarker), not merely hoped for: the lane
//    itself is a recommender and will happily answer a trading-card need with a cleanser;
//  - every returned signal is a CATALOG product with a non-null product_id. The lane also emits
//    "ungrounded" archetypes (a product it named but could not resolve, every identity field null); they
//    are suppressed from the shortlist and reported as text on `metadata.unresolved_archetypes`;
//  - it calls an external decision service (AURORA_DECISION_BASE_URL) — seconds, not milliseconds; the
//    door's heartbeat keeps the connection alive. `budgetMs` is passed to the lane's own deadline for its
//    enrichment/framework passes; the upstream LLM leg is bounded separately by the lane's
//    AURORA_BFF_RECO_UPSTREAM_TIMEOUT_MS (8s, hard cap 12s), so it is a hint, not a hard ceiling;
//  - results are NOT cached: the lane keeps a per-caller diversity memory, so two identical calls may differ
//    on purpose.
//
// IDENTITY. The lane keys profile / anti-repeat memory on a uid. Here the uid is a NAMESPACED synthetic per
// calling agent (`agent:<agent_id>`), never a consumer uid, so an agent call can neither read a consumer's
// stored profile nor write into one. No bearer is passed, so the lane's identity-link write never runs.
//
// SANITIZER-SAFE BY CONSTRUCTION. The commerce surface strips `score`/`confidence` from product-shaped nodes
// and drops `score_breakdown`/`candidate_source`/`debug` anywhere (safety-kernel/src/protocol/resultSanitizer).
// Per-item certainty therefore lives under `value.fit` (not a bare `confidence`), and the overall certainty
// sits on `metadata` (not a product node).

const MAX_NEED_CHARS = 500;
const MAX_CONSTRAINT_KEYS = 8;
const MAX_CONSTRAINT_VALUE_CHARS = 120;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_BUDGET_MS = 9000;
// Live price re-verification bounds: check only the items that could reach the shortlist (limit plus a
// small margin for slots freed by the ceiling pass), and never let one slow PDP lookup hold the whole
// tool call — the race resolves null and the item degrades to its snapshot price, explicitly marked.
const PRICE_VERIFY_EXTRA = 2;
// The race is a BACKSTOP against a verifier dep with no timeout of its own -- it must sit ABOVE the
// dep's real latency, not inside it. Measured 2026-08-21: the loopback get_pdp_v2 answers in ~4.7s
// (sig -> ext resolution does real work), so the old 2500ms race (and the wiring's old 2000ms axios
// timeout) killed every live-price check exactly when it mattered.
const PRICE_VERIFY_RACE_MS = 6500;
const PRICE_VERIFY_MAX_CHECKS = 8;

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}
function firstString(...values) {
  for (const v of values) if (nonEmpty(v)) return v.trim();
  return null;
}
function asStringArray(v, max = 6) {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).slice(0, max);
  if (nonEmpty(v)) return [v.trim()];
  return [];
}
function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// ── OFF-VERTICAL GATE ────────────────────────────────────────────────────────────────────────────
// The tool description promises: "Today's lane is tuned for beauty/skincare: off-vertical needs answer
// with an empty shortlist and a reason, never with fabricated products." Nothing enforced that half of
// the sentence. Live 2026-09-08, "I collect Pokémon trading cards and want a sealed Scarlet & Violet
// booster box" answered with a Jurlique cleanser and a COSRX moisturizer — both at `fit.level: 'high'`,
// both `grounding: 'catalog'`, `products_empty_reason: null` — plus one invented sunscreen. Nothing had
// malfunctioned: the beauty lane is never ASKED whether the need is a beauty need, it is asked to
// recommend, and a recommender always recommends. The question has to be put before it is called.
//
// Lexical, and deliberately so: it runs BEFORE the lane, so an off-vertical need costs no LLM
// generation (that live call took 21s) and no fabricated shortlist is ever built to be filtered later.
//
// DELIBERATELY ASYMMETRIC, because the two error directions are not equally expensive:
//   - a false NEGATIVE (an off-vertical domain this list does not name) leaves today's behaviour, which
//     the grounding suppression downstream already makes safer — the answer is wrong-vertical, not
//     fabricated;
//   - a false POSITIVE refuses a real beauty buyer, which is the only outcome here that loses a sale.
// So a need is off-vertical ONLY when it names an off-vertical domain AND names nothing beauty at all.
// "a lipstick to match my dress" keeps its shortlist; "a sealed booster box" does not. That asymmetry
// is also why the beauty lexicon is generous and the off-vertical one is narrow: a word added to the
// beauty side can only ever make this gate QUIETER, so it costs nothing to be liberal there, while a
// word added to the off-vertical side can refuse a paying buyer.
//
// LEXICAL, AND ONLY LEXICAL — which is why the served description says a RECOGNISED off-vertical need
// rather than promising a universal.
//
// A second axis was tried and REMOVED, and the reason is worth keeping: the lane frequently admits in
// its own `warnings` that it excluded the need as off-domain ("Non-skincare requests … have been
// excluded per domain boundaries"), which looked like free coverage for needs no keyword list holds.
// It is not, because the lane's DOMAIN IS NARROWER THAN THIS TOOL'S. prompts/reco_main_v1_2.system.txt
// says "Recommend skincare only. Never recommend makeup, brushes, beauty tools, devices, fragrance,
// haircare, or supplements" — so it emits that same admission for a bronzer, a brush set, cologne or a
// gua sha tool, all of which are squarely inside the beauty/skincare lane this tool advertises. Its
// prose cannot distinguish "not commerce for us" from "beauty, but not skincare for me", so acting on
// it emptied the shortlist for in-vertical buyers and told them their beauty need was not beauty. The
// admission is still relayed verbatim in `metadata.warnings`; nothing is lost by not acting on it.
//
// SEPARATORS ARE NORMALISED FIRST. Every multi-word alternative here is written with a single space,
// so "booster-box", "trading-cards", "graphics-card" and "magic: the gathering" all escaped the gate
// while their spaced spellings were refused — the repro's own wording, one hyphen away from passing.
// normalizeForMatch collapses `-`, `:`, `/`, `_` to spaces before matching, so a rewording cannot buy
// a fabricated shortlist.
//
// Word-anchored so a token cannot match inside a longer word: `\btcg\b` refuses "tcg singles" but not
// "tcgel". (An earlier version of this comment claimed the anchors stop "carbon" being read as "car" —
// they do not, because `car` is not an alternative here; the only bare-`car` entry is the two-word
// `car t[iy]res`. Test 8f pins the case the anchors actually carry.) The CJK patterns are bare
// substrings on purpose: `\b` is meaningless between CJK characters, and this tool takes
// `language: 'CN'` as a first-class parameter, so a CN need must reach the same gate.
// Each group below is an alternation of word-anchored alternatives; `anchored` wraps the lot so a
// group can be edited without re-deriving the boundaries every time.
const anchored = (groups) => new RegExp(String.raw`\b(?:${groups.join('|')})\b`, 'i');
const OFF_VERTICAL_RE = anchored([
  // Collectibles / TCG — the reported repro.
  String.raw`trading cards?|booster (?:box|pack)e?s?|pok[eé]mon|tcg|graded cards?|magic the gathering|sports cards?|funko`,
  // Consumer electronics. `switch`/`monitor` are absent on purpose: alone they are ordinary English.
  String.raw`laptops?|smartphones?|iphones?|ipads?|headphones|earbuds|graphics cards?|gpus?|cpus?|game consoles?|xbox|playstation|nintendo|keyboards?|webcams?|televisions?|printers?|drones?`,
  // Large household goods.
  String.raw`refrigerators?|dishwashers?|washing machines?|mattress(?:es)?|sofas?|couch(?:es)?|lawn ?mowers?|power drills?`,
  // Vehicles.
  String.raw`motorcycles?|car t[iy]res?|windshields?|spark plugs?`,
  // Kitchen / small appliances — measured 2026-09-08: "an air fryer" returned a Jurlique cleanser at
  // fit 'high'. `blenders?` is deliberately ABSENT: a beauty blender is a makeup sponge, "a blender
  // sponge" was measured being refused by it, and a kitchen blender is not worth a refused buyer.
  String.raw`air ?fryers?|microwaves?|coffee ?makers?|espresso machines?|toasters?|kettles?|vacuum cleaners?`,
  // Fitness. "protein powder" is a phrase, never bare `powder` — setting powder is beauty.
  String.raw`treadmills?|dumbbells?|kettlebells?|exercise bikes?|yoga mats?|protein powder`,
  // Apparel / footwear. Bare `coat` is deliberately absent (a top coat is nail care) and so is
  // `boots` (Boots is a beauty retailer); only unambiguous compounds appear.
  String.raw`sneakers?|running shoes?|jeans|handbags?|backpacks?|winter coats?|hoodies?`,
  // Baby / childcare.
  String.raw`diapers?|nappies|strollers?|car seats?`,
  // Outdoors / tools / auto care. `car wax` is a phrase: bare `wax` is hair removal.
  String.raw`rifle scopes?|fishing rods?|tents?|sleeping bags?|chainsaws?|car wax|wiper blades?`,
  // Pets / groceries / other verticals that share a storefront with beauty but not this lane.
  String.raw`dog food|cat litter|aquariums?|textbooks?|firearms?|ammunition`,
]);
const OFF_VERTICAL_CJK_RE = /卡牌|显卡|笔记本电脑|智能手机|游戏机|键盘|冰箱|洗碗机|洗衣机|床垫|沙发|摩托车|狗粮|猫砂/;
// Suppression side: anything that plausibly makes this a beauty need. Liberal by design (see above).
const BEAUTY_RE = anchored([
  String.raw`skin|skin ?care|complexion|faces?|facial|derma\w*|cosmetics?|makeup|beauty`,
  String.raw`serums?|essences?|ampoules?|moistur\w*|cleansers?|cleans\w*|toners?|exfoliat\w*|peels?|masks?|creams?|lotions?|balms?|oils?|mists?`,
  String.raw`sunscreens?|spf|retinols?|retinoids?|niacinamide|hyaluronic|ceramides?|salicylic|glycolic|azelaic|vitamin c|peptides?|antioxidants?`,
  String.raw`acne|breakouts?|blackheads?|whiteheads?|pores?|wrinkles?|fine lines|dark spots?|hyperpigmentation|redness|rosacea|eczema|psoriasis|dryness|oiliness|sensitive|dull\w*`,
  String.raw`anti ?ag\w*|brighten\w*|hydrat\w*|soothing|barrier|routines?`,
  String.raw`lips?|lipsticks?|foundations?|concealers?|mascaras?|eyeliners?|eyeshadows?|blush(?:es)?|primers?|nail polish`,
  // The class the LANE refuses but this TOOL advertises (its prompt is skincare-only; see above).
  // These sit on the SUPPRESSION side, so they cost nothing and stop the gate refusing a beauty buyer:
  // measured 2026-09-08, "a bronzer for contouring", "a brush set for my kit" and "a blender sponge"
  // carried no beauty token at all.
  String.raw`bronzers?|highlighters?|contour\w*|palettes?|brow pencils?|brows?|lash(?:es)?|eyelash\w*|setting sprays?|makeup brush(?:es)?|brush(?:es)?|sponges?|beauty blenders?`,
  String.raw`manicures?|pedicures?|nails?|cuticles?|colognes?|body butter|body creams?|gua sha|jade rollers?|derm[ar]?planing|razor burn|ingrown hairs?|melasma|under.?eye\w*|puffiness|dark circles?`,
  String.raw`shampoos?|conditioners?|scalp|hair|fragrances?|perfumes?|deodorants?|body wash`,
]);
const BEAUTY_CJK_RE = /护肤|皮肤|精华|面霜|乳液|洁面|防晒|化妆|彩妆|口红|唇|痘|毛孔|皱纹|美白|保湿|敏感肌|洗发|护发|香水|面膜|眼霜|爽肤/;

/** Fold the separators a buyer may type between words of one term onto a single space. */
function normalizeForMatch(s) {
  return String(s).replace(/[-–—_:/\\]+/g, ' ').replace(/\s+/g, ' ');
}

/** Does the need name anything beauty at all? The suppression side of the asymmetry. */
function hasBeautyMarker(need) {
  if (!nonEmpty(need)) return false;
  return BEAUTY_RE.test(normalizeForMatch(need)) || BEAUTY_CJK_RE.test(need);
}

/**
 * Is this need plainly outside the beauty/skincare lane? Exported so the rule is testable directly
 * rather than only through a mocked lane.
 * @returns {string|null} the off-vertical phrase that fired, or null (in-vertical, or unrecognised)
 */
function offVerticalMarker(need) {
  if (!nonEmpty(need)) return null;
  // A beauty word anywhere in the need suppresses the gate outright — see the asymmetry note above.
  if (hasBeautyMarker(need)) return null;
  const m = OFF_VERTICAL_RE.exec(normalizeForMatch(need)) || OFF_VERTICAL_CJK_RE.exec(need);
  return m ? m[0] : null;
}

/** The lane's integer 0-100 score as a band an agent can act on (never the raw score: see `fit`). */
function scoreBand(score) {
  if (score === null) return null;
  if (score >= 80) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
}

function finiteNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// Structured price-ceiling constraint keys (canonicalized: lowercased, separators removed). The VALUE
// must be a number, or a bare currency-marked numeral under one of these keys (`40`, `"40.00"`,
// `"40 USD"`, `"USD 40"`). Prose is refused: `budget: "under $40"` is free text the LLM may honour or
// not, and parsing an amount out of a sentence is exactly the guessing this pass must not do.
const PRICE_MAX_KEYS = new Set(['pricemax', 'maxprice', 'budget', 'budgetmax', 'maxbudget', 'pricelimit', 'priceceiling']);
// Keys whose value declares the CURRENCY the ceiling is denominated in. DERIVED from the ceiling keys
// rather than hand-listed: a hand-listed set covered `budget_currency` but not `budget_max_currency`,
// silently dropping a declaration and enforcing the number as USD.
const PRICE_CURRENCY_KEYS = new Set(['currency', 'pricecurrency']);
// Currencies the catalog plausibly carries. An allowlist, not a shape test: it keeps a key like
// `budget_cap` from being read as a ceiling denominated in "CAP".
const KNOWN_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'KRW', 'HKD', 'SGD', 'TWD', 'CHF', 'SEK', 'NZD']);
// The serving path normalizes catalog prices to USD (Shopify Markets USD; see the no_us_offer work), so
// an undeclared ceiling is read as USD. `metadata.price_max_currency` reports which it used, and a
// declared currency always wins — the assumption is visible to the caller, never silent.
const DEFAULT_PRICE_MAX_CURRENCY = 'USD';
for (const k of PRICE_MAX_KEYS) PRICE_CURRENCY_KEYS.add(`${k}currency`);

// Detecting a claim that the item MEETS the price constraint. Deliberately NOT a bare price-word match:
// watchouts is fed by the lane's `warnings` (its SAFETY field), where "Limit use to 2-3 times per week"
// and "Keep the cap closed" are ordinary copy — deleting a safety warning to suppress a budget claim is
// a worse trade than the defect it fixes. So a line is stripped only when it either
//   (a) asserts affordability outright (afford/cheap/inexpensive — inherently a claim about price), or
//   (b) pairs a price token with a FIT assertion ("within your $40 budget", "under the dollar cap").
// A subjective quality judgment ("a great price for the size") asserts nothing about the ceiling and is
// left alone: the marker and `constraint_violations` already carry the truth. Word-anchored so
// "Priceless glow" is not read as a price claim, and bilingual — `language: 'CN'` is a first-class
// parameter of this tool.
const AFFORDABILITY_CLAIM_RE = /\b(afford\w*|cheap\w*|inexpensive|budget-friendly|bargain)\b|便宜|实惠|划算|预算友好/i;
// A price token names MONEY. `value` is deliberately absent: it earns no strip on its own, and pairing
// it with a fit word deletes true copy ("a great-value serum that layers under makeup"). `spend`/`cost`
// are NOT bare tokens: in this lane's safety copy they are routinely about TIME and TOLERANCE ("limit
// the time you spend in the sun", "this acid costs you UV tolerance"), and a bare match pairs them with
// the fit word `limit` to delete a photosensitivity warning — a worse trade than the claim it suppresses.
// They count as money only inside an explicitly monetary construction (MONETARY_PHRASE_RE); when they sit
// next to an actual amount, the `[$£€¥]\s*\d` alternative already carries the line without their help.
const PRICE_TOKEN_RE = /\b(budget|price[ds]?|pricing|dollars?|usd)\b|[$£€¥]\s*\d|预算|价格|美元|价钱/i;
// The monetary idioms of `spend`/`cost` that appear WITHOUT an amount: a ceiling compound ("your stated
// spend limit", "spending cap") with the gap clause-bounded so "the time you spend in the sun … cap" in a
// later clause never joins, and a cost comparative ("costs less than you allowed", "the cost is lower
// than your maximum"). `spend under/below` is deliberately NOT here: that shape is the sunlight warning
// ("reduce the time you spend under direct sunlight"), while a real monetary "spends under your budget"
// still strips via its budget/amount token.
const MONETARY_PHRASE_RE = /\b(?:spend\w*|costs?)\b[^.;,，。；]{0,30}?\b(?:limit|cap|ceiling|budget|maximum|max)\b|\bcosts?\s+(?:is\s+|are\s+)?(?:much\s+|far\s+)?(?:less|lower|below|under)\b/i;
// A fit assertion names the CONSTRAINT being met — containment, comparison, or negated exceedance.
// `limit`/`cap`/`ceiling`/`maximum` live HERE rather than among the price tokens: alone they are
// ordinary skincare copy ("limit use to 2-3x per week", "keep the cap closed") and strip nothing; they
// only ever fire alongside a money word, which is exactly when they mean the buyer's ceiling.
const FIT_ASSERTION_RE = new RegExp([
  '\\b(within|under|below|inside|beneath|fits?|fitting|comfortably|meets?|stays?|keeps?)\\b',
  '\\b(less than|lower than|cheaper than|no more than|at most|respects?)\\b',
  '\\b(limit|cap|ceiling|maximum|max)\\b',
  "\\b(wo|do|does|will|is|are)n'?t\\s+(exceed|break|go over|top)\\b",
  '\\bwill not exceed\\b',
  '之内|以内|不超过|低于|范围内|预算内|不会超出|不高于',
].join('|'), 'i');

function assertsBudgetFit(line) {
  return AFFORDABILITY_CLAIM_RE.test(line)
    || ((PRICE_TOKEN_RE.test(line) || MONETARY_PHRASE_RE.test(line)) && FIT_ASSERTION_RE.test(line));
}

/**
 * Canonical form of a constraint key: lowercased, separators and punctuation removed. DIGITS ARE KEPT —
 * stripping them would fold a distinct key like `budget2` into `budget` and enforce a ceiling the caller
 * never asked for.
 */
function canonKey(key) {
  return str(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A ceiling value → `{ amount, currency }`, or null when it is not a bare numeral. */
function parseCeilingValue(value) {
  const n = finiteNumber(value);
  if (n !== null) return { amount: n, currency: null };
  // A structured numeral carrying its own ISO code — "40 USD" / "USD 40". NOT prose: anything with a
  // surrounding word ("under $40") fails this anchor and is refused.
  const m = /^([A-Z]{3})\s*([0-9]+(?:\.[0-9]+)?)$|^([0-9]+(?:\.[0-9]+)?)\s*([A-Z]{3})$/.exec(str(value).toUpperCase());
  if (!m) return null;
  const currency = m[1] || m[4];
  if (!KNOWN_CURRENCIES.has(currency)) return null;
  return { amount: Number(m[2] !== undefined ? m[2] : m[3]), currency };
}

/**
 * The buyer's structured price ceiling, read from the RAW constraints object (pre-normalization, so a
 * numeric 40 is still a number). Returns `{ limit, currency, declared }` for the smallest recognized
 * ceiling, or null when none is present. `unstructured` reports a budget-shaped key whose value was
 * prose — enforcement did not run, and the caller is told so rather than left to assume it did.
 */
function extractPriceMax(raw) {
  if (!isPlainObject(raw)) return null;
  let best = null;
  let declaredCurrency = null;
  let unstructured = null;
  for (const [key, value] of Object.entries(raw)) {
    const k = canonKey(key);
    if (PRICE_CURRENCY_KEYS.has(k)) {
      const c = str(value).toUpperCase();
      if (KNOWN_CURRENCIES.has(c)) declaredCurrency = c;
      continue;
    }
    // A currency-suffixed ceiling key: `price_max_usd` → ceiling in USD.
    let keyCurrency = null;
    let base = k;
    if (!PRICE_MAX_KEYS.has(k) && k.length > 3) {
      const suffix = k.slice(-3).toUpperCase();
      if (KNOWN_CURRENCIES.has(suffix) && PRICE_MAX_KEYS.has(k.slice(0, -3))) {
        base = k.slice(0, -3);
        keyCurrency = suffix;
      }
    }
    if (!PRICE_MAX_KEYS.has(base)) continue;
    const parsed = parseCeilingValue(value);
    if (parsed === null || parsed.amount <= 0) {
      // A refused value under a ceiling key is DISCLOSED, whatever its type: `nonEmpty` only sees
      // strings, so `price_max: [40]` (schema-legal) used to produce no metadata at all — byte-identical
      // to sending no constraint, which is the ambiguity this disclosure exists to remove.
      if (value !== null && value !== undefined && value !== '') {
        unstructured = parsed === null ? 'unstructured_value' : 'out_of_range_value';
      }
      continue;
    }
    // The winning (smallest) ceiling carries its own currency; a losing ceiling never lends it one.
    if (best === null || parsed.amount < best.limit) best = { limit: parsed.amount, currency: parsed.currency || keyCurrency };
  }
  if (best === null) return unstructured ? { unstructured } : null;
  const currency = best.currency || declaredCurrency;
  return { limit: best.limit, currency: currency || DEFAULT_PRICE_MAX_CURRENCY, declared: Boolean(currency), unstructured };
}

/**
 * Deterministic comparison of a structured price ceiling against the GROUNDED catalog price on a
 * projected signal — the check the LLM cannot be trusted to do (live 2026-08-20: a $45 product answered
 * "under $40" with a why[] line claiming budget fit).
 *
 * Returns 'ok' | 'violation' | 'unverifiable'. A price in a DIFFERENT currency than the ceiling is
 * `unverifiable`, never a violation: this bridge holds no FX rates, and comparing 4500 JPY against a
 * ceiling of 40 would fabricate both directions — a clean pass for 35 GBP over a $40 cap, and a bogus
 * violation for a ¥4500 item well under it. A price with NO currency is unverifiable for the same
 * reason: every grounded row carries one (normalizePriceObject stamps a currency on every return path),
 * so a currency-less amount is an unnormalized row whose unit is genuinely unknown — assuming the
 * ceiling's own would fabricate exactly the comparison this function exists to refuse. An item with no
 * resolvable price is likewise unverifiable (ungrounded items carry no price by construction).
 */
function checkPriceMax(signal, ceiling) {
  const product = signal?.value?.product || {};
  const price = product.price;
  if (typeof price !== 'number') return 'unverifiable';
  if (!nonEmpty(product.currency)) return 'unverifiable';
  if (product.currency.toUpperCase() !== ceiling.currency) return 'unverifiable';
  return price > ceiling.limit ? 'violation' : 'ok';
}

function stripBudgetClaims(lines) {
  return lines.filter((line) => !assertsBudgetFit(line));
}

/** Mark a violating signal in place: fit downgraded, machine-readable violation, false claims stripped. */
function markPriceViolation(signal, ceiling) {
  const v = signal.value;
  const price = v.product.price;
  // Guaranteed present: checkPriceMax only returns 'violation' for a price whose currency matches the
  // ceiling's. Never fall back to the ceiling's currency here — that would launder an ASSUMED unit into
  // the machine-readable field partner agents are told to trust.
  const currency = v.product.currency.toUpperCase();
  // Any budget-fit claim on an item that FAILED the comparison is false — strip it rather than forward
  // it to a partner agent that will trust it. This is the bridge's job, not the sanitizer's. watchouts
  // is stripped too: `constraint_notes` is the lane's OWN field for constraint commentary, so it is the
  // likeliest home for "stays under your $40 budget" — the very claim this pass exists to kill.
  v.why = stripBudgetClaims(v.why);
  v.notes = stripBudgetClaims(v.notes);
  const marker = `exceeds price_max ${ceiling.limit} ${ceiling.currency}: price ${price} ${currency}`;
  // The marker leads so the 6-item watchouts cap can never truncate it away.
  v.watchouts = dedupe([marker, ...stripBudgetClaims(v.watchouts)]).slice(0, 6);
  // Only ever a DOWNGRADE: where the lane emitted no score there is no band to assert, and inventing
  // one would be the same fabrication this file's header guards against.
  v.fit = { ...v.fit, level: v.fit.level === null ? null : 'low' };
  v.constraint_violations = [{
    constraint: 'price_max',
    limit: ceiling.limit,
    limit_currency: ceiling.currency,
    price,
    currency,
  }];
  return signal;
}

/**
 * An item whose price could not be compared (no price, no currency, or a different currency) carries an
 * explicit marker so a partner agent can tell "checked and clean" from "could not be checked".
 *
 * Budget-FIT assertions are stripped here too. An unverified claim is not a proven-false one, but the
 * premise of this whole pass is that a partner agent trusts `why[]`: forwarding "fits comfortably within
 * your $40 budget" on an item the bridge has just declared uncheckable relays precisely the assertion it
 * cannot stand behind. Only fit assertions go — every other reason, including subjective price praise
 * and every safety warning, survives untouched.
 */
function markPriceUnverifiable(signal, ceiling) {
  const v = signal.value;
  const product = v.product;
  let detail;
  if (typeof product.price !== 'number') detail = 'no catalog price';
  else if (!nonEmpty(product.currency)) detail = 'price carries no currency';
  else detail = `price in ${product.currency}, ceiling in ${ceiling.currency}`;
  v.why = stripBudgetClaims(v.why);
  v.notes = stripBudgetClaims(v.notes);
  v.watchouts = dedupe([
    `price_max ${ceiling.limit} ${ceiling.currency} not verified: ${detail}`,
    ...stripBudgetClaims(v.watchouts),
  ]).slice(0, 6);
  return signal;
}

/**
 * The agent's uid for the lane: namespaced, stable per calling agent, never a consumer uid.
 *
 * The lane keys its anti-repeat diversity memory on this, so it must be stable per caller AND
 * distinct between callers: one shared `agent:anonymous` bucket would let one caller's history
 * filter another's results. Callers with no resolved agent_id fall back to the auth key's
 * fingerprint (already non-reversible), and only a wholly unauthenticated context lands in the
 * shared bucket.
 */
function agentLaneUid(ctx) {
  const agentId = str(ctx?.agent_id) || str(ctx?.invokeAuth?.agent_id);
  if (agentId) return `agent:${agentId}`;
  const fingerprint = str(ctx?.invokeAuth?.key_fingerprint);
  if (fingerprint) return `agentkey:${fingerprint}`;
  return 'agent:anonymous';
}

/** Normalize + bound the model's constraints into the lane's free-form map (strings only, bounded). */
function normalizeConstraints(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = str(key);
    if (!k || k.length > 64 || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    let rendered;
    if (Array.isArray(value)) rendered = value.map((x) => str(typeof x === 'number' ? String(x) : x)).filter(Boolean).slice(0, 8).join(', ');
    else if (typeof value === 'number' && Number.isFinite(value)) rendered = String(value);
    else if (typeof value === 'boolean') rendered = value ? 'yes' : 'no';
    else if (isPlainObject(value)) {
      try { rendered = JSON.stringify(value); } catch { rendered = ''; }
    } else rendered = str(value);
    if (!rendered) continue;
    out[k] = rendered.slice(0, MAX_CONSTRAINT_VALUE_CHARS);
    if (Object.keys(out).length >= MAX_CONSTRAINT_KEYS) break;
  }
  return out;
}

/**
 * One lane recommendation item → one `recommendation` Signal. Returns null for an item with no identity.
 *
 * THE FIELD NAMES COME FROM THE LANE'S OWN OUTPUT CONTRACT — prompts/reco_main_v1_2.user_schema.json
 * (`output_schema.recommendations[]`): slot, step, score, product_type, brand, name, display_name,
 * use_case, concern_match, skin_fit, constraint_notes, query_terms, reasons, sku{…}, missing_info,
 * warnings — plus what `buildRecoVisibleProductFields` attaches on the grounded path (price as a
 * `{amount, currency}` OBJECT, image_url, url/pdp_url/product_url) and what `coerceRecoItemForUi`
 * normalizes (notes, pdp_open, grounding_status). An earlier version read `why_candidate`,
 * `watchouts`, `fit_level`, `evidence_grade` and `pdp_open.directUrl` — none of which this lane
 * emits — so every real call answered with empty reasoning and a null price.
 */
function recommendationItemToSignal(item, { rank } = {}) {
  if (!isPlainObject(item)) return null;
  const sku = isPlainObject(item.sku) ? item.sku : isPlainObject(item.product) ? item.product : {};
  const pdpOpen = isPlainObject(item.pdp_open) ? item.pdp_open : {};
  const external = isPlainObject(pdpOpen.external) ? pdpOpen.external : {};
  const pdpSubject = isPlainObject(pdpOpen.subject) ? pdpOpen.subject : {};

  const productId = firstString(sku.product_id, sku.productId, item.product_id, item.productId);
  const merchantId = firstString(sku.merchant_id, item.merchant_id);
  const title = firstString(sku.display_name, sku.displayName, sku.name, item.display_name, item.displayName, item.name, item.title);
  const brand = firstString(sku.brand, item.brand);
  const category = firstString(sku.category, item.category, item.product_type);
  const url = firstString(external.url, item.pdp_url, item.pdpUrl, item.url, item.product_url, sku.pdp_url);
  // Internally-grounded items open through Pivota rather than a direct URL: surface the ref the
  // platform can hand back to get_product instead of leaving the agent with an id it cannot open.
  const productRef = firstString(pdpOpen.product_ref, pdpSubject.product_group_id, pdpSubject.id);
  const imageUrl = firstString(sku.image_url, sku.imageUrl, item.image_url, item.imageUrl);
  // The lane's price is a normalized OBJECT ({amount, currency, unknown}) built by
  // extractCatalogCandidatePrice; a bare number/string only appears on unnormalized rows.
  const priceObj = isPlainObject(item.price) ? item.price : isPlainObject(sku.price) ? sku.price : null;
  const price = finiteNumber(priceObj ? priceObj.amount : (sku.price ?? item.price));
  const currency = firstString(priceObj && priceObj.currency, sku.currency, item.currency);
  const grounded = item.grounding_status !== 'ungrounded';

  // A recommendation with neither an id nor a name is not something an agent can act on.
  if (!productId && !title) return null;

  // `reasons` is the lane's per-item rationale; `use_case`, `concern_match` and `skin_fit` say who
  // and what it is for. coerceRecoItemForUi folds some of these into `notes`, so both are read and
  // deduplicated.
  const why = [
    ...asStringArray(item.reasons, 6),
    ...asStringArray(item.use_case, 1),
    ...asStringArray(item.concern_match, 3),
    ...asStringArray(item.skin_fit, 3),
  ];
  const notes = asStringArray(item.notes, 6).filter((n) => !why.includes(n));
  // Real caution content: the per-item warnings the lane emits (its SAFETY field — photosensitivity,
  // patch-testing, interactions) and constraint_notes (why a constraint forced or blocked something).
  // WARNINGS LEAD on purpose: downstream passes prepend up to three bookkeeping lines (ceiling marker,
  // price-update, out-of-stock) against the 6-slot cap, and whatever sits LAST in this array is what
  // eviction takes first. With constraint_notes first, four of them plus the markers pushed every
  // safety warning off the list — the #2036 failure class reached by eviction instead of deletion.
  const watchouts = [...asStringArray(item.warnings, 4), ...asStringArray(item.constraint_notes, 4)];

  return {
    signal_type: 'recommendation',
    subject: { kind: 'product', id: productId || null },
    value: {
      rank: Number.isInteger(rank) ? rank : null,
      product: {
        product_id: productId || null,
        merchant_id: merchantId || null,
        title: title || null,
        brand: brand || null,
        category: category || null,
        price,
        currency: currency || null,
        url: url || null,
        // A canonical ref the platform can pass to get_product when there is no direct URL.
        product_ref: productRef || null,
        image_url: imageUrl || null,
      },
      why: dedupe(why).slice(0, 8),
      watchouts: dedupe(watchouts).slice(0, 6),
      notes: notes.slice(0, 4),
      routine_step: firstString(item.step, item.slot),
      product_type: firstString(item.product_type),
      // Grounded = resolved to a product in Pivota's catalog; ungrounded = the lane named a product it could
      // not resolve, and such items carry NO url/price by construction (the lane strips them).
      grounding: grounded ? 'catalog' : 'ungrounded',
      fit: {
        // Not a bare `confidence`/`score`: the sanitizer removes those keys from product-shaped nodes.
        // The lane emits an integer 0-100 `score`; it is surfaced as a BAND, which is what an agent can
        // act on, and lane-level certainty stays on metadata.confidence_overall.
        //
        // UNGROUNDED items carry NO band (live 2026-08-20: an invented "Hydrating Amino Acid Gel
        // Cleanser" rode fit=high above a real catalog item — while the deterministic price gate had
        // capped the REAL item to fit=low, so the model's own score outranked the only thing an agent
        // could actually buy). Fit-to-catalog is unmeasurable for a product that is not in the catalog;
        // an asserted band there is a model claim with no object, the class this file exists to strip.
        level: grounded ? scoreBand(finiteNumber(item.score)) : null,
      },
    },
    evidence: {
      // This lane is an LLM recommendation grounded (or not) in Pivota's catalog — it carries no
      // graded evidence bundle. `get_intel` is the tool that does; the description says so, and
      // inventing a grade here would be exactly the fabrication this repo keeps removing.
      method: grounded ? 'llm_recommendation_catalog_grounded' : 'llm_recommendation',
    },
    visibility: 'buyer_safe',
  };
}

/**
 * @param {{
 *   generate: (args:object) => Promise<object>,   // Aurora routes.__internal.generateProductRecommendations
 *   buildAsk?: ({focus, constraints, lang}) => string, // routes.__internal.buildRecoGenerateUserAsk
 *   isEnabled?: () => boolean,                     // agent-surface flag (fail-closed when absent)
 *   verifyPrice?: ({product_id, merchant_id, product_ref}) => Promise<{price, currency, in_stock?}|{unresolvable:true}|null>,
 *     // live PDP/offer lookup for a grounded item (server.js wires get_pdp_v2 over loopback); absent =
 *     // no re-verification, items keep their catalog-snapshot price with no price_verified key at all.
 *     // `{unresolvable:true}` means the lookup answered a DEFINITIVE not-found (the id is dead on the
 *     // same read chain get_product serves) — the item is DROPPED from the shortlist, unlike null,
 *     // which only degrades it to an unverified snapshot price. `{unresolvable:true, confirm:true}`
 *     // is the AMBIGUOUS flavor (an envelope a transient dependency blip can also mint): the bridge
 *     // probes that item once more, and only a repeated unresolvable answer buys the drop
 *   logger?: { warn?: Function, info?: Function },
 *   budgetMs?: number,
 *   now?: () => number,
 *   newId?: () => string,
 *     // opaque id body for the outcome-graph join keys (recommendation_id / recommendation_set_id);
 *     // defaults to 12 random bytes as hex. Injected only so tests can pin them.
 * }} deps
 */
function makeRecommendProducts(deps = {}) {
  const { generate, buildAsk, isEnabled, logger, verifyPrice } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  // Injectable so a test can pin the join keys; `crypto.randomBytes` by default rather than
  // Math.random because these ids are the primary key of the outcome graph and a collision silently
  // merges two buyers' outcomes onto one row. 12 bytes = 96 bits, which is far past birthday-collision
  // risk at any plausible recommendation volume.
  const newId = typeof deps.newId === 'function'
    ? deps.newId
    : () => require('crypto').randomBytes(12).toString('hex');
  const budgetMs = Number.isFinite(deps.budgetMs) && deps.budgetMs > 0 ? deps.budgetMs : DEFAULT_BUDGET_MS;
  if (typeof generate !== 'function') throw new Error('makeRecommendProducts requires generate');

  return async function recommendProducts(params = {}, ctx = {}) {
    const p = (params && params.payload) || params || {};
    const need = str(p.need).slice(0, MAX_NEED_CHARS);
    // `text`, NOT `id`: resultSanitizer exempts id-shaped keys from PAN redaction on the premise that
    // their values are Pivota's own identifiers. This is buyer-authored prose, so it must sit under a
    // key that stays scrubbed.
    const subject = { kind: 'need', text: need || null };

    // Minted BEFORE the guards, not at the end, because three of this function's four
    // exits are early returns and an empty shortlist is exactly the case the key exists
    // for. `lane_unavailable` matters most: it is the only empty class that is a DEFECT
    // rather than a legitimate answer, and this lane has gone dark in prod before
    // (decision-service prompt-template skew). Those are the events an outcome graph most
    // needs to count, and minting at the end left them as the only ones with no key —
    // collapsing every lane outage into one null bucket.
    const recommendationSetId = `rset_${newId()}`;

    if (typeof isEnabled === 'function' && !isEnabled()) {
      return { subject, signals: [], metadata: { reason: 'disabled', recommendation_set_id: recommendationSetId } };
    }
    if (!need) {
      return { subject, signals: [], metadata: { reason: 'need_required', recommendation_set_id: recommendationSetId } };
    }

    const constraints = normalizeConstraints(p.constraints);
    const limitRaw = Number(p.limit);
    const limit = Number.isInteger(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, limitRaw)) : DEFAULT_LIMIT;
    const lang = str(p.language).toUpperCase() === 'CN' ? 'CN' : 'EN';
    const uid = agentLaneUid(ctx);
    const requestId = `rp_${Math.random().toString(36).slice(2, 12)}`;
    const laneCtx = {
      request_id: requestId,
      trace_id: requestId,
      aurora_uid: uid,
      brief_id: null,
      lang,
      ui_lang: lang,
      match_lang: lang,
      language_mismatch: false,
      language_resolution_source: 'agent_tool',
      trigger_source: 'agent_tool',
      state: null,
      backend_auth_headers: {},
    };
    const message = typeof buildAsk === 'function'
      ? buildAsk({ focus: need, constraints, lang })
      : `Recommend a few products for me with focus on ${need}.`;

    // Extracted BEFORE the lane runs, not only after it answers. Until now the ceiling reached the
    // lane exclusively as PROSE inside buildAsk, so recall was price-blind: live 2026-08-21 a
    // {price_max: 40} call returned 3 grounded items at 45/45/60 USD -- honestly flagged, but the
    // whole shortlist -- while the catalog held 40+ conforming products at or under 40 USD. Passing
    // it as a first-class argument lets the recall pool prefer conforming candidates; the post-hoc
    // enforcement below is unchanged and still has the last word.
    const ceiling = extractPriceMax(isPlainObject(p.constraints) ? p.constraints : null);
    const enforcing = ceiling !== null && Number.isFinite(ceiling.limit);

    const startedAt = now();

    // OFF-VERTICAL: answer with an empty shortlist and a REASON, before spending a lane generation on
    // a need this lane cannot serve. See offVerticalMarker for why the rule is shaped the way it is.
    // The full metadata block is returned (not the thin `reason:` shape the disabled/need_required
    // exits use) because this is a legitimate ANSWER, not a failure: a partner agent has to be able to
    // tell "we cannot help with this" from "we broke", and `products_empty_reason` is the field the
    // description points it at.
    const offVerticalAnswer = (marker, detectedBy) => ({
      subject,
      signals: [],
      metadata: {
        need,
        constraints,
        limit,
        returned: 0,
        recommendation_set_id: recommendationSetId,
        confidence_overall: null,
        // What Pivota would need for this to become answerable: a different lane. Said as the thing
        // the agent should DO, since missing_info is the field it reads to decide whether to re-ask.
        missing_info: [
          lang === 'CN'
            ? '该推荐通道目前仅覆盖美妆/护肤品类，无法回答此需求。'
            : 'This recommendation lane covers beauty/skincare only; it cannot serve this need.',
        ],
        warnings: [
          lang === 'CN'
            ? `需求涉及非美妆品类（“${marker}”），已返回空结果，未生成任何推荐。`
            : `The need names an off-vertical domain ("${marker}"); returned an empty shortlist rather than beauty products.`,
        ],
        grounding_status: null,
        source_mode: null,
        products_empty_reason: 'off_vertical',
        vertical: 'beauty',
        // The phrase that fired, so a partner (and we) can audit the gate's precision from logs
        // instead of guessing which word refused a buyer.
        off_vertical_marker: marker,
        off_vertical_detected_by: detectedBy,
        latency_ms: now() - startedAt,
      },
    });

    const offVertical = offVerticalMarker(need);
    if (offVertical) {
      logger?.info?.(
        { recommendation_set_id: recommendationSetId, marker: offVertical, detected_by: 'need_lexicon' },
        'recommend_products refused an off-vertical need',
      );
      return offVerticalAnswer(offVertical, 'need_lexicon');
    }
    let result;
    try {
      result = await generate({
        ctx: laneCtx,
        profile: null,
        recentLogs: [],
        message,
        focus: need,
        analysisContextSnapshot: null,
        requestOverride: null,
        includeAlternatives: false,
        debug: false,
        logger,
        recoTriggerSource: 'agent_tool',
        entryType: 'direct',
        budgetMs,
        // Only an ENFORCING ceiling is threaded. A `price_max` the extractor refused (prose, an array,
        // a non-positive number) must leave recall exactly as it is today rather than silently biasing
        // it on a value nobody could parse.
        ...(enforcing ? { priceCeiling: { limit: ceiling.limit, currency: ceiling.currency } } : {}),
        // The caller's own limit, so the lane knows how many CONFORMING products the shortlist should
        // hold. Without it the lane has no idea whether one conforming item is the whole answer or a
        // third of it.
        shortlistTarget: limit,
      });
    } catch (err) {
      // The set id goes IN THE LOG, not just the response. `lane_unavailable` returns zero
      // items, so the agent has no outcome to report and nothing would otherwise record this
      // id server-side — leaving every lane outage in one unjoinable bucket, which is the
      // exact gap minting-before-the-guards was meant to close. Minting alone did not close
      // it; this line is the other half.
      logger?.warn?.(
        { err: err?.message || String(err), recommendation_set_id: recommendationSetId },
        'recommend_products lane failed',
      );
      return { subject, signals: [], metadata: { reason: 'lane_unavailable', latency_ms: now() - startedAt, recommendation_set_id: recommendationSetId } };
    }
    const norm = isPlainObject(result?.norm) ? result.norm : null;
    const payload = isPlainObject(norm?.payload) ? norm.payload : isPlainObject(norm) ? norm : {};
    const items = Array.isArray(payload.recommendations) ? payload.recommendations : [];

    // DETERMINISTIC CONSTRAINT ENFORCEMENT. The lane only ever sees constraints as prompt text
    // (normalizeConstraints → buildAsk), so nothing upstream guarantees the shortlist honours them —
    // live 2026-08-20 a "under $40" need answered with a $45 product whose why[] asserted budget fit.
    // With a structured price ceiling present, verified-conforming items fill the limit FIRST (lane
    // order preserved); violating items are kept only in slots left over, each carrying an explicit
    // machine-readable violation — so a near-miss is still visible when the shortlist is thin, but can
    // never displace a conforming item, and never travels as a clean recommendation.
    const projected = [];
    for (const item of items) {
      const s = recommendationItemToSignal(item, {});
      if (s) projected.push(s);
    }
    // NOTHING UNBUYABLE LEAVES THIS FUNCTION. Two independent ways a signal can carry no purchasable
    // identity; both are suppressed HERE, the one point every exit below flows through.
    //
    //  (1) UNGROUNDED — the lane named a product it could not resolve, so product_id, price, url and
    //      image are all null by construction. An earlier revision RANKED these last instead of
    //      dropping them, on the theory that an advisory archetype is still worth something to an
    //      agent. Live 2026-09-08 settled it: a "Daily Broad Spectrum SPF 30 Sunscreen" with every
    //      identity field null reached a partner agent as rank 3 of 3, in a tool whose own description
    //      promises that exact case never happens ("never with fabricated products"). Ranking it last
    //      was never the fix — a commerce door's shortlist is a list of things to BUY, and an item an
    //      agent can neither open, price nor purchase is not a weaker recommendation, it is a
    //      different kind of object. It travels on `metadata.unresolved_archetypes` now, as TEXT,
    //      where it cannot be mistaken for something with a product identity.
    //      NOTE the count was already computed before this change (`ungrounded_returned`) — the
    //      condition was detected and then not acted on, which is the whole defect.
    //
    //  (2) A NULL product_id on an item that claims catalog grounding — a lane defect rather than a
    //      design choice (grounding_status is ABSENT on some rows and absence reads as grounded, so an
    //      item with a name and no id projects to grounding 'catalog' with product_id null). Rare, and
    //      it must not reach a caller either: the chain contract this file already enforces on the
    //      verifier path is "never advertise a product_id that get_product cannot resolve", and null
    //      is the strongest form of that. Filtering on grounding ALONE would leave this one open, so
    //      the id is checked on its own terms.
    //
    // Lane order is preserved among the survivors.
    const suppressed = { ungrounded: 0, unidentified: 0 };
    const unresolvedArchetypes = [];
    let groundedSignals = [];
    for (const s of projected) {
      if (s.value.grounding !== 'catalog') {
        suppressed.ungrounded += 1;
        // The archetype is the only part worth keeping: "look for a broad-spectrum SPF 30".
        const name = str(s.value.product.title);
        if (name) unresolvedArchetypes.push(name);
        continue;
      }
      if (!nonEmpty(s.value.product.product_id)) {
        suppressed.unidentified += 1;
        // The title goes to the SAME place as an ungrounded archetype's. From a caller's side these
        // are one thing — "a product the lane named but could not resolve" — and the description says
        // such products appear there. Counting this one and dropping its name silently made that
        // sentence false for exactly the route the grounding filter does not cover, and a named
        // product would vanish leaving only an integer.
        const named = str(s.value.product.title);
        if (named) unresolvedArchetypes.push(named);
        continue;
      }
      groundedSignals.push(s);
    }
    if (suppressed.unidentified > 0) {
      logger?.warn?.(
        { recommendation_set_id: recommendationSetId, count: suppressed.unidentified },
        'recommend_products suppressed catalog-grounded items carrying no product_id',
      );
    }

    // LIVE PRICE RE-VERIFICATION (grounded items only; there is nothing to verify on an invented
    // product). The lane's price is a catalog-offer snapshot; the injected `verifyPrice` resolves the
    // same PDP/offer lane the public product page renders from, so a stale snapshot is corrected
    // BEFORE the ceiling is enforced — the gate must judge the price the buyer would actually see.
    // Bounded: only items that could reach the shortlist are checked, in parallel, and a failed or
    // slow check degrades to the snapshot price with `price_verified: false` — never an error. The
    // ONE outcome that removes an item is a definitive `{unresolvable:true}`: the loopback proved the
    // id this item would advertise answers PRODUCT_NOT_FOUND on the very read chain get_product
    // serves, so returning it breaks the chain contract ("never advertise a product_id that
    // get_product cannot resolve" — the same rule the public search projector enforces). Only the
    // proven envelope buys a drop; a timeout or error must never buy a delisting. Each signal
    // records the outcome so a partner agent knows what it is holding.
    let verification = null;
    if (typeof verifyPrice === 'function' && groundedSignals.length > 0) {
      // The window is sized to what can actually RETURN: without a ceiling the first `limit` grounded
      // items ARE the shortlist, so nothing beyond them is checked (each check is a loopback invoke —
      // fanning out for items that cannot appear is pure backend load); with a ceiling, re-slotting can
      // pull items from just past the limit, so a small margin rides along. Hard-capped regardless: a
      // limit-10 caller must not turn one tool call into 12 concurrent PDP lookups against a pool this
      // repo has wedged before. Anything returned UNCHECKED is marked `price_verified: false` and
      // counted below — an absent key must never read as "checked and clean".
      const toVerify = groundedSignals.slice(0, Math.min(
        enforcing ? limit + PRICE_VERIFY_EXTRA : limit,
        PRICE_VERIFY_MAX_CHECKS,
      ));
      verification = { checked: toVerify.length, confirmed: 0, updated: 0, unavailable: 0, unresolvable: 0, unchecked: 0 };
      const unresolvableSignals = new Set();
      await Promise.all(toVerify.map(async (s) => {
        const product = s.value.product;
        const probe = async () => {
          try {
            return await Promise.race([
              verifyPrice({ product_id: product.product_id, merchant_id: product.merchant_id, product_ref: product.product_ref }),
              new Promise((resolve) => { const t = setTimeout(() => resolve(null), PRICE_VERIFY_RACE_MS); if (t.unref) t.unref(); }),
            ]);
          } catch { return null; }
        };
        let live = await probe();
        if (isPlainObject(live) && live.unresolvable === true && live.confirm === true) {
          // The AMBIGUOUS not-found (see classifyVerifyPriceResponse): a transient dependency blip
          // mints the same body as a truly absent row, so this envelope must be seen TWICE before
          // it buys a drop. A second answer carrying a price — or nothing at all — wins the item
          // back to the ordinary degrade path.
          live = await probe();
        }
        if (isPlainObject(live) && live.unresolvable === true) {
          // Grounded in Aurora's corpus, dead on the serving chain (live repro 2026-08-26: the lane's
          // top acne picks 404'd on get_product). Dropped, and the slot backfills from the remaining
          // grounded candidates below.
          unresolvableSignals.add(s);
          verification.unresolvable += 1;
          return;
        }
        const livePrice = finiteNumber(isPlainObject(live) ? live.price : null);
        const liveCurrency = isPlainObject(live) ? str(live.currency).toUpperCase() : '';
        // A live answer is trusted only when it is a POSITIVE amount in a KNOWN currency. `price: 0` is a
        // documented broken-offer shape in this catalog (offer_price_missing) — writing it through would
        // flip a $45 violator to "live-verified, within budget" at price 0, the strongest claim this
        // surface can make, on a fabrication. And an unrecognized currency must not launder a hard
        // violation into "unverifiable" — the same allowlist that guards the CEILING side (a caller's
        // `price_max_currency: 'XYZ'` cannot suppress enforcement) guards the live side here.
        if (livePrice === null || livePrice <= 0 || !liveCurrency || !KNOWN_CURRENCIES.has(liveCurrency)) {
          product.price_verified = false;
          verification.unavailable += 1;
          return;
        }
        const changed = product.price !== livePrice || str(product.currency).toUpperCase() !== liveCurrency;
        if (changed) {
          // Said out loud on the item: a partner that cached the snapshot price learns it moved.
          s.value.watchouts = dedupe([
            `price updated by live check: ${product.price ?? 'unknown'} ${product.currency || ''} -> ${livePrice} ${liveCurrency}`.replace(/\s+/g, ' '),
            ...s.value.watchouts,
          ]).slice(0, 6);
          product.price = livePrice;
          product.currency = liveCurrency;
          verification.updated += 1;
        } else {
          verification.confirmed += 1;
        }
        product.price_verified = true;
        if (isPlainObject(live) && live.in_stock === false) {
          s.value.watchouts = dedupe(['live availability check: out of stock', ...s.value.watchouts]).slice(0, 6);
        }
      }));
      if (unresolvableSignals.size > 0) {
        logger?.warn?.(
          {
            dropped_product_ids: [...unresolvableSignals].map((s) => s.value.product?.product_id ?? null),
          },
          'recommend_products dropped items unresolvable on the read chain',
        );
        groundedSignals = groundedSignals.filter((s) => !unresolvableSignals.has(s));
      }
    }

    let signals;
    let violationsReturned = 0;
    let unverifiedReturned = 0;
    if (!enforcing) {
      signals = groundedSignals.slice(0, limit);
    } else {
      // Verified-conforming first, then price-unverifiable, then known violations: a slot never goes
      // to an item known to breach the ceiling while one that honours it is waiting. There is no
      // fourth rung any more — ungrounded advisories used to backfill the leftover slots here, and
      // they are suppressed above instead.
      const verdicts = new Map(groundedSignals.map((s) => [s, checkPriceMax(s, ceiling)]));
      signals = groundedSignals.filter((s) => verdicts.get(s) === 'ok').slice(0, limit);
      for (const rung of ['unverifiable', 'violation']) {
        for (const s of groundedSignals) {
          if (signals.length >= limit) break;
          if (verdicts.get(s) !== rung) continue;
          if (rung === 'violation') { signals.push(markPriceViolation(s, ceiling)); violationsReturned += 1; }
          else { signals.push(markPriceUnverifiable(s, ceiling)); unverifiedReturned += 1; }
        }
      }
    }
    signals.forEach((s, i) => { s.value.rank = i + 1; });
    // Coverage honesty: with a ceiling, re-slotting can return a grounded item from beyond the
    // verification window (a conforming item the lane ranked low). It carries `price_verified: false`
    // like any other unchecked price, and `unchecked` counts it — otherwise "checked N, unavailable 0"
    // over a shortlist containing an unexamined #1 reads as full coverage, the exact absence-as-clean
    // misreading this metadata exists to prevent.
    if (verification) {
      for (const s of signals) {
        // Every survivor is catalog-grounded now (see the suppression above), so there is no
        // grounding test here: an ungrounded item can no longer reach this loop to be skipped.
        if (s.value.product.price_verified === undefined) {
          s.value.product.price_verified = false;
          verification.unchecked += 1;
        }
      }
    }
    // OUTCOME-GRAPH JOIN KEYS. Everything the card rail needs to measure — did the agent complete,
    // at what actual total, and if not then why — has to join back to the specific recommendation it
    // acted on. Today nothing here is addressable: `click_id` is minted at REDIRECT-BUILD time, one
    // hop too late and only on the `/r?token=` path, so a partner that drives checkout from the
    // item's own url is unattributable by construction.
    //
    // TWO ids, because they answer different questions:
    // NOT `primary_recommendation_id`, which already exists on the consumer /v1/reco/generate
    // envelope (src/auroraBff/legacyRecoGenerationResult.js and friends) and whose value is a
    // PRODUCT id, not a minted join key. Two similarly-named keys with different types in one lane
    // is a foot-gun for whoever wires the outcome table; they never meet, because both the item
    // projector and the metadata block pick fields explicitly and neither spreads the lane payload.
    //
    //   recommendation_id      per ITEM — the handoff key. An agent hands off ONE item and the
    //                          outcome is about that item, so this is what an outcome row keys on.
    //                          Self-contained on purpose: reporting an outcome must not require
    //                          sending back a tuple.
    //   recommendation_set_id  per RESPONSE — correlates the shortlist, so "which of the three did
    //                          they pick, and were the others cheaper?" stays answerable.
    //
    // STAMPED LAST, deliberately. Ordering, live re-verification and the price-marker passes all
    // MUTATE `s.value` in place above (see markPriceViolation). Minting here means the id travels
    // with the item exactly as returned and cannot be dropped by an earlier pass that rewrites part
    // of the node — the failure mode that lost a budget marker in #2070.
    //
    // KEEP THE `rec_` / `rset_` PREFIX — but for the reason below, not the one first written here.
    // resultSanitizer treats any key ending in "id" as an id key, and `recommendationid` is NOT in
    // its PAN_EXEMPT_ID_KEYS set, so these VALUES are Luhn-gated PAN-scanned. The original comment
    // claimed a bare all-digit body would therefore be redacted. It would not, at today's length:
    // `PAN_RE` is /\b(?:\d[ -]*?){13,19}\b/ and needs a word boundary at BOTH ends, so a 24-digit
    // run contains no bounded 13-19 substring and never matches (verified: '4'.repeat(24) -> null),
    // and luhnValid rejects anything longer than 19 anyway.
    //
    // The prefix is DEFENCE-IN-DEPTH against the id body ever getting shorter. Drop it and shorten
    // `newId` to 8 bytes and the body becomes 16 digits — a matchable, Luhn-checkable length — and a
    // join key would silently become [REDACTED_PAN] for roughly ONE RECOMMENDATION IN 18,000:
    // (10/16)^16 = 5.4e-4 that 16 hex chars are all digits, times ~1/10 for Luhn. (Earlier revisions
    // of this comment said "a few million"; that was wrong by ~150x, and it is the third arithmetic
    // claim here to not survive being checked — so it is now shown, not asserted.) A defect at that
    // rate is frequent enough to corrupt real joins and rare enough that nobody ever traces it. `PAN_RE` starts with `\b` and `_` is a word character,
    // so a digit run immediately after an underscore can never begin a match at ANY length. That is
    // what makes the prefix worth keeping regardless of what `newId` later returns.
    for (const s of signals) {
      s.value.recommendation_id = `rec_${newId()}`;
    }

    const meta = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
    const confidence = finiteNumber(payload.confidence);
    // Measured HERE, after verification and slotting: a 2s live-price pass is real wall time the
    // partner waited; stamping the lane's latency alone would understate the call by that much.
    const latencyMs = now() - startedAt;

    return {
      subject,
      signals,
      metadata: {
        need,
        constraints,
        limit,
        returned: signals.length,
        // See the join-key block above. On metadata rather than on each item because it identifies
        // the RESPONSE, not a product — and an empty shortlist is still a recommendation event worth
        // being able to point at ("we were asked and returned nothing" is a measurable outcome).
        recommendation_set_id: recommendationSetId,
        // Lane-level certainty. On metadata on purpose: the sanitizer strips `confidence` from PRODUCT nodes;
        // this node carries no product identity.
        confidence_overall: confidence,
        missing_info: asStringArray(payload.missing_info, 8),
        warnings: asStringArray(payload.warnings, 8),
        grounding_status: firstString(payload.grounding_status, meta.grounding_status) || null,
        source_mode: firstString(meta.source_mode, payload.source) || null,
        // When the shortlist emptied because the resolvability pass dropped everything, say THAT —
        // 'no_recommendations' would blame the lane for items it actually produced.
        products_empty_reason: signals.length === 0
          ? firstString(payload.products_empty_reason, result?.upstreamFailureCode)
            || (verification && verification.unresolvable > 0 ? 'unresolvable_on_read_chain' : null)
            // The lane DID answer, but every item it produced was an archetype it could not resolve
            // (or carried no id). 'no_recommendations' would blame it for producing nothing when the
            // truth is that nothing it produced was buyable — a different problem with a different fix.
            || (suppressed.ungrounded + suppressed.unidentified > 0 ? 'no_grounded_recommendations' : 'no_recommendations')
          : null,
        vertical: 'beauty',
        latency_ms: latencyMs,
        // What was withheld, and why. `ungrounded_returned` used to live here and counted archetypes
        // that were RETURNED; nothing is returned any more, so the key would be permanently absent and
        // is gone. These replace it: a shortlist shorter than `limit` now has a stated reason rather
        // than looking like a thin catalog.
        ...(suppressed.ungrounded > 0 ? { ungrounded_suppressed: suppressed.ungrounded } : {}),
        // The archetypes themselves, as plain strings. Deliberately NOT product-shaped: the whole
        // point is that these have no product identity, and a node with a null `product_id` is exactly
        // what a partner agent showed a buyer on 2026-09-08.
        ...(unresolvedArchetypes.length > 0
          ? { unresolved_archetypes: dedupe(unresolvedArchetypes).slice(0, 8) }
          : {}),
        // A lane defect, not a policy outcome (see the suppression block): an item that claimed
        // catalog grounding and carried no id. Surfaced so it is countable rather than silent.
        ...(suppressed.unidentified > 0 ? { unidentified_suppressed: suppressed.unidentified } : {}),
        // Live-price check tallies (only when a verifier is wired and grounded items existed):
        // checked = confirmed + updated + unavailable + unresolvable; `updated` items carry the
        // corrected price and a watchout naming the move; `unavailable` items keep the snapshot with
        // price_verified: false; `unresolvable` items were DROPPED — the loopback proved their id
        // answers PRODUCT_NOT_FOUND on the read chain get_product serves, so they never reach the
        // shortlist (the count is the only trace, deliberately: an agent must not be handed a dead id
        // even in a diagnostic field).
        ...(verification ? { price_verification: verification } : {}),
        // What this pass actually enforced, so a partner agent can tell "all conforming" from "includes
        // flagged near-misses" from "could not be checked" — without rescanning items, and without
        // reading an absent marker as a clean bill of health.
        ...(enforcing ? {
          price_max_enforced: ceiling.limit,
          price_max_currency: ceiling.currency,
          // false = the ceiling's currency was assumed (see DEFAULT_PRICE_MAX_CURRENCY), not declared.
          price_max_currency_declared: ceiling.declared,
          constraint_violations_returned: violationsReturned,
          price_unverified_returned: unverifiedReturned,
          // Nothing in the shortlist could actually be compared (e.g. a ceiling declared in a currency
          // this catalog does not carry). `price_max_enforced: N` + `constraint_violations_returned: 0`
          // otherwise reads as "checked and all clean", which is the exact misreading this key exists
          // to prevent — so say it out loud even though a ceiling WAS present.
          ...(signals.length > 0 && unverifiedReturned === signals.length
            ? { price_constraint_unenforced: 'nothing_verifiable' }
            : {}),
        } : {}),
        // A budget-shaped constraint whose value could not be read as a ceiling: that constraint was not
        // enforced — including when a DIFFERENT, structured ceiling WAS (`{price_max: 40, budget: "under
        // $30"}` must not read as "enforced at 40, all clean" when the buyer asked for 30). Said out loud
        // so absence is never read as "checked and clean". Order matters: this spread sits after the
        // enforcing block, so in the corner where both fire (enforced ceiling, nothing verifiable, plus an
        // unreadable second constraint) the key reports the unread constraint — either value already means
        // "do not treat this shortlist as fully price-checked".
        ...(ceiling !== null && ceiling.unstructured ? { price_constraint_unenforced: ceiling.unstructured } : {}),
        // Counts only items projection could not IDENTIFY (items minus projected), not the whole
        // lane output: an empty shortlist can now also mean identified items were dropped as
        // unresolvable, and those belong to price_verification.unresolvable, not to this key.
        ...(signals.length === 0 && items.length > projected.length
          ? { dropped_unidentified_items: items.length - projected.length }
          : {}),
      },
    };
  };
}

/**
 * Classify the loopback get_pdp_v2 HTTP answer for the injected verifyPrice. Pure, and exported so
 * the server.js wiring and its tests read the SAME line — the `{unresolvable: true}` drop signal
 * must come from exactly one place. ONLY an HTTP 404 carrying the PRODUCT_NOT_FOUND envelope is
 * definitive (that is what the pdp_v2 lane answers for an id get_product cannot serve); a 404
 * without the code, and every other non-2xx, is null ("price unavailable") — cannot-verify must
 * never buy a delisting.
 * @param {number} status
 * @param {any} body
 * @returns {{unresolvable:true}|null|undefined} undefined = 2xx: the caller reads the price itself
 */
function classifyVerifyPriceResponse(status, body) {
  if (status === 404) {
    const b = isPlainObject(body) ? body : null;
    const code = b ? String(b.error || b.reasonCode || '').trim().toUpperCase() : '';
    // PRODUCT_NOT_SERVABLE is emitted ONLY after a SUCCESSFUL serving-eligibility read (server.js
    // get_pdp_v2 eligibility gate) — a definitive "get_product will not serve this id", with no
    // transient path that can mint it. It maps to the same NO_MERCHANT_OFFER the buyer would see.
    if (code === 'PRODUCT_NOT_SERVABLE') return { unresolvable: true };
    if (code === 'PRODUCT_NOT_FOUND') {
      // With details.reason (e.g. external_seed_not_active) the verdict came from a successful
      // read of the row — definitive. WITHOUT it, this is the rescue-fail emit, and that path
      // swallows dependency errors into null: a transient DB blip mints the SAME body as a truly
      // absent row. Ambiguous — the caller must CONFIRM it with a second probe before it may buy
      // a drop.
      const reason = b && isPlainObject(b.details) ? str(b.details.reason) : '';
      return reason ? { unresolvable: true } : { unresolvable: true, confirm: true };
    }
    // A 404 without either code (a proxy, a route miss) proves nothing.
    return null;
  }
  if (status < 200 || status >= 300) return null;
  return undefined;
}

// markPriceViolation/markPriceUnverifiable are exported ONLY so a test can pin that they mutate
// `signal.value` in place rather than rebuilding it. That is not an implementation detail — the
// join-key mint above is ordered after them precisely because of it, and without a direct
// assertion the ordering is unfalsifiable (verified: moving the mint earlier left every test green).
module.exports = { makeRecommendProducts, recommendationItemToSignal, normalizeConstraints, agentLaneUid, extractPriceMax, markPriceViolation, markPriceUnverifiable, classifyVerifyPriceResponse, offVerticalMarker };
