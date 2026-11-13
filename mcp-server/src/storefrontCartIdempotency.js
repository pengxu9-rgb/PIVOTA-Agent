// A RETRIED STOREFRONT CREATE RETURNS THE SAME CHECKOUT (AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED, default OFF).
//
// WHY. A create's idempotency key (UCP `meta["idempotency-key"]`, native `idempotency_key`) was ignored on the
// storefront path: the kernel's ledger is only reached by a kernel checkout. So an agent that retried a create (a
// slow answer, a dropped connection) built a second anonymous cart at the seller's store, and a second referral.
//
// WHAT. With the flag on, for the SAME partner's SAME verified buyer in the SAME session on the SAME door with the
// SAME key (THE SCOPE, below):
//   - the same request (canonicalRequest below) within the record's life gets the SAME checkout id, read back: no
//     second `create_cart`, no second referral, no second hand-off record;
//   - a DIFFERENT request is refused, terminally, with the kernel ledger's own code and meaning
//     (IDEMPOTENCY_CONFLICT: "a different request reusing an old reference", use a new key for a new request);
//   - two creates at the same moment: ONE builds; the other waits for it and then reads the same checkout back.
//
// THE STORE. The kernel's own state store (safety-kernel/src/mount.js `stateStore`), in a namespace of its own: in
// production that is Postgres (`commerce_kv`), shared by every instance, with an atomic insert-if-absent; strict
// checkout refuses to boot without it. The in-process store exists only where the whole kernel is in-process (tests,
// a single dev instance), exactly as the kernel's own idempotency ledger. No store wired, or a store call that
// fails: the create proceeds as it did before this module (FAIL OPEN), counted and logged. A failed dedup must
// never cost the buyer the cart.
//
// THE SCOPE: (door, partner, buyer, session, key).
//   partner  the calling principal the gateway verified: the agent of an api-key call, or the issuer and client of
//            an OAuth call. The SAME value the partner assertion on the referral and the hand-off record is signed
//            for (src/attribution/issuingAgentAssertion.js `issuingSubjectFromInvokeContext`), so a checkout and its
//            replay can never belong to two partners. A buyer's `user_ref` does NOT name the partner: one person
//            signed in through two OAuth clients is one `user_ref`, and without the partner here the second client
//            was handed the first client's checkout, with the first client's referral on its link.
//   session  the call's `acp_session_id`, as the kernel's own ledger scopes a key (canonicalExecutor.js
//            `scopedBaseKey`): a key reused in another session is another request, not a conflict. WHAT THAT VALUE
//            IS depends on the door's sign-in. On an api-key call it is the session the gateway's sign-in channel
//            resolved for the buyer. On an OAuth call it is a session claim of the access token when the token
//            carries one, and otherwise the `Mcp-Session-Id` header THE CLIENT SENDS: a value the client chooses, which
//            this gateway neither issues nor checks. A client that reconnects under a new one is in a new scope,
//            so its retry is NOT deduplicated (it builds a second cart, as with the flag off). That splits only
//            the client's own scope: the partner and the buyer are verified on every door.
// NEVER ACROSS AN UNKNOWN PRINCIPAL. A call with no partner (a service or degraded identity, an unbound caller) or
// no session is not deduplicated at all: it proceeds as it did before this module, counted and logged
// (`fail_open: no_partner` / `no_session`).
//
// WHICH KEYS ARE ACCEPTED IS NOT DECIDED HERE. A key's alphabet and its minimum length are the shared intake rule's
// (safety-kernel/src/protocol/intakeBounds.cjs), the one rule every checkout door applies to a key that is present,
// whatever this flag says. Both doors apply it before they reach this path, and with this flag on the create path
// applies it again to the key exactly as sent before it asks this module for anything (ucpCheckoutEscalation.js),
// so a key that rule refuses is never claimed, never looked up and never replayed. This module holds no number
// and no reason of its own for a key.
//
// THE GUARANTEE, stated exactly. While the store answers, at most one create per scope is building at a
// time, for as long as its claim's lease (CLAIM_LEASE_MS) holds. A build slower than the lease can be overlapped
// by a retry; the create path's own budgets (product reads, the gate, the seller's door, the record write) sum to
// well under it. A create that crashes mid-build leaves a claim that expires with the lease.
//
// WHAT IS STORED, AND FOR HOW LONG. Key: an HMAC-SHA-256 over the scope: none of its members is
// stored. Value: the SHA-256 of the canonical request, and the checkout id ENCRYPTED (AES-256-GCM) under a key
// derived (HMAC) from that same scope, so a row can be opened only by a request that presents all of it
// again; a seller-priced id carries the seller's cart id, which is that seller's bearer handle. Nothing else: no
// cart link, no totals, no email. Life: ESCALATION_TTL_MS (6 h), the checkout id's own stated expiry (`expires_at`);
// after it the id is expired on its face and a retry builds a fresh cart. The seller's cart may outlive that; the
// door has never read the seller's expiry and makes no claim about it.
//
// UNDER A SERVER SECRET. Every member of the scope is a value a caller knows or can guess (a key is often
// `checkout-1`), so digests of the scope alone would let anyone who can read the table find a buyer's row and open
// it; the row holds the seller's cart id, a bearer handle. The request digest is guessable in the same way (a cart
// is a few product ids and quantities): stored plain, a reader of the table could confirm a guessed cart against a
// row. So the record key, the sealing key AND the stored request digest (`fp`) are all
// HMACs under `scope.serverKey`: a key the door derives from the kernel's own secret, with a label of this
// module's own (ucpCheckoutEscalation.js `storeCartIdempotencyKey`; the same secret and derivation as the id
// binding, another label, so neither key can stand in for the other). NO KEY, NO RECORD: with the flag on and no
// usable secret, a create is not deduplicated (`fail_open: no_secret`, counted and logged) and nothing is written.
// FAIL OPEN, unlike the id binding, on purpose: the binding fails closed because an unbound id is the very thing
// its switch exists to stop; here the thing to stop is a record sealed with no secret, and not writing one stops
// it, while refusing the create would cost the buyer the cart, which this module never does. Strict checkout does
// not boot without a strong secret, so in production this arm is not reached.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";

