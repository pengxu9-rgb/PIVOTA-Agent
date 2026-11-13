// A STORE THAT ANSWERED A MARKET'S CART IN ANOTHER CURRENCY IS REMEMBERED FOR A SHORT WHILE
// (AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_ENABLED, default OFF, read per call).
//
// WHY. Under the currency rule (AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET) a seller whose rows are in the market's
// currency is asked for a cart, and only its ANSWER shows that its storefront prices that market in another
// currency. A cart with no catalog price to state instead is then refused by name
// (`seller_not_priced_in_market_currency`), correctly. But the cart was already built at the store, and a referral
// was already minted for it (the referral precedes the cart: its members ride on it). Nothing is recorded for a
// refused create, so every retry did all of it again: one more cart at the store and one more unused click row per
// attempt, for an answer that could not change.
//
// WHAT. With the flag on, a refusal of that kind remembers (seller host, market) -> the currency the store answered
// in, in this process, for a bounded time. While it is remembered, a create for that seller and that market whose
// cart would be refused the same way is refused WITHOUT asking the store: no discovery, no referral, no cart. The
// refusal is raised by the same function from the same arguments as the first one, with the remembered currency in
// the place of the store's answer, so it is the same code, reason, message and detail for the same request.
//
// THE KEY IS (SELLER HOST, MARKET), NEVER THE SELLER ALONE. A storefront prices each market on its own: answering a
// GB cart in USD says nothing about what it answers a US cart in. A request for another market never reads this
// market's entry. As a second lock, an entry is only used while the market's currency (the gateway's one market ->
// currency source, resolved again for THIS request) is the one it was recorded against, and differs from the
// currency remembered.
//
// IT ONLY EVER REPEATS THAT REFUSAL. An entry is written only when the refusal was actually raised on a store's
// answer, and it is used only to raise it again. A cart that has a catalog price to answer with (so the first
// attempt was answered, not refused) is not short-cut: the store is asked exactly as with the flag off.
//
// BOUNDED, AND IT EXPIRES. At most MAX_ENTRIES entries (the oldest is dropped first), each for TTL_MS from the
// moment the store answered. A hit does NOT renew an entry: however often a refused create is retried, the store is
// asked again once the entry is TTL_MS old, so a store that fixes its currency is served again within that time.
// A process restart forgets everything. The memo is per process: another instance asks the store once for itself.
//
// WHAT IS HELD. A seller host, a two-letter market and two currency codes. Nothing of the buyer, the partner, the
// cart, the request or the key.

export const STORE_CART_CURRENCY_MISMATCH_MEMO_FLAG = "AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_ENABLED";
export const STORE_CART_CURRENCY_MISMATCH_MEMO_TTL_ENV = "AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_TTL_MS";
export const STORE_CART_CURRENCY_MISMATCH_MEMO_MAX_ENV = "AGENT_CHECKOUT_STORE_CART_CURRENCY_MISMATCH_MEMO_MAX_ENTRIES";
// Long enough to absorb an agent's retries of one refused create, short enough that a store which fixes its
// currency is asked again soon.
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MIN_TTL_MS = 1000;
export const MAX_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 1000;
export const MIN_MAX_ENTRIES = 1;
export const MAX_MAX_ENTRIES = 20000;

export function currencyMismatchMemoEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String((env && env[STORE_CART_CURRENCY_MISMATCH_MEMO_FLAG]) || "").trim());
}

// A whole number of plain digits inside [min, max], or the default. Anything else (blank, a sign, a fraction, an
// exponent, a unit, out of range) is the default: a mistyped value never widens or disables the bound.
function boundedInteger(raw, { min, max, fallback }) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!/^\d{1,9}$/.test(text)) return fallback;
  const value = Number(text);
  return value >= min && value <= max ? value : fallback;
}

export function currencyMismatchMemoTtlMs(env = process.env) {
  return boundedInteger(env && env[STORE_CART_CURRENCY_MISMATCH_MEMO_TTL_ENV], { min: MIN_TTL_MS, max: MAX_TTL_MS, fallback: DEFAULT_TTL_MS });
}

export function currencyMismatchMemoMaxEntries(env = process.env) {
  return boundedInteger(env && env[STORE_CART_CURRENCY_MISMATCH_MEMO_MAX_ENV], { min: MIN_MAX_ENTRIES, max: MAX_MAX_ENTRIES, fallback: DEFAULT_MAX_ENTRIES });
}

