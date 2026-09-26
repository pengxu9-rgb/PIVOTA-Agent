// Declared-schema enforcement on the NATIVE tools/call path — the guard that ends the silent-ignore gap
// verified on prod 2026-08-25: `recommend_products {price_max: 40}` (misplaced — the ceiling belongs inside
// `constraints`) was accepted, the argument silently deleted by the params allowlist, and an over-budget $64
// item returned with empty warnings. A buyer-agent believing an unenforced budget is enforced is the worst
// failure mode this surface can have, so these tests drive the REAL surface (kernel + canonicalExecutor, no
// network) and pin, for the whole tool table, that an undeclared argument is a loud refusal and its declared
// spelling still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SafetyKernel } from "../../safety-kernel/src/kernel.js";
import { createCanonicalExecutor } from "../../safety-kernel/src/protocol/canonicalExecutor.js";
import { createCommerceToolSurface } from "../src/commerceToolSurface.js";
import { findUndeclaredArguments } from "../src/inputSchemaGuard.js";

const SECRET = "schema-guard-secret-0123456789abc";
const quiet = { info() {}, warn() {}, error() {} };
const QUOTE = {
  merchant_of_record: "merch_A", currency: "USD",
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: "p1", quantity: 1 }], acp_state: {},
};

function setup() {
  let charges = 0;
  const kernelUpstream = async (op) => (
    op === "preview_quote" ? QUOTE
    : op === "create_order" ? { order_id: "o_exec", acp_state: {} }
    : op === "submit_payment" ? (charges++, { order_id: "o_exec", payment_id: "pay1", payment_status: "succeeded" })
    : {}
  );
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const reads = [];
  const recoCalls = [];
  const executor = createCanonicalExecutor({
    kernel,
    upstream: async (op, payload) => { reads.push({ op, payload }); return { ok: true, op }; },
    localReads: {
      recommend_products: async (params) => { recoCalls.push(params); return { ok: true, recommendations: [] }; },
      get_alternatives: async () => ({ ok: true }),
      get_offers: async () => ({ ok: true }),
      get_intel: async () => ({ ok: true }),
    },
    verifyPaymentAuthorization: async (_a, b) => ({ ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }),
  });
  const surface = createCommerceToolSurface(executor, { cache: false });
  return { surface, reads, recoCalls, charges: () => charges };
}

const CLAIMS = { iss: "https://idp.test", sub: "user-1", email: "buyer@example.com", email_verified: true };
const SESS = { user_ref: "user_1", acp_session_id: "sess_conn_1", claims: CLAIMS };
const CART = () => ({ merchant_id: "merch_A", items: [{ product_id: "p1", variant_id: "v1", quantity: 1 }] });

const isGuardRefusal = (e) =>
  e.name === "ToolValidationError" && e.code === "INVALID_ARGUMENTS" && /unknown argument/.test(e.message);

// THE reported failure, pinned exactly: top-level price_max is refused loudly (never silently dropped), and
// the refusal tells the caller the envelope that works.
test("recommend_products: misplaced top-level price_max is REFUSED, naming the constraints envelope", async () => {
  const { surface, recoCalls } = setup();
  await assert.rejects(
    surface.callTool("recommend_products", { need: "a gentle retinol", price_max: 40 }, {}),
    (e) => {
      assert.ok(isGuardRefusal(e), `wrong error: ${e.name}/${e.code}: ${e.message}`);
      assert.match(e.message, /"price_max"/);
      // the ACTIONABLE half: the refusal must name the envelope that works, not just the accepted list
      assert.match(e.message, /send it inside `constraints`/);
      assert.match(e.message, /\{"constraints":\{"price_max":40\}\}/);
      assert.match(e.message, /silently ignored/);
      return true;
    },
  );
  assert.equal(recoCalls.length, 0, "a refused call must never reach the recommendation lane");
});

// …and the DECLARED spelling of the same constraint is accepted and actually travels to the lane.
test("recommend_products: constraints.price_max is accepted and reaches the recommendation lane", async () => {
  const { surface, recoCalls } = setup();
  await surface.callTool("recommend_products", { need: "a gentle retinol", constraints: { price_max: 40 } }, {});
  assert.equal(recoCalls.length, 1);
  assert.equal(recoCalls[0].payload.constraints.price_max, 40, "the enforced ceiling must reach the lane");
});

