// The Reap agentic lane's PURE parts, beside the door's other UCP suites: the checkout id codec, the status
// table, the hosted-URL check, the wire readers and the idempotency derivation. The lane end to end — through
// the real surface, the real backend client over a stubbed transport, the real money filter and the remote MCP
// adapter — is tests/reap_agentic_lane.node.test.cjs.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REAP_AGENTIC_LANE_FLAG,
  REAP_STATE_TO_UCP_STATUS,
  reapAgenticLaneEnabled,
  encodeReapCheckoutId,
  decodeReapCheckoutId,
  isReapCheckoutId,
  reapIdempotencyKey,
  reapConsentVersion,
  reapShippingAddress,
  reapMissingBuyerFields,
  reapMerchantDomain,
  vetHostedUrl,
  mapReapPurchaseToCheckout,
  buildDegradedReapCheckout,
  tryReapAgenticCheckout,
} from "../src/ucpReapAgenticLane.js";
import { ucpCommerceToolDefinitions } from "../src/commerceToolSurface.js";
import { UCP_DIALECT_OPERATIONS } from "../../safety-kernel/src/protocol/canonicalContract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const PID = "rp_283fba3ce85c4e59bb331e54";
const SNAP = Object.freeze({ purchaseId: PID, productId: "sig_reap_a", productKey: "prod::m_brand::shopify::1001", quantity: 1, currency: "USD", unitMinor: 4250 });
const STATUS_ENUM = ["incomplete", "requires_escalation", "ready_for_complete", "complete_in_progress", "completed", "canceled"];
// pivota-backend docs/reap_agentic_routes.md "States the door will see" — all nine.
const BACKEND_STATES = ["resolving", "needs_enrollment", "quoting", "awaiting_approval", "processing", "completed", "refused", "failed", "expired"];

describe("switch", () => {
  test("OFF by default; truthy spellings turn it on; nothing else does", () => {
    assert.equal(reapAgenticLaneEnabled({}), false);
    for (const v of ["0", "no", "off", "false", ""]) assert.equal(reapAgenticLaneEnabled({ [REAP_AGENTIC_LANE_FLAG]: v }), false, v);
    for (const v of ["1", "true", "yes", "on", "enabled", " TRUE "]) assert.equal(reapAgenticLaneEnabled({ [REAP_AGENTIC_LANE_FLAG]: v }), true, v);
  });

  test("OFF, or no client: every op returns null and reads nothing", async () => {
    const seen = [];
    const executor = { async execute(op) { seen.push(op); return { product: null }; } };
    const client = { startPurchase: async () => { throw new Error("must not be called"); }, getPurchase: async () => { throw new Error("must not be called"); } };
    const id = encodeReapCheckoutId(SNAP);
    for (const [opId, params] of [
      ["create_checkout_session", { idempotency_key: "idem-1234", quote: { items: [{ product_id: "sig_reap_a", quantity: 1 }] } }],
      ["get_checkout_session", { session_id: id }],
      ["update_checkout_session", { session_id: id }],
      ["complete_checkout_session", { session_id: id }],
    ]) {
      assert.equal(await tryReapAgenticCheckout({ op: { id: opId }, params, ctx: {}, executor, ucpArgs: {}, client, env: {} }), null, `${opId} flag off`);
      assert.equal(await tryReapAgenticCheckout({ op: { id: opId }, params, ctx: {}, executor, ucpArgs: {}, client: undefined, env: { [REAP_AGENTIC_LANE_FLAG]: "1" } }), null, `${opId} no client`);
    }
    assert.equal(seen.length, 0);
  });
});

describe("checkout id", () => {
  test("round-trips, starts with reap_ + the backend purchase id, and is canonical", () => {
    const id = encodeReapCheckoutId(SNAP);
    assert.ok(id.startsWith(`reap_${PID}.`));
    assert.deepEqual(decodeReapCheckoutId(id), { ...SNAP });
    assert.equal(isReapCheckoutId(id), true);
    assert.ok(id.length < 200);
  });

  test("refuses anything this door did not mint", () => {
    const good = encodeReapCheckoutId(SNAP);
    const snap = good.split(".")[1];
    const j = (o) => `reap_${PID}.${Buffer.from(JSON.stringify(o)).toString("base64url")}`;
    for (const bad of [
      null, 42, "", "reap_", "reap_../x", `reap_${"a".repeat(300)}`, `reap_${PID}`, `reap_${PID}.`, `reap_${PID}.${snap}=`,
      `esc_${PID}.${snap}`, `reap_rp_${"g".repeat(24)}.${snap}`, `reap_${PID}x.${snap}`, `reap_${PID}.${snap}.${snap}`,
      `reap_${PID}.${"A".repeat(600)}`,
      j({ i: "a", k: "k", q: 1, c: "USD", u: 1 }), j({ v: 1, i: "a", k: "k", q: 0, c: "USD", u: 1 }), j({ v: 1, i: "a", k: "k", q: 11, c: "USD", u: 1 }),
      j({ v: 1, i: "a", k: "k", q: 1, c: "US", u: 1 }), j({ v: 1, i: "a", k: "k", q: 1, c: "USD", u: 1.5 }), j({ v: 1, i: " a", k: "k", q: 1, c: "USD", u: 1 }),
      j({ v: 1, i: "a\u0000", k: "k", q: 1, c: "USD", u: 1 }), j({ v: 1, k: "k", q: 1, c: "USD", u: 1, i: "a" }), j({ v: 1, i: "a", k: "k", q: 1, c: "USD", u: 1, x: 1 }),
      j({ v: 1, i: "a", k: "k", q: 1, c: "USD", u: 1e13 }), j({ v: 1, i: "a", q: 1, c: "USD", u: 1 }),
      j({ v: 1, i: "a", k: "", q: 1, c: "USD", u: 1 }), j({ v: 1, k: "k", q: 1, c: "USD", u: 1 }), j({ v: 1, i: "a", k: "k ", q: 1, c: "USD", u: 1 }),
    ]) {
      assert.equal(decodeReapCheckoutId(bad), null, String(bad).slice(0, 80));
    }
    assert.ok(decodeReapCheckoutId(j({ v: 1, i: "a", k: "k", q: 1, c: "USD", u: 1 })), "control: the builder itself makes a valid id");
  });

  test("encode refuses a value that is not a backend purchase id", () => {
    assert.throws(() => encodeReapCheckoutId({ ...SNAP, purchaseId: "../etc" }));
  });
});