const hostOf = (value) => (typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null);
const marketOf = (value) => (typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : null);
const currencyOf = (value) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null);

/**
 * The key of an entry: the seller host AND the market, as a JSON array (neither can re-segment into the other).
 * Null when either is missing or malformed: such a pair is never remembered and never recalled. Pure.
 */
export function currencyMismatchMemoKey(sellerHost, market) {
  const host = hostOf(sellerHost);
  const code = marketOf(market);
  return host && code ? JSON.stringify([host, code]) : null;
}

/**
 * One memo. `clock` returns the time in milliseconds (Date.now by default; a test passes its own).
 * Never throws: a memo that cannot answer answers "nothing remembered", and the store is asked as before.
 */
export function createCurrencyMismatchMemo({ clock = Date.now } = {}) {
  let now = clock;
  const entries = new Map(); // key -> { storeCurrency, marketCurrency, at }, oldest first
  const outcomes = new Map();
  const count = (outcome) => { outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1); };
  const fresh = (entry, at, ttlMs) => at >= entry.at && at - entry.at < ttlMs;

  return {
    /**
     * The store at `sellerHost` answered a cart for `market` in `storeCurrency`, the market's currency is
     * `marketCurrency`, and the create was refused for it. Written only with the flag on.
     */
    remember({ sellerHost, market, marketCurrency, storeCurrency, env = process.env }) {
      try {
        if (!currencyMismatchMemoEnabled(env)) return false;
        const key = currencyMismatchMemoKey(sellerHost, market);
        const expected = currencyOf(marketCurrency);
        const answered = currencyOf(storeCurrency);
        if (!key || !expected || !answered || expected === answered) return false;
        const at = now();
        if (!Number.isFinite(at)) return false;
        const ttlMs = currencyMismatchMemoTtlMs(env);
        const maxEntries = currencyMismatchMemoMaxEntries(env);
        // A fresh answer from the store replaces what was held, and is the newest entry.
        entries.delete(key);
        // Room first: what has expired goes, then the oldest, until the new entry fits the bound.
        if (entries.size >= maxEntries) {
          for (const [k, entry] of entries) if (!fresh(entry, at, ttlMs)) entries.delete(k);
        }
        // (`entries.size > 0`: this loop ends whatever the bound is.)
        while (entries.size > 0 && entries.size >= maxEntries) {
          entries.delete(entries.keys().next().value);
          count("evicted");
        }
        entries.set(key, { storeCurrency: answered, marketCurrency: expected, at });
        count("remembered");
        return true;
      } catch { return false; }
    },

    /**
     * The currency the store at `sellerHost` was last seen answering `market`'s carts in, when that is remembered,
     * still fresh, recorded against `marketCurrency` and not `marketCurrency` itself. Otherwise null. Does not
     * renew the entry.
     */
    recall({ sellerHost, market, marketCurrency, env = process.env }) {
      try {
        if (!currencyMismatchMemoEnabled(env)) return null;
        const key = currencyMismatchMemoKey(sellerHost, market);
        const expected = currencyOf(marketCurrency);
        if (!key || !expected) return null;
        const entry = entries.get(key);
        if (!entry) return null;
        const at = now();
        if (!Number.isFinite(at) || !fresh(entry, at, currencyMismatchMemoTtlMs(env))) {
          entries.delete(key);
          count("expired");
          return null;
        }
        // The market's currency is no longer the one this was recorded against: nothing is known about it.
        if (entry.marketCurrency !== expected || entry.storeCurrency === expected) {
          entries.delete(key);
          return null;
        }
        return entry.storeCurrency;
      } catch { return null; }
    },

    /** A create was refused from what is remembered, with no store asked: counted (`refused_without_store`). */
    noteRefusedWithoutStore() { count("refused_without_store"); },

    /** How many entries are held (expired ones included until they are next read or room is needed). */
    size() { return entries.size; },
    /** Per-process counts: remembered, refused_without_store, expired, evicted. */
    counts() { return Object.fromEntries(outcomes); },
    resetForTest() { entries.clear(); outcomes.clear(); now = clock; },
    /** A test's own clock for this memo (undefined: the one it was made with). */
    useClockForTest(fn) { now = typeof fn === "function" ? fn : clock; },
  };
}

// THE PROCESS'S MEMO: the one every door's storefront path reads unless its caller passes another.
export const storeCartCurrencyMismatchMemo = createCurrencyMismatchMemo();
