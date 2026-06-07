import { test } from "node:test";
import assert from "node:assert/strict";

import { createConfirmationActionHandler } from "../src/confirmationAction.js";

test("confirmation action refuses construction without a host UI action verifier", () => {
  assert.throws(
    () =>
      createConfirmationActionHandler({
        commerce: { async mintConfirmation() {} },
        authenticate: async () => ({}),
      }),
    /verifyUserAction/,
  );
});

test("confirmation action mints from verified session context only", async () => {
  const calls = [];
  const handler = createConfirmationActionHandler({
    commerce: {
      async mintConfirmation(binding, ctx) {
        calls.push({ binding, ctx });
        return "confirm_token_123";
      },
    },
    authenticate: async () => ({
      sessionContext: {
        user_ref: "usr_verified",
        acp_session_id: "sess_verified",
        agent_id: "claude",
      },
    }),
    verifyUserAction: async () => true,
  });

  const out = await handler.handle({
    body: {
      order_id: "ORD_CONFIRM_1",
      user_ref: "usr_model_supplied",
      acp_session_id: "sess_model_supplied",
    },
  });

  assert.equal(out.status, 200);
  assert.equal(out.body.confirmation_token, "confirm_token_123");
  assert.deepEqual(calls, [
    {
      binding: { order_id: "ORD_CONFIRM_1" },
      ctx: {
        user_ref: "usr_verified",
        acp_session_id: "sess_verified",
        agent_id: "claude",
      },
    },
  ]);
});

test("confirmation action refuses when the host UI action is not verified", async () => {
  let minted = false;
  const handler = createConfirmationActionHandler({
    commerce: {
      async mintConfirmation() {
        minted = true;
        return "confirm_token_123";
      },
    },
    authenticate: async () => ({
      sessionContext: {
        user_ref: "usr_verified",
        acp_session_id: "sess_verified",
      },
    }),
    verifyUserAction: async () => false,
  });

  const out = await handler.handle({ body: { order_id: "ORD_CONFIRM_2" } });

  assert.equal(out.status, 403);
  assert.equal(out.body.error.code, "CONFIRMATION_ACTION_REQUIRED");
  assert.equal(minted, false);
});

test("confirmation action refuses missing verified buyer session", async () => {
  let minted = false;
  const handler = createConfirmationActionHandler({
    commerce: {
      async mintConfirmation() {
        minted = true;
        return "confirm_token_123";
      },
    },
    authenticate: async () => ({ sessionContext: { user_ref: "usr_verified" } }),
    verifyUserAction: async () => true,
  });

  const out = await handler.handle({ body: { order_id: "ORD_CONFIRM_3" } });

  assert.equal(out.status, 401);
  assert.equal(out.body.error.code, "USER_AUTH_REQUIRED");
  assert.equal(minted, false);
});

test("confirmation action requires order_id and parses raw JSON bodies", async () => {
  const seen = [];
  const handler = createConfirmationActionHandler({
    commerce: {
      async mintConfirmation(binding, ctx) {
        seen.push({ binding, ctx });
        return "confirm_token_raw";
      },
    },
    authenticate: async () => ({
      sessionContext: {
        user_ref: "usr_verified",
        acp_session_id: "sess_verified",
      },
    }),
    verifyUserAction: async () => true,
  });

  const missing = await handler.handle({ body: {} });
  const ok = await handler.handle({
    rawBody: Buffer.from(JSON.stringify({ order_id: "ORD_RAW_1" })),
  });

  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "INVALID_ARGUMENTS");
  assert.equal(ok.status, 200);
  assert.deepEqual(seen[0].binding, { order_id: "ORD_RAW_1" });
});
