// Money — the canonical representation for every amount that crosses a kernel boundary: an INTEGER
// number of MINOR units (cents for USD, yen for JPY, fils×… for BHD) plus an ISO-4217 currency. This is
// the Stripe/Adyen convention and the only safe one: floats cannot represent money exactly, and the
// kernel's invariants are EXACT-equality checks (expected_amount === authoritative, price lock,
// charge-once). Minor-unit integers make those comparisons exact and make zero-/three-decimal currencies
// (JPY, BHD) correct without any "divide by 100" assumption.
//
// Conversion happens ONLY at the edges (the upstream adapter parses backend decimal strings → minor;
// the display layer formats minor → major). Inside the kernel, an amount is always a minor-unit integer.

// Minor-unit exponents for the kernel's CHARGE representation. These are the exponents the PSP charge
// API expects, which mostly match ISO 4217 but NOT always.
//
// ⚠️ CHARGE EXPONENTS ARE PSP-SPECIFIC (Codex P0). The PSP here is Stripe. The lists below are Stripe's
// STABLE zero-decimal and three-decimal currencies — for those, the charge exponent is unambiguous.
// Stripe SPECIAL CASES are deliberately NOT listed (they fall through to the default of 2):
//   • HUF, TWD, UGX — charged as 2-decimal amounts that MUST be a multiple of 100 (e.g. 175 HUF → 17500).
//     Putting them at exponent 0 would UNDERCHARGE ~100×; they are 2 here, and the multiple-of-100
//     constraint must be enforced at the charge boundary.
//   • ISK — Stripe's handling changed over time (ISO 4217 says 0); treat as confirm-required.
// Any currency actually transacted must have its charge exponent (and any multiple-of-N constraint)
// CONFIRMED against the live PSP contract before charging — see https://docs.stripe.com/currencies#special-cases.
const EXPONENT = Object.freeze({
  // Stripe zero-decimal (stable): pass the amount in the major unit (no ×100).
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, JPY: 0, KMF: 0, KRW: 0, MGA: 0, PYG: 0, RWF: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal (ISO 4217). NOTE: Stripe requires these charge amounts to be a multiple of 10.
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
});

/** Number of minor units per major unit's decimal places for a currency (default 2). */
export function minorUnitExponent(currency) {
  if (typeof currency !== 'string') return 2;
  const exp = EXPONENT[currency.toUpperCase()];
  return exp === undefined ? 2 : exp;
}

// Stripe CHARGE divisibility constraints (Codex round-2 P2). Some currencies are represented at a given
// exponent but cannot charge arbitrary minor amounts:
//   • HUF, TWD, UGX, ISK — represented at exponent 2 but the charge amount must be a WHOLE major unit,
//     i.e. a multiple of 100 minor units (5.25 UGX is invalid; 5.00 UGX → 500 is valid).
//   • three-decimal currencies (BHD, KWD, …) — the charge amount must be a multiple of 10 minor units.
// Everything else is a multiple of 1 (no constraint). This is a no-op for USD/EUR/etc.
const CHARGE_MULTIPLE = Object.freeze({
  HUF: 100, TWD: 100, UGX: 100, ISK: 100,
  BHD: 10, IQD: 10, JOD: 10, KWD: 10, LYD: 10, OMR: 10, TND: 10,
});

/** Minor-unit granularity a PSP charge must be a multiple of for this currency (default 1). */
export function chargeAmountMultiple(currency) {
  if (typeof currency !== 'string') return 1;
  return CHARGE_MULTIPLE[currency.toUpperCase()] ?? 1;
}

/** True iff `minor` is NOT a chargeable amount for `currency` (violates the divisibility constraint). */
export function violatesChargeMultiple(minor, currency) {
  if (!Number.isSafeInteger(minor)) return true;
  return minor % chargeAmountMultiple(currency) !== 0;
}

/**
 * Render a JS number as a plain decimal string WITHOUT scientific notation, so the exact-parse path
 * below never sees "1e-7". Money amounts are never in scientific range, but be defensive.
 */
function numberToPlainString(n) {
  if (!Number.isFinite(n)) return null;
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // Fall back to a fixed representation with enough digits for any realistic currency exponent.
  return n.toFixed(12);
}

/**
 * Parse a MAJOR-unit amount (decimal string like "113.00" / "1.500", or a Number like 113 or 19.99)
 * into an INTEGER number of MINOR units for the given currency, with NO floating-point multiply.
 *
 * FAILS CLOSED (returns undefined) for: null/empty, sign-only/dot-only/junk (must have ≥1 digit), an
 * amount carrying MORE nonzero precision than the currency supports (an authoritative total must already
 * be at currency precision — silently rounding it could become a ±1-unit mis-charge), or an absurdly
 * large value beyond Number.isSafeInteger.
 *
 * Examples: ("113.00","USD")→11300 · (19.99,"USD")→1999 · ("1000","JPY")→1000 · ("1.500","BHD")→1500
 *           ("1.005","USD")→undefined (over-precise) · (".","USD")→undefined · ("-","USD")→undefined
 */
export function parseDecimalToMinor(value, currency) {
  const exp = minorUnitExponent(currency);
  if (value == null) return undefined;
  let s = typeof value === 'number' ? numberToPlainString(value) : String(value).trim();
  if (s == null || s === '') return undefined;
  let neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); } else if (s[0] === '+') { s = s.slice(1); }
  // Codex P1-1: require at least one digit — reject sign-only ("+","-"), dot-only ("."), "+." etc.
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return undefined;
  let [intPart, fracPart = ''] = s.split('.');
  intPart = intPart || '0';
  // Codex P2-1: STRICT precision. If the input has more fractional digits than the currency supports,
  // reject when those extra digits are NONZERO (real precision loss) rather than silently rounding.
  // Trailing zeros ("95.000" for USD) are fine — same value.
  if (fracPart.length > exp) {
    if (/[^0]/.test(fracPart.slice(exp))) return undefined;
    fracPart = fracPart.slice(0, exp);
  }
  const minor = BigInt(intPart + fracPart.padEnd(exp, '0'));
  const out = Number(minor);
  if (!Number.isSafeInteger(out)) return undefined; // absurdly large — refuse rather than lose precision
  const signed = neg ? -out : out;
  return signed === 0 ? 0 : signed; // normalize -0 → 0
}

/** Coerce an already-minor amount (integer) defensively; returns undefined if not a safe integer. */
export function asMinor(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/** Format a minor-unit integer back to a major-unit decimal string for DISPLAY only (never for math). */
export function formatMinor(minor, currency) {
  if (!Number.isSafeInteger(minor)) return undefined; // display contract: callers pass safe-integer minor
  const exp = minorUnitExponent(currency);
  const neg = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exp + 1, '0');
  const cut = digits.length - exp;
  const major = exp === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return neg ? `-${major}` : major;
}

/** True iff two minor-unit amounts are exactly equal (the kernel's bar — no tolerance for integers). */
export function sameMinor(a, b) {
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && a === b;
}
