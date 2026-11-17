import callerLimitsConfig from "../../src/guardrails/mcpCallerLimitsConfig.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";

// Each new merchant quote opens a real temporary checkout at the seller and makes about six signed calls
// under Pivota's agent identity. These limits keep one caller from flooding a store or getting that
// identity blocked. The general per-caller door limits (MCP_CALLER_LIMITS_MODE) can run in observe mode;
// this limit is always enforced and never reads that mode.
//
// Every new quote takes one unit from each of three counters, in this order:
//   1. its partner budget, per window;
//   2. the seller's budget, per window;
//   3. the seller's daily cap (one UTC day).
// If a later counter refuses, the units already taken are given back, so a refusal costs no budget.
//
// WHO IS A PARTNER. An API-key agent has its own budget, and so does an MCP OAuth client named in
// MCP_CALLER_LIMITS_OVERRIDES_JSON (`oauth:<issuer>#<client_id>`, the provisioning list the caller limits
// already use). Dynamic client registration lets anyone mint a client id, so every other OAuth client
// shares ONE pooled budget, as the caller limits pool them (see src/guardrails/mcpCallerLimitsConfig.js).
//
// WHICH SELLER. The seller counters are keyed by the seller's Shopify checkout endpoint, not the storefront
// host, so two storefront hosts configured onto one store share that store's budget.
//
// HOW. Each counter is one atomic statement on the lane's durable state store (incrementCounterBelow), so
// every instance shares the counts, concurrent callers never pass a limit, and a caller under a limit is
// never refused for racing. A store without those methods, or a store error, refuses the quote.
//
// WINDOWS. The per-window counters are fixed windows: across a boundary, up to twice a window limit can
// arrive within moments (6 + 6 for a seller at the default). The daily cap bounds the total regardless.
//
// No limit can be turned off: a value below a minimum rises to it, and an unreadable value uses the default.

export const MERCHANT_QUOTE_RATE_LIMITED = "merchant_quote_rate_limited";
const POOLED_OAUTH_PARTNER = "oauth:unregistered";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_SLACK_MS = 5000;
const SETTINGS = {
  windowSec: { env: "AGENT_MERCHANT_CHECKOUT_QUOTE_RATE_WINDOW_SEC", fallback: 60, min: 10, max: 3600 },
  perPartner: { env: "AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT", fallback: 12, min: 1, max: 240 },
  pooledOauth: { env: "AGENT_MERCHANT_CHECKOUT_QUOTE_UNREGISTERED_OAUTH_LIMIT", fallback: 6, min: 1, max: 240 },
  perSeller: { env: "AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT", fallback: 6, min: 1, max: 120 },
  perSellerDaily: { env: "AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_DAILY_LIMIT", fallback: 200, min: 1, max: 5000 },
};

function setting(env, { env: name, fallback, min, max }) {
  const raw = String(env?.[name] ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return fallback;
  return Math.min(max, Math.max(min, Number(raw)));
}

export function merchantQuoteRateLimits(env = process.env) {
  return {
    windowMs: setting(env, SETTINGS.windowSec) * 1000,
    perPartner: setting(env, SETTINGS.perPartner),
    pooledOauth: setting(env, SETTINGS.pooledOauth),
    perSeller: setting(env, SETTINGS.perSeller),
    perSellerDaily: setting(env, SETTINGS.perSellerDaily),
  };
}

/**
 * The budget a partner principal (partnerPrincipalOf's JSON string) draws on, and that budget's limit.
 * Anything not recognised as a provisioned partner falls into the pooled OAuth budget.
 */
function merchantQuotePartnerBudget(partner, env = process.env) {
  const limits = merchantQuoteRateLimits(env);
  let parsed = null;
  try { parsed = JSON.parse(partner); } catch { /* pooled below */ }
  if (Array.isArray(parsed) && parsed[0] === "agent" && typeof parsed[1] === "string" && parsed[1]) {
    return { key: `agent:${parsed[1]}`, limit: limits.perPartner };
  }
  if (Array.isArray(parsed) && parsed[0] === "oauth" && typeof parsed[1] === "string" && typeof parsed[2] === "string") {
    const id = `oauth:${parsed[1]}#${parsed[2]}`;
    // A malformed overrides value parses to an empty list, so every OAuth client is pooled.
    if (callerLimitsConfig.readCallerLimitsConfig(env).overrides.has(id)) return { key: id, limit: limits.perPartner };
  }
  return { key: POOLED_OAUTH_PARTNER, limit: limits.pooledOauth };
}

function merchantQuoteRateLimited(retryAfterSeconds) {
  return new PivotaCommerceError("MERCHANT_UNAVAILABLE", {
    reason: MERCHANT_QUOTE_RATE_LIMITED, retry_after_seconds: retryAfterSeconds,
  });
}

const unavailable = () => new PivotaCommerceError("MERCHANT_UNAVAILABLE", { reason: "merchant_quote_unavailable" });

/**
 * Returns admit({ partner, sellerEndpoint }). It resolves when every counter had room and was incremented,
 * and throws the named retriable refusal otherwise. `keyOf` turns a scope into the store key (an HMAC
 * under the lane secret, so no partner identity or endpoint is stored in the clear).
 */
export function createMerchantQuoteRateLimiter({ stateStore, keyOf, env = process.env, now = Date.now }) {
  async function giveBack(taken) {
    // Best effort: a failed refund only costs budget until the window ends; it never admits more.
    for (const counter of taken) {
      try { await stateStore.decrementCounter(counter.key); } catch { /* the window expires */ }
    }
  }

  return async function admit({ partner, sellerEndpoint }) {
    if (typeof stateStore?.incrementCounterBelow !== "function" || typeof stateStore?.decrementCounter !== "function"
      || typeof sellerEndpoint !== "string" || !sellerEndpoint) throw unavailable();
    const limits = merchantQuoteRateLimits(env);
    const budget = merchantQuotePartnerBudget(partner, env);
    const at = now();
    const windowStart = Math.floor(at / limits.windowMs) * limits.windowMs;
    const windowEnd = windowStart + limits.windowMs;
    const dayStart = Math.floor(at / DAY_MS) * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const counters = [
      { key: keyOf(["rate", "partner", budget.key, limits.windowMs, windowStart]), limit: budget.limit, end: windowEnd },
      { key: keyOf(["rate", "seller", sellerEndpoint, limits.windowMs, windowStart]), limit: limits.perSeller, end: windowEnd },
      { key: keyOf(["rate", "seller-day", sellerEndpoint, dayStart]), limit: limits.perSellerDaily, end: dayEnd },
    ];
    const taken = [];
    let refusedAt = null;
    try {
      for (const counter of counters) {
        const ttlMs = Math.max(1, counter.end + EXPIRY_SLACK_MS - now());
        if (await stateStore.incrementCounterBelow(counter.key, counter.limit, { ttlMs }) === null) {
          refusedAt = counter;
          break;
        }
        taken.push(counter);
      }
    } catch {
      await giveBack(taken);
      throw unavailable();
    }
    if (refusedAt) {
      await giveBack(taken);
      throw merchantQuoteRateLimited(Math.max(1, Math.ceil((refusedAt.end - at) / 1000)));
    }
  };
}
