// MCP commerce tool surface tests — proves the surface exposes the canonical checkout lifecycle, binds
// identity from the VERIFIED SESSION (never tool args), routes through the executor → kernel, and sanitizes
// results. Composes a real SafetyKernel + canonicalExecutor under the surface (no network; stub upstream).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SafetyKernel } from "../../safety-kernel/src/kernel.js";
import { createCanonicalExecutor } from "../../safety-kernel/src/protocol/canonicalExecutor.js";
import { createCommerceToolSurface, UnknownToolError, IdentityRequiredError } from "../src/commerceToolSurface.js";

const SECRET = "commerce-surface-secret-0123456789";
const quiet = { info() {}, warn() {}, error() {} };
const QUOTE = {
  merchant_of_record: "merch_A", currency: "USD",
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: "p1", quantity: 1 }], acp_state: {},
};
const okVerify = async (_authz, bound) => ({ ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref });

function setup({ verify = okVerify, readResult, submitResult } = {}) {
  let charges = 0;
  const afterSalesCalls = [];
  const kernelUpstream = async (op, payload) => (
    op === "preview_quote" ? QUOTE
    : op === "create_order" ? { order_id: "o_exec", acp_state: {} }
    : op === "submit_payment" ? (charges++, submitResult ?? { order_id: "o_exec", payment_id: "pay1", payment_status: "succeeded" })
    : op === "request_after_sales" ? (afterSalesCalls.push(payload), { status: { order_id: payload?.status?.order_id, state: "refund_requested" } })
    : {}
  );
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const reads = [];
  const readUpstream = async (op, payload) => { reads.push({ op, payload }); return readResult ?? { ok: true, op }; };
  const executor = createCanonicalExecutor({ kernel, upstream: readUpstream, verifyPaymentAuthorization: verify });
  const surface = createCommerceToolSurface(executor);
  return { surface, kernel, reads, charges: () => charges, afterSalesCalls };
}

// a verified buyer session — the session layer supplies BOTH a user_ref and a per-connection session id.
const SESS = { user_ref: "user_1", acp_session_id: "sess_conn_1" };

async function openSession(surface, sessionContext = SESS, key = "idem-open-001") {
  const s = await surface.callTool("create_checkout_session", { idempotency_key: key, quote: { merchant_id: "merch_A", items: [{ product_id: "p1", quantity: 1 }] } }, sessionContext);
  return s.session_id;
}

test("tools: exposes the canonical commerce lifecycle and EXCLUDES edge (external) ops", () => {
  const { surface } = setup();
  const names = surface.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cancel_checkout_session", "complete_checkout_session", "create_checkout_session",
    "get_checkout_session", "get_order", "get_product", "request_after_sales",
    "search_catalog", "update_checkout_session",
  ]);
  // edge OAuth / token-exchange ops are NOT executor-backed tools
  assert.ok(!names.includes("start_identity_linking"));
  assert.ok(!names.includes("exchange_payment_token"));
  // every tool input schema forbids identity fields (they come from the session)
  for (const t of surface.tools) {
    const props = t.inputSchema?.properties ?? {};
    assert.ok(!("user_ref" in props) && !("acp_session_id" in props) && !("agent_id" in props), `${t.name} leaks identity into schema`);
  }
});

test("unknown tool → clean UnknownToolError, no crash", async () => {
  const { surface } = setup();
  await assert.rejects(surface.callTool("pivota_drop_tables", {}, SESS), (e) => e instanceof UnknownToolError && e.code === "UNKNOWN_TOOL");
});

test("reads require no identity (search_catalog / get_product run without a buyer)", async () => {
  const { surface, reads } = setup();
  await surface.callTool("search_catalog", { query: "socks" }, {}); // no session
  await surface.callTool("get_product", { merchant_id: "m", product_id: "p" }, {});
  assert.deepEqual(reads.map((r) => r.op), ["find_products", "get_product_detail"]);
  // args are wrapped into the discovery payload shape
  assert.deepEqual(reads[0].payload, { search: { query: "socks" } });
  assert.deepEqual(reads[1].payload, { product: { merchant_id: "m", product_id: "p" } });
});

