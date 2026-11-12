'use strict';

// EVERY CURRENCY AN ANSWER STATES, AND EVERY PRICE IT QUOTES. For tests that hold a door to the currency rule:
// a price for a market is in that market's currency, or the answer states no price at all.
//
// THE MARKET -> CURRENCY SOURCE these checks are meant to be used with is the gateway's one source:
// `resolveServingCurrency` (src/services/buyerMarket.js) over `BUYER_REGION_CURRENCY` (src/auroraBff/buyerRegion.js).
// A test asks that source for the market's currency and hands it to `assertAnswerCurrency`; this file keeps no
// market table. It requires nothing: no dependency, no I/O, no clock, no environment.
//
// WHAT IS WALKED: the whole parsed answer, every object and array, to any depth (cycles are not followed), whether it
// is a success value or an error body (`{ error: { code, message, detail } }`). A string that is itself a JSON object
// or array (a tool result's `content[].text`) is parsed and walked too, so a raw JSON-RPC body can be handed in whole.
// NO SUBTREE IS SKIPPED: what sits under a member that merely mentions a currency is walked like everything else.
//
// WHAT IS COLLECTED, each with the JSON path it was found at:
//
//   PRICES (judged by the rule)
//   - `priceCurrencies`: a member that LABELS A PRICE. Its name, with letter case and every `_` / `-` ignored, is
//     one of: `currency`, `currencycode`, `pricecurrency`, `pricecurrencycode`, `settlementcurrency`, `ccy` (so
//     `currency_code`, `currencyCode`, `currency-code`, `price_currency`, `priceCurrencyCode`, `settlement_currency`).
//     Its value is a string, or an object naming the code in `code`, `currency_code`, `currencyCode`, `iso_code` or
//     `isoCode` (`{ currency: { code: 'USD' } }`); the rest of such an object is walked like any other. One beside a
//     price says what that price is in; one with no price beside it still reads as "this is priced in X", so it is
//     held to the same rule. A label object no code can be read from is in `unreadableCurrencies` (and breaks the
//     rule: a currency nobody can read is not the market's).
//     AN EMPTY LABEL IS "NO LABEL HERE", AND IT STOPS INHERITANCE: an object whose only price-label members are
//     empty (`''`, blank, `null`, a boolean, a number, an unreadable object) says its own money has no currency. The
//     amounts in that object, and below it down to the next real label, are paired with NO currency: they never take
//     the label of an object further out (a line that says `currency: ''` under a GBP checkout is not a GBP line).
//     An empty label beside no amount is not a problem by itself (an unpriced row says `price: null, currency: null`).
//   - `money`: a member that QUOTES AN AMOUNT: a finite number (or numeric string) under a money name. A money name
//     is one of `price`, `amount`, `total`, `subtotal`, `tax`, `min_price`, `max_price`, `price_min`, `price_max`,
//     `shipping_cost`; any name whose LAST word is `price`, `amount`, `cost`, `fee`, `subtotal` or `tax`
//     (`unit_price`, `price_amount`, `current_price`, `compareAtPrice`, `shipping_fee`); or any name made ONLY of the
//     words price, amount, total, subtotal, cost, fee, tax (`amount_total`, `total_price`). So `total_count`,
//     `strict_total`, `price_ratio` and `price_as_of` are not money. A `price` / `money` object is walked into, and
//     an entry of a `totals` array is read through its `amount`. EACH AMOUNT IS PAIRED with the price label in its
//     scope: its own object's, else the nearest enclosing object's (`currency`, `currencyPath`; null when no object
//     above it states one).
//   - `textMoney`: money written in FREE TEXT, in any string value (see FREE TEXT below).
//
//   NOT PRICES (reported, never judged by the rule)
//   - `otherCurrencyMentions`: any OTHER member whose name contains "currenc" (`market_currency`,
//     `seller_currencies`, `serving_currency`, `metadata.serving_currency_guard`, `dropped_currencies`,
//     `withheld_currencies`, `price_currency_fill`, ...), with its raw value. These state a fact about a seller, a
//     market or what a guard removed; they do not price anything. A GB answer whose guard says it dropped `["USD"]`
//     mentions USD and serves no USD price.
//   - `currencyMentions`: the same members, as the currency codes each one names directly (a string code, or the
//     string codes of an array): `{ path, currencies }`. This is the class a caller reads to tell "a price was SERVED
//     in another currency" (a `priceCurrencies` / `money` / `textMoney` entry) from "a diagnostic NAMES another
//     currency" (an entry here). A mention is walked into: a price label or an amount INSIDE it is a price like any
//     other (`{ seller_currency_info: { price: 12, currency: 'USD' } }` quotes a USD price).
//   - `counts`: a `total` that counts rows, not money: one whose own object also has `products`, `page`, `page_size`,
//     `returned` or `has_next_page` (a search page's `{ products: [], total: 0 }`). Elsewhere `total` is money.
//
// FREE TEXT. Every string value is scanned, except the value of a member that is an identifier or a link by name
// (last word `id`, `ids`, `url`, `urls`, `uri`, `href`, `link`, `token`, `key`, `signature`, `cursor`, `sku`, `gid`):
// an opaque id can contain any letters. Two things are read as money in text:
//   - a currency SYMBOL directly before a number (one optional space): `$`, `£`, `€`, `¥`, and a dollar sign with a
//     capital-letter prefix: `US$` USD, `S$` SGD, `A$` / `AU$` AUD, `C$` / `CA$` CAD, `HK$` HKD, `NZ$` NZD, `R$` BRL,
//     `MX$` MXN, `NT$` TWD ("$12.00", "US$ 12", "£5", "CA$9"). A prefixed dollar sign is never read as a bare `$`:
//     any other prefix of one to three capitals at a word start (`XY$5`) is reported under that spelling, which is
//     no market's currency;
//   - one of these ISO 4217 CODES directly before or after a number (one optional space): USD EUR GBP SGD JPY AUD CAD
//     HKD NZD CNY KRW CHF SEK NOK DKK INR MXN BRL AED TWD THB MYR IDR PHP VND PLN ZAR SAR ("USD 12", "12 USD", "12GBP").
// `textMoney` entries are `{ path, currency, match }`: `currency` is the ISO code, or `'$'` for a bare dollar sign
// and `'¥'` for a yen/yuan sign, which are ambiguous: `$` is accepted for a market priced in USD, SGD, AUD, CAD, HKD,
// NZD or TWD, `¥` for JPY or CNY.
// `textCurrencyIs(currency, marketCurrency)` answers "is money written like this money in that market's currency".
// WHAT FREE TEXT DOES NOT CATCH: a currency named in words ("twelve dollars", "12 pounds", "GBP twelve"); a code or
// symbol not next to a digit ("priced in USD"); any ISO code outside the list above (notably TRY, ALL, TOP, GEL, PEN,
// MOP, which are also English words or product words); a code in lower or title case ("12usd", "Usd 12"); a symbol
// AFTER the number ("12 €", "12$"); a no-break space or any other non-ASCII space between the two; the fullwidth
// yen sign; other symbols (kr, Rs, ₩, ₹, Fr); a number written with a thousands separator after a code is matched
// on its first digits only; `$12` in an SGD answer (accepted: ambiguous); money inside a member skipped as an
// identifier or link.
//
// OTHER STATED LIMITS (not read as money, by design or not yet): an amount in minor units under a name that does not
// end in a money word (`amount_minor`, `price_cents`, `total_cents`); `line_total` and `grand_total` (a name ending
// in `total` is money only when every word in it is a money word); `price.value` and any amount under `value`;
// `discount`, `savings`, `msrp`; a plural list of bare amounts (`prices: [12, 15]`); a currency-keyed map
// (`{ USD: 12 }`) and an amount/currency tuple (`[12, 'USD']`); a numeric string with a thousands or decimal comma
// ("1,299.00", "12,50"); a price label under any other spelling than the ones listed above.

