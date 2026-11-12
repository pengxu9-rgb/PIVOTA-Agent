'use strict';

// EVERY CURRENCY AN ANSWER STATES, AND EVERY PRICE IT QUOTES. For tests that hold a door to the currency rule:
// a price for a market is in that market's currency, or the answer states no price at all.
//
// THE MARKET -> CURRENCY SOURCE these checks are meant to be used with is the gateway's one source:
// `resolveServingCurrency` (src/services/buyerMarket.js) over `BUYER_REGION_CURRENCY` (src/auroraBff/buyerRegion.js).
// A test asks that source for the market's currency and hands it to `assertAnswerCurrency`; this file keeps no table.
//
// WHAT IS WALKED: the whole parsed answer, every object and array, to any depth (cycles are not followed), whether it
// is a success value or an error body (`{ error: { code, message, detail } }`). Three things are collected, each with
// the JSON path it was found at:
//   - `priceCurrencies`: a member that LABELS A PRICE: `currency`, `currency_code`, `price_currency`, `priceCurrency`
//     (any letter case), with a string value. One beside a price says what that price is in; one with no price beside
//     it still reads as "this is priced in X", so it is held to the same rule.
//   - `money`: a member that QUOTES AN AMOUNT: a finite number (or numeric string) under `price`, `amount`, `total`,
//     `subtotal`, `unit_price`, `list_price`, `compare_at_price`, `sale_price`, `min_price`, `max_price`,
//     `price_min`, `price_max`, `shipping_cost`, `tax`; a `price` / `money` object is walked into, and an entry of a
//     `totals` array is read through its `amount`.
//   - `otherCurrencyMentions`: any OTHER member whose name contains "currenc" (`market_currency`,
//     `seller_currencies`, `withheld_currencies`, ...). These state a fact about a seller or a market, not a price;
//     they are reported so a caller can decide what to allow, and are not part of the price rule.
// Free text (`message`, `content`) is not parsed.

const PRICE_CURRENCY_KEYS = new Set(['currency', 'currency_code', 'price_currency', 'pricecurrency']);
const MONEY_KEYS = new Set([
  'price', 'amount', 'total', 'subtotal', 'unit_price', 'list_price', 'compare_at_price', 'sale_price',
  'min_price', 'max_price', 'price_min', 'price_max', 'shipping_cost', 'tax',
]);

const isObject = (v) => typeof v === 'object' && v !== null;
const isAmount = (v) => (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()));

/**
 * @param {unknown} answer a parsed answer (success value or error body)
 * @returns {{ priceCurrencies: {path:string,value:string}[], money: {path:string,value:number|string}[],
 *             otherCurrencyMentions: {path:string,value:unknown}[] }}
 */
function collectAnswerCurrencies(answer) {
  const out = { priceCurrencies: [], money: [], otherCurrencyMentions: [] };
  const seen = new Set();
  const walk = (node, path) => {
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const at = `${path}.${key}`;
      const name = key.toLowerCase();
      if (PRICE_CURRENCY_KEYS.has(name)) {
        if (typeof value === 'string' && value.trim() !== '') out.priceCurrencies.push({ path: at, value: value.trim() });
      } else if (name.includes('currenc')) {
        out.otherCurrencyMentions.push({ path: at, value });
        continue; // a statement about currencies, not a place prices live
      }
      if (MONEY_KEYS.has(name) && isAmount(value)) out.money.push({ path: at, value });
      walk(value, at);
    }
  };
  walk(answer, '$');
  return out;
}

/**
 * THE RULE, for one answer and the currency of the market it was asked for (`null` = the market has none).
 * Returns the problems found (empty = the answer keeps the rule):
 *   - every price-labelling currency is the market's currency;
 *   - a quoted amount is always labelled by one (so "no currency" can never hide a price);
 *   - for a market with no currency: no price and no price-labelling currency at all.
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
  if (found.money.length && !marketCurrency) problems.push(`a price is quoted (${found.money[0].path}) for a market that has no currency`);
  if (found.money.length && marketCurrency && found.priceCurrencies.length === 0) problems.push(`a price is quoted (${found.money[0].path}) with no currency beside it`);
  return problems;
}

/** Throws when the answer breaks the rule; returns what was collected, so a test can also say "priced" / "no price". */
function assertAnswerCurrency(answer, marketCurrency, label = 'answer') {
  const problems = answerCurrencyProblems(answer, marketCurrency);
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  return collectAnswerCurrencies(answer);
}

module.exports = { collectAnswerCurrencies, answerCurrencyProblems, assertAnswerCurrency };