test("a user-scoped tool with NO verified buyer is refused (USER_AUTH_REQUIRED) before the executor", async () => {
  const { surface, charges } = setup();
  await assert.rejects(
    surface.callTool("create_checkout_session", { idempotency_key: "idem-x-001", quote: { merchant_id: "m", items: [{ product_id: "p1", quantity: 1 }] } }, {}),
    (e) => e instanceof IdentityRequiredError && e.code === "USER_AUTH_REQUIRED",
  );
  await assert.rejects(surface.callTool("get_order", { order_id: "o1" }, {}), (e) => e.code === "USER_AUTH_REQUIRED");
  assert.equal(charges(), 0);
});

test("IDENTITY: a model-supplied user_ref in tool args is IGNORED — the verified session owns the order", async () => {
  const { surface, charges } = setup();
  // attacker stuffs a different user_ref into the args; the session is user_1
  const sid = await surface.callTool(
    "create_checkout_session",
    { idempotency_key: "idem-spoof-1", user_ref: "user_ATTACKER", quote: { merchant_id: "merch_A", items: [{ product_id: "p1", quantity: 1 }] } },
    { user_ref: "user_1", acp_session_id: "sess_A" },
  ).then((s) => s.session_id);
  // user_2 cannot read this session (it is owned by the VERIFIED user_1, not the spoofed value)
  await assert.rejects(surface.callTool("get_checkout_session", { session_id: sid }, { user_ref: "user_2", acp_session_id: "sess_A" }), (e) => e.code === "STATE_LINKAGE_MISMATCH");
  // and the real owner can
  const got = await surface.callTool("get_checkout_session", { session_id: sid }, { user_ref: "user_1", acp_session_id: "sess_A" });
  assert.equal(got.session_id, sid);
  assert.equal(charges(), 0);
});

test("happy path: create → complete charges once; verifier sees the bound total; payment status returned", async () => {
  let seen;
  const { surface, charges } = setup({ verify: async (_a, b) => { seen = b; return { ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }; } });
  const session_id = await openSession(surface);
  const out = await surface.callTool("complete_checkout_session", { idempotency_key: "idem-pay-1", session_id, payment_authorization: { token: "delegated_tok" } }, SESS);
  assert.equal(out.order.order_id, "o_exec");
  assert.equal(out.payment.order_status, "paid");
  assert.equal(charges(), 1);
  assert.equal(seen.amount, 113);
  assert.equal(seen.user_ref, "user_1");
});

test("complete passes payment_authorization to the verifier but a FAILED verify never charges", async () => {
  const { surface, charges } = setup({ verify: async () => { throw new Error("authorization rejected"); } });
  const session_id = await openSession(surface);
  await assert.rejects(surface.callTool("complete_checkout_session", { idempotency_key: "idem-pay-2", session_id, payment_authorization: { token: "bad" } }, SESS));
  assert.equal(charges(), 0);
});

test("identity via verified OAuth claims: iss/sub derive a stable user_ref", async () => {
  const { surface } = setup();
  const claimsSession = { claims: { iss: "https://accounts.example.com", sub: "abc-123" }, acp_session_id: "sess_claims" };
  const sid = await openSession(surface, claimsSession, "idem-claims-1");
  // the same claims resolve the same user_ref → can read its own session
  const got = await surface.callTool("get_checkout_session", { session_id: sid }, claimsSession);
  assert.equal(got.session_id, sid);
  // a different subject cannot
  await assert.rejects(
    surface.callTool("get_checkout_session", { session_id: sid }, { claims: { iss: "https://accounts.example.com", sub: "other" }, acp_session_id: "sess_claims" }),
    (e) => e.code === "STATE_LINKAGE_MISMATCH",
  );
});