// Price-label member names, compared with letter case and every `_` / `-` removed.
const PRICE_CURRENCY_KEYS = new Set(['currency', 'currencycode', 'pricecurrency', 'pricecurrencycode', 'settlementcurrency', 'ccy']);
const isPriceLabelKey = (key) => PRICE_CURRENCY_KEYS.has(String(key).toLowerCase().replace(/[_-]/g, ''));
const CURRENCY_OBJECT_CODE_KEYS = ['code', 'currency_code', 'currencyCode', 'iso_code', 'isoCode'];
const MONEY_KEYS = new Set([
  'price', 'amount', 'total', 'subtotal', 'unit_price', 'list_price', 'compare_at_price', 'sale_price',
  'min_price', 'max_price', 'price_min', 'price_max', 'shipping_cost', 'tax',
]);
const MONEY_LAST_WORDS = new Set(['price', 'amount', 'cost', 'fee', 'subtotal', 'tax']);
const MONEY_WORDS = new Set(['price', 'amount', 'total', 'subtotal', 'cost', 'fee', 'tax']);
// Beside any of these, `total` counts rows.
const ROW_COUNT_SIBLINGS = ['products', 'page', 'page_size', 'returned', 'has_next_page'];
const OPAQUE_LAST_WORDS = new Set(['id', 'ids', 'url', 'urls', 'uri', 'href', 'link', 'token', 'key', 'signature', 'cursor', 'sku', 'gid']);

