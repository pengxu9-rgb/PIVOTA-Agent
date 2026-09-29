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
  reapLineItemTitle,
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

describe("the line item title: plain unless a half carries RTL text, then that half alone is bidi-isolated", () => {
  // Escapes only -- no literal invisible characters in this file (the last test below checks the lane's source).
  const FSI = "\u2068";
  const PDI = "\u2069";
  const RLM = "\u200F";
  const LRM = "\u200E";
  const ALM = "\u061C";
  const ZWSP = "\u200B";
  const HEBREW = "\u05E9\u05E4\u05EA\u05D5\u05DF"; // Bidi_Class R
  const ARABIC = "\u0623\u062D\u0645\u0631"; // Bidi_Class AL
  const SYRIAC = "\u0710\u0712"; // AL
  const THAANA = "\u0780\u0781"; // AL
  const NKO = "\u07CA\u07CB"; // R
  const ADLAM = "\u{1E900}\u{1E901}"; // R, supplementary plane
  const count = (s, ch) => s.split(ch).length - 1;
  const iso = (text) => `${FSI}${text}${PDI}`;
  // main's composition at 8c9205fda, verbatim: an all-LTR title must be byte-identical to it.
  const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const mainTitle = (n, v) => {
    const productName = str(n);
    const variantTitle = str(v);
    return productName ? (variantTitle && variantTitle !== productName ? `${productName} — ${variantTitle}` : productName) : null;
  };

  test("an all-LTR title is BYTE-IDENTICAL to main's, lone name included: no isolate, no other change", () => {
    const cases = [
      ["Silky Matte Lip Ink", "07 BURGUNDY INK"],
      ["Silky Matte Lip Ink", undefined],
      ["Silky Matte Lip Ink", null],
      ["  Standard Eau de Parfum ", " Standard "],
      ["Standard Eau de Parfum", "Standard Eau de Parfum"],
      ["Crème Brûlée Lip Balm — Nº 5", "Rosé 01"],
      ["\u96EA\u82B1\u79C0 Serum", "50ml"], // CJK is left-to-right
      ["Glow Oil ✨ 100% Pure", "1.01 oz / 30 mL"],
      ["Tint", "#07 / Berry, 3.5g (Refill)"],
    ];
    for (const [n, v] of cases) {
      const got = reapLineItemTitle(n, v);
      assert.equal(got, mainTitle(n, v), JSON.stringify([n, v]));
      assert.equal(/[\u2066-\u2069]/.test(got), false, JSON.stringify(got));
    }
  });

  test("a name ENDING in an RTL letter (R or AL): that half is isolated, the Latin variant stays plain", () => {
    for (const rtl of [HEBREW, ARABIC, SYRIAC, THAANA, NKO, ADLAM]) {
      const name = `Lip Ink ${rtl}`;
      const title = reapLineItemTitle(name, "07 BURGUNDY INK");
      assert.equal(title, `${iso(name)} — 07 BURGUNDY INK`, JSON.stringify(rtl));
      assert.equal(count(title, FSI), 1);
      assert.equal(count(title, PDI), 1);
    }
  });

  test("a name ENDING in RLM or ALM: the mark is kept inside the name's isolate; the variant stays plain", () => {
    for (const mark of [RLM, ALM]) {
      const name = `Silky Matte Lip Ink${mark}`;
      const title = reapLineItemTitle(name, "07 BURGUNDY INK");
      assert.equal(title, `${iso(name)} — 07 BURGUNDY INK`);
      assert.equal(title.indexOf(mark) + 1, title.indexOf(PDI), "the mark is the last character before the PDI");
    }
    // LRM alone is not RTL-bearing: plain, exactly as main.
    assert.equal(reapLineItemTitle(`Lip Ink${LRM}`, "07"), `Lip Ink${LRM} — 07`);
  });

  test("an RTL variant under a Latin name, and RTL on both sides: each RTL half exactly one pair", () => {
    assert.equal(reapLineItemTitle("Lip Ink", `${HEBREW} 07`), `Lip Ink — ${iso(`${HEBREW} 07`)}`);
    const both = reapLineItemTitle(`${ARABIC} ${RLM}`, `07 ${HEBREW}`);
    assert.equal(both, `${iso(`${ARABIC} ${RLM}`)} — ${iso(`07 ${HEBREW}`)}`);
    assert.equal(count(both, FSI), 2);
    assert.equal(count(both, PDI), 2);
    const [a, b] = both.split(" — ");
    for (const half of [a, b]) {
      assert.equal(count(half, FSI), 1);
      assert.equal(count(half, PDI), 1);
      assert.ok(half.startsWith(FSI) && half.endsWith(PDI));
    }
    assert.equal(reapLineItemTitle(`Lip Ink ${HEBREW}`, null), iso(`Lip Ink ${HEBREW}`), "a lone RTL name");
  });

  test("a half made only of invisible characters is ABSENT: no name -> null (item id shown); no variant -> omitted", () => {
    const invisible = [RLM, LRM, ALM, ZWSP, `${RLM}${ZWSP} ${LRM}`, "\uFEFF", "   ", ""];
    for (const v of invisible) {
      assert.equal(reapLineItemTitle(v, "07 BURGUNDY INK"), null, `name ${JSON.stringify(v)}`);
      assert.equal(reapLineItemTitle("Silky Matte Lip Ink", v), "Silky Matte Lip Ink", `variant ${JSON.stringify(v)}`);
    }
    for (const v of [undefined, null, 7, { t: "x" }]) {
      assert.equal(reapLineItemTitle(v, "07"), null);
      assert.equal(reapLineItemTitle("Silky Matte Lip Ink", v), "Silky Matte Lip Ink");
    }
    const id = encodeReapCheckoutId(SNAP);
    const view = { id: PID, state: "processing", product_key: SNAP.productKey, product_name: RLM, variant_title: "07", quantity: 1, totals: { currency: "USD", our_price_minor: 4250 } };
    assert.equal(mapReapPurchaseToCheckout({ id, snapshot: SNAP, view, now: NOW, env: {} }).line_items[0].item.title, "sig_reap_a", "the item id, not an invisible title");
  });

  test("the variant is de-duplicated against the name on the VISIBLE text (a trailing RLM does not defeat it)", () => {
    const name = `Lip Ink ${HEBREW}`;
    assert.equal(reapLineItemTitle(name, `${name}${RLM}`), iso(name));
    assert.equal(reapLineItemTitle(`${name}${RLM}`, name), iso(`${name}${RLM}`));
    assert.equal(reapLineItemTitle("Lip Ink", `Lip${ZWSP} Ink${LRM}`), "Lip Ink");
    assert.equal(reapLineItemTitle("Lip Ink", "Lip  Ink"), "Lip Ink", "whitespace runs collapse on the key");
    assert.equal(reapLineItemTitle("Lip Ink", "Lip Ink 2"), "Lip Ink — Lip Ink 2");
  });

  test("line and paragraph breaks inside an ISOLATED half are folded to spaces (they would close the isolate)", () => {
    for (const br of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\u0085", "\u001C"]) {
      const title = reapLineItemTitle(`Lip${br}Ink ${HEBREW}`, `07${br}${ARABIC}`);
      const spaces = " ".repeat(br.length);
      assert.equal(title, `${iso(`Lip${spaces}Ink ${HEBREW}`)} — ${iso(`07${spaces}${ARABIC}`)}`, JSON.stringify(br));
    }
    // A Latin half is not isolated, so it is not rewritten: byte-identical to main.
    assert.equal(reapLineItemTitle("Lip\nInk", "07"), mainTitle("Lip\nInk", "07"));
  });

  test("stray embedding/override/isolate controls are removed from every half, so each pair stays balanced", () => {
    const stray = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069";
    const title = reapLineItemTitle(`${stray}  Lip Ink ${HEBREW}${PDI}${stray} `, ` ${FSI}07${PDI}\u202E BURGUNDY `);
    assert.equal(title, `${iso(`Lip Ink ${HEBREW}`)} — 07 BURGUNDY`);
    assert.equal(reapLineItemTitle(stray, "07"), null);
    assert.equal(reapLineItemTitle("Lip Ink", stray), "Lip Ink");
  });

  test("through the view mapping: the line item carries the title; the checkout id does not carry it", () => {
    const id = encodeReapCheckoutId(SNAP);
    const view = {
      id: PID, state: "processing", product_key: SNAP.productKey, product_name: `Lip Ink ${HEBREW}`, variant_title: "07 BURGUNDY INK", quantity: 1,
      totals: { currency: "USD", our_price_minor: 4250 },
    };
    const out = mapReapPurchaseToCheckout({ id, snapshot: SNAP, view, now: NOW, env: {} });
    assert.equal(out.line_items[0].item.title, `${iso(`Lip Ink ${HEBREW}`)} — 07 BURGUNDY INK`);
    assert.equal(out.id, id);
    const snapshotJson = Buffer.from(id.split(".")[1], "base64url").toString("utf8");
    assert.equal(/Lip|BURGUNDY|[\u0590-\u05FF\u2068\u2069]/.test(snapshotJson), false, snapshotJson);
    assert.deepEqual(decodeReapCheckoutId(id), { ...SNAP });
  });

  test("the lane source writes its isolates and ranges as escapes: no literal format (Cf) character in the file", () => {
    const src = fs.readFileSync(path.join(HERE, "../src/ucpReapAgenticLane.js"), "utf8");
    assert.equal(/\p{Cf}/u.test(src), false);
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
    assert.equal(lane.reapMerchantIdOfProductKey("prod::merch_obs_judydoll::external_seed::ext_1"), "merch_obs_judydoll", "a per-brand observed seller IS a seller");
    assert.equal(lane.reapMerchantIdOfProductKey("prod::external_seed::external_seed::ext_0f95730ee5ba05a6b7957ada"), null, "the shared sentinel is not");
    assert.equal(lane.reapMerchantIdOfProductKey("ext:jungsaemmool-skin-nuder-cushion::9f2c1e7ab04d"), null, "not the prod:: form");
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

  // The LIVE judydoll demo row (sig_6433c8107859a484fb72d14861e84690), read 2026-09-29 via search_catalog: its
  // external_redirect_url is a Pivota /r hop carrying the backend's own TWO-segment token
  // (`<b64url(payload JSON)>.<b64url(HMAC-SHA256)>`, pivota-backend make_redirect_token), payload first.
  const LIVE_JUDY_TOKEN = "eyJ2IjowLCJ0IjoicmVkaXJlY3QiLCJtYXJrZXQiOiJVUyIsInRvb2wiOiJjcmVhdG9yX2FnZW50cyIsIm1hcmtldF9vYnNlcnZlZCI6dHJ1ZSwiZGVzdCI6Imh0dHBzOi8vanVkeWRvbGwuY29tL3Byb2R1Y3RzL3NpbGt5LW1hdHRlLWxpcC1pbms_dmFyaWFudD00OTgxOTI2NzMwMTY1MyZ1dG1fc291cmNlPXBpdm90YSZ1dG1fbWVkaXVtPWFmZmlsaWF0ZSZ1dG1fY2FtcGFpZ249VVMmcHZ0X2NsaWNrX2lkPWNsa18zNjQ1YmYyZjdkMDk0OWZmYTMxYTRlZjEmdXRtX2NvbnRlbnQ9Y2xrXzM2NDViZjJmN2QwOTQ5ZmZhMzFhNGVmMSIsImN0eCI6eyJzZWVkSWQiOiJlcHN2XzM4YWQ4OGQ0MzZjMzJlMjRiYTdjNjQ0NiIsInNvdXJjZSI6ImV4dGVybmFsX3NlZWRfbGlua3MiLCJwdnRfY2xpY2tfaWQiOiJjbGtfMzY0NWJmMmY3ZDA5NDlmZmEzMWE0ZWYxIiwicHZ0X3N1cmZhY2UiOiJjcmVhdG9yX2FnZW50cyIsInRvb2wiOiJjcmVhdG9yX2FnZW50cyIsImpvaW5fbW9kZSI6InJlZmVycmFsX29ubHkifSwiaWF0IjoxNzkwNjUzMTYyLCJleHAiOjE3OTEyNTc5NjJ9.z2eUZz-tCUGToldwJc-Y_i4XNkDV39QTgKj27vCzVyE";
  const [LIVE_PAYLOAD_B64, LIVE_SIG] = LIVE_JUDY_TOKEN.split(".");
  const JUDY_PAYLOAD = JSON.parse(Buffer.from(LIVE_PAYLOAD_B64, "base64url").toString("utf8"));
  // The backend's format for any payload (the signature is not checked here, so the live one is reused).
  const hopToken = (payload) => `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${LIVE_SIG}`;
  const judyHop = (payload = null, host = "api.pivota.cc") => `https://${host}/r?token=${payload === null ? LIVE_JUDY_TOKEN : hopToken(payload)}`;

  test("the live token IS the backend's two-segment shape and its payload is what the backend documents", () => {
    assert.equal(LIVE_JUDY_TOKEN.split(".").length, 2);
    assert.deepEqual(Object.keys(JUDY_PAYLOAD).sort(), ["ctx", "dest", "exp", "iat", "market", "market_observed", "t", "tool", "v"]);
    assert.equal(JUDY_PAYLOAD.t, "redirect");
    assert.match(JUDY_PAYLOAD.dest, /^https:\/\/judydoll\.com\/products\/silky-matte-lip-ink\?variant=49819267301653&/);
  });

  test("a Pivota /r?token= hop is judged by its token's `dest` (the live demo row passes for its own seller only)", () => {
    const j = lane.judgeSellerUrl;
    for (const expected of ["judydoll.com", "www.judydoll.com", "JUDYDOLL.COM"]) assert.deepEqual(j(expected, judyHop()), { ok: true }, expected);
    assert.deepEqual(j("judydoll.com", judyHop(null, "agent.pivota.cc")), { ok: true }, "agent.pivota.cc hop too");
    assert.deepEqual(j("other-seller.example", judyHop()), { ok: false, cause: "different_seller", host: "judydoll.com" });
    assert.deepEqual(j("judydoll.co", judyHop()), { ok: false, cause: "different_seller", host: "judydoll.com" });
    // A re-encoding of the live payload with `dest` on ANOTHER host is that host's link.
    assert.deepEqual(j("judydoll.com", judyHop({ ...JUDY_PAYLOAD, dest: "https://other-seller.example/products/x?variant=1" })), { ok: false, cause: "different_seller", host: "other-seller.example" });
    // Unreadable hops: fail closed.
    const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
    const unconfirmed = [
      ["three segments (a JWT is not what the backend mints)", `https://api.pivota.cc/r?token=eyJhbGciOiJIUzI1NiJ9.${LIVE_PAYLOAD_B64}.${LIVE_SIG}`],
      ["three segments whose first IS a readable payload", `https://api.pivota.cc/r?token=${LIVE_PAYLOAD_B64}.${LIVE_SIG}.${LIVE_SIG}`],
      ["one segment", `https://api.pivota.cc/r?token=${LIVE_PAYLOAD_B64}`],
      ["empty signature", `https://api.pivota.cc/r?token=${LIVE_PAYLOAD_B64}.`],
      ["empty payload", `https://api.pivota.cc/r?token=.${LIVE_SIG}`],
      ["payload not base64url", `https://api.pivota.cc/r?token=!!!.${LIVE_SIG}`],
      ["payload not JSON", `https://api.pivota.cc/r?token=${b64("not json")}.${LIVE_SIG}`],
      ["signature segment first", `https://api.pivota.cc/r?token=${LIVE_SIG}.${LIVE_PAYLOAD_B64}`],
      ["payload not an object", judyHop(["https://judydoll.com/p"])],
      ["no dest", judyHop({ ...JUDY_PAYLOAD, dest: undefined })],
      ["dest http", judyHop({ ...JUDY_PAYLOAD, dest: "http://judydoll.com/p" })],
      ["dest with userinfo", judyHop({ ...JUDY_PAYLOAD, dest: "https://u:p@judydoll.com/p" })],
      ["dest itself a hop", judyHop({ ...JUDY_PAYLOAD, dest: judyHop() })],
      ["dest carries another URL", judyHop({ ...JUDY_PAYLOAD, dest: "https://judydoll.com/go?url=https://other-seller.example/p" })],
      ["dest unparseable", judyHop({ ...JUDY_PAYLOAD, dest: "not a url" })],
      ["two token params", `${judyHop()}&token=${LIVE_JUDY_TOKEN}`],
      ["not exactly /r", `https://api.pivota.cc/r/?token=${LIVE_JUDY_TOKEN}`],
      ["another Pivota host", `https://pivota.cc/r?token=${LIVE_JUDY_TOKEN}`],
      ["the hop over http", `http://api.pivota.cc/r?token=${LIVE_JUDY_TOKEN}`],
    ];
    for (const [label, url] of unconfirmed) assert.deepEqual(j("judydoll.com", url), { ok: false, cause: "seller_unconfirmed" }, label);
  });

  test("hop detection ignores `ref` and `utm_*` values, and a malformed path encoding fails CLOSED", () => {
    const j = lane.judgeSellerUrl;
    assert.deepEqual(j("brand.example", "https://www.brand.example/p?ref=https://pivota.cc/x&utm_source=https%3A%2F%2Fa.example&UTM_Campaign=//b"), { ok: true });
    assert.equal(j("brand.example", "https://www.brand.example/p?refx=https://other.example").cause, "seller_unconfirmed", "only `ref` itself");
    assert.equal(j("brand.example", "https://www.brand.example/r/https%3A%2F%2Fother.com%ZZ").cause, "seller_unconfirmed", "decodeURIComponent throws: unconfirmed");
  });

  test("native rows: a Pivota hop is judged by its dest; the registered store still counts", () => {
    const native = { product_id: "p", merchant_id: "m" };
    assert.deepEqual(lane.judgeRowSeller("judydoll.com", { ...native, external_redirect_url: judyHop(), purchase_route: "internal_checkout" }, null), { ok: true });
    assert.deepEqual(lane.judgeRowSeller("judydoll.com", { ...native, external_redirect_url: judyHop(), online_store_url: "https://judydoll.com/products/x" }, null), { ok: true });
    assert.equal(lane.judgeRowSeller("judydoll.com", { ...native, external_redirect_url: judyHop(), online_store_url: "https://other.example/x" }, null).cause, "different_seller");
    assert.equal(lane.judgeRowSeller("judydoll.com", { ...native, external_redirect_url: "https://api.pivota.cc/r?token=junk" }, null).cause, "seller_unconfirmed");
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

describe("soleReadVariantId: the cart-link pre-filter's read of the row's own sole variant", async () => {
  const lane = await import("../src/ucpReapAgenticLane.js");
  const LIVE = { default_variant_id: "41596313010251", variants: [{ variant_id: "41596313010251", sku_id: "K108-01-0000-EU", title: "1.01 oz" }] };
  test("accepts the live KraveBeauty shape and each agreeing / sole form", () => {
    assert.equal(lane.soleReadVariantId(LIVE), "41596313010251");
    assert.equal(lane.soleReadVariantId({ variants: LIVE.variants }), "41596313010251");
    assert.equal(lane.soleReadVariantId({ default_variant_id: "41596313010251" }), "41596313010251");
    assert.equal(lane.soleReadVariantId({ default_variant_id: "41596313010251", variants: [] }), "41596313010251");
    assert.equal(lane.soleReadVariantId({ variants: [{ variant_id: "gid://shopify/ProductVariant/41596313010251" }] }), "41596313010251");
    assert.equal(lane.soleReadVariantId({ ...LIVE, default_variant_id: "gid://shopify/ProductVariant/41596313010251" }), "41596313010251");
    assert.equal(lane.soleReadVariantId({ variants: [{ variant_id: 41596313010251 }] }), "41596313010251");
  });
  test("refuses: two variants, non-Shopify ids, a default beside two or more variants, disagreement, nothing", () => {
    for (const [label, row] of [
      ["two variants, different ids", { variants: [{ variant_id: "1" }, { variant_id: "2" }] }],
      ["two variants, same id", { variants: [{ variant_id: "1" }, { variant_id: "1" }] }],
      ["default beside two variants", { default_variant_id: "1", variants: [{ variant_id: "1" }, { variant_id: "2" }] }],
      ["non-numeric variant id", { variants: [{ variant_id: "K108-01-0000-EU" }] }],
      ["non-numeric default", { default_variant_id: "ext_8026e90301d17f1f7745b5c7:single" }],
      ["disagreeing ids", { ...LIVE, default_variant_id: "41596313010999" }],
      ["Shopify variant id beside a non-Shopify default", { ...LIVE, default_variant_id: "ext_x:single" }],
      ["zero / negative", { variants: [{ variant_id: 0 }] }],
      ["nothing", {}],
      ["variants not an array, no default", { variants: { variant_id: "1" } }],
    ]) assert.equal(lane.soleReadVariantId(row), null, label);
  });
});

// ---- option 2 PR D: ENRICHMENT rows on the cart-link lane (behind REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED) ------

describe("enrichment cart-link rows: key shape, source system, merchant host", async () => {
  const lane = await import("../src/ucpReapAgenticLane.js");
  const { createHash } = await import("node:crypto");
  // THE PRODUCER, transcribed: pivota-backend services/catalog_enrichment_agent/ingestion.py `_normalize_token`
  // (`[^a-z0-9]+` -> " " over str.lower(), stripped), `canonical_product_name` (spaces -> "-", "" -> "unknown"),
  // `derive_product_key` ("ext:" + canonical[:200] + "::" + sha1(canonical)[:8]), and the retailer branch of
  // `_build_pdp_insert` ("ext:retailer:" + sha256(listing)[:32]). The accepted keys below are what it emits.
  const canonical = (brand, name) => (`${brand || ""} ${name || ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/ /g, "-")) || "unknown";
  const deriveProductKey = (brand, name) => {
    const c = canonical(brand, name);
    return `ext:${c.slice(0, 200)}::${createHash("sha1").update(c, "utf8").digest("hex").slice(0, 8)}`;
  };
  const retailerKey = (listing) => `ext:retailer:${createHash("sha256").update(listing, "utf8").digest("hex").slice(0, 32)}`;
  const LONG_NAME = `Kiss Professional Full Cover Press On Fake Toenails - Tippy Toes | 130 Toenails, Includes Nail Glue, ${"Solid White Short Squoval Pedicure ".repeat(6)}`;
  const PRODUCED = [
    deriveProductKey("JUNGSAEMMOOL", "Essential Mool Toner"),
    deriveProductKey("tarte", "shape tape™ concealer"),
    deriveProductKey("Kérastase", "Élixir Ultime L'Huile Originale"),
    deriveProductKey("Kiss", LONG_NAME),
    retailerKey("bluemercury.com/products/tatcha-the-dewy-skin-cream"),
    retailerKey("global.oliveyoung.com/product/detail?prdtNo=GA123"),
  ];
  // Keys read LIVE on 2026-09-29 (get_product): tarte, stila, MAC, bluemercury.
  const LIVE_KEYS = [
    "ext:tarte-shape-tape-blur-concealer-stick::874dcfea",
    "ext:stila-stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown-last-chance-shade::73fc0547",
    "ext:mac-cosmetics-retro-matte-lipstick::a234aae1",
    "ext:retailer:1af5dd8fd7ce370b37e13eedcdd32fc7",
  ];

  test("the producer's own keys and the live keys are accepted (source system absent, or the agent's)", () => {
    assert.ok(PRODUCED[3].length > 200, "a long name really reaches the 200-char cut");
    for (const key of [...LIVE_KEYS, ...PRODUCED, `ext:${"a".repeat(199)}-::0123abcd`, "ext:unknown-brand-serum::0123abcd"]) {
      for (const source_system of [undefined, null, "", "catalog_enrichment_agent_v1", " catalog_enrichment_agent_v1 "]) {
        assert.equal(lane.isEnrichmentCartLinkRow(source_system === undefined ? {} : { source_system }, key), true, `${key.slice(0, 60)} / ${source_system}`);
      }
    }
  });

  test("REFUSES the LEGACY collapsed `ext:unknown::<8 hex>` key: every name with no ASCII letter or digit shared it", () => {
    // `deriveProductKey` above is the pre-#2461 generator (still exact for every name its slug stands for).
    const collapsed = [deriveProductKey("", ""), deriveProductKey("설화수", "자음생크림"), deriveProductKey("雪肌精", "化粧水"), deriveProductKey("—", "™")];
    assert.equal(new Set(collapsed).size, 1, "the legacy generator really collapses them to one key");
    assert.equal(collapsed[0], `ext:unknown::${createHash("sha1").update("unknown").digest("hex").slice(0, 8)}`);
    assert.equal(collapsed[0], "ext:unknown::50d8b4a9", "the key #2461's tests name");
    for (const key of [collapsed[0], "ext:unknown::0123abcd", "ext:unknown::00000000", "ext:unknown::ffffffff"]) {
      for (const source_system of [undefined, "catalog_enrichment_agent_v1"]) {
        assert.equal(lane.isEnrichmentCartLinkRow(source_system === undefined ? {} : { source_system }, key), false, `${key} / ${source_system}`);
      }
    }
  });

  // pivota-backend #2461 `_script_identity`: a name whose ASCII slug cannot stand for it (a non-Latin letter, a
  // Vietnamese letter, a non-ASCII digit or numeral) is keyed `ext:` + prefix[:192] + `::` + sha1(identity)[:16], the
  // prefix being the `[^a-z0-9]+` slug of the identity text or "unknown". These are that PR's derive_product_key
  // OUTPUTS (head 3d33719c, run on the real function), not a transcription of it.
  const SCRIPT_IDENTITY_KEYS = [
    ["설화수 / 자음생크림", "ext:unknown::d3bac5e705f83353"],
    ["雪肌精 / 化粧水", "ext:unknown::af6477008cb7405c"],
    ["설×300 / 크림 (the slug is still empty)", "ext:unknown::7c34f59310294da6"],
    ["Sulwhasoo / 자음생크림", "ext:sulwhasoo::86a6cd5aec54a25a"],
    ["Sulwhasoo / 윤조에센스", "ext:sulwhasoo::8191647c363b22a0"],
    ["Cos de BAHA / 【美容神ゆりちゃん監修】MVマルチビタ導入美容液 50ml (the live key #2461 moves)", "ext:cos-de-baha-mv-50ml::63c46c9fb300432e"],
    ["a×300 / 크림 (prefix cut at 192, 214 chars)", `ext:${"a".repeat(192)}::4320095d0dd5b799`],
  ];

  test("ACCEPTS #2461's distinct 16-hex keys, `ext:unknown::` included: one product each", () => {
    // The pure-Hangul / pure-Han digest is sha1 over the words joined by "-" (NFKC + casefold change nothing there).
    const sha16 = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);
    assert.equal(SCRIPT_IDENTITY_KEYS[0][1], `ext:unknown::${sha16("설화수-자음생크림")}`);
    assert.equal(SCRIPT_IDENTITY_KEYS[1][1], `ext:unknown::${sha16("雪肌精-化粧水")}`);
    assert.equal(SCRIPT_IDENTITY_KEYS[3][1], `ext:sulwhasoo::${sha16("sulwhasoo-자음생크림")}`);
    assert.equal(SCRIPT_IDENTITY_KEYS[6][1].length, 214, "the widest key #2461 mints");
    assert.equal(new Set(SCRIPT_IDENTITY_KEYS.map(([, k]) => k)).size, SCRIPT_IDENTITY_KEYS.length);
    for (const [label, key] of [...SCRIPT_IDENTITY_KEYS, ["a 191-char slug ending on the cut", `ext:${"a".repeat(191)}-::0123456789abcdef`]]) {
      for (const source_system of [undefined, null, "", "catalog_enrichment_agent_v1"]) {
        assert.equal(lane.isEnrichmentCartLinkRow(source_system === undefined ? {} : { source_system }, key), true, `${label} / ${source_system}`);
      }
    }
  });

  test("REFUSES everything near #2461's 16-hex shape: 9..15 and 17+ hex, uppercase, a slug over 192", () => {
    const hex = "d3bac5e705f83353a1b2";
    for (const slug of ["unknown", "sulwhasoo", "cos-de-baha-mv-50ml"]) {
      for (let n = 1; n <= 20; n++) {
        if (n === 8 && slug === "unknown") {
          assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${slug}::${hex.slice(0, n)}`), false, `${slug} 8 hex is the legacy collapsed key`);
          continue;
        }
        const expected = n === 8 || n === 16;
        assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${slug}::${hex.slice(0, n)}`), expected, `${slug} ${n} hex`);
      }
      assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${slug}::${hex.slice(0, 16).toUpperCase()}`), false, `${slug} uppercase 16 hex`);
      assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${slug}::D${hex.slice(1, 16)}`), false, `${slug} one uppercase hex digit`);
      assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${slug}::${hex.slice(0, 15)}g`), false, `${slug} non-hex`);
    }
    assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${"a".repeat(193)}::${hex.slice(0, 16)}`), false, "slug over 192 with 16 hex");
    assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${"a".repeat(192)}::${hex.slice(0, 16)}`), true, "control: 192 with 16 hex");
    assert.equal(lane.isEnrichmentCartLinkRow({}, `ext:${"a".repeat(200)}::${hex.slice(0, 8)}`), true, "control: 200 with 8 hex");
    assert.equal(lane.isEnrichmentCartLinkRow({}, "ext:unknown::d3bac5e705f83353\n"), false, "trailing newline");
    assert.equal(lane.isEnrichmentCartLinkRow({}, "ext:unknown::d3bac5e705f83353::0123abcd"), false, "a second hash");
    assert.equal(lane.isEnrichmentCartLinkRow({}, "ext:Unknown::d3bac5e705f83353"), false, "uppercase slug");
    assert.equal(lane.isEnrichmentCartLinkRow({}, "ext:-unknown::d3bac5e705f83353"), false, "leading hyphen (the slug is stripped)");
    assert.equal(lane.isEnrichmentCartLinkRow({}, "ext:-::d3bac5e705f83353"), false, "a hyphen-only slug");
    assert.equal(lane.isEnrichmentCartLinkRow({}, "ext:::d3bac5e705f83353"), false, "empty slug (#2461 answers \"unknown\")");
    assert.equal(lane.isEnrichmentCartLinkRow({ source_system: "external_product_seeds_mirror_v1" }, SCRIPT_IDENTITY_KEYS[0][1]), false, "another source system");
  });

  test("REFUSES every other `ext:` shape (and the mirror key, which has its own path)", () => {
    const hex32 = "0123456789abcdef0123456789abcdef";
    for (const [label, key] of [
      ["no hash", "ext:foo"],
      ["empty hash", "ext:foo::"],
      ["empty slug", "ext:::0123abcd"],
      ["uppercase slug", "ext:Foo::0123abcd"],
      ["uppercase hex", "ext:foo::0123ABCD"],
      ["7 hex", "ext:foo::0123abc"],
      ["9 hex", "ext:foo::0123abcde"],
      ["non-hex", "ext:foo::0123abcg"],
      ["leading hyphen", "ext:-foo::0123abcd"],
      ["space in slug", "ext:foo bar::0123abcd"],
      ["underscore in slug", "ext:foo_bar::0123abcd"],
      ["colon in slug", "ext:foo:bar::0123abcd"],
      ["slug over 200", `ext:${"a".repeat(201)}::0123abcd`],
      ["trailing newline", "ext:foo::0123abcd\n"],
      ["leading space", " ext:foo::0123abcd"],
      ["prefix case", "EXT:foo::0123abcd"],
      ["ext_ not ext:", "ext_foo::0123abcd"],
      ["retailer, 31 hex", `ext:retailer:${hex32.slice(0, 31)}`],
      ["retailer, 33 hex", `ext:retailer:${hex32}0`],
      ["retailer, uppercase hex", `ext:retailer:${hex32.toUpperCase()}`],
      ["retailer, non-hex", `ext:retailer:${hex32.slice(0, 31)}g`],
      ["retailer, double colon", `ext:retailer::${hex32}`],
      ["retailer, with a hash suffix", `ext:retailer:${hex32}::0123abcd`],
      ["mirror key", "prod::external_seed::external_seed::ext_0f95730ee5ba05a6b7957ada"],
      ["shopify key", "prod::m_brand::shopify::1001"],
      ["null", null],
      ["number", 42],
    ]) {
      assert.equal(lane.isEnrichmentCartLinkRow({}, key), false, label);
    }
  });

  test("REFUSES a well-shaped key whose read names ANOTHER source system", () => {
    for (const source_system of ["external_product_seeds_mirror_v1", "catalog_enrichment_agent_v2", "CATALOG_ENRICHMENT_AGENT_V1", "affiliate_feed_v1"]) {
      assert.equal(lane.isEnrichmentCartLinkRow({ source_system }, LIVE_KEYS[0]), false, source_system);
      assert.equal(lane.isEnrichmentCartLinkRow({ source_system }, LIVE_KEYS[3]), false, `${source_system} (retailer)`);
    }
  });

  test("storefrontPageHost: exactly https://<host>/products/<handle> (pivota-backend storefront_page + the door's seller rules)", () => {
    const h = lane.storefrontPageHost;
    assert.equal(h("https://tartecosmetics.com/products/shape-tape-blur-concealer-stick"), "tartecosmetics.com", "live tarte");
    assert.equal(h("https://bluemercury.com/products/nars-afterglow-liquid-blush"), "bluemercury.com", "live bluemercury");
    assert.equal(h("https://WWW.StilaCosmetics.com/products/x"), "www.stilacosmetics.com", "lowercased, www. kept");
    assert.equal(h("https://shop.brand.example/products/Shade_01%C3%A9"), "shop.brand.example", "an encoded handle as written");
    assert.equal(h("HTTPS://Tartecosmetics.com/products/x"), "tartecosmetics.com", "scheme case does not matter");
    for (const [label, url] of [
      ["http", "http://tartecosmetics.com/products/x"],
      ["userinfo", "https://tartecosmetics.com@evil.example/products/x"],
      ["userinfo with password", "https://u:p@tartecosmetics.com/products/x"],
      ["empty userinfo", "https://@tartecosmetics.com/products/x"],
      ["a tab in the path (the parser drops it)", "https://tartecosmetics.com/products/x\ty"],
      ["uppercase scheme is still https, but a raw path must match", "HTTPS://tartecosmetics.com/products/x/../y"],
      ["explicit port", "https://tartecosmetics.com:8443/products/x"],
      ["explicit default port", "https://tartecosmetics.com:443/products/x"],
      ["a query (utm)", "https://tartecosmetics.com/products/x?utm_source=pivota"],
      ["a redirector query", "https://tartecosmetics.com/products/x?url=https://other.example/p"],
      ["an empty query", "https://tartecosmetics.com/products/x?"],
      ["a fragment", "https://tartecosmetics.com/products/x#reviews"],
      ["a Pivota /r hop", "https://api.pivota.cc/r?token=a.b"],
      ["a Pivota PDP", "https://agent.pivota.cc/products/sig_1d54c9e3b5d3969ea4327b5de4f5d101"],
      ["a path hop", "https://tartecosmetics.com/r/https://other.example/p"],
      ["collection path", "https://tartecosmetics.com/collections/face/products/x"],
      ["a bare /<handle> page (no /products/)", "https://tartecosmetics.com/shape-tape-blur-concealer-stick"],
      ["/product/ singular", "https://tartecosmetics.com/product/x"],
      ["trailing slash", "https://tartecosmetics.com/products/x/"],
      ["no handle", "https://tartecosmetics.com/products/"],
      [".js handle", "https://tartecosmetics.com/products/x.js"],
      [".json handle", "https://tartecosmetics.com/products/x.json"],
      ["dot segment", "https://tartecosmetics.com/a/../products/x"],
      ["backslash", "https://tartecosmetics.com/products\\x"],
      ["whitespace", "https://tartecosmetics.com/products/x y"],
      ["trailing newline", "https://tartecosmetics.com/products/x\n"],
      ["a raw non-ASCII handle (re-encoded by the parser)", "https://tartecosmetics.com/products/crème"],
      ["single-label host", "https://localhost/products/x"],
      ["not a url", "not a url"],
      ["empty", ""],
      ["null", null],
    ]) {
      assert.equal(h(url), null, label);
    }
  });

  // The LIVE stila read (get_product sig_07176ee6bdd7c39f60dd4f9fc121df0d, 2026-09-29), merchant fields only.
  const STILA = {
    external_redirect_url: "https://stilacosmetics.com/products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown",
    url: "https://agent.pivota.cc/products/sig_07176ee6bdd7c39f60dd4f9fc121df0d",
    canonical_url: "https://agent.pivota.cc/products/sig_07176ee6bdd7c39f60dd4f9fc121df0d",
    destination_url: "https://stilacosmetics.com/products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown",
    source_url: "https://www.stilacosmetics.com/products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown",
  };
  const d = (row) => lane.enrichmentCartLinkMerchantDomain(row);

  test("merchant host: the storefront target's host; the live read's www. source_url AGREES (the door's fold); canonical_url is never read", () => {
    assert.deepEqual(d(STILA), { host: "stilacosmetics.com" });
    for (const [label, patch, host] of [
      ["no destination_url / source_url", { destination_url: undefined, source_url: undefined }, "stilacosmetics.com"],
      ["empty ones are absent", { destination_url: "", source_url: null, source_domain: "", merchant_domain: null }, "stilacosmetics.com"],
      ["a padded explicit field is read trimmed (as the door reads it)", { source_domain: "  stilacosmetics.com " }, "stilacosmetics.com"],
      ["www. target, bare others", { external_redirect_url: "https://www.stilacosmetics.com/products/x" }, "www.stilacosmetics.com"],
      ["agreeing source_domain / merchant_domain, any case, www. or not", { source_domain: "WWW.StilaCosmetics.com", merchant_domain: "stilacosmetics.com" }, "stilacosmetics.com"],
      ["canonical_url on ANOTHER host is not read", { canonical_url: "https://other-seller.example/products/x", url: "https://other-seller.example/p" }, "stilacosmetics.com"],
    ]) {
      const row = { ...STILA, ...patch };
      assert.deepEqual(d(row), { host }, label);
    }
  });

  test("merchant host: any merchant field naming ANOTHER seller, or unreadable, is merchant_domain_conflict", () => {
    for (const [label, patch] of [
      ["affiliate destination_url", { destination_url: "https://click.linksynergy.com/deeplink?murl=https%3A%2F%2Fstilacosmetics.com%2Fp" }],
      ["a retailer's source_url", { source_url: "https://bluemercury.com/products/stila-liner" }],
      ["source_domain another seller", { source_domain: "bluemercury.com" }],
      ["merchant_domain another seller", { merchant_domain: "ulta.com" }],
      ["a sibling subdomain is not the same host", { source_url: "https://shop.stilacosmetics.com/products/x" }],
      ["a Pivota hop destination_url", { destination_url: "https://api.pivota.cc/r?token=a.b" }],
      ["unparseable destination_url", { destination_url: "not a url" }],
      ["non-string source_domain", { source_domain: 42 }],
      ["non-ASCII lookalike merchant_domain", { merchant_domain: "Kiko.com" }],
    ]) {
      assert.deepEqual(d({ ...STILA, ...patch }), { host: null, code: "merchant_domain_conflict" }, label);
    }
  });

  test("merchant host: no valid storefront page is no_merchant_domain -- destination_url / source_url never stand in for it", () => {
    for (const [label, row, target] of [
      ["no target", STILA, null],
      ["target a Pivota hop", STILA, "https://api.pivota.cc/r?token=a.b"],
      ["target with a query", STILA, `${STILA.external_redirect_url}?utm_source=pivota`],
      ["target not a /products/ page", STILA, "https://stilacosmetics.com/collections/eye"],
      ["a host the door's fold cannot read (www. + a TLD)", {}, "https://www.com/products/x"],
      ["target with :443 (the parsed form would drop it)", STILA, "https://stilacosmetics.com:443/products/x"],
      ["target with a dot segment (the parsed form would resolve it)", STILA, "https://stilacosmetics.com/a/../products/x"],
      ["target with surrounding whitespace (escalationTargetOf would trim it)", STILA, " https://stilacosmetics.com/products/x "],
    ]) {
      const r = { ...row };
      if (target === null) delete r.external_redirect_url; else r.external_redirect_url = target;
      assert.deepEqual(lane.enrichmentCartLinkMerchantDomain(r), { host: null, code: "no_merchant_domain" }, label);
    }
  });

  test("the dial: OFF by default; truthy spellings only", () => {
    assert.equal(lane.REAP_AGENTIC_CART_LINK_ENRICHMENT_FLAG, "REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED");
    assert.equal(lane.reapCartLinkEnrichmentEnabled({}), false);
    for (const v of ["0", "no", "off", "false", ""]) assert.equal(lane.reapCartLinkEnrichmentEnabled({ REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED: v }), false, v);
    for (const v of ["1", "true", "on", " YES "]) assert.equal(lane.reapCartLinkEnrichmentEnabled({ REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED: v }), true, v);
  });

  // The lane called DIRECTLY (no door in front), so its own ordering is what is observed.
  test("lane order: a row with no host to send is skipped no_merchant_domain / merchant_domain_conflict, never seller_mismatch", async () => {
    const ENV = { REAP_AGENTIC_LANE_ENABLED: "1", REAP_AGENTIC_CART_LINK_LANE_ENABLED: "1", REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED: "1" };
    const base = {
      product_id: "sig_07176ee6bdd7c39f60dd4f9fc121df0d", title: "Dual-Ended Waterproof Liquid Eye Liner", price: 20, currency: "USD",
      product_key: LIVE_KEYS[1], ...STILA, default_variant_id: "40318467145831", variants: [{ variant_id: "40318467145831", sku_id: "SC91020001", title: "Amber / Dark Brown" }],
    };
    const run = async (row, expected) => {
      const logs = [];
      let starts = 0;
      const out = await lane.tryReapAgenticCheckout({
        op: { id: "create_checkout_session" }, ctx: {}, env: ENV, now: NOW, hints: [],
        params: { idempotency_key: "idem-order-1", quote: { items: [{ product_id: row.product_id, quantity: 1 }] } },
        executor: { async execute() { return { product: { ...row } }; } },
        client: { hasCallerCredentials: () => true, startPurchase: async () => { starts += 1; return { kind: "accepted", purchase: { id: PID, state: "resolving", poll_after_seconds: 60 } }; }, getPurchase: async () => ({ kind: "unavailable" }) },
        log: { info: (x) => logs.push(x), warn: (x) => logs.push(x) },
        shouldOfferPurchase: async () => true,
        ucpArgs: { checkout: { context: { address_country: "US" }, ...(expected ? { reap: { expected_merchant_domain: expected } } : {}) } },
      });
      return { out, starts, codes: logs.filter((l) => l.outcome === "skipped").map((l) => l.code) };
    };
    const ok = await run(base, "stilacosmetics.com");
    assert.equal(ok.starts, 1, "control: the live row with its own seller is opened");
    for (const [label, patch, code] of [
      // Each of these ALSO fails the seller judgement (judgeRowSeller), which used to run first.
      ["target a Pivota hop with an unreadable token", { external_redirect_url: "https://api.pivota.cc/r?token=junk" }, "no_merchant_domain"],
      ["target a redirector", { external_redirect_url: `${STILA.external_redirect_url}?url=https://other-seller.example/p` }, "no_merchant_domain"],
      ["source_domain another seller", { source_domain: "bluemercury.com" }, "merchant_domain_conflict"],
      ["merchant_domain another seller", { merchant_domain: "ulta.com" }, "merchant_domain_conflict"],
      // These pass the seller judgement and are still refused by the host rules.
      ["target a /collections/ page", { external_redirect_url: "https://stilacosmetics.com/collections/eye" }, "no_merchant_domain"],
      // The door and escalationTargetOf see the PARSED form (no :443, no dot segment), which passes; the raw field does not.
      ["target with :443", { external_redirect_url: "https://stilacosmetics.com:443/products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown" }, "no_merchant_domain"],
      ["target with a dot segment", { external_redirect_url: "https://stilacosmetics.com/x/../products/stay-all-day-dual-ended-liquid-eye-liner-amber-dark-brown" }, "no_merchant_domain"],
      ["affiliate destination_url", { destination_url: "https://click.linksynergy.com/deeplink?murl=x" }, "merchant_domain_conflict"],
    ]) {
      const r = await run({ ...base, ...patch }, "stilacosmetics.com");
      assert.equal(r.out, null, label);
      assert.equal(r.starts, 0, label);
      assert.deepEqual(r.codes, [code], label);
    }
  });
});
