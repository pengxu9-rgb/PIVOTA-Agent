// money.js — the canonical minor-unit money representation. These tests pin the exact-parse behavior
// (NO float multiply), zero-/three-decimal currencies, rounding, round-trip, and the safety guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minorUnitExponent, parseDecimalToMinor, asMinor, formatMinor, sameMinor, chargeAmountMultiple, violatesChargeMultiple } from '../src/money.js';

test('minorUnitExponent: default 2, zero-decimal, three-decimal, case-insensitive', () => {
  assert.equal(minorUnitExponent('USD'), 2);
  assert.equal(minorUnitExponent('EUR'), 2);
  assert.equal(minorUnitExponent('JPY'), 0);
  assert.equal(minorUnitExponent('krw'), 0);
  assert.equal(minorUnitExponent('BHD'), 3);
  assert.equal(minorUnitExponent('XYZ'), 2);   // unknown → default 2
  assert.equal(minorUnitExponent(undefined), 2);
});

test('Codex P0: Stripe charge SPECIAL CASES are NOT zero-decimal (HUF/TWD/UGX default to 2, not 0)', () => {
  // Treating these as zero-decimal would undercharge ~100×. Stripe charges them as 2-decimal (×100,
  // multiple-of-100 enforced at the charge boundary).
  assert.equal(minorUnitExponent('HUF'), 2);
  assert.equal(minorUnitExponent('TWD'), 2);
  assert.equal(minorUnitExponent('UGX'), 2);
  assert.equal(parseDecimalToMinor('175.00', 'HUF'), 17500); // NOT 175
  assert.equal(parseDecimalToMinor('800.45', 'TWD'), 80045); // NOT 800
});

test('parseDecimalToMinor: 2-decimal currencies (USD) — exact, no float drift', () => {
  assert.equal(parseDecimalToMinor('113.00', 'USD'), 11300);
  assert.equal(parseDecimalToMinor('0.00', 'USD'), 0);
  assert.equal(parseDecimalToMinor('0.01', 'USD'), 1);
  assert.equal(parseDecimalToMinor('19.99', 'USD'), 1999);
  assert.equal(parseDecimalToMinor('100', 'USD'), 10000);   // no fraction → still major
  assert.equal(parseDecimalToMinor('1.5', 'USD'), 150);      // short fraction padded
  // the classic float trap: 19.99 * 100 = 1998.9999999... — the string parse must NOT lose the cent.
  // String(19.99) is the clean "19.99", so the exact parse yields 1999.
  assert.equal(parseDecimalToMinor(19.99, 'USD'), 1999);
  // A genuinely noisy float (0.1 + 0.2 = 0.30000000000000004) carries precision beyond cents → under the
  // strict rule it FAILS CLOSED rather than rounding. Safe either way (no mis-charge); fail-closed is
  // stronger. (Authoritative amounts arrive as decimal strings/integers, never as float-arithmetic noise.)
  assert.equal(parseDecimalToMinor(0.1 + 0.2, 'USD'), undefined);
});

test('parseDecimalToMinor: zero-decimal (JPY) and three-decimal (BHD)', () => {
  assert.equal(parseDecimalToMinor('1000', 'JPY'), 1000);    // minor == major
  assert.equal(parseDecimalToMinor('1000.00', 'JPY'), 1000); // trailing decimals collapse
  assert.equal(parseDecimalToMinor('1.500', 'BHD'), 1500);
  assert.equal(parseDecimalToMinor('1', 'BHD'), 1000);
});

test('Codex P2-1: over-precise authoritative input FAILS CLOSED (no silent rounding); trailing zeros ok', () => {
  assert.equal(parseDecimalToMinor('1.005', 'USD'), undefined); // real precision beyond cents → reject
  assert.equal(parseDecimalToMinor('1.004', 'USD'), undefined);
  assert.equal(parseDecimalToMinor('1.999', 'USD'), undefined);
  assert.equal(parseDecimalToMinor('1.6', 'JPY'), undefined);   // zero-decimal: any fraction is over-precise
  assert.equal(parseDecimalToMinor('95.000', 'USD'), 9500);     // trailing zeros are NOT precision loss
  assert.equal(parseDecimalToMinor('1000.00', 'JPY'), 1000);
});