const TEXT_ISO_CODES = [
  'USD', 'EUR', 'GBP', 'SGD', 'JPY', 'AUD', 'CAD', 'HKD', 'NZD', 'CNY', 'KRW', 'CHF', 'SEK', 'NOK', 'DKK', 'INR', 'MXN', 'BRL',
  'AED', 'TWD', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'PLN', 'ZAR', 'SAR',
];
const SYMBOL_CURRENCY = Object.freeze({
  'US$': 'USD', 'S$': 'SGD', 'A$': 'AUD', 'AU$': 'AUD', 'C$': 'CAD', 'CA$': 'CAD', 'HK$': 'HKD', 'NZ$': 'NZD', 'R$': 'BRL', 'MX$': 'MXN', 'NT$': 'TWD',
  '£': 'GBP', '€': 'EUR', $: '$', '¥': '¥',
});
const AMBIGUOUS_SYMBOL = Object.freeze({ $: new Set(['USD', 'SGD', 'AUD', 'CAD', 'HKD', 'NZD', 'TWD']), '¥': new Set(['JPY', 'CNY']) });
const ISO = TEXT_ISO_CODES.join('|');
// 1: a symbol before a number (a prefixed dollar sign first, so `CA$` is never read as `A$` or as a bare `$`).
// 2: a code before a number.  3: a code after a number.
const TEXT_MONEY = new RegExp(`(\\b[A-Z]{1,3}\\$|HK\\$|NZ\\$|US\\$|CA\\$|AU\\$|MX\\$|NT\\$|R\\$|S\\$|A\\$|C\\$|\\$|£|€|¥) ?\\d[\\d.,]*|\\b(${ISO}) ?\\d[\\d.,]*|\\d[\\d.,]*? ?(${ISO})\\b`, 'g');

const isObject = (v) => typeof v === 'object' && v !== null;
const isAmount = (v) => (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const wordsOf = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const lastWordOf = (key) => { const w = wordsOf(key); return w.length ? w[w.length - 1] : ''; };

function isMoneyKey(key) {
  if (MONEY_KEYS.has(String(key).toLowerCase())) return true;
  const words = wordsOf(key);
  return words.length > 0 && (MONEY_LAST_WORDS.has(words[words.length - 1]) || words.every((w) => MONEY_WORDS.has(w)));
}
const isRowCount = (key, parent) => String(key).toLowerCase() === 'total' && ROW_COUNT_SIBLINGS.some((k) => has(parent, k));

/** The member of a label object that names its code (`code`, `currency_code`, ...), or null. */
function currencyCodeKeyOf(value) {
  if (!isObject(value) || Array.isArray(value)) return null;
  return CURRENCY_OBJECT_CODE_KEYS.find((key) => typeof value[key] === 'string' && value[key].trim() !== '') || null;
}

/** The code a price-labelling member's value names: the string itself, or an object's code member. Else null. */
function currencyValueOf(value) {
  if (typeof value === 'string') return value.trim() !== '' ? value.trim() : null;
  const key = currencyCodeKeyOf(value);
  return key ? value[key].trim() : null;
}

/** The currency codes a mention names directly: a string code, or the string codes of an array. */
function mentionedCodesOf(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim())).map((v) => v.trim().toUpperCase());
}