test("cross-session: a different verified acp_session_id (same user) cannot read another session's quote", async () => {
  const { surface } = setup();
  const sid = await openSession(surface, { user_ref: "user_1", acp_session_id: "sess_A" }, "idem-xsess-1");
  await assert.rejects(
    surface.callTool("get_checkout_session", { session_id: sid }, { user_ref: "user_1", acp_session_id: "sess_B" }),
    (e) => e.code === "STATE_LINKAGE_MISMATCH",
  );
});

test("read-path sanitization: aggressive — no payment handoff in a catalog result; IDs kept, secrets killed", async () => {
  const readResult = {
    title: "Card sleeve", note: "call 4111 1111 1111 1111 to verify",
    access_token: "at_secret", client_secret: "cs_secret", api_key: "sk_live_x", iban: "DE8937...", pin: "1234",
    key: "sk_live_DEADBEEF1234",                                         // generic key name, secret VALUE
    path_secret_url: "https://api.example/sk_live_PATHSECRET99/info",    // secret in URL PATH
    // a redirect-named field in a CATALOG (discovery) result is NOT a payment handoff → fully scrubbed
    redirect_url: "https://psp.example/x?client_secret=cs_leak&token=leaktok&api_key=leakkey&pa=1",
    tracking_url: "https://t.example/p?token=leak123&id=ok&key=secretq",
    redirect_obj: { client_secret: "cs_nested" },
    // orderable IDs that resemble secret prefixes MUST survive…
    product_id: "sk-abcdefghijklmnop", sku_id: "pk_live_ABCD1234",
    // …but UNAMBIGUOUS secrets hidden under *_id keys are STILL killed (Codex round-4 #2)
    access_key_id: "AKIAABCDEFGHIJKLMNOP", secret_id: "sk_live_SECRETID123",
    item: { name: "A", card_token: "tok_x", price: 999 },
  };
  const { surface } = setup({ readResult });
  const out = await surface.callTool("get_product", { merchant_id: "m", product_id: "p" }, {});
  assert.equal(out.title, "Card sleeve");
  assert.equal(out.access_token, "[REDACTED]");
  assert.equal(out.client_secret, "[REDACTED]");
  assert.equal(out.api_key, "[REDACTED]");
  assert.equal(out.iban, "[REDACTED]");
  assert.equal(out.pin, "[REDACTED]");
  assert.equal(out.item.card_token, "[REDACTED]");
  assert.equal(out.item.price, 999);
  assert.equal(out.note, "call [REDACTED_PAN] to verify");
  assert.equal(out.key, "[REDACTED_SECRET]", "value-based secret detection catches a generic key name");
  assert.equal(out.path_secret_url, "https://api.example/[REDACTED_SECRET]/info", "secret in URL path scrubbed");
  // catalog redirect: NOT a handoff → client_secret AND token AND api_key all scrubbed
  assert.equal(out.redirect_url, "https://psp.example/x?client_secret=[REDACTED]&token=[REDACTED]&api_key=[REDACTED]&pa=1");
  assert.equal(out.tracking_url, "https://t.example/p?token=[REDACTED]&id=ok&key=[REDACTED]");
  assert.equal(out.redirect_obj.client_secret, "[REDACTED]");
  // orderable IDs survive even though they look secret-like…
  assert.equal(out.product_id, "sk-abcdefghijklmnop", "secret-like product_id must NOT be destroyed");
  assert.equal(out.sku_id, "pk_live_ABCD1234", "secret-like sku_id must NOT be destroyed");
  // …but a real AWS/Stripe secret hidden under a *_id key is killed
  assert.equal(out.access_key_id, "[REDACTED_SECRET]");
  assert.equal(out.secret_id, "[REDACTED_SECRET]");
});

