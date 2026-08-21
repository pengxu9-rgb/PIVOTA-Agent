const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

// toPositiveNumberOrNull's fast path did `Number(compact.replace(/,/g, ''))` — every comma treated
// as a thousands separator. Roughly half the world writes `35,30` for thirty-five thirty, so that
// read a price 100x too high, and `1.234,56` — dots grouping, comma decimal — 1000x too LOW ($1.23).
// The salvage path further down already resolved separators correctly, so the defect fired
// precisely on the clean numeric strings that need no salvaging: `€35,30` parsed fine, `35,30` did
// not. These land on alternatives[].product.price and on the analyze-a-URL anchor price.
const amountOf = (internal, text) => internal.normalizePriceObject(text, { fallbackCurrency: 'USD' })?.amount ?? null;

// [input, amount] — every row measured against e7493ca60 before being written down.
const DECIMAL_COMMA = [
  ['35,30', 35.3],
  ['19,99', 19.99],
  ['24,90', 24.9],
  ['129,90', 129.9],
  ['1299,00', 1299],
  ['2999,00', 2999],
  ['0,99', 0.99],
  ['1,2', 1.2],
];

// Dots grouping with a comma decimal — the European long form. These were the worst reads on the
// old rule: `2.999,00` came back as $3.
const EU_GROUPED = [
  ['1.234,56', 1234.56],
  ['2.999,00', 2999],
  ['12.345,00', 12345],
  ['1.234.567,89', 1234567.89],
  ['1.234.567', 1234567],
];

// Commas grouping with a dot decimal, or no decimal at all — the US form. NONE of these may move:
// the whole risk of this change is mistaking one convention for the other.
const US_GROUPED = [
  ['1,299.00', 1299],
  ['1,299', 1299],
  ['12,345', 12345],
  ['1,000', 1000],
  ['10,000.50', 10000.5],
  ['1,234,567', 1234567],
  ['12,345,678.90', 12345678.9],
];

const PLAIN = [['19.99', 19.99], ['1299', 1299], ['0.99', 0.99], ['250', 250], ['19.999', 20], ['.5', 0.5]];

test('a decimal comma is a decimal point, not a thousands separator', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.ok(DECIMAL_COMMA.length >= 8, 'the decimal-comma table must not be emptied');
    for (const [text, expected] of DECIMAL_COMMA) {
      assert.equal(amountOf(__internal, text), expected, `${text} must parse as ${expected}`);
    }
    for (const [text, expected] of EU_GROUPED) {
      assert.equal(amountOf(__internal, text), expected, `${text} must parse as ${expected}`);
    }
  } finally {
    delete require.cache[moduleId];
  }
});

test('a grouping comma is still a thousands separator', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.ok(US_GROUPED.length >= 7, 'the grouping table must not be emptied');
    for (const [text, expected] of [...US_GROUPED, ...PLAIN]) {
      assert.equal(amountOf(__internal, text), expected, `${text} must parse as ${expected}`);
    }
    // Three digits after the final comma is the one genuinely ambiguous case, and it reads as
    // grouping — both the commoner convention and the reading this code already had.
    assert.equal(amountOf(__internal, '1,299'), 1299, "`1,299` is twelve-ninety-nine, not 1.299");
  } finally {
    delete require.cache[moduleId];
  }
});

test('the separator rules survive a currency symbol and every reader', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // Symbols take the salvage path rather than the separator-aware one; both must agree, or a
    // price changes meaning depending on whether it was written with a symbol.
    for (const [text, expected] of [...DECIMAL_COMMA, ...US_GROUPED]) {
      for (const wrap of [(s) => `$${s}`, (s) => `€${s}`, (s) => `${s} EUR`, (s) => ` ${s} `]) {
        assert.equal(amountOf(__internal, wrap(text)), expected, `${wrap(text)} must parse as ${expected}`);
      }
    }
    // ...and through the readers that actually serve a buyer.
    assert.equal(__internal.extractCatalogCandidatePrice({ price: '35,30' })?.amount, 35.3, 'catalog reader');
    assert.equal(__internal.extractCatalogCandidatePrice({ price_usd: '19,99' })?.amount, 19.99, 'scalar alias reader');
    assert.equal(
      __internal.extractProductPriceFromHtml('<html><body><span>€35,30</span></body></html>')?.amount,
      35.3,
      'the on-page reader — this is the analyze-a-URL anchor price',
    );
    assert.equal(
      __internal.extractProductPriceFromHtml('<html><body><span>$1,299.00</span></body></html>')?.amount,
      1299,
      '...and the US form through the same reader',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

// The two paths disagreeing was its own live bug, and a worse one. A symbol sent the string down
// the salvage path, whose rule was "comma and no dot -> the comma is the decimal point" — so a
// grouped price with no cents was read three orders of magnitude low. Measured on e7493ca60.
test('a currency symbol does not change what a grouped price means', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    for (const [text, expected] of [
      ['$1,299', 1299],      // was $1.30
      ['$1,000', 1000],      // was $1
      ['$12,345', 12345],    // was $12.35
      ['$1,234,567', 1234567], // was $1.23
      ['From $1,299', 1299],
      ['€1.234,56', 1234.56], // was €1.23
      ['€2.999,00', 2999],    // was €3
    ]) {
      assert.equal(amountOf(__internal, text), expected, `${text} must parse as ${expected}`);
    }
    // Symbol and no symbol must agree, for every convention.
    for (const bare of ['1,299', '1,000', '12,345', '35,30', '19,99', '1.234,56', '1,299.00']) {
      assert.equal(
        amountOf(__internal, `$${bare}`),
        amountOf(__internal, bare),
        `$${bare} and ${bare} must mean the same amount`,
      );
    }
    // ...and it reaches the catalog reader, which is what prices a card.
    assert.equal(__internal.extractCatalogCandidatePrice({ price: '$1,299' })?.amount, 1299, 'catalog reader');
  } finally {
    delete require.cache[moduleId];
  }
});

test('a malformed number is still no price', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    // The separator-aware branch must not become a way to parse junk. Each of these has a doubled
    // or dangling separator, or is not a number at all.
    for (const text of ['1..2', '1,,2', '.,', '--5', 'abc', '', '   ', 'NaN', '0', '-5', '0,00', '0.00', ',,', '1,,299']) {
      assert.equal(amountOf(__internal, text), null, `${text} must not parse as a price`);
    }
    // An overflow is still rejected rather than salvaged into digits.
    assert.equal(amountOf(__internal, '1e999'), null, 'an overflow is not a price');
    // A DANGLING separator carries no digits, so it is not a decimal point — and that has to hold
    // with a symbol too, or the trim only covers half the inputs.
    for (const [text, expected] of [['5.', 5], ['$5.', 5], ['99,', 99], ['$99,', 99], ['€1.299,', 1299]]) {
      assert.equal(amountOf(__internal, text), expected, `${text} must parse as ${expected}`);
    }
  } finally {
    delete require.cache[moduleId];
  }
});