/** Money written in one string: `[{ currency, match }]`. See FREE TEXT in the file header. */
function textMoneyOf(text) {
  const out = [];
  if (typeof text !== 'string' || text === '') return out;
  for (const m of text.matchAll(TEXT_MONEY)) {
    // A prefixed dollar sign this file has no currency for is reported as written (`XY$`): no market's currency.
    const currency = m[1] ? (SYMBOL_CURRENCY[m[1]] || m[1]) : (m[2] || m[3]);
    out.push({ currency, match: m[0].trim() });
  }
  return out;
}

function parsedJsonOf(text) {
  const trimmed = text.trim();
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) return undefined;
  try { const parsed = JSON.parse(trimmed); return isObject(parsed) ? parsed : undefined; } catch { return undefined; }
}

/**
 * @param {unknown} answer a parsed answer (success value or error body), or a raw JSON-RPC body
 * @returns {{
 *   priceCurrencies: {path:string,value:string}[],
 *   money: {path:string,value:number|string,currency:string|null,currencyPath:string|null}[],
 *   textMoney: {path:string,currency:string,match:string}[],
 *   unreadableCurrencies: {path:string,value:unknown}[],
 *   otherCurrencyMentions: {path:string,value:unknown}[],
 *   currencyMentions: {path:string,currencies:string[]}[],
 *   counts: {path:string,value:number|string}[],
 * }}
 */
function collectAnswerCurrencies(answer) {
  const out = { priceCurrencies: [], money: [], textMoney: [], unreadableCurrencies: [], otherCurrencyMentions: [], currencyMentions: [], counts: [] };
  const seen = new Set();
  // `scope`: the price label of the nearest object at or above this node that states one, or null.
  const scanText = (text, at, opaque) => {
    const nested = parsedJsonOf(text);
    if (nested !== undefined) { walk(nested, `${at}<json>`, null, false); return; }
    if (!opaque) for (const found of textMoneyOf(text)) out.textMoney.push({ path: at, ...found });
  };
  function walk(node, path, scope, opaque) {
    if (typeof node === 'string') { scanText(node, path, opaque); return; }
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, `${path}[${i}]`, scope, opaque));
      return;
    }
    // This object's own price label, read first so every amount in it is paired whatever the member order.
    let own = null;
    let emptyLabel = false;
    for (const [key, value] of Object.entries(node)) {
      if (!isPriceLabelKey(key)) continue;
      const code = currencyValueOf(value);
      const at = `${path}.${key}`;
      if (code) {
        out.priceCurrencies.push({ path: at, value: code });
        if (!own) own = { value: code.toUpperCase(), path: at };
      } else {
        emptyLabel = true;
        if (isObject(value)) out.unreadableCurrencies.push({ path: at, value });
      }
    }
    // Its own label; else, when it has only an EMPTY label, no label at all (never an outer object's); else the scope's.
    const here = own || (emptyLabel ? null : scope);
    for (const [key, value] of Object.entries(node)) {
      const at = `${path}.${key}`;
      const name = key.toLowerCase();
      const isLabel = isPriceLabelKey(key);
      if (!isLabel && name.includes('currenc')) {
        // A statement about currencies. Reported as a mention, and walked like everything else.
        out.otherCurrencyMentions.push({ path: at, value });
        out.currencyMentions.push({ path: at, currencies: mentionedCodesOf(value) });
        if (isObject(value)) walk(value, at, here, opaque);
        continue;
      }
      if (isLabel) {
        // The code itself was read above. The REST of a label object is walked like any other object (a price inside
        // it is a price); only the member that named the code is left out, so it is not counted as a second label.
        if (isObject(value)) {
          const codeKey = currencyCodeKeyOf(value);
          if (codeKey) { const { [codeKey]: _code, ...rest } = value; walk(rest, at, here, opaque); } else walk(value, at, here, opaque);
        }
        continue;
      }
      if (isAmount(value) && isRowCount(key, node)) {
        out.counts.push({ path: at, value });
      } else if (isAmount(value) && isMoneyKey(key)) {
        out.money.push({ path: at, value, currency: here ? here.value : null, currencyPath: here ? here.path : null });
      }
      walk(value, at, here, opaque || OPAQUE_LAST_WORDS.has(lastWordOf(key)));
    }
  }
  walk(answer, '$', null, false);
  return out;
}