describe("status table", () => {
  test("every backend state maps to a UCP status, and only the two buyer-action states escalate", () => {
    assert.deepEqual(Object.keys(REAP_STATE_TO_UCP_STATUS).sort(), [...BACKEND_STATES].sort());
    for (const [state, status] of Object.entries(REAP_STATE_TO_UCP_STATUS)) {
      assert.ok(STATUS_ENUM.includes(status), `${state} -> ${status}`);
      assert.equal(status === "requires_escalation", ["needs_enrollment", "awaiting_approval"].includes(state), state);
    }
    assert.equal(REAP_STATE_TO_UCP_STATUS.processing, "complete_in_progress");
    assert.equal(REAP_STATE_TO_UCP_STATUS.completed, "completed");
    for (const s of ["refused", "failed", "expired"]) assert.equal(REAP_STATE_TO_UCP_STATUS[s], "canceled");
  });

  test("a view for a DIFFERENT purchase, or with an unknown state, is not mapped (the caller degrades)", () => {
    const id = encodeReapCheckoutId(SNAP);
    assert.equal(mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: { id: "rp_000000000000000000000000", state: "completed" }, now: NOW }), null);
    assert.equal(mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: { id: PID, state: "teleporting" }, now: NOW }), null);
    assert.equal(mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: null, now: NOW }), null);
  });

  test("the degraded answer is spec-shaped, incomplete, built from the id alone — and SAYS so", () => {
    const id = encodeReapCheckoutId({ ...SNAP, quantity: 3 });
    const out = buildDegradedReapCheckout({ id, snapshot: decodeReapCheckoutId(id), now: NOW, env: {} });
    assert.equal(out.status, "incomplete");
    assert.ok(out.messages.some((m) => m.code === "reap.view_unavailable" && /recorded in this checkout id/.test(m.content)));
    assert.equal(out.line_items[0].item.id, SNAP.productId, "the caller's id, never the product_key");
    assert.equal(JSON.stringify(out).includes(SNAP.productKey), false);
    for (const k of ["ucp", "id", "line_items", "status", "currency", "totals", "links"]) assert.ok(Object.hasOwn(out, k), k);
    assert.equal(out.totals.find((t) => t.type === "total").amount, 12750);
    assert.equal(Object.hasOwn(out, "continue_url"), false);
  });
});

describe("the approval deadline is the quote TTL, not the hosted page's expiry (measured 2026-09-25)", () => {
  const URL = "https://pay.prava.space/checkout/chk_7f3a";
  const SOON = new Date(NOW + 5 * 60_000).toISOString();
  const LATER = new Date(NOW + 15 * 60_000).toISOString();
  const PAST = new Date(NOW - 60_000).toISOString();
  const base = {
    id: PID, state: "awaiting_approval", product_key: SNAP.productKey, product_name: "Name", quantity: 1,
    totals: { currency: "USD", our_price_minor: 4250, quoted_total_minor: 4500, final_total_minor: null },
    hosted_url: URL, hosted_url_expires_at: LATER, reap_quote_expires_at: SOON, poll_after_seconds: 30,
  };
  const map = (view) => mapReapPurchaseToCheckout({ id: encodeReapCheckoutId(SNAP), snapshot: SNAP, view, now: NOW, env: {} });

  test("expires_at is approval_deadline when the backend sends it, and it is published as a bare message", () => {
    const out = map({ ...base, approval_deadline: SOON });
    assert.equal(out.status, "requires_escalation");
    assert.equal(out.continue_url, URL);
    assert.equal(out.expires_at, SOON);
    assert.equal(out.messages.find((m) => m.code === "reap.approval_deadline").content, SOON);
  });
  test("a passed approval_deadline hides a link whose page is still live, and says the window closed (not 'page not ready')", () => {
    const out = map({ ...base, approval_deadline: PAST });
    assert.equal(out.status, "incomplete");
    assert.equal(Object.hasOwn(out, "continue_url"), false);
    assert.equal(out.messages.some((m) => m.code === "reap.hosted_page_not_ready"), false);
    const passed = out.messages.find((m) => m.code === "reap.approval_deadline_passed");
    assert.equal(passed.type, "warning");
    assert.ok(passed.content.endsWith(`Closed at ${PAST}.`));
  });
  test("the raw deadline text is never echoed — only the normalised instant", () => {
    const raw = "2026-09-23T11:59:00+00:00";
    const out = map({ ...base, approval_deadline: raw });
    const passed = out.messages.find((m) => m.code === "reap.approval_deadline_passed");
    assert.equal(passed.content.includes(raw), false);
    assert.ok(passed.content.endsWith("Closed at 2026-09-23T11:59:00.000Z."));
    const live = map({ ...base, approval_deadline: "2026-09-23T12:05:00+00:00" });
    assert.equal(live.expires_at, "2026-09-23T12:05:00.000Z");
    assert.equal(live.messages.find((m) => m.code === "reap.approval_deadline").content, "2026-09-23T12:05:00.000Z");
  });
  test("absent (or null) approval_deadline falls back to hosted_url_expires_at; a present unreadable one does not", () => {
    assert.equal(map(base).expires_at, LATER);
    assert.equal(map({ ...base, approval_deadline: null }).expires_at, LATER);
    assert.equal(map({ ...base, approval_deadline: "not a time" }).status, "incomplete");
  });
  test("needs_enrollment never carries the deadline message", () => {
    const out = map({ ...base, state: "needs_enrollment", hosted_url: "https://pay.prava.space/enroll/1", reap_quote_expires_at: null });
    assert.equal(out.status, "requires_escalation");
    assert.equal(out.expires_at, LATER);
    assert.equal(out.messages.some((m) => m.code === "reap.approval_deadline"), false);
  });
});