// The gap was a CLASS, not one tool: every tool on the surface refuses an undeclared top-level argument.
// Anonymous context on purpose — the guard answers before the identity gate, so the sweep also pins that a
// malformed call is named malformed rather than answered with a sign-in demand it could never satisfy.
test("EVERY tool refuses an undeclared top-level argument (no silent-ignore anywhere on the surface)", async () => {
  const { surface, reads, recoCalls, charges } = setup();
  for (const tool of surface.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must advertise a strict schema`);
    await assert.rejects(
      surface.callTool(tool.name, { definitely_undeclared_argument: 1 }, {}),
      (e) => isGuardRefusal(e) && e.message.includes(tool.name) && e.message.includes('"definitely_undeclared_argument"'),
      `${tool.name} accepted an undeclared argument`,
    );
  }
  assert.equal(reads.length + recoCalls.length, 0, "no refused call may reach an upstream read");
  assert.equal(charges(), 0);
});

// Strictness recurses to where the schema declares it: an undeclared key inside a cart line item is refused
// with its full path, before anything is priced.
test("nested undeclared keys are refused with a full path (quote.items[0].price)", async () => {
  const { surface, charges } = setup();
  const quote = CART();
  quote.items[0].price = 0.01; // a model-asserted price must never even reach the intake
  await assert.rejects(
    surface.callTool("create_checkout_session", { idempotency_key: "idem-nested-1", quote }, SESS),
    (e) => isGuardRefusal(e) && e.message.includes('"quote.items[0].price"'),
  );
  assert.equal(charges(), 0);
});

// A misplaced-but-declared-deeper name gets pointed at its declared home.
test('misplaced customer_email at the top level answers with did-you-mean "quote.customer_email"', async () => {
  const { surface } = setup();
  await assert.rejects(
    surface.callTool("create_checkout_session", { idempotency_key: "idem-dym-1", quote: CART(), customer_email: "b@x.test" }, SESS),
    (e) => isGuardRefusal(e) && e.message.includes('did you mean "quote.customer_email"?'),
  );
});

// Identity fields are undeclared BY DESIGN (they come from the verified session); a model asserting one is
// now refused loudly rather than silently stripped — same neutralization, better teaching signal.
test("model-supplied identity in tool args is refused, not silently stripped", async () => {
  const { surface, charges } = setup();
  await assert.rejects(
    surface.callTool("create_checkout_session", { idempotency_key: "idem-id-1", user_ref: "user_ATTACKER", quote: CART() }, SESS),
    (e) => isGuardRefusal(e) && e.message.includes('"user_ref"'),
  );
  assert.equal(charges(), 0);
});

// The guard enforces the ADVERTISED shape, not blanket strictness: schemas that declare a free-form envelope
// (payment_authorization additionalProperties:true; constraints typed-additionalProperties) keep accepting
// undeclared members there, so a real delegated token of any shape still completes a checkout.
test("free-form envelopes stay free-form: arbitrary payment_authorization members still charge once", async () => {
  const { surface, charges } = setup();
  const s = await surface.callTool("create_checkout_session", { idempotency_key: "idem-pay-open-1", quote: CART() }, SESS);
  const out = await surface.callTool(
    "complete_checkout_session",
    { idempotency_key: "idem-pay-open-2", session_id: s.session_id, payment_authorization: { token: "t", provider_extras: { anything: true } } },
    SESS,
  );
  assert.equal(out.payment.order_status, "paid");
  assert.equal(charges(), 1);
});

// Asymmetry pinned: price_max IS declared on search_catalog, so the same spelling that recommend_products
// refuses at the top level is legal there — the guard follows each tool's own schema, not a global denylist.
test("search_catalog: top-level price_max is declared and accepted", async () => {
  const { surface, reads } = setup();
  await surface.callTool("search_catalog", { query: "retinol", price_max: 40 }, {});
  assert.equal(reads.length, 1);
  assert.equal(reads[0].payload.search.price_max, 40);
});

// Unit rules the route tests above can't isolate: array recursion, depth bounding, and type-mismatch skips.
test("findUndeclaredArguments: walking rules", () => {
  const schema = {
    type: "object", additionalProperties: false,
    properties: {
      a: { type: "object", additionalProperties: false, properties: { b: { type: "string" } } },
      list: { type: "array", items: { type: "object", additionalProperties: false, properties: { x: { type: "number" } } } },
      open: { type: "object", additionalProperties: true, properties: { k: { type: "string" } } },
    },
  };
  assert.deepEqual(findUndeclaredArguments(schema, { a: { b: "ok" }, list: [{ x: 1 }], open: { junk: 1 } }), []);
  // absent additionalProperties = permissive (the JSON Schema default) — strictness requires the EXPLICIT
  // `additionalProperties: false` declaration, not merely the presence of `properties`. (Kills the
  // `!== true` mutant, which no published schema can distinguish from `=== false` today.)
  assert.deepEqual(findUndeclaredArguments({ type: "object", properties: { k: { type: "string" } } }, { k: "v", extra: 1 }), []);
  assert.deepEqual(
    findUndeclaredArguments(schema, { zzz: 1, a: { c: 2 }, list: [{ x: 1 }, { y: 2 }] }).map((v) => v.path),
    ["zzz", "a.c", "list[1].y"],
  );
  // a type mismatch (string where an object was declared) is downstream's refusal, not this guard's
  assert.deepEqual(findUndeclaredArguments(schema, { a: "not-an-object" }), []);
  // a JSON __proto__ own-key is just an undeclared key; nothing is polluted by walking it
  const evil = JSON.parse('{"__proto__": {"zz": 1}}');
  assert.deepEqual(findUndeclaredArguments(schema, evil).map((v) => v.path), ["__proto__"]);
  assert.equal({}.zz, undefined);
});
