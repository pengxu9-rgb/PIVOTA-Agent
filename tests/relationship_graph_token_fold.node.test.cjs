const test = require('node:test');
const assert = require('node:assert/strict');
const { foldTokenText } = require('../src/auroraBff/relationshipTokenText');
const {
  __internal: { normalizeTokens, hasSpecificUseCaseAlignment },
} = require('../src/auroraBff/productRelationshipGraphBuilder');
const {
  __internal: { overlapScore },
} = require('../src/auroraBff/productRelationshipGraphSources');

// normalizeTokens exactly as it was before folding: the oracle for "unchanged on text that
// needs no folding".
function unfoldedNormalizeTokens(value) {
  const rawItems = Array.isArray(value) ? value : [value];
  const items = rawItems.flatMap((item) => String(item == null ? '' : item).split(/[>,/|;:_\s-]+/g));
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    let text = String(raw == null ? '' : raw).trim();
    if (text.length > 80) text = text.slice(0, 80);
    const token = text.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

const MARKS = /[\u2122\u2120\u00ae\u00a9]/;

test('a crawled super- or subscript digit stays attached to its word as an ASCII digit', () => {
  assert.deepEqual(normalizeTokens('Vitamin B₅'), ['vitamin', 'b5']);
  assert.deepEqual(normalizeTokens('H₂O'), ['h2o']);
  assert.deepEqual(normalizeTokens('SPF⁵⁰ PA++++'), ['spf50', 'pa']);
  assert.deepEqual(normalizeTokens('Ceramide¹ complex'), ['ceramide1', 'complex']);
  // The same words written with plain digits, which is what the crawler emitted before.
  assert.deepEqual(normalizeTokens('Vitamin B₅, H₂O, SPF⁵⁰, Ceramide¹'), normalizeTokens('Vitamin B5, H2O, SPF50, Ceramide1'));
});

test('full-width Latin folds to ASCII; full-width separators split like their ASCII forms', () => {
  assert.deepEqual(normalizeTokens('ＳＰＦ５０ ＵＶ Ｃｒｅａｍ'), ['spf50', 'uv', 'cream']);
  assert.deepEqual(normalizeTokens('Ｓｅｒｕｍ／Ｅｓｓｅｎｃｅ'), ['serum', 'essence']);
  // Unfolded, every one of those was stripped to nothing.
  assert.deepEqual(unfoldedNormalizeTokens('ＳＰＦ５０ ＵＶ Ｃｒｅａｍ'), []);
});

test('a trademark mark is a word boundary, never the letters NFKC spells it with', () => {
  assert.deepEqual(normalizeTokens('Brand™ Serum'), ['brand', 'serum']);
  assert.deepEqual(normalizeTokens('Brand™Serum'), ['brand', 'serum']);
  assert.deepEqual(normalizeTokens('Name℠'), ['name']);
  assert.equal('Brand™'.normalize('NFKC'), 'BrandTM');
});

test('text that needs no folding tokenizes byte-identically to the unfolded tokenizer', () => {
  const corpus = [
    '',
    null,
    undefined,
    42,
    'Hydrating Barrier Serum',
    'Skincare > Serums & Essences > Face Serum',
    'skincare/face_serum|moisturizer;night-cream: 50ml',
    'SPF 50+ broad-spectrum (PA++++), 1.7 fl oz',
    '  ...leading and trailing punctuation!!  ',
    'Crème brûlée lip balm — naïve rosé',
    'Glow Recipe-ish "dewy" finish, 10% niacinamide + 2% zinc',
    '化粧水 とてもしっとり UVカット',
    '수분 크림 cream',
    'Mascara 🖤 volume',
    ['Serum', 'serum', 'SERUM', 'face serum'],
    ['vitamin c', 'vitamin-c', 'Vitamin_C'],
    `${'x'.repeat(120)} tail`,
  ];
  for (const value of corpus) {
    assert.deepEqual(normalizeTokens(value), unfoldedNormalizeTokens(value), JSON.stringify(value));
  }

  // Seeded printable-ASCII fuzz: NFKC is the identity on ASCII, so nothing may move.
  let seed = 20261014;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 2000; i += 1) {
    let text = '';
    const length = next() % 60;
    for (let j = 0; j < length; j += 1) text += String.fromCharCode(32 + (next() % 95));
    assert.deepEqual(normalizeTokens(text), unfoldedNormalizeTokens(text), JSON.stringify(text));
  }

  // Every BMP code point, inside and at the edge of a word. Wherever the input is already
  // NFKC-stable and carries no mark, the tokens must not change.
  let checked = 0;
  for (let cp = 0x80; cp <= 0xffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCharCode(cp);
    const text = `ab${ch}cd ef${ch} ${ch}gh`;
    if (MARKS.test(text) || text.normalize('NFKC') !== text) continue;
    checked += 1;
    assert.deepEqual(normalizeTokens(text), unfoldedNormalizeTokens(text), `U+${cp.toString(16)}`);
  }
  assert.ok(checked > 50000, `checked ${checked} code points`);
});

test('the folded tokens reach the use-case overlap a description feeds', () => {
  const anchor = {
    category: 'sunscreen',
    name: 'Daily Sun Gel',
    description: 'Water-light gel with SPF⁵⁰, H₂O-based, Ceramide¹ and Vitamin B₅.',
  };
  const candidate = {
    category: 'sunscreen',
    name: 'Everyday Sun Fluid',
    description: 'Fluid with SPF50, H2O base, Ceramide1 and Vitamin B5.',
  };
  const { overlap } = hasSpecificUseCaseAlignment(anchor, candidate);
  for (const token of ['spf50', 'h2o', 'ceramide1']) {
    assert.ok(overlap.overlap.includes(token), `${token} in ${JSON.stringify(overlap.overlap)}`);
  }
});

test('the candidate-scoring description overlap folds the same digits', () => {
  assert.equal(overlapScore('SPF⁵⁰ H₂O Ceramide¹', 'SPF50 H2O Ceramide1'), 1);
  assert.equal(overlapScore('ＳＰＦ５０ cream', 'SPF50 cream'), 1);
  assert.equal(overlapScore('Brand™ cream', 'Brand cream'), 1);
});

test('foldTokenText is a string-in, string-out fold', () => {
  assert.equal(foldTokenText(null), '');
  assert.equal(foldTokenText(undefined), '');
  assert.equal(foldTokenText('H₂O ＵＶ B₅'), 'H2O UV B5');
  assert.equal(foldTokenText('Brand®'), 'Brand ');
});