describe("a successful read is the ONLY source of what is displayed", () => {
  const VIEW = {
    id: PID, state: "processing", product_key: "prod::m_brand::shopify::1001", product_name: "Backend Name", quantity: 2,
    totals: { currency: "CAD", our_price_minor: 999, quoted_total_minor: 2222, final_total_minor: null },
    order_reference: "ord_should_not_leak", poll_after_seconds: 45,
  };
  test("item id echoes the CALLER's id; title, quantity, currency, unit price and totals come from the view, never the snapshot", () => {
    const id = encodeReapCheckoutId(SNAP);
    const out = mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: VIEW, now: NOW, env: {} });
    assert.equal(out.currency, "CAD");
    assert.deepEqual(out.line_items, [{
      id: "li_1",
      item: { id: "sig_reap_a", title: "Backend Name", price: 999 },
      quantity: 2,
      totals: [{ type: "subtotal", amount: 1998 }, { type: "total", amount: 1998 }],
    }]);
    assert.deepEqual(out.totals.map((t) => [t.type, t.amount]), [["subtotal", 1998], ["total", 2222]]);
    assert.equal(JSON.stringify(out).includes("ord_should_not_leak"), false, "an order reference is only published on completed");
    assert.equal(JSON.stringify(out).includes("prod::"), false, "the product_key (an internal merchant id) is never published");
  });
  test("the product_key is a HIDDEN cross-check: a view of another product is a failed read", () => {
    const id = encodeReapCheckoutId(SNAP);
    assert.equal(mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: { ...VIEW, product_key: "prod::m_other::shopify::2002" }, now: NOW, env: {} }), null);
  });
  test("a view missing any displayed field is NOT filled from the snapshot — it is not the documented shape", () => {
    const id = encodeReapCheckoutId(SNAP);
    for (const drop of [
      (v) => { delete v.product_key; }, (v) => { delete v.quantity; }, (v) => { delete v.totals.currency; },
      (v) => { delete v.totals.our_price_minor; }, (v) => { delete v.totals; }, (v) => { v.quantity = 0; },
    ]) {
      const v = structuredClone(VIEW); drop(v);
      assert.equal(mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: v, now: NOW, env: {} }), null);
    }
  });
  test("an unknown but well-formed state is `incomplete`, named, and reported once to the caller", () => {
    const seen = [];
    const out = mapReapPurchaseToCheckout({ id: encodeReapCheckoutId(SNAP), snapshot: SNAP, view: { ...VIEW, state: "partner_review" }, now: NOW, env: {}, onUnrecognisedState: (s) => seen.push(s) });
    assert.equal(out.status, "incomplete");
    assert.ok(out.messages.some((m) => m.code === "reap.state_unrecognised"));
    assert.ok(out.messages.some((m) => m.code === "reap.poll_after_seconds" && m.content === "45"));
    assert.deepEqual(seen, ["partner_review"]);
  });
  test("terminal reasons: uppercase backend codes are shown lowercased; unsafe ones are not echoed", () => {
    const id = encodeReapCheckoutId(SNAP);
    const reason = (r) => mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: { ...VIEW, state: "failed", last_error_code: r }, now: NOW, env: {} })
      .messages.find((m) => m.code === "reap.purchase_failed").content;
    assert.match(reason("ENROLLMENT_NOT_ACTIVE"), /Reason: enrollment_not_active\./);
    assert.match(reason("AGENTIC_QUOTE_EXPIRED"), /Reason: agentic_quote_expired\./);
    assert.match(reason("options:sole_label_differs:size"), /Reason: options:sole_label_differs:size\./);
    assert.doesNotMatch(reason("buyer ada@example.test said <no>"), /Reason:/);
  });
});

describe("hosted url", () => {
  test("https, an allowlisted host (exact or dot-suffix), default port, unexpired, and intact through the money filter", () => {
    assert.equal(vetHostedUrl("https://pay.prava.space/checkout/chk_1", "2099-01-01T00:00:00+00:00", NOW), "https://pay.prava.space/checkout/chk_1");
    const LATER = "2099-01-01T00:00:00+00:00";
    assert.equal(vetHostedUrl("https://prava.space/x", LATER, NOW), "https://prava.space/x");
    assert.equal(vetHostedUrl("https://api.reap.global/x", LATER, NOW), "https://api.reap.global/x");
    // ONLY with a present, future expiry.
    for (const exp of [undefined, null, "", 1893456000000]) assert.equal(vetHostedUrl("https://pay.prava.space/x", exp, NOW), null, `expiry ${exp}`);
    for (const bad of [
      "http://pay.prava.space/x", "https://evilprava.space/x", "https://pay.prava.space.evil.example/x",
      "https://user:pw@pay.prava.space/x", "https://pay.prava.space:8443/x", "javascript:alert(1)", "not a url",
      "https://pay.prava.space/x?token=abc", "https://pay.prava.space/x?code=abc", "https://pay.prava.space/a b", "",
    ]) {
      assert.equal(vetHostedUrl(bad, "2099-01-01T00:00:00+00:00", NOW), null, bad);
    }
    assert.equal(vetHostedUrl("https://pay.prava.space/x", "2026-09-23T11:59:59+00:00", NOW), null, "expired");
    assert.equal(vetHostedUrl("https://pay.prava.space/x", "garbage", NOW), null, "unparseable expiry");
  });
});