export const STORE_CART_IDEMPOTENCY_FLAG = "AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED";
export const STORE_CART_IDEMPOTENCY_NAMESPACE = "storefront_cart_idempotency";
// Longer than the slowest create this path can run: product reads (3 s), the purchasability gate, the referral
// (1 s), the seller's door (5 s) and the hand-off record write (2 s).
export const CLAIM_LEASE_MS = 30 * 1000;
// How long a create that lost the claim waits for the winner before answering "outcome unknown, retry the same".
export const WAIT_FOR_WINNER_MS = 12 * 1000;
export const POLL_INTERVAL_MS = 100;
export const KEY_REUSED_REASON = "storefront_cart_idempotency_key_reused";
export const IN_FLIGHT_REASON = "storefront_cart_create_in_flight";
const MAX_CLAIM_ATTEMPTS = 3;

export function storeCartIdempotencyEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String((env && env[STORE_CART_IDEMPOTENCY_FLAG]) || "").trim());
}

// Per-process counts: claimed, replayed, replayed_after_wait, replay_refused, conflict, in_flight,
// fail_open:<stage>, finalize_failed, lease_lost, released. The log line is the fleet-wide view, and the ONLY one
// production has: nothing outside the tests reads these counts, and `claimed` and `released` have no log line.
const outcomes = new Map();
function count(outcome) { outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1); }
export function storeCartIdempotencyCounts() { return Object.fromEntries(outcomes); }
export function resetStoreCartIdempotencyCountsForTest() { outcomes.clear(); }

