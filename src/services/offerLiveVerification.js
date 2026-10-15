'use strict';

/*
 * A GATEWAY LIVE VERIFICATION UNLOCKS A STALE OFFER'S CART (contract, Peng go 2026-10-15).
 *
 * WHY. Under UCP_LIVE_OFFER_READ=enforce, get_offers opts into offers.resolve's freshness-gated seed offers
 * (pivota-backend #2629). They come back flagged `requires_live_verification`: no cart, no stock claim, a
 * stale price. The gateway's live UCP read then verifies them and serves the verified ones (#2445), but only
 * as product-page referrals: only the backend mints carts and signs the affiliate redirect. So the gateway
 * re-asks offers.resolve with a SIGNED ASSERTION of exactly what the merchant just told it, and the backend
 * mints the cart from that, for that one answer (nothing is persisted).
 *
 * TOKEN (the backend verifies it; the contract's test vector pins the bytes):
 *
 *   v1.<b64url(JSON claims)>.<b64url(HMAC-SHA256(secret, "offer_live_verification.v1." + part1))>
 *
 *   claims = { a, av, c, exp, h, iat, m, sid, v: 1, vid }   (serialised in exactly this key order)
 *     sid  the flagged offer's source.seed_id        vid  the numeric variant id the live read looked up
 *     m    the declared buyer market (ISO-2)         c    that market's currency
 *     a    the merchant's live amount, major units   av   the merchant's live availability
 *     h    the merchant host the read used           iat/exp  unix seconds, exp = iat + 120
 *
 * SECRET. OFFER_LIVE_VERIFICATION_SECRET, at least 32 bytes, in both services. Missing (or too short):
 * nothing is signed and get_offers makes no second call.
 *
 * FLAG. GET_OFFERS_LIVE_CART = off (default) | shadow | on. Shadow makes the second call and LOGS what
 * would change (event `get_offers_live_cart`); only `on` changes an answer.
 */

const crypto = require('crypto');
const { flaggedOfferHandle, numericVariantId, cartPinnedTo } = require('./ucpLiveOfferRead');

const MODES = Object.freeze({ OFF: 'off', SHADOW: 'shadow', ON: 'on' });
const TOKEN_VERSION = 'v1';
const MAC_CONTEXT = 'offer_live_verification.v1.';
const TTL_SEC = 120;
const MIN_SECRET_BYTES = 32;
// offers.resolve takes at most 10 tokens (get_offers asserts only the <= 10 offers it serves), each at
// most 2 KB.
const MAX_TOKEN_BYTES = 2048;

/** GET_OFFERS_LIVE_CART, read like the UCP_LIVE_* modes: off unless shadow or on is named. */
function liveCartMode(env = process.env, key = 'GET_OFFERS_LIVE_CART') {
  const v = String((env && env[key]) || '').trim().toLowerCase();
  return v === MODES.SHADOW || v === MODES.ON ? v : MODES.OFF;
}

/** The signing secret, or '' when it is unset or shorter than 32 bytes (then nothing is signed). */
function readOfferLiveVerificationSecret(env = process.env) {
  const s = env && typeof env.OFFER_LIVE_VERIFICATION_SECRET === 'string' ? env.OFFER_LIVE_VERIFICATION_SECRET.trim() : '';
  return Buffer.byteLength(s, 'utf8') >= MIN_SECRET_BYTES ? s : '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function text(v) {
  return typeof v === 'string' && v.trim() ? v : '';
}

/**
 * Sign one assertion. `claims` carries a, av, c, h, m, sid, vid (v is always 1); `iat`/`exp` default to
 * `now` (ms) and now + 120 s. Returns the token, or null when the secret is too short or any claim is
 * missing or of the wrong type -- the same claims the backend would reject are never sent.
 */
function signOfferLiveVerification(claims, { secret, now } = {}) {
  const s = typeof secret === 'string' ? secret : '';
  if (Buffer.byteLength(s, 'utf8') < MIN_SECRET_BYTES) return null;
  const c = claims && typeof claims === 'object' ? claims : null;
  if (!c) return null;
  const nowMs = typeof now === 'function' ? now() : Number.isFinite(now) ? now : Date.now();
  const iat = c.iat !== undefined ? c.iat : Math.floor(nowMs / 1000);
  const exp = c.exp !== undefined ? c.exp : iat + TTL_SEC;
  const ok =
    (c.v === undefined || c.v === 1) &&
    text(c.sid) &&
    typeof c.vid === 'string' && /^\d{1,20}$/.test(c.vid) &&
    typeof c.m === 'string' && /^[A-Z]{2}$/.test(c.m) &&
    typeof c.c === 'string' && /^[A-Z]{3}$/.test(c.c) &&
    typeof c.a === 'number' && Number.isFinite(c.a) && c.a > 0 &&
    typeof c.av === 'boolean' &&
    text(c.h) &&
    Number.isInteger(iat) && Number.isInteger(exp) && exp > iat && exp - iat <= 300;
  if (!ok) return null;
  // Key order is part of the contract (the test vector is this exact serialisation).
  const ordered = { a: c.a, av: c.av, c: c.c, exp, h: c.h, iat, m: c.m, sid: c.sid, v: 1, vid: c.vid };
  const part1 = b64url(JSON.stringify(ordered));
  const mac = crypto.createHmac('sha256', s).update(MAC_CONTEXT + part1).digest();
  const token = `${TOKEN_VERSION}.${part1}.${b64url(mac)}`;
  // offers.resolve refuses a token over 2 KB: one that long is never sent.
  return Buffer.byteLength(token, 'utf8') <= MAX_TOKEN_BYTES ? token : null;
}

