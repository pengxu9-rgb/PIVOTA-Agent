// The v2-router <-> v1-mainline delegation cycle, pinned so it cannot come back.
//
// WHAT HAPPENED. `POST /v1/chat` with `action.action_id = 'chip.start.dupes'` never answered: it pinned a CPU
// at 100% forever. Two independently-reasonable classifiers disagreed about who owned the request and each
// deferred to the other:
//
//   handleChat (routes/chat.js)            -- shouldProxyFrameworkRecoToV1Mainline() said TRUE
//     -> invokeBoundedV1MainlineChat
//       -> runV1ChatMainlineInProcess      (routes.js)
//         -> handleV1Chat                  -- its intent contract said delegate_target === 'v2'
//           -> handleChatV2 == handleChat  -- ...and round again, forever
//
// The proxy call is already wrapped in `withTimeoutCode`, and that bound CANNOT fire here: the recursion is a
// chain of promise continuations, so the microtask queue never drains and the timeout's timer never gets a
// turn. The suite that owned this request (aurora_bff_v1_chat_rollout) therefore hung at test 54 of 60 — and
// because that file is in no CI job, nothing noticed. Both halves are covered below.
//
// THIS FILE MUST FAIL FAST, NEVER HANG. A regression here is an infinite loop, and a test that reproduces an
// infinite loop in CI is worse than no test: it burns a runner until the job timeout and reports nothing
// useful. So every end-to-end case instruments the routing decision with a hard call budget that THROWS on
// the (N+1)th consultation. A regression fails in milliseconds with a legible message.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const POLICY_ID = require.resolve('../src/auroraBff/recoOwnershipPolicy');
const ROUTES_ID = require.resolve('../src/auroraBff/routes');
const CHAT_ID = require.resolve('../src/auroraBff/routes/chat');

// Well above any legitimate use (one decision per request, two if a future design adds a deliberate second
// hop) and low enough that a cycle trips it instantly.
const CALL_BUDGET = 8;

/** The payload that used to hang: a v2-owned action whose reply_text reads like a reco ask. */
function dupesBody() {
  return {
    action: {
      action_id: 'chip.start.dupes',
      kind: 'chip',
      data: {
        reply_text: 'Find dupes for Barrier Cloud Cream',
        product_anchor: {
          brand: 'Glow Lab',
          name: 'Barrier Cloud Cream',
          product_id: 'anchor_1',
          candidates: [
            { product_id: 'dupe_1', brand: 'Budget Lab', name: 'Barrier Daily Cream', similarity_score: 84 },
          ],
        },
      },
    },
  };
}

/**
 * Boot the chat stack with the ownership decision instrumented.
 *
 * The modules are re-required from a cleared cache because routes/chat.js DESTRUCTURES the policy function at
 * require time — patching the module export after it loaded would leave the original bound and the counter
 * would read zero while the cycle span merrily on.
 *
 * @param {(realResult:boolean)=>boolean} [override] force the decision, to exercise the structural guard
 */
function bootInstrumented(override) {
  for (const id of [POLICY_ID, ROUTES_ID, CHAT_ID]) delete require.cache[id];
  const policy = require('../src/auroraBff/recoOwnershipPolicy');
  const real = policy.shouldProxyFrameworkRecoToV1Mainline;
  const state = { calls: 0, decisions: [] };
  policy.shouldProxyFrameworkRecoToV1Mainline = (...args) => {
    state.calls += 1;
    if (state.calls > CALL_BUDGET) {
      // The regression signature: the two routers are handing the request back and forth.
      throw new Error(
        `v1-mainline delegation cycle: the reco-ownership decision was consulted ${state.calls} times for a `
        + 'single request. The v2 router and the v1 mainline are each deferring to the other.',
      );
    }
    const result = real(...args);
    const decided = typeof override === 'function' ? override(result) : result;
    state.decisions.push(decided);
    return decided;
  };
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });
  return { app, state };
}

function withChatEnv(fn) {
  const keys = ['AURORA_BFF_USE_MOCK', 'AURORA_CHAT_V2_STUB_RESPONSES', 'AURORA_CHAT_SKILL_ROUTER_V2'];
  const previous = keys.map((k) => [k, process.env[k]]);
  process.env.AURORA_BFF_USE_MOCK = 'true';
  process.env.AURORA_CHAT_V2_STUB_RESPONSES = '1';
  process.env.AURORA_CHAT_SKILL_ROUTER_V2 = 'true';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of previous) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
      for (const id of [POLICY_ID, ROUTES_ID, CHAT_ID]) delete require.cache[id];
    });
}

