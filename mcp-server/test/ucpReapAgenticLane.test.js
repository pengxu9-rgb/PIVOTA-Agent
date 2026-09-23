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
