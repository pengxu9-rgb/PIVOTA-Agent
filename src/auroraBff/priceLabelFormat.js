'use strict';

// The one place that turns an (amount, currency) pair into a price string a human or a prompt reads.
//
// Why this module exists: the card factory and the reco assistant prompt each grew their own
// formatter, and they disagreed. formatPriceLabel in chatCardFactory.js special-cased GBP/EUR/CNY and
// fell back to '$' for EVERYTHING else, so a { amount: 4500, currency: 'JPY' } price rendered
// price_label '$4500' on a card whose price.currency correctly said 'JPY' -- the same card
// contradicting itself, for 10 of the 14 currencies the reco lane recognizes (JPY, KRW, CHF, SEK, CAD,
// AUD, HKD, SGD, TWD, NZD). The string had always been wrong; #2065 is what made it reachable, by
// fixing the data layer so a card can reliably CARRY a declared non-USD currency instead of having it
// discarded and stamped USD.
//
// The rule both callers now share: NEVER PRINT A SYMBOL WE ARE NOT SURE OF. A bare ISO code is honest
// and readable; a wrong symbol silently restates the price in another country's money, and the reader
// has no way to tell. So a symbol table lists only glyphs that unambiguously belong to their code, and
// every code outside its own table renders as '<CODE> <amount>'.
//
// CAD, AUD, HKD, SGD, TWD and NZD are deliberately absent from both tables. Each does use a dollar
// sign at home, but '$' next to a catalog whose serving path normalizes to USD is exactly the
// confusion this module exists to prevent, and the disambiguating prefixes (C$, A$, NT$) are not
// consistently recognized. They render as codes on purpose -- that is the honest answer, not a gap.

// Card/UI table: a symbol only where the glyph is unambiguous for that code.
//
// JPY and CNY share the yen/yuan glyph in ordinary use, and both are correct for their own currency;
// a card carries price.currency alongside the label, so the pair stays resolvable. 'RMB' is not an ISO
// code but is accepted as an alias for CNY, preserving what the card formatter already did with it.
const DISPLAY_PRICE_SYMBOLS = Object.freeze({
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  RMB: '¥',
  KRW: '₩',
});

// Prompt table: USD only, on purpose. This text is read by a model, not a person, and '¥4500' is
// genuinely ambiguous between JPY and CNY to a reader with no currency field to check. Every non-USD
// price reaches the prompt as an explicit code. This is the shape the reco prompt already emitted;
// keeping it means this refactor changes no LLM-facing string.
const PROMPT_PRICE_SYMBOLS = Object.freeze({
  USD: '$',
});

// Deliberately strict: Number(null), Number(''), Number(false) and Number([]) are all a finite 0, so
// `Number.isFinite(Number(value))` would accept four different kinds of "no amount" and print a
// confident "$0". Only a real number, or a string that is entirely one, is an amount.
function finiteAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  // A single-element list IS an amount, because the catalog and crawl surfaces genuinely deliver one:
  // toPositiveNumberOrNull (routes.js) documents `offers: [{ price: ['19.99'] }]`, `price_info: {
  // price: ['19.99'] }` and `{ amount: ['19.99'] }` as real shapes, and records that rejecting arrays
  // there was MEASURED and "dropped every one of those to no price". Reading them differently here is
  // how the card and the prompt drift, which is the whole thing this module exists to prevent -- the
  // card would say "Price unavailable" for a row the prompt priced at EUR 19.99.
  //
  // Unwrapped through this same strict reader rather than through Number(): Number(['']) and
  // Number([null]) are both a finite 0, the exact coercion this function exists to refuse, and
  // Number([]) is 0 as well. Only a one-element list of a real amount is an amount.
  if (Array.isArray(value)) return value.length === 1 ? finiteAmount(value[0]) : null;
  return null;
}

// A currency is a three-letter code or it is nothing. Anything else falls back, so a junk token can
// never reach the tables above and can never be printed as if it were a currency.
function normalizeCurrencyToken(value, fallback) {
  const token = String(value == null ? '' : value).trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (token.length === 3) return token;
  const fallbackToken = String(fallback == null ? '' : fallback).trim().toUpperCase().replace(/[^A-Z]/g, '');
  return fallbackToken.length === 3 ? fallbackToken : '';
}

// Money reads as money: whole amounts stay whole (4500, not 4500.00), anything else gets two decimals.
function formatAmountDigits(amount) {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

function renderPriceLabel(amount, currency, symbols) {
  const num = finiteAmount(amount);
  if (num == null) return '';
  const digits = formatAmountDigits(num);
  // 'USD' is the fallback because the serving path normalizes catalog prices to USD, the same
  // assumption normalizePrice and the reco price ceiling already make for an undeclared currency.
  const code = normalizeCurrencyToken(currency, 'USD');
  if (!code) return digits;
  const symbol = symbols[code];
  return symbol ? `${symbol}${digits}` : `${code} ${digits}`;
}

// For a card or any other surface a person reads.
function formatDisplayPriceLabel(amount, currency) {
  return renderPriceLabel(amount, currency, DISPLAY_PRICE_SYMBOLS);
}

// For prompt text a model reads.
function formatPromptPriceLabel(amount, currency) {
  return renderPriceLabel(amount, currency, PROMPT_PRICE_SYMBOLS);
}

module.exports = {
  formatDisplayPriceLabel,
  formatPromptPriceLabel,
  readFiniteAmount: finiteAmount,
  DISPLAY_PRICE_SYMBOLS,
  PROMPT_PRICE_SYMBOLS,
};
