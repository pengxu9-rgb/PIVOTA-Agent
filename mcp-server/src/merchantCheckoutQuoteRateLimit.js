import { randomUUID } from "node:crypto";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";

// Each new merchant quote opens a real temporary checkout at the seller and makes about six signed calls
// under Pivota's agent identity. These limits keep one partner loop from flooding a store or getting that
// identity blocked. The general per-caller door limits (MCP_CALLER_LIMITS_MODE) can run in observe mode;
// this limit is always enforced and never reads that mode.
//
// Two fixed-window counters, one per partner and one per seller, live in the lane's durable state store, so
// every instance shares them. A store read or write failure refuses the quote. Neither limit can be turned
// off: a value of 0 or below rises to 1, and an unreadable value uses the default.

export const MERCHANT_QUOTE_RATE_LIMITED = "merchant_quote_rate_limited";
const WINDOW_SEC_ENV = "AGENT_MERCHANT_CHECKOUT_QUOTE_RATE_WINDOW_SEC";
const PER_PARTNER_ENV = "AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT";
const PER_SELLER_ENV = "AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT";
const SETTINGS = {
  windowSec: { env: WINDOW_SEC_ENV, fallback: 60, min: 10, max: 3600 },
  perPartner: { env: PER_PARTNER_ENV, fallback: 12, min: 1, max: 240 },
  perSeller: { env: PER_SELLER_ENV, fallback: 6, min: 1, max: 120 },
};
const UPDATE_ATTEMPTS = 4;
const EXPIRY_SLACK_MS = 5000;

function setting(env, { env: name, fallback, min, max }) {
  const raw = String(env?.[name] ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
}

export function merchantQuoteRateLimits(env = process.env) {
  return {
    windowMs: setting(env, SETTINGS.windowSec) * 1000,
    perPartner: setting(env, SETTINGS.perPartner),
    perSeller: setting(env, SETTINGS.perSeller),
  };
}

export function merchantQuoteRateLimited(retryAfterSeconds) {
  return new PivotaCommerceError("MERCHANT_UNAVAILABLE", {
    reason: MERCHANT_QUOTE_RATE_LIMITED, retry_after_seconds: retryAfterSeconds,
  });
}

export function isMerchantQuoteRateLimited(error) {
  return error instanceof PivotaCommerceError && error.detail?.reason === MERCHANT_QUOTE_RATE_LIMITED;
}

/**
 * Returns admit({ partner, sellerHost }). It resolves when both counters had room and were incremented,
 * and throws the named retriable refusal otherwise. The partner counter is taken first, so a partner over
 * its own limit never uses up a seller's budget. `keyOf` turns a scope into the store key (an HMAC under
 * the lane secret, so no partner identity is stored in the clear).
 */
export function createMerchantQuoteRateLimiter({ stateStore, keyOf, env = process.env, now = Date.now }) {
  async function take(key, limit, expiresAt) {
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
      const ttlMs = Math.max(1, expiresAt - now());
      const token = randomUUID();
      if (await stateStore.putIfAbsent(key, { count: 1, token }, { ttlMs })) return true;
      const prior = await stateStore.get(key);
      if (!prior) continue;
      if (!Number.isSafeInteger(prior.count) || typeof prior.token !== "string" || prior.count >= limit) return false;
      if (await stateStore.compareAndSet(key, "token", prior.token, { count: prior.count + 1, token }, { ttlMs })) {
        return true;
      }
    }
    // Writers kept racing for the same counter: that is load, so it is refused as load.
    return false;
  }

  return async function admit({ partner, sellerHost }) {
    const { windowMs, perPartner, perSeller } = merchantQuoteRateLimits(env);
    const at = now();
    const windowStart = Math.floor(at / windowMs) * windowMs;
    const windowEnd = windowStart + windowMs;
    const expiresAt = windowEnd + EXPIRY_SLACK_MS;
    let admitted;
    try {
      admitted = await take(keyOf(["rate", "partner", partner, windowMs, windowStart]), perPartner, expiresAt)
        && await take(keyOf(["rate", "seller", sellerHost, windowMs, windowStart]), perSeller, expiresAt);
    } catch {
      throw new PivotaCommerceError("MERCHANT_UNAVAILABLE", { reason: "merchant_quote_unavailable" });
    }
    if (!admitted) throw merchantQuoteRateLimited(Math.max(1, Math.ceil((windowEnd - at) / 1000)));
  };
}