const HEADERS = {
  'X-Aurora-UID': 'uid_delegation_cycle',
  'X-Trace-ID': 'trace_delegation_cycle',
  'X-Brief-ID': 'brief_delegation_cycle',
  'X-Lang': 'EN',
};

// ---- 1. the routing decision itself --------------------------------------------------------------------

test('an explicit non-reco action is decided by the ACTION, not by its own reply_text', () => {
  delete require.cache[POLICY_ID];
  const { shouldProxyFrameworkRecoToV1Mainline } = require('../src/auroraBff/recoOwnershipPolicy');

  // The cycle's source: the typed-text heuristics used to run BEFORE the action gate, so a v2-owned action
  // carrying reco-shaped text was proxied to the mainline — which promptly classified it back to v2.
  assert.equal(shouldProxyFrameworkRecoToV1Mainline(dupesBody()), false);

  // The same text under other v2-owned actions must not be proxied either — this is the general rule, not a
  // special case for `dupes`.
  for (const actionId of ['chip.start.travel', 'chip.action.analyze_product', 'chip.action.add_to_routine']) {
    const body = dupesBody();
    body.action.action_id = actionId;
    assert.equal(shouldProxyFrameworkRecoToV1Mainline(body), false, `${actionId} must not proxy to the mainline`);
  }
});

test('the narrowing does not steal the reco action or free-text asks from the mainline', () => {
  delete require.cache[POLICY_ID];
  const { shouldProxyFrameworkRecoToV1Mainline } = require('../src/auroraBff/recoOwnershipPolicy');

  // Both directions matter. A fix that simply answered `false` more often would "fix" the hang by breaking
  // the mainline's actual traffic, so pin what MUST still route there.
  const recoAction = dupesBody();
  recoAction.action.action_id = 'chip.start.reco_products';
  recoAction.action.data.reply_text = 'what moisturizer should I use for dry skin?';
  assert.equal(shouldProxyFrameworkRecoToV1Mainline(recoAction), true, 'the reco action still owns the mainline');

  // Free text with no action at all is untouched by the ordering change.
  assert.equal(
    shouldProxyFrameworkRecoToV1Mainline({ message: 'what moisturizer should I use for dry skin?' }),
    true,
    'a typed reco ask still routes to the mainline',
  );
});

// ---- 2. end to end: the request that used to hang ---------------------------------------------------------

test('the payload that used to hang now answers, and consults the routing decision once', async () => {
  await withChatEnv(async () => {
    const { app, state } = bootInstrumented();

    const response = await supertest(app).post('/v1/chat').set(HEADERS).send(dupesBody()).expect(200);

    // Answered, and answered as the OWNING router would: a dupe card, not a mainline reco envelope. Asserting
    // the card matters — the structural guard alone makes this request terminate with the wrong body, so a
    // test that only checked "it responded" would pass against a half-fixed system.
    assert.equal(response.body.cards?.[0]?.card_type, 'dupe_suggest');
    assert.equal(state.calls, 1, `the ownership decision must be taken once, was taken ${state.calls}x`);
    assert.deepEqual(state.decisions, [false]);
  });
});

// ---- 3. the structural guard, tested on its own ------------------------------------------------------------

test('the mainline refuses to hand a request back to the router that proxied it in', async () => {
  await withChatEnv(async () => {
    // Force the disagreement that caused the cycle: the router insists on proxying to the mainline, while the
    // mainline's own intent contract still says this action belongs to v2. Before the guard this looped until
    // the process died. This is what keeps the NEXT classifier disagreement from being an outage — the
    // ownership fix in test 1 removes today's instance, this removes the failure mode.
    const { app, state } = bootInstrumented(() => true);

    const response = await supertest(app).post('/v1/chat').set(HEADERS).send(dupesBody()).expect(200);

    assert.ok(response.body, 'the request must terminate rather than delegate forever');
    assert.ok(
      state.calls <= 2,
      `a forced disagreement must not re-enter the router (took ${state.calls} decisions)`,
    );
  });
});
