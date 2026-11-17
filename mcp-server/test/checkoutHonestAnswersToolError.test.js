// The tool doors' words for the kernel's checkout refusals (toToolError): what is surfaced, and what never is.
// Every name is a placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toToolError } from "../src/commerceToolSurface.js";
import { PivotaCommerceError, kernelOutcomeUnknown } from "../../safety-kernel/src/errors.js";

const bodyOf = (err) => JSON.parse(toToolError(err).content[0].text).error;

test("an order id that is not id-shaped is never surfaced: the unknown outcome, the used session and the cancel refusal leave it out", () => {
  for (const bad of ["o 1", "o_1\n", "<script>", "", "x".repeat(200), "../o_1", "o_1;drop"]) {
    const unknown = bodyOf(kernelOutcomeUnknown("payment_outcome_unknown_after_order", bad));
    assert.equal(unknown.detail.order_id, null, JSON.stringify(bad));
    const used = bodyOf(new PivotaCommerceError("QUOTE_ALREADY_USED", { quote_id: "q_1", order_id: bad }));
    assert.equal(used.detail, undefined, JSON.stringify(bad));
    const cancel = bodyOf(new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: "cancel_checkout_session", reason: "session_already_ordered", order_id: bad, upstream_cancel: false }));
    assert.equal("order_id" in cancel.detail, false, JSON.stringify(bad));
    assert.equal(JSON.stringify([unknown, used, cancel]).includes(bad || "\u0000"), false, JSON.stringify(bad));
  }
  // A well-formed id passes.
  assert.equal(bodyOf(kernelOutcomeUnknown("payment_outcome_unknown_after_order", "ord_0001")).detail.order_id, "ord_0001");
});

test("a session a cancellation holds is told it was canceled: never 'used to place an order', never get_order", () => {
  const body = bodyOf(new PivotaCommerceError("QUOTE_ALREADY_USED", { quote_id: "q_1", claim: "canceled", reason: "session_canceled" }));
  assert.deepEqual(body, {
    code: "QUOTE_ALREADY_USED",
    message: "This checkout was canceled, so it cannot be completed or paid. No order was placed from it.",
    retriable: false,
    detail: { reason: "session_canceled" },
    recovery: "do not complete this checkout; start a new checkout only if the buyer wants to buy",
  });
  // A canceled claim never names an order, even if one were passed.
  assert.equal(JSON.stringify(bodyOf(new PivotaCommerceError("QUOTE_ALREADY_USED", { claim: "canceled", order_id: "ord_0001" }))).includes("ord_0001"), false);
});

test("an ordered session's cancel refusal: with the upstream cancel off, never 'cancel it by the order_id'; with it on, that wording stays", () => {
  const off = bodyOf(new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: "cancel_checkout_session", reason: "session_already_ordered", order_id: "ord_0001", upstream_cancel: false }));
  assert.deepEqual(off.detail, { reason: "session_already_ordered", canceled: false, order_id: "ord_0001" });
  assert.equal(/cancel it by/i.test(off.recovery + off.message), false, off.recovery);
  assert.match(off.recovery, /get_order \(detail\.order_id\)/);
  assert.match(off.recovery, /cannot cancel it at the store/);
  assert.match(off.message, /payment page stays open until it expires/);
  const offNoId = bodyOf(new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: "cancel_checkout_session", reason: "session_already_ordered", upstream_cancel: false }));
  assert.equal(/detail\.order_id/.test(offNoId.recovery), false, "no id, none pointed at");
  // The upstream-cancel lane (CHECKOUT_CANCEL_UPSTREAM_ENABLED on) raises it without the member: its words stay.
  const on = bodyOf(new PivotaCommerceError("OPERATION_NOT_ALLOWED", { op: "cancel_checkout_session", reason: "session_already_ordered" }));
  assert.equal(on.recovery, "cancel it by its order_id");
});