test('Codex P1-1: signs, sign-only/dot-only, and junk', () => {
  assert.equal(parseDecimalToMinor('-5.00', 'USD'), -500); // refunds/adjustments may be negative
  assert.equal(parseDecimalToMinor('+5.00', 'USD'), 500);
  assert.equal(parseDecimalToMinor('.', 'USD'), undefined);  // no digits → reject (was 0)
  assert.equal(parseDecimalToMinor('-.', 'USD'), undefined);
  assert.equal(parseDecimalToMinor('+', 'USD'), undefined);
  assert.equal(parseDecimalToMinor('-', 'USD'), undefined);
  assert.equal(parseDecimalToMinor('.5', 'USD'), 50);        // leading-dot WITH a digit is valid
  assert.equal(parseDecimalToMinor('-0.00', 'USD'), 0);      // -0 normalized to 0
  assert.equal(parseDecimalToMinor('abc', 'USD'), undefined);
  assert.equal(parseDecimalToMinor('1.2.3', 'USD'), undefined);
  assert.equal(parseDecimalToMinor('1,000.00', 'USD'), undefined); // thousands separator → reject
  assert.equal(parseDecimalToMinor('', 'USD'), undefined);
  assert.equal(parseDecimalToMinor(null, 'USD'), undefined);
  assert.equal(parseDecimalToMinor(NaN, 'USD'), undefined);
});

test('asMinor: accepts safe integers / integer strings, rejects floats and junk', () => {
  assert.equal(asMinor(11300), 11300);
  assert.equal(asMinor('11300'), 11300);
  assert.equal(asMinor(-1), -1);
  assert.equal(asMinor(11300.5), undefined);
  assert.equal(asMinor('11.3'), undefined);
  assert.equal(asMinor('abc'), undefined);
  assert.equal(asMinor(undefined), undefined);
});

test('formatMinor: round-trips minor → major display string', () => {
  assert.equal(formatMinor(11300, 'USD'), '113.00');
  assert.equal(formatMinor(1, 'USD'), '0.01');
  assert.equal(formatMinor(0, 'USD'), '0.00');
  assert.equal(formatMinor(1000, 'JPY'), '1000');
  assert.equal(formatMinor(1500, 'BHD'), '1.500');
  assert.equal(formatMinor(-500, 'USD'), '-5.00');
});

test('parse → format round-trip is stable for representative amounts', () => {
  for (const [v, ccy] of [['113.00', 'USD'], ['19.99', 'USD'], ['0.01', 'USD'], ['1000', 'JPY'], ['1.500', 'BHD']]) {
    const minor = parseDecimalToMinor(v, ccy);
    assert.equal(parseDecimalToMinor(formatMinor(minor, ccy), ccy), minor, `${v} ${ccy}`);
  }
});

test('Codex R2-P2: charge divisibility constraints (multiple-of-N) per currency', () => {
  assert.equal(chargeAmountMultiple('USD'), 1);   // no constraint
  assert.equal(chargeAmountMultiple('UGX'), 100); // whole major unit
  assert.equal(chargeAmountMultiple('ISK'), 100);
  assert.equal(chargeAmountMultiple('HUF'), 100);
  assert.equal(chargeAmountMultiple('BHD'), 10);  // three-decimal → multiple of 10
  // USD: every integer minor amount is chargeable.
  assert.equal(violatesChargeMultiple(11300, 'USD'), false);
  assert.equal(violatesChargeMultiple(1, 'USD'), false);
  // UGX 5.25 parses to 525 but is NOT a whole major unit → unchargeable; 5.00 → 500 is fine.
  assert.equal(parseDecimalToMinor('5.25', 'UGX'), 525);
  assert.equal(violatesChargeMultiple(525, 'UGX'), true);
  assert.equal(violatesChargeMultiple(500, 'UGX'), false);
  // BHD must be a multiple of 10 minor units.
  assert.equal(violatesChargeMultiple(1234, 'BHD'), true);
  assert.equal(violatesChargeMultiple(1230, 'BHD'), false);
});

test('sameMinor: exact integer equality only', () => {
  assert.equal(sameMinor(11300, 11300), true);
  assert.equal(sameMinor(11300, 11301), false);
  assert.equal(sameMinor(11300, 113), false);   // the major/minor confusion this guard exists to catch
  assert.equal(sameMinor(1.5, 1.5), false);      // non-integers are never "same money"
  assert.equal(sameMinor(undefined, undefined), false);
});
