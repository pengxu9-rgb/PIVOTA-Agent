'use strict';

// The banner loop in stripExternalSeedMarketingBannerPrefix was made linear: the prefix checks are
// accumulated in one pass instead of re-slicing, re-normalising and regex-counting the prefix at
// every candidate boundary. That is only safe if it returns EXACTLY what the old loop did, so this
// runs the live function against a frozen copy of the old one over generated text aimed at every
// branch: banners of every length around the 24-char and 6-token floors, the 3x upper/lower ratio,
// "A"/"An" article boundaries, colon-led banners, all-caps runs past the 1000-char window, every
// whitespace kind the normaliser collapses, non-ASCII letters, surrogate pairs, and bodies around the
// 24-char floor. The golden of real descriptions in external_seed_marketing_text.test.js covers the
// real distribution.
const { stripExternalSeedMarketingBannerPrefix } = require('../src/services/externalSeedMarketingText');
const frozen = require('./fixtures/external_seed_marketing_text_pre_linear');
const golden = require('./fixtures/external_seed_marketing_text_golden.json');

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const CAPS = ['NEW', 'LIMITED', 'EDITION', 'SHOP', 'NOW', 'FREE', 'SHIPPING', 'SALE', 'BESTSELLER', 'GLOW', 'SET', 'SPF30', 'X', 'OK', 'THE', 'LOWDOWN', 'INGREDIENTS', 'WATER,', 'GLYCERIN,', '100%', 'É', 'ÜBER', 'K-BEAUTY'];
const LOWER = ['a', 'hydrating', 'gel', 'cream', 'for', 'oily', 'skin', 'and', 'it', 'absorbs', 'quickly', 'ab', 'with', 'niacinamide.', 'éclat', 'straße', '\u{1F48E}', 'x'];
const MIXED = ['A', 'An', 'an', 'Glow', 'Serum', 'SPF30s', 'McDonald', 'iPhone', 'Straight', 'up', 'What', 'else', 'Dr.', 'N°5'];
const SPACES = [' ', ' ', ' ', '  ', '\t', '\n', ' ', ' ', ' \r\n '];
const PREFIXES = ['', '', '', 'STRAIGHT UP: ', 'The lowdown: ', 'WHAT ELSE:', 'NOTE: ', 'the #s don\'t lie: ', ': ', 'SHOP ALL THE NEW LIMITED DROPS: '];

function pick(r, list) {
  return list[Math.floor(r() * list.length)];
}

function generate(r) {
  const parts = [pick(r, PREFIXES)];
  const segments = 1 + Math.floor(r() * 4);
  for (let s = 0; s < segments; s += 1) {
    const kind = r();
    const length = Math.floor(r() * (r() < 0.1 ? 260 : 18));
    const vocab = kind < 0.45 ? CAPS : kind < 0.8 ? LOWER : MIXED;
    for (let i = 0; i < length; i += 1) {
      parts.push(r() < 0.08 ? pick(r, MIXED) : pick(r, vocab));
      parts.push(pick(r, SPACES));
    }
  }
  let text = parts.join('');
  if (r() < 0.2) text = pick(r, SPACES) + text;
  if (r() < 0.2) text += pick(r, SPACES);
  return text;
}

describe('stripExternalSeedMarketingBannerPrefix linear loop', () => {
  test('returns exactly what the pre-change function did on 30,000 generated texts', () => {
    const r = rng(20260917);
    const mismatches = [];
    let stripped = 0;
    let tokenLoopStrips = 0;
    for (let i = 0; i < 30000; i += 1) {
      const text = generate(r);
      const expected = frozen.stripExternalSeedMarketingBannerPrefix(text);
      const actual = stripExternalSeedMarketingBannerPrefix(text);
      if (actual !== expected) mismatches.push({ text, expected, actual });
      const normalized = frozen.normalizeBannerText(text);
      if (expected !== normalized) {
        stripped += 1;
        // A strip that the colon branch did not produce came from the token loop under test.
        const colon = normalized.indexOf(':');
        if (colon <= 0 || colon > 160 || !normalized.slice(colon + 1).trim().startsWith(expected.slice(0, 10))) {
          tokenLoopStrips += 1;
        }
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
    // The generator has to actually reach the loop's accepting branch often, or equality is cheap.
    expect(stripped).toBeGreaterThan(1500);
    expect(tokenLoopStrips).toBeGreaterThan(1000);
  });

  test('returns exactly what the pre-change function did at every boundary around the floors', () => {
    // Exhaustive over small shapes: k caps tokens, an optional article, then a body of m characters.
    const mismatches = [];
    for (const capWord of ['AB', 'ABCDE', 'AbC', 'ÉÉÉ', 'A1', 'SHOPNOW']) {
      for (let k = 0; k <= 14; k += 1) {
        for (const article of ['', 'A ', 'An ', 'a ', 'AN ']) {
          for (const lowerRun of ['', 'x ', 'ab cd ', 'mixed Case ']) {
            for (let m = 18; m <= 30; m += 1) {
              const body = `b${'y'.repeat(m - 1)}`;
              const text = `${`${capWord} `.repeat(k)}${lowerRun}${article}${body}`;
              if (stripExternalSeedMarketingBannerPrefix(text) !== frozen.stripExternalSeedMarketingBannerPrefix(text)) {
                mismatches.push(text);
              }
            }
          }
        }
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
  });

  test('returns exactly what the pre-change function did on the real golden descriptions and their tails', () => {
    const mismatches = [];
    for (const row of golden) {
      for (const cut of [0, 1, 7, 24, 100, 400]) {
        const text = row.input.slice(cut);
        if (stripExternalSeedMarketingBannerPrefix(text) !== frozen.stripExternalSeedMarketingBannerPrefix(text)) {
          mismatches.push(`${row.name}@${cut}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('a window full of candidate boundaries costs a fraction of the old loop', () => {
    // The prod shape: ~1000 chars of mixed-case prose before any banner decision, every token a
    // candidate. The old loop re-scanned the prefix for each one.
    const text = `${'Glow serum with niacinamide and squalane for oily skin. '.repeat(40)}${'More text. '.repeat(4000)}`;
    const time = (fn) => {
      const startedAt = process.hrtime.bigint();
      for (let i = 0; i < 60; i += 1) fn(text);
      return Number(process.hrtime.bigint() - startedAt) / 1e6;
    };
    time(stripExternalSeedMarketingBannerPrefix);
    time(frozen.stripExternalSeedMarketingBannerPrefix);
    // Best of interleaved rounds, so one GC or scheduler pause cannot land on only one side.
    let oldMs = Infinity;
    let newMs = Infinity;
    for (let round = 0; round < 7; round += 1) {
      oldMs = Math.min(oldMs, time(frozen.stripExternalSeedMarketingBannerPrefix));
      newMs = Math.min(newMs, time(stripExternalSeedMarketingBannerPrefix));
    }
    expect(stripExternalSeedMarketingBannerPrefix(text)).toBe(frozen.stripExternalSeedMarketingBannerPrefix(text));
    // Loose on purpose (CI noise): ~7x measured on this input, where both sides still pay to normalise and
    // tokenise ~44KB; the real golden descriptions measured ~31x. It only has to fail if the rescan returns.
    expect(newMs * 2).toBeLessThan(oldMs);
  });
});