function emit(log, level, detail) {
  if (log && typeof log[level] === "function") {
    try { log[level]({ event: "storefront_cart_idempotency", ...detail }); } catch { /* never throw the door */ }
  }
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest();
// A JSON array, so no member's content can re-segment into another scope (as the kernel's `scopedBaseKey`).
const scopeOf = ({ door, partner, userRef, sessionId, rawKey }) =>
  JSON.stringify([String(door), String(partner), String(userRef), String(sessionId), String(rawKey)]);

/**
 * THE PARTNER of a call, as one string, from the verified subject the partner assertion is signed for
 * (`{ kind: 'agent', sub }` for an api-key call, `{ kind: 'oauth', iss, cid }` for an OAuth call), or null when
 * the call is bound to no partner. A JSON array: an agent id can never read as an OAuth client. Pure.
 */
export function partnerPrincipalOf(subject) {
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  if (!subject || typeof subject !== "object") return null;
  if (subject.kind === "agent") return text(subject.sub) ? JSON.stringify(["agent", text(subject.sub)]) : null;
  if (subject.kind === "oauth") return text(subject.iss) && text(subject.cid) ? JSON.stringify(["oauth", text(subject.iss), text(subject.cid)]) : null;
  return null;
}

// The server key of a scope (see UNDER A SERVER SECRET): 32 bytes, or null. Never a default.
const serverKeyOf = (scope) => (scope && Buffer.isBuffer(scope.serverKey) && scope.serverKey.length === 32 ? scope.serverKey : null);
const keyed = (scope, purpose) => {
  const serverKey = serverKeyOf(scope);
  if (!serverKey) throw new Error("storefront cart idempotency: no server key");
  return createHmac("sha256", serverKey).update(`${purpose}|${scopeOf(scope)}`, "utf8").digest();
};

/**
 * The record's key: an HMAC of the scope under the server key. None of its members can be read back from it, and
 * it cannot be computed from them without the key. Throws without a server key (runIdempotentCart never asks).
 */
export function recordKey(scope) {
  return `sci1_${keyed(scope, "key").toString("hex")}`;
}

function sealingKey(scope) {
  return keyed(scope, "seal");
}

/**
 * The request digest AS STORED (`fp`): an HMAC of the scope and the request's fingerprint under the server key, with
 * a purpose of its own. A row's `fp` cannot be matched against a guessed cart without the key. Throws without a
 * server key (runIdempotentCart never asks). A record written before this (a plain digest in `fp`) simply does not
 * match: it reads as another request under the key, which is refused, and it expires with its six hours.
 */
export function storedFingerprint(scope, fingerprint) {
  return keyed(scope, `fp|${String(fingerprint)}`).toString("hex");
}

/** The checkout id, sealed so that only a request presenting the same scope, on a server holding the key, can open it. */
export function sealCheckoutId(id, scope) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(scope), iv);
  const body = Buffer.concat([cipher.update(String(id), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${body.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

/** The sealed id opened, or null when it is not one this scope sealed. */
export function openCheckoutId(sealed, scope) {
  try {
    const [iv, body, tag] = String(sealed).split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(scope), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch { return null; }
}

/**
 * THE CANONICAL REQUEST: what makes two creates "the same request". The cart as a set of lines (product, quantity,
 * chosen variant; order does not matter), the market the cart is built for and whether the buyer named it, the
 * discount codes, the seller the request named and the seller it expects. Nothing about the buyer's contact
 * details: a retry may repeat or omit an email without becoming another request. Pure.
 */
export function canonicalRequest({ items, market, marketAssumed, discountCodes, sellerNamed, expectedSeller }) {
  const lines = (Array.isArray(items) ? items : [])
    .map((it) => [String(it.product_id), Number(it.quantity), it.variant_id === undefined || it.variant_id === null ? null : String(it.variant_id)])
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  return {
    v: 1,
    lines,
    market: typeof market === "string" ? market : null,
    market_assumed: marketAssumed === true,
    discount_codes: discountCodes === undefined ? null : discountCodes,
    seller_named: sellerNamed === undefined || sellerNamed === null ? null : String(sellerNamed),
    expected_seller: expectedSeller === undefined || expectedSeller === null ? null : String(expectedSeller),
  };
}

export function requestFingerprint(canonical) {
  return sha256(JSON.stringify(canonical)).toString("hex");
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Why a replayed create's read-back answered nothing (the `reason` of its `replay_refused` line and count).
export const REPLAY_NOTHING_SERVED = Object.freeze({ declined: "declined", notReadable: "not_readable" });

/**
 * Build the checkout once per (door, partner, buyer, session, key, request).
 *
 * @param {{
 *   store: object|undefined,          // a KvStore: get, putIfAbsent, compareAndSet, compareAndDelete
 *   scope: { door:string, partner:(string|null), userRef:string, sessionId:(string|null), rawKey:string, serverKey:(Buffer|null) },
 *                                     // partner: partnerPrincipalOf(...); null (or no session) = not deduplicated
 *                                     // serverKey: 32 bytes derived from the server's secret; null = not deduplicated
 *   fingerprint: string,
 *   ttlMs: number,                    // the life of a finished record
 *   now: () => number,
 *   build: () => Promise<{ answer:any, id:(string|null) }>,   // today's create; `id` null = no checkout was handed out
 *   replay: (id:string, createdAt:number) => Promise<any>,   // read the recorded checkout back
 *   nothingServedReason?: () => string,   // asked only when `replay` answered nothing: REPLAY_NOTHING_SERVED.notReadable
 *                                     // when the recorded id is no longer one the caller may read; anything else
 *                                     // (or no function) is counted as REPLAY_NOTHING_SERVED.declined
 *   log?: object, waitMs?: number, pollMs?: number,
 * }} a
 * @returns {Promise<any>} the answer
 */
export async function runIdempotentCart({ store, scope, fingerprint, ttlMs, now = Date.now, build, replay, nothingServedReason, log, waitMs = WAIT_FOR_WINNER_MS, pollMs = POLL_INTERVAL_MS }) {
  const failOpen = async (stage) => {
    count(`fail_open:${stage}`);
    emit(log, "warn", { outcome: "fail_open", stage });
    return (await build()).answer;
  };
  // Never across an unknown principal: no partner, or no session, is no scope to deduplicate in.
  const known = (value) => typeof value === "string" && value !== "";
  if (!scope || !known(scope.partner)) return failOpen("no_partner");
  if (!known(scope.sessionId)) return failOpen("no_session");
  // No key, no record: nothing is ever stored under digests a caller could compute.
  if (!serverKeyOf(scope)) return failOpen("no_secret");
  if (!store || typeof store.putIfAbsent !== "function") return failOpen("no_store");
  const key = recordKey(scope);
  // What is stored and compared is the KEYED digest, never the request's plain one.
  const fp = storedFingerprint(scope, fingerprint);
  const owner = randomUUID();
  const replayOf = async (record, outcome) => {
    const id = openCheckoutId(record.sealed, scope);
    if (id === null) return failOpen("unreadable_record");
    count(outcome);
    emit(log, "info", { outcome });
    // `replayed` / `replayed_after_wait` mean A RECORD WAS FOUND AND READ BACK, not that its checkout was served: the
    // read-back is judged again (the purchasability gate, the currency rule, the rows as they are now) and may be
    // refused. Each read-back that hands out no checkout is counted and logged once more, as `replay_refused`,
    // with the refusal's reason. A read-back that ANSWERED NOTHING (the door then refuses it by name) is one of two
    // things, told apart by the caller (`nothingServedReason`), never guessed here:
    //   `declined`      the recorded checkout was read and the purchasability gate (or a rule that declines as the
    //                   gate does) declined it;
    //   `not_readable`  the recorded id is no longer one this buyer may read (an unbound id after the id binding
    //                   moved to `enforce`, or a bound one after its secret changed): nothing was read or judged.
    // SERVED replays = replayed + replayed_after_wait - replay_refused.
    const notServed = (reason) => {
      count("replay_refused");
      emit(log, "info", { outcome: "replay_refused", reason });
    };
    let answer;
    try {
      answer = await replay(id, Number(record.created_at));
    } catch (err) {
      const detail = err && typeof err === "object" ? err.detail : null;
      const reason = detail && typeof detail === "object" && typeof detail.reason === "string" ? detail.reason : null;
      notServed(reason || (err && typeof err.code === "string" ? err.code : "error"));
      throw err;
    }
    if (answer === null || answer === undefined) {
      let said = null;
      try { said = typeof nothingServedReason === "function" ? nothingServedReason() : null; } catch { said = null; }
      notServed(said === REPLAY_NOTHING_SERVED.notReadable ? REPLAY_NOTHING_SERVED.notReadable : REPLAY_NOTHING_SERVED.declined);
    }
    return answer;
  };
  const conflictIfOther = (record) => {
    if (record.fp !== fp) {
      count("conflict");
      emit(log, "info", { outcome: "conflict" });
      throw new PivotaCommerceError("IDEMPOTENCY_CONFLICT", { reason: KEY_REUSED_REASON });
    }
  };

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    let claimed;
    try {
      claimed = await store.putIfAbsent(key, { fp, status: "pending", owner, claimed_at: now() }, { ttlMs: CLAIM_LEASE_MS });
    } catch { return failOpen("claim"); }

    if (claimed) {
      count("claimed");
      let built;
      try {
        built = await build();
      } catch (err) {
        // Nothing was handed out: release OUR claim (only ours) so a real retry can build.
        try { await store.compareAndDelete(key, "owner", owner); } catch { /* the lease expires it */ }
        count("released");
        throw err;
      }
      if (typeof built.id !== "string") {
        try { await store.compareAndDelete(key, "owner", owner); } catch { /* the lease expires it */ }
        count("released");
        return built.answer;
      }
      try {
        const done = { fp, status: "done", sealed: sealCheckoutId(built.id, scope), created_at: now() };
        const finalized = await store.compareAndSet(key, "owner", owner, done, { ttlMs });
        if (!finalized) { count("lease_lost"); emit(log, "warn", { outcome: "lease_lost" }); }
      } catch {
        count("finalize_failed");
        emit(log, "warn", { outcome: "finalize_failed" });
      }
      return built.answer;
    }

    // Someone else holds the key.
    const deadline = Date.now() + waitMs;
    let waited = false;
    for (;;) {
      let existing;
      try { existing = await store.get(key); } catch { return failOpen("read"); }
      if (!existing) break; // the holder released (or expired): try to claim again
      conflictIfOther(existing);
      if (existing.status === "done") return replayOf(existing, waited ? "replayed_after_wait" : "replayed");
      if (Date.now() >= deadline) {
        count("in_flight");
        emit(log, "warn", { outcome: "in_flight" });
        // The first create may yet hand out a checkout. Retriable, with the same key: never "start another".
        throw new PivotaCommerceError("CHECKOUT_OUTCOME_UNKNOWN", { reason: IN_FLIGHT_REASON });
      }
      waited = true;
      await sleep(pollMs);
    }
  }
  return failOpen("claim_contended");
}