/**
 * Is money written in text as `currency` money in `marketCurrency`? `currency` is what a `textMoney` entry carries:
 * an ISO code, or an ambiguous sign: `'$'` (USD, SGD, AUD, CAD, HKD, NZD or TWD) or `'¥'` (JPY or CNY). Anything else
 * (an unknown prefixed dollar sign, an empty value) is no market's currency, and no currency is a market's when the
 * market has none.
 */
function textCurrencyIs(currency, marketCurrency) {
  if (typeof currency !== 'string' || typeof marketCurrency !== 'string' || !/^[A-Z]{3}$/.test(marketCurrency)) return false;
  return has(AMBIGUOUS_SYMBOL, currency) ? AMBIGUOUS_SYMBOL[currency].has(marketCurrency) : currency === marketCurrency;
}

/**
 * THE RULE, for one answer and the currency of the market it was asked for (`null` = the market has none).
 * Returns the problems found (empty = the answer keeps the rule):
 *   - every price-labelling currency is the market's currency, and can be read;
 *   - every quoted amount has a price label in its scope (so "no currency" can never hide a price, even beside
 *     another row that is labelled);
 *   - money written in free text is in the market's currency;
 *   - for a market with no currency: no price, no price-labelling currency and no money in text at all.
 * Mentions (`otherCurrencyMentions` / `currencyMentions`) and row counts are never problems.
 * @param {unknown} answer
 * @param {string|null} marketCurrency
 * @returns {string[]}
 */
function answerCurrencyProblems(answer, marketCurrency) {
  const found = collectAnswerCurrencies(answer);
  const problems = [];
  for (const c of found.priceCurrencies) {
    if (!marketCurrency) problems.push(`${c.path} states ${c.value} for a market that has no currency`);
    else if (c.value.toUpperCase() !== marketCurrency) problems.push(`${c.path} is ${c.value}, the market's currency is ${marketCurrency}`);
  }
  for (const c of found.unreadableCurrencies) problems.push(`${c.path} labels a price with a currency that cannot be read`);
  if (found.money.length && !marketCurrency) problems.push(`a price is quoted (${found.money[0].path}) for a market that has no currency`);
  if (marketCurrency) {
    for (const m of found.money) if (!m.currency) problems.push(`a price is quoted (${m.path}) with no currency beside it`);
  }
  for (const t of found.textMoney) {
    if (!marketCurrency) problems.push(`${t.path} states money in text (${t.match}) for a market that has no currency`);
    else if (!textCurrencyIs(t.currency, marketCurrency)) problems.push(`${t.path} states money in text as ${t.match}, the market's currency is ${marketCurrency}`);
  }
  return problems;
}

/** Throws when the answer breaks the rule; returns what was collected, so a test can also say "priced" / "no price". */
function assertAnswerCurrency(answer, marketCurrency, label = 'answer') {
  const problems = answerCurrencyProblems(answer, marketCurrency);
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  return collectAnswerCurrencies(answer);
}

module.exports = { collectAnswerCurrencies, answerCurrencyProblems, assertAnswerCurrency, textMoneyOf, isMoneyKey, textCurrencyIs };