/**
 * The claims (without iat/exp) a SERVED first-pass offer supports, or null. Only a flagged offer whose live
 * read is `verified`, under the product its page names (the handle the merchant answered equals the
 * offer's page handle), for the id the backend asked it to look up, priced in the market's currency.
 * Everything asserted is what the merchant's answer said (`offer.live_read`), never the stored offer.
 */
function offerLiveVerificationClaims(offer, { market, currency } = {}) {
  if (!offer || typeof offer !== 'object') return null;
  const flag = offer.requires_live_verification;
  if (!flag) return null;
  const lr = offer.live_read;
  if (!lr || lr.status !== 'verified') return null;
  const want = flaggedOfferHandle(offer);
  if (!want || lr.handle !== want) return null;
  const sid = text(offer.source && offer.source.seed_id);
  // The id the backend will compare against: requires_live_verification.lookup_variant_id, else
  // execution_spec.variant_id. The read must have looked up exactly that id.
  const expected = numericVariantId(flag && typeof flag === 'object' ? flag.lookup_variant_id : null)
    || numericVariantId(offer.execution_spec && offer.execution_spec.variant_id);
  const vid = numericVariantId(lr.variant_id);
  const m = String(market || '').trim().toUpperCase();
  const c = String(currency || '').trim().toUpperCase();
  if (!sid || !expected || vid !== expected) return null;
  if (lr.currency !== c || offer.currency !== c) return null;
  if (typeof lr.amount !== 'number' || !Number.isFinite(lr.amount) || lr.amount <= 0) return null;
  // Only an IN-STOCK answer is asserted: an out-of-stock one can never mint a cart, so asserting it would
  // only cost a second offers.resolve call. The first pass serves that offer as it is.
  if (lr.available !== true) return null;
  const h = text(lr.host);
  if (!h || !/^[A-Z]{2}$/.test(m)) return null;
  return { a: lr.amount, av: lr.available, c, h, m, sid, v: 1, vid };
}

/**
 * The second pass's offer for one asserted seed, or null: exactly one offer for that seed came back
 * UNflagged, saying the backend accepted THIS assertion (`live_verification` verified for `vid`), at the
 * asserted price, currency and stock -- and its cart, if it names a variant or a total, names `vid` and `a`.
 */
function acceptedSecondPassOffer(secondOffers, claims) {
  const list = Array.isArray(secondOffers) ? secondOffers : [];
  const same = list.filter((o) => o && typeof o === 'object' && o.source && o.source.seed_id === claims.sid);
  const unflagged = same.filter((o) => !o.requires_live_verification);
  if (unflagged.length !== 1) return null;
  const o = unflagged[0];
  const lv = o.live_verification;
  if (!lv || lv.status !== 'verified' || String(lv.variant_id) !== claims.vid) return null;
  if (Number(o.price) !== claims.a || String(o.currency || '').toUpperCase() !== claims.c) return null;
  if (o.in_stock !== claims.av) return null;
  // Defence in depth: a cart for another variant, or a total other than the asserted amount, is not ours.
  const spec = o.execution_spec && typeof o.execution_spec === 'object' ? o.execution_spec : {};
  if (spec.variant_id != null && String(spec.variant_id) !== claims.vid) return null;
  if (spec.expected_item_total != null && Number(spec.expected_item_total) !== claims.a) return null;
  return o;
}

const EXPECTED_TOTAL_KEYS = ['expected_item_total', 'expected_currency', 'expected_quantity', 'expected_total_expires_at'];

/**
 * The offer served in place of a first-pass flagged one (GET_OFFERS_LIVE_CART=on): the backend's second-pass
 * offer (its cart, its affiliate link, its price = the live amount), carrying the first pass's live-read
 * annotation (live_read, the verification flags, the options as the merchant answered them). No second
 * merchant read. A total is offered only beside a cart pinned to the market, as the reader does.
 */
function adoptLiveCartOffer(first, second, { market } = {}) {
  const out = { ...second };
  const lr = { ...(first.live_read || {}) };
  delete lr.expected_total_withheld;
  out.live_read = lr;
  out.stock_verified = true;
  out.merchant_price_verified = true;
  out.price_source = 'merchant_live';
  // `in_stock` is the merchant's answer; a stored availability string beside it would contradict it.
  delete out.availability;
  if (Array.isArray(first.variants)) out.variants = first.variants;
  const spec = { ...(second.execution_spec || {}) };
  if (!cartPinnedTo(spec.cart_url, String(market || '').trim().toUpperCase())) {
    for (const k of EXPECTED_TOTAL_KEYS) delete spec[k];
    lr.expected_total_withheld = spec.cart_url ? 'cart_not_pinned_to_market' : 'no_cart';
  }
  out.execution_spec = spec;
  return out;
}

function hasCart(offer) {
  return Boolean(offer && offer.execution_spec && typeof offer.execution_spec.cart_url === 'string' && offer.execution_spec.cart_url.trim());
}

module.exports = {
  MODES,
  TTL_SEC,
  liveCartMode,
  readOfferLiveVerificationSecret,
  signOfferLiveVerification,
  offerLiveVerificationClaims,
  acceptedSecondPassOffer,
  adoptLiveCartOffer,
  hasCart,
};