describe("wire readers", () => {
  const args = (buyer, destination) => ({
    checkout: {
      buyer,
      fulfillment: destination === undefined ? undefined : { methods: [{ type: "shipping", destinations: [destination] }] },
    },
  });
  const DEST = { first_name: "Ada", last_name: "Lovelace", phone_number: "+15550100", street_address: "900 Brannan St", address_locality: "San Francisco", postal_code: "94103", address_country: "us" };

  test("consent_version: any string is returned VERBATIM (the backend owns the validator); a non-string is absent", () => {
    for (const v of [" Reap-Agentic-V1 ", "v\u00a01", "版本", "", "  "]) {
      assert.equal(reapConsentVersion(args({ consent_version: v })), v, JSON.stringify(v));
    }
    for (const v of [undefined, null, 7, true, {}, []]) assert.equal(reapConsentVersion(args({ consent_version: v })), undefined, JSON.stringify(v));
    assert.equal(reapConsentVersion({}), undefined);
  });

  test("shipping address: Reap field names, WHATEVER arrived (the backend judges completeness); phone falls back to buyer.phone_number", () => {
    assert.deepEqual(reapShippingAddress(args({}, DEST)), {
      firstName: "Ada", lastName: "Lovelace", phone: "+15550100", addressLine1: "900 Brannan St", city: "San Francisco", postalCode: "94103", country: "us",
    });
    assert.equal(reapShippingAddress(args({ phone_number: "+15550199" }, { ...DEST, phone_number: undefined })).phone, "+15550199");
    assert.deepEqual(Object.keys(reapShippingAddress(args({}, { ...DEST, phone_number: undefined, last_name: undefined }))).sort(),
      ["addressLine1", "city", "country", "firstName", "postalCode"]);
    assert.equal(reapShippingAddress(args({}, undefined)), undefined);
  });

  test("missing buyer fields: named by their UCP paths, field names only", () => {
    const D = "checkout.fulfillment.methods[0].destinations[0]";
    assert.deepEqual(reapMissingBuyerFields(args({}, DEST), "a@b.test"), []);
    assert.deepEqual(reapMissingBuyerFields(args({}, { ...DEST, last_name: undefined, phone_number: undefined }), "a@b.test"), [`${D}.last_name`, `${D}.phone_number`]);
    assert.deepEqual(reapMissingBuyerFields(args({ phone_number: "+1" }, { ...DEST, phone_number: undefined }), null), ["checkout.buyer.email"]);
    assert.deepEqual(reapMissingBuyerFields(args({}, undefined), "a@b.test"), [D]);
  });

  test("merchant domain: AS OBSERVED, lowercased only — no `www.` stripped anywhere; never a non-hostname", () => {
    assert.equal(reapMerchantDomain({ source_domain: "Brand.Example" }, "https://www.other.example/p"), "brand.example");
    assert.equal(reapMerchantDomain({ source_domain: "www.Brand.com" }, null), "www.brand.com", "explicit field keeps its www.");
    assert.equal(reapMerchantDomain({}, "https://www.brand.example/products/x?y=1"), "www.brand.example", "the URL host keeps its www.");
    assert.equal(reapMerchantDomain({}, "https://WWW.Brand.Example/p"), "www.brand.example");
    assert.equal(reapMerchantDomain({ canonical_url: "https://shop.brand.example/p" }, null), "shop.brand.example");
    assert.equal(reapMerchantDomain({ source_domain: "brand.example/../x" }, null), null);
    // Pivota's own hosts are never the merchant: an attribution redirect or the canonical PDP is skipped.
    assert.equal(reapMerchantDomain({ canonical_url: "https://agent.pivota.cc/products/sig_a", url: "https://www.brand.example/p" }, "https://agent.pivota.cc/r?token=a.b"), "www.brand.example");
    assert.equal(reapMerchantDomain({ destination_url: "https://tracking.example/out" }, null), null, "destination_url is never read");
    assert.equal(reapMerchantDomain({}, null), null);
  });
});

describe("idempotency", () => {
  test("derived, deterministic, namespaced, bounded, and never the raw caller key", () => {
    const a = reapIdempotencyKey("idem-reap-0001");
    assert.equal(a, reapIdempotencyKey("idem-reap-0001"));
    assert.equal(a, reapIdempotencyKey("  idem-reap-0001  "));
    assert.notEqual(a, reapIdempotencyKey("idem-reap-0002"));
    assert.match(a, /^ucp-reap-v1-[0-9a-f]{48}$/);
    assert.ok(a.length <= 128);
    assert.equal(reapIdempotencyKey(""), null);
    assert.equal(reapIdempotencyKey(undefined), null);
  });
});

describe("ratchets this lane must not move", () => {
  test("no new UCP tool name and no new canonical operation", () => {
    const names = ucpCommerceToolDefinitions.map((d) => d.name).sort();
    assert.deepEqual(names, [...new Set(UCP_DIALECT_OPERATIONS.map((op) => op.ucpTool))].filter((n) => names.includes(n)).sort());
    for (const n of names) assert.equal(/reap/i.test(n), false, n);
    for (const op of UCP_DIALECT_OPERATIONS) assert.equal(/reap/i.test(`${op.id} ${op.ucpTool}`), false, op.id);
  });

  test("the lane module makes no network call of its own (the backend client is injected)", () => {
    const src = fs.readFileSync(path.join(HERE, "..", "src", "ucpReapAgenticLane.js"), "utf8")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\bfetch\s*\(|axios|https?\.request|node:https|node:http\b/);
  });
});

describe("offer codes are advertised and accepted ONLY while armed (review of #2323, G1/G8)", async () => {
  const adapter = await import("../src/ucpArgumentAdapter.js");
  const lane = await import("../src/ucpReapAgenticLane.js");
  const ARMED = { REAP_AGENTIC_LANE_ENABLED: "1", REAP_AGENTIC_CART_LINK_LANE_ENABLED: "1" };
  const op = { id: "create_checkout_session" };
  const body = (discounts) => ({
    meta: { "ucp-agent": { profile: "https://p.example/.well-known/ucp-agent" }, "idempotency-key": "k1" },
    checkout: { line_items: [{ item: { id: "sig_a" }, quantity: 1 }], buyer: { email: "a@b.example" }, ...(discounts ? { discounts } : {}) },
  });
  test("the arming rule is lane AND cart-link dial", () => {
    assert.equal(lane.reapOfferCodesEnabled({}), false);
    assert.equal(lane.reapOfferCodesEnabled({ REAP_AGENTIC_LANE_ENABLED: "1" }), false);
    assert.equal(lane.reapOfferCodesEnabled({ REAP_AGENTIC_CART_LINK_LANE_ENABLED: "1" }), false);
    assert.equal(lane.reapOfferCodesEnabled(ARMED), true);
  });
  test("schema: `discounts` on create/update_checkout only when armed", () => {
    const has = (env, id) => Object.hasOwn(adapter.ucpInputSchemasFor(env)[id].properties.checkout.properties, "discounts");
    assert.equal(has({}, "create_checkout_session"), false);
    assert.equal(has({}, "update_checkout_session"), false);
    assert.equal(has(ARMED, "create_checkout_session"), true);
    assert.equal(has(ARMED, "update_checkout_session"), true);
    assert.equal(adapter.ucpInputSchemasFor({}), adapter.UCP_INPUT_SCHEMAS, "unarmed is byte-identical to the base schemas");
  });
  test("mapper: refused as an unknown field when not armed; accepted and NOT mapped into the quote when armed", () => {
    assert.throws(() => adapter.ucpToNativeToolArgs(op, body({ codes: ["SAVE10"] }), {}), (e) => e.detail?.reason === "ucp_unknown_field" || /discounts/.test(JSON.stringify(e)));
    const mapped = adapter.ucpToNativeToolArgs(op, body({ codes: ["SAVE10"] }), ARMED);
    assert.equal(JSON.stringify(mapped).includes("SAVE10"), false, "a code never reaches the kernel quote");
  });
});

