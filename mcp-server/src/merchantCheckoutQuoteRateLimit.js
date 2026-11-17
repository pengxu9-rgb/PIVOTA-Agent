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
// WHO MAY QUOTE. Partners only (decision D-12: API-key agents or confidential OAuth clients). An API-key
// agent has its own budget. An MCP OAuth client may quote only when it is listed, as
// `oauth:<issuer>#<client_id>`, in AGENT_MERCHANT_CHECKOUT_QUOTE_OAUTH_PARTNERS (a JSON array), and then it
// has its own budget too. Dynamic client registration lets anyone mint a client id, so every other OAuth
// client is refused before any state or seller call (merchant_quote_partner_unprovisioned). A free client
// can therefore never draw on a seller's shared window or daily budget. The list is this lane's own, apart
// from the caller-limit overrides, so an entry made there to throttle a client never admits it here.
// A malformed list admits no OAuth client.
//
// WHICH SELLER. The seller counters are keyed by the seller's Shopify checkout endpoint, not the storefront
// host, so two storefront hosts configured onto one store share that store's budget.
//
// HOW. Each counter is one atomic statement on the lane's durable state store (incrementCounterBelow), so
// every instance shares the counts and concurrent callers never pass a limit. A caller under a limit is not
// refused for losing a write race. It can, briefly, be refused by a unit that another of the same partner's
// requests holds while a later counter refuses it, until that unit is given back (one store round trip).
// A store without those methods, or a store error, refuses the quote.
//
// WINDOWS. The per-window counters are fixed windows: across a boundary, up to twice a window limit can
// arrive within moments (6 + 6 for a seller at the default). The daily cap bounds the total regardless.
//
// No limit can be turned off: a value below a minimum rises to it, and an unreadable value uses the default.

export const MERCHANT_QUOTE_RATE_LIMITED = "merchant_quote_rate_limited";
export const MERCHANT_QUOTE_PARTNER_UNPROVISIONED = "merchant_quote_partner_unprovisioned";
const OAUTH_PARTNERS_ENV = "AGENT_MERCHANT_CHECKOUT_QUOTE_OAUTH_PARTNERS";
const OAUTH_PARTNER_ID = /^oauth:[^\s#]+#\S+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_SLACK_MS = 5000;
const SETTINGS = {
  windowSec: { env: "AGENT_MERCHANT_CHECKOUT_QUOTE_RATE_WINDOW_SEC", fallback: 60, min: 10, max: 3600 },
  perPartner: { env: "AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT", fallback: 12, min: 1, max: 240 },
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
    perSeller: setting(env, SETTINGS.perSeller),
    perSellerDaily: setting(env, SETTINGS.perSellerDaily),
  };
}

function provisionedOauthPartners(env) {
  let parsed;
  try { parsed = JSON.parse(String(env?.[OAUTH_PARTNERS_ENV] || "[]")); } catch { return new Set(); }
  if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string" || !OAUTH_PARTNER_ID.test(id))) return new Set();
  return new Set(parsed);
}

/**
 * The budget a partner principal (partnerPrincipalOf's JSON string) draws on, or null when that principal
 * is not a provisioned partner and may not quote at all.
 */
export function merchantQuotePartnerBudget(partner, env = process.env) {
  let parsed = null;
  try { parsed = JSON.parse(partner); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  if (parsed[0] === "agent" && typeof parsed[1] === "string" && parsed[1]) return { key: `agent:${parsed[1]}` };
  if (parsed[0] === "oauth" && typeof parsed[1] === "string" && typeof parsed[2] === "string") {
    const id = `oauth:${parsed[1]}#${parsed[2]}`;
    if (provisionedOauthPartners(env).has(id)) return { key: id };
  }
  return null;
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
    if (!budget) throw unavailable();
    const at = now();
    const windowStart = Math.floor(at / limits.windowMs) * limits.windowMs;
    const windowEnd = windowStart + limits.windowMs;
    const dayStart = Math.floor(at / DAY_MS) * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const counters = [
      { key: keyOf(["rate", "partner", budget.key, limits.windowMs, windowStart]), limit: limits.perPartner, end: windowEnd },
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