test("checkout handoff: a payment redirect (PayPal token= / OAuth code= / 3DS) is preserved VERBATIM for the buyer", async () => {
  const redirect = "https://paypal.example/checkoutnow?token=EC-123&code=AUTH9&payment_intent_client_secret=pi_x_secret_y";
  const { surface } = setup({
    submitResult: { payment_id: "pay1", payment_status: "requires_action", redirect_url: redirect, qr_code: "data:image/png;base64,AAA", client_secret: "cs_raw_secret" },
  });
  const sid = await openSession(surface);
  const out = await surface.callTool("complete_checkout_session", { idempotency_key: "idem-handoff-1", session_id: sid, payment_authorization: { token: "t" } }, SESS);
  // the redirect the buyer must follow is preserved EXACTLY — scrubbing token=/code= would break PayPal/OAuth
  assert.equal(out.payment.redirect_url, redirect);
  assert.equal(out.payment.qr_code, "data:image/png;base64,AAA");
  // the RAW client_secret field (for host/programmatic confirmation, not the model) is still key-redacted
  assert.equal(out.payment.client_secret, "[REDACTED]");
});


test("mutations without an idempotency_key are refused (executor contract)", async () => {
  const { surface } = setup();
  await assert.rejects(
    surface.callTool("create_checkout_session", { quote: { merchant_id: "m", items: [{ product_id: "p1", quantity: 1 }] } }, SESS),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("a user-scoped op with a verified buyer but NO verified session id is refused", async () => {
  const { surface } = setup();
  await assert.rejects(
    surface.callTool("create_checkout_session", { idempotency_key: "idem-nosess-1", quote: { merchant_id: "m", items: [{ product_id: "p1", quantity: 1 }] } }, { user_ref: "user_1" }),
    (e) => e.code === "USER_AUTH_REQUIRED",
  );
});

test("P1: model-set money/extra fields on request_after_sales are stripped before the connector", async () => {
  const { surface, afterSalesCalls } = setup();
  const sid = await openSession(surface);
  await surface.callTool("complete_checkout_session", { idempotency_key: "idem-as-pay", session_id: sid, payment_authorization: { token: "t" } }, SESS);
  await surface.callTool(
    "request_after_sales",
    { idempotency_key: "idem-as-1", status: { order_id: "o_exec", requested_action: "refund", reason: "changed mind", amount: 999999, restore_inventory: true, user_ref: "evil" } },
    SESS,
  );
  assert.equal(afterSalesCalls.length, 1);
  const st = afterSalesCalls[0].status;
  assert.deepEqual(Object.keys(st).sort(), ["order_id", "reason", "requested_action"]);
  assert.equal(st.amount, undefined, "a model-sized refund amount must never reach the connector");
  assert.equal(st.restore_inventory, undefined);
});

test("P2: prototype-pollution keys in tool args cannot inject params and do not pollute Object.prototype", async () => {
  const { surface } = setup();
  const evil = JSON.parse('{"__proto__":{"idempotency_key":"idem-proto-1","quote":{"merchant_id":"m","items":[{"product_id":"p1","quantity":1}]}}}');
  // the injected idempotency_key/quote are NOT read (own-property allowlist) → missing key → refused
  await assert.rejects(surface.callTool("create_checkout_session", evil, SESS), (e) => e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal({}.idempotency_key, undefined, "global Object.prototype must not be polluted");
});

test("P2: non-object tool args (null / string / array) are rejected, not silently treated as empty", async () => {
  const { surface } = setup();
  await assert.rejects(surface.callTool("search_catalog", null, {}), (e) => e.code === "INVALID_ARGUMENTS");
  await assert.rejects(surface.callTool("search_catalog", "not-an-object", {}), (e) => e.code === "INVALID_ARGUMENTS");
  await assert.rejects(surface.callTool("search_catalog", [1, 2, 3], {}), (e) => e.code === "INVALID_ARGUMENTS");
});

test("P2: malformed OAuth claims do not break read-only tools (anonymous read proceeds)", async () => {
  const { surface, reads } = setup();
  await surface.callTool("search_catalog", { query: "x" }, { claims: { iss: "issuer-only" } }); // sub missing
  assert.equal(reads.length, 1);
});