// ---- THE SELLER (docs/reap-agentic-lane.md §5.4): refused at the door on a difference; published on Reap answers --

describe("the seller contract (cc.pivota.reap_seller)", async () => {
  const lane = await import("../src/ucpReapAgenticLane.js");
  const adapter = await import("../src/ucpArgumentAdapter.js");
  const { CANONICAL_CAPABILITIES } = await import("../../safety-kernel/src/protocol/canonicalContract.js");
  const LANE_ON = { [REAP_AGENTIC_LANE_FLAG]: "1" };
  const msg = (out, code) => (out.messages || []).filter((m) => m.code === code);

  test("canonicalisation is the backend's: lowercase, ONE leading www. removed, bare ASCII hosts only", () => {
    const c = lane.canonicalReapMerchantDomain;
    assert.equal(c("brand.com"), "brand.com");
    assert.equal(c("Brand.COM"), "brand.com");
    assert.equal(c("www.brand.com"), "brand.com");
    assert.equal(c("WWW.Brand.com"), "brand.com");
    assert.equal(c("www.www.brand.com"), "www.brand.com", "folded ONCE, as pivota-backend canonical_merchant_domain");
    assert.equal(c("wwwbrand.com"), "wwwbrand.com", "only a whole `www.` label");
    assert.equal(c("shop.brand.com"), "shop.brand.com", "no other subdomain is stripped");
    assert.equal(c("xn--brnd-hra.com"), "xn--brnd-hra.com", "punycode is ASCII");
    for (const bad of ["", " brand.com", "brand.com ", "https://brand.com", "brand.com/x", "brand.com:443", "user@brand.com",
      "brand", "www.com", "agent.pivota.cc", "PIVOTA.CC", "brand..com", null, undefined, 42, ["brand.com"],
      // Non-ASCII is refused BEFORE the fold: U+212A KELVIN SIGN lowercases to ASCII `k`, U+0130 to `i̇`.
      "Kiko.com", "www.Kiko.com", "bränd.com", "İnfo.com", "brand．com"]) {
      assert.equal(c(bad), null, JSON.stringify(bad));
    }
  });

  test("isSameReapMerchant: bare vs www. and case match; a different seller, or a missing row merchant, does not", () => {
    const same = lane.isSameReapMerchant;
    assert.equal(same("brand.com", "www.brand.com"), true, "bare expected, www. row");
    assert.equal(same("www.brand.com", "brand.com"), true, "www. expected, bare row");
    assert.equal(same("BRAND.com", "www.brand.COM"), true, "case");
    assert.equal(same("other.com", "www.brand.com"), false, "a different seller");
    assert.equal(same("shop.brand.com", "brand.com"), false, "a different host of the same registrable domain");
    assert.equal(same("Kiko.com", "kiko.com"), false, "a lookalike is not the seller");
    assert.equal(same("brand.com", null), false, "missing row merchant: fail closed");
    assert.equal(same("brand.com", undefined), false);
    assert.equal(same("not a host", "not a host"), false, "two unreadable values are never a match");
  });

  test("a row's explicit non-ASCII merchant domain is not folded into an ASCII one", () => {
    assert.equal(lane.reapMerchantDomain({ merchant_domain: "Kiko.com" }, null), null);
    assert.equal(lane.reapMerchantDomain({ merchant_domain: "Kiko.com" }, null), "kiko.com");
  });

  test("the merchant id is the product key's <merchant> segment, or nothing", () => {
    assert.equal(lane.reapMerchantIdOfProductKey("prod::m_brand::shopify::1001"), "m_brand");
    for (const bad of ["prod::m_brand::shopify", "sku::m_brand::shopify::1", "prod::::shopify::1", "prod::a b::shopify::1", null, 7]) {
      assert.equal(lane.reapMerchantIdOfProductKey(bad), null, String(bad));
    }
  });

  const VIEW = { id: PID, state: "resolving", merchant_domain: "WWW.Brand.example", product_key: SNAP.productKey, product_name: "N", quantity: 1, totals: { currency: "USD", our_price_minor: 4250 }, poll_after_seconds: 30 };
  test("get: the seller comes from the VIEW (lowercased as observed) and the checked product key, at $.line_items[0]", () => {
    const id = encodeReapCheckoutId(SNAP);
    const out = mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: VIEW, now: NOW, env: {} });
    assert.deepEqual(msg(out, "reap.merchant_domain"), [{ type: "info", code: "reap.merchant_domain", path: "$.line_items[0]", content: "www.brand.example", content_type: "plain" }]);
    assert.deepEqual(msg(out, "reap.merchant_id"), [{ type: "info", code: "reap.merchant_id", path: "$.line_items[0]", content: "m_brand", content_type: "plain" }]);
    assert.equal(out.messages.at(-1).code, "reap.lane", "the lane note stays last");
    for (const merchant_domain of [undefined, null, "", "agent.pivota.cc", "https://brand.example", "Kiko.com"]) {
      const o = mapReapPurchaseToCheckout({ id, snapshot: SNAP, view: { ...VIEW, merchant_domain }, now: NOW, env: {} });
      assert.equal(msg(o, "reap.merchant_domain").length, 0, String(merchant_domain));
      assert.equal(msg(o, "reap.merchant_id")[0].content, "m_brand");
    }
  });

  test("degraded get: NO seller message at all -- its only source is the caller-carried id", () => {
    // A crafted id (a product key naming any merchant) must not make this door name a seller.
    const crafted = { ...SNAP, productKey: "prod::m_attacker::shopify::1" };
    const id = encodeReapCheckoutId(crafted);
    const out = buildDegradedReapCheckout({ id, snapshot: decodeReapCheckoutId(id), now: NOW, env: {} });
    assert.ok(msg(out, "reap.view_unavailable").length);
    assert.equal(msg(out, "reap.merchant_domain").length + msg(out, "reap.merchant_id").length, 0);
    assert.equal(JSON.stringify(out).includes("m_attacker"), false);
  });

  // The lane, called directly with SPIES: the purchase client and the purchasability gate.
  const ROW = { product_id: "sig_reap_a", title: "T", price: 42.5, currency: "USD", external_redirect_url: "https://www.brand.example/products/x", product_key: "prod::m_brand::shopify::1001", purchase_grain: "product", variants: [{ variant_id: "sig_reap_a" }] };
  function harness(row = ROW) {
    const calls = { start: 0, get: 0, gate: 0, reads: 0 };
    const client = {
      hasCallerCredentials: () => true,
      startPurchase: async () => { calls.start += 1; return { kind: "accepted", purchase: { id: PID, state: "resolving", poll_after_seconds: 60 } }; },
      getPurchase: async () => { calls.get += 1; return { kind: "unavailable" }; },
    };
    const executor = { async execute(op, params) { calls.reads += 1; return { product: params.payload.product.product_id === row.product_id ? { ...row } : null }; } };
    const logs = [];
    const log = { info: (d) => logs.push(d), warn: (d) => logs.push(d) };
    const ucpArgs = (expected) => ({ checkout: { line_items: [{ item: { id: row.product_id }, quantity: 1 }], context: { address_country: "US" }, ...(expected === undefined ? {} : { reap: { expected_merchant_domain: expected } }) } });
    const params = { idempotency_key: "idem-seller-1", quote: { items: [{ product_id: row.product_id, quantity: 1 }], customer_email: "a@b.example" } };
    const run = (expected, hints = []) => lane.tryReapAgenticCheckout({
      op: { id: "create_checkout_session" }, params, ctx: {}, executor, client, log, now: NOW, hints,
      // The purchasability gate ON, so "the gate was not asked" is a real claim (off, it is never asked).
      env: { ...LANE_ON, MERCHANT_PURCHASABILITY_GATE_ENABLED: "1" },
      shouldOfferPurchase: async () => { calls.gate += 1; return true; },
      ucpArgs: ucpArgs(expected),
    });
    const door = (expected) => lane.assertExpectedSeller({ ucpArgs: ucpArgs(expected), params, executor, ctx: {} });
    return { calls, run, door, logs };
  }
  const refusal = async (p) => { try { await p; } catch (e) { return e; } return null; };

  test("DOOR: a different seller is REFUSED ucp_seller_mismatch with the served seller in the detail", async () => {
    const h = harness();
    const e = await refusal(h.door("other.example"));
    assert.equal(e.code, "QUOTE_REQUIRED");
    assert.equal(e.detail.reason, lane.SELLER_MISMATCH_REASON);
    assert.equal(lane.SELLER_MISMATCH_REASON, "ucp_seller_mismatch");
    assert.deepEqual(e.detail.acp_detail, {
      reason: "ucp_seller_mismatch", dialect: "ucp", rejected_field: "checkout.reap.expected_merchant_domain",
      cause: "different_seller", line_item: "$.line_items[0]", merchant_domain: "www.brand.example", merchant_id: "m_brand",
    });
    assert.equal(e.detail.acp_message.includes("other.example"), false, "no request value is echoed");
    assert.deepEqual([h.calls.start, h.calls.gate], [0, 0]);
  });

  test("DOOR: the same seller (bare vs www., any case) passes; absent reads NOTHING", async () => {
    for (const expected of ["brand.example", "www.brand.example", "BRAND.Example", "WWW.BRAND.EXAMPLE"]) {
      assert.equal(await refusal(harness().door(expected)), null, expected);
    }
    const h = harness();
    assert.equal(await refusal(h.door(undefined)), null);
    assert.equal(h.calls.reads, 0, "no expected seller: the door does not even read");
  });

  test("DOOR fails CLOSED: no row merchant, an absent row, a failed read, a non-string value", async () => {
    const noHost = harness({ ...ROW, external_redirect_url: "https://agent.pivota.cc/r?token=abc" });
    let e = await refusal(noHost.door("brand.example"));
    assert.deepEqual([e.detail.reason, e.detail.acp_detail.cause, e.detail.acp_detail.merchant_domain, e.detail.acp_detail.merchant_id], ["ucp_seller_mismatch", "seller_unconfirmed", undefined, "m_brand"]);
    const absent = harness();
    e = await refusal(lane.assertExpectedSeller({
      ucpArgs: { checkout: { reap: { expected_merchant_domain: "brand.example" } } },
      params: { quote: { items: [{ product_id: "sig_gone", quantity: 1 }] } }, executor: { execute: async () => ({ product: null }) }, ctx: {},
    }));
    assert.equal(e.detail.acp_detail.cause, "seller_unconfirmed");
    e = await refusal(lane.assertExpectedSeller({
      ucpArgs: { checkout: { reap: { expected_merchant_domain: "brand.example" } } },
      params: { quote: { items: [{ product_id: "sig_reap_a", quantity: 1 }] } }, executor: { execute: async () => { throw new Error("upstream down"); } }, ctx: {},
    }));
    assert.deepEqual([e.detail.reason, e.detail.acp_detail.cause, e.detail.acp_detail.line_item], ["ucp_seller_mismatch", "seller_unconfirmed", undefined]);
    for (const v of [null, 42, { host: "brand.example" }, ["brand.example"]]) {
      e = await refusal(absent.door(v));
      assert.equal(e && e.detail.reason, "ucp_seller_mismatch", JSON.stringify(v));
    }
  });

  test("DOOR: EVERY line must be the expected seller; the first that is not is named", async () => {
    const rows = { a: { ...ROW, product_id: "a" }, b: { ...ROW, product_id: "b", external_redirect_url: "https://other.example/p", product_key: "prod::m_other::shopify::2" } };
    const executor = { async execute(op, params) { return { product: rows[params.payload.product.product_id] || null }; } };
    const e = await refusal(lane.assertExpectedSeller({
      ucpArgs: { checkout: { reap: { expected_merchant_domain: "brand.example" } } },
      params: { quote: { items: [{ product_id: "a", quantity: 1 }, { product_id: "b", quantity: 2 }] } }, executor, ctx: {},
    }));
    assert.deepEqual([e.detail.acp_detail.line_item, e.detail.acp_detail.merchant_domain, e.detail.acp_detail.merchant_id], ["$.line_items[1]", "other.example", "m_other"]);
  });

  test("LANE (belt and braces behind the door): a different seller opens nothing, silently", async () => {
    for (const expected of ["other.example", null, 42]) {
      const h = harness();
      const hints = [];
      assert.equal(await h.run(expected, hints), null);
      assert.deepEqual([h.calls.start, h.calls.gate], [0, 0], String(expected));
      assert.deepEqual(hints, []);
      assert.equal(h.logs.at(-1).code, "seller_mismatch");
    }
  });

  test("LANE: the same seller proceeds and the create answer names it; absent is unchanged", async () => {
    for (const expected of ["brand.example", "WWW.BRAND.EXAMPLE", undefined]) {
      const h = harness();
      const out = await h.run(expected);
      assert.ok(out && out.id.startsWith(`reap_${PID}.`), String(expected));
      assert.equal(h.calls.start, 1);
      assert.equal(msg(out, "reap.merchant_domain")[0].content, "www.brand.example", "published as POSTed");
      assert.equal(msg(out, "reap.merchant_id")[0].content, "m_brand");
      assert.deepEqual(decodeReapCheckoutId(out.id), { purchaseId: PID, productId: ROW.product_id, productKey: ROW.product_key, quantity: 1, currency: "USD", unitMinor: 4250 }, "the id format is main's");
    }
  });

  test("the checkout id must ROUND-TRIP before the POST: near-bound inputs", async () => {
    // At the bound (256-char item id, 256-char key, quantity 10, the largest unit price): opens, and decodes back.
    const key256 = `prod::m_brand::shopify::${"9".repeat(256 - "prod::m_brand::shopify::".length)}`;
    const atBound = { ...ROW, product_id: "s".repeat(256), product_key: key256, price: 1e10 - 0.01 };
    const h = harness(atBound);
    const out = await h.run(undefined);
    assert.ok(out, "at the bound the purchase opens");
    assert.ok(out.id.length <= 1100);
    assert.equal(decodeReapCheckoutId(out.id).productId, atBound.product_id);
    // One past it (an item id the id codec cannot carry back): skipped BEFORE the POST, not minted undecodable.
    for (const productId of ["s".repeat(257), "sig_a\u0007b"]) {
      const h2 = harness({ ...ROW, product_id: productId });
      assert.equal(await h2.run(undefined), null, JSON.stringify(productId).slice(0, 20));
      assert.equal(h2.calls.start, 0, "no purchase opened");
      assert.equal(h2.logs.at(-1).code, "id_unencodable");
    }
  });

  test("judgeSellerUrl: the link's host must be the seller; hops, Pivota hosts, http and userinfo are unconfirmed", () => {
    const j = lane.judgeSellerUrl;
    assert.deepEqual(j("brand.example", "https://www.brand.example/products/x?variant=1&utm_source=pivota"), { ok: true });
    assert.deepEqual(j("brand.example", "https://other-seller.example/p"), { ok: false, cause: "different_seller", host: "other-seller.example" });
    for (const url of [
      "https://click.linksynergy.com/deeplink?id=a&murl=https%3A%2F%2Fother-seller.example%2Fp",
      "https://www.brand.example/go?url=https://www.brand.example/p",
      "https://www.brand.example/go?u=%2F%2Fother-seller.example",
      "https://www.brand.example/go?u=https%253A%252F%252Fother.example",
      "https://www.brand.example/redirect/https://other-seller.example/p",
      "https://www.brand.example/redirect/https%3A%2F%2Fother-seller.example",
      "https://agent.pivota.cc/r?token=abc",
      "http://www.brand.example/p",
      "https://user:pw@www.brand.example/p",
      "not a url",
      "https://xn--brnd-hra.com/p",
    ]) {
      assert.equal(j("brand.example", url).ok, false, url);
      if (!url.includes("xn--")) assert.equal(j("brand.example", url).cause, "seller_unconfirmed", url);
    }
  });

  test("judgeRowSeller: native rows are checked against their REGISTERED store, never a catalog url", () => {
    const native = { product_id: "p", merchant_id: "merchant_native", canonical_url: "https://native.example/p", url: "https://native.example/p" };
    assert.deepEqual(lane.judgeRowSeller("native.example", native, null), { ok: false, cause: "seller_unconfirmed" }, "catalog url only: unconfirmed");
    assert.deepEqual(lane.judgeRowSeller("native.example", { ...native, online_store_url: "https://www.native.example/products/p" }, null), { ok: true });
    assert.deepEqual(lane.judgeRowSeller("native.example", { ...native, external_redirect_url: "https://native.example/products/p", purchase_route: "internal_checkout" }, null), { ok: true });
    assert.equal(lane.judgeRowSeller("native.example", { ...native, online_store_url: "https://native.example/p", external_redirect_url: "https://other.example/p" }, null).cause, "different_seller", "EVERY registered destination");
    assert.deepEqual(lane.judgeRowSeller("native.example", { ...native, merchant_domain: "native.example" }, null), { ok: true }, "an explicit merchant field");
    assert.equal(lane.judgeRowSeller("native.example", { ...native, merchant_domain: "native.example", online_store_url: "https://other.example/p" }, null).cause, "different_seller");
    // A non-native row: the explicit field AND the storefront target, never online_store_url (not a destination there).
    const esc = { external_redirect_url: "https://www.brand.example/p", online_store_url: "https://ignored.example/p" };
    assert.deepEqual(lane.judgeRowSeller("brand.example", esc, esc.external_redirect_url), { ok: true });
    assert.equal(lane.judgeRowSeller("brand.example", { ...esc, merchant_domain: "other.example" }, esc.external_redirect_url).cause, "different_seller");
    assert.equal(lane.judgeRowSeller("brand.example", null, null).cause, "seller_unconfirmed");
    assert.equal(lane.judgeRowSeller("brand.example", { merchant_domain: "Kiko.com" }, null).cause, "seller_unconfirmed");
  });

  const createOp = { id: "create_checkout_session" };
  const updateOp = { id: "update_checkout_session" };
  const body = (reap, extra = {}) => ({
    meta: { "ucp-agent": { profile: "https://p.example/.well-known/ucp-agent" }, "idempotency-key": "k1" },
    ...extra,
    checkout: { line_items: [{ item: { id: "sig_a" }, quantity: 1 }], buyer: { email: "a@b.example" }, ...(reap === undefined ? {} : { reap }) },
  });
  const reasonOf = (fn) => { try { fn(); return "accepted"; } catch (e) { return e.detail?.reason || e.message; } };

  test("adapter: `checkout.reap` is advertised and accepted ONLY on create_checkout and ONLY while the lane is on", () => {
    const has = (env, id) => Object.hasOwn(adapter.ucpInputSchemasFor(env)[id].properties.checkout.properties, "reap");
    assert.equal(has({}, "create_checkout_session"), false);
    assert.equal(has(LANE_ON, "create_checkout_session"), true);
    assert.equal(has(LANE_ON, "update_checkout_session"), false);
    assert.equal(has({ ...LANE_ON, REAP_AGENTIC_CART_LINK_LANE_ENABLED: "1" }, "create_checkout_session"), true, "armed keeps it");
    assert.equal(has({ REAP_AGENTIC_CART_LINK_LANE_ENABLED: "1" }, "create_checkout_session"), false, "the cart-link dial alone is not the lane");
    assert.equal(adapter.ucpInputSchemasFor({}), adapter.UCP_INPUT_SCHEMAS, "off is the very same object as main's");
    assert.equal(adapter.ucpToolDescriptionsFor({}), adapter.UCP_TOOL_DESCRIPTIONS);
    assert.match(adapter.ucpToolDescriptionsFor(LANE_ON).create_checkout_session, /checkout\.reap\.expected_merchant_domain.*cc\.pivota\.reap_seller/);
    assert.doesNotMatch(adapter.UCP_TOOL_DESCRIPTIONS.create_checkout_session, /expected_merchant_domain/);

    assert.equal(reasonOf(() => adapter.ucpToNativeToolArgs(createOp, body({ expected_merchant_domain: "brand.com" }), {})), "ucp_unknown_field", "lane off: unknown field, as before");
    const mapped = adapter.ucpToNativeToolArgs(createOp, body({ expected_merchant_domain: "SELLER-SENTINEL.example" }), LANE_ON);
    assert.equal(JSON.stringify(mapped).toLowerCase().includes("seller-sentinel"), false, "never reaches the canonical quote");
    assert.equal(reasonOf(() => adapter.ucpToNativeToolArgs(createOp, body({}), LANE_ON)), "accepted", "an empty `reap` is fine");
    assert.equal(reasonOf(() => adapter.ucpToNativeToolArgs(updateOp, body({ expected_merchant_domain: "brand.com" }, { id: "q_1" }), LANE_ON)), "ucp_unknown_field", "create only");
  });

  test("adapter: a value that could never match any seller is refused loudly, by the lane's own rule", () => {
    for (const v of ["https://brand.com", "brand.com/p", "brand.com:443", "brand", "", " brand.com", "agent.pivota.cc", "Kiko.com", 42, null, ["brand.com"], "a".repeat(254)]) {
      assert.equal(reasonOf(() => adapter.ucpToNativeToolArgs(createOp, body({ expected_merchant_domain: v }), LANE_ON)), "ucp_expected_merchant_domain_invalid", JSON.stringify(v).slice(0, 40));
    }
    for (const reap of ["brand.com", ["brand.com"], null]) {
      assert.equal(reasonOf(() => adapter.ucpToNativeToolArgs(createOp, body(reap), LANE_ON)), "ucp_expected_merchant_domain_invalid", JSON.stringify(reap));
    }
    assert.equal(reasonOf(() => adapter.ucpToNativeToolArgs(createOp, body({ expected_merchant_domain: "brand.com", seller: "x" }), LANE_ON)), "ucp_unknown_field", "a strict object");
    for (const ok of ["brand.com", "WWW.Brand.com", "shop.brand.co.uk"]) {
      assert.equal(reasonOf(() => adapter.ucpToNativeToolArgs(createOp, body({ expected_merchant_domain: ok }), LANE_ON)), "accepted", ok);
    }
  });

  test("the vendor extension schema is self-describing, composed onto checkout, and IS the advertised member", () => {
    const hosted = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "docs", "ucp", "reap_seller.json"), "utf8"));
    assert.deepEqual(hosted, JSON.parse(JSON.stringify(adapter.REAP_SELLER_EXTENSION_SCHEMA)), "docs/ucp/reap_seller.json is the byte copy to host");
    const cap = CANONICAL_CAPABILITIES.reap_seller;
    assert.equal(hosted.name, cap.ucp);
    assert.equal(hosted.name, adapter.REAP_SELLER_CAPABILITY_ID);
    assert.equal(new URL(hosted.$id).host, "pivota.cc", "hosted on the namespace authority (reverse of cc.pivota)");
    // "Extension schemas MUST have a $defs entry for each parent declared in extends" -- keyed by full name.
    for (const parent of cap.extends) {
      assert.ok(hosted.$defs[parent], parent);
      assert.ok(Array.isArray(hosted.$defs[parent].allOf));
      assert.match(hosted.$defs[parent].allOf[0].$ref, /\/schemas\/shopping\/checkout\.json$/);
    }
    assert.deepEqual(Object.keys(hosted.requires.capabilities).filter((k) => !hosted.$defs[k]), [], "requires keys are $defs keys");
    const { title, ...member } = hosted.$defs.reap_object;
    assert.deepEqual(member, JSON.parse(JSON.stringify(adapter.ucpInputSchemasFor(LANE_ON).create_checkout_session.properties.checkout.properties.reap)), "the door advertises exactly the hosted member");
  });
});
