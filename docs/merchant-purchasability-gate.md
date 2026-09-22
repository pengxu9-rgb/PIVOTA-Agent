# The merchant-purchasability gate (gateway side)

`src/services/merchantPurchasabilityClient.js` (the client and the rule),
`src/services/ucpWarmHandoff.js` (the seam), `src/services/checkoutHandoffResolver.js` and
`src/services/ucpWarmHandoffInternalRoute.js` (the two callers that supply the market),
`tests/merchant_purchasability_gate.node.test.cjs` (the pins).

This rail ships **dark**, behind `MERCHANT_PURCHASABILITY_GATE_ENABLED` (default OFF). With the
switch off nothing is asked of the backend and the warm-handoff lane is byte-identical to before
this PR — pinned, not asserted, by the snapshot test in the suite above.

The authority for the FACT is the backend: `pivota-backend
docs/runbooks/merchant_purchasability.md`. This document is only about the consumer.

---

## 1. What the fact is, and the incident that produced it

A merchant × market carries a PURCHASE affordance only while it holds a fresh, positive
purchasability fact: **we rendered that merchant's landed checkout, the checkout's own
`availablePaymentLines` named a CARD gateway, and the line was charged at the price we hold**,
measured from the buyer market's vantage, inside a TTL (72 h by default).

On 2026-09-22 **flowerbeauty.com was served as purchasable** and four separate signals said yes.
Not one of them was about paying:

| signal | what it actually said |
|---|---|
| the liveness sweep | read `products.json` and treated "cannot verify" as a FREEZE that kept every affordance, buy included |
| **the UCP reprobe** | recorded `ready_for_complete` — which means the door **PRICED a cart**. It says nothing about payment |
| `/.well-known/ucp` `payment_handlers` | listed `dev.shopify.card`, a **platform constant every Shopify store repeats** |
| the cart-link preflight | read the merchandise line and the market, and **never looked at the payment methods** |

Rendered in a browser that day, flowerbeauty's checkout offered **PayPal ONLY**, and its
storefront charged **USD 8.00** against our indexed **USD 14.95**.

**The second row is this repo's.** `ready_for_complete` does not exist in pivota-backend at all —
it is produced here, by the in-chat priced preview in `ucpWarmHandoff.buildPreview`
(`checkout_status: p.status`). That is why the gate is a gateway change and not a backend one.

---

## 2. Where the seam is, and why it is there

**`src/services/ucpWarmHandoff.js`, in `resolveWarmHandoff`, immediately after `brandLabel` is
computed and BEFORE endpoint discovery.**

That function is the gateway's purchase affordance for an observed (crawled, uncontracted)
merchant: it builds a cart on the merchant's own checkout and — with
`UCP_INCHAT_PREVIEW_ENABLED` on — prices it in chat. Its two callers already treat a `null`
return as "cold-redirect the shopper to the product page instead", which is exactly the
browse/referral behaviour the gate needs to fall back to:

| caller | purchase affordance | what a `null` becomes |
|---|---|---|
| `checkoutHandoffResolver.maybeResolveWarmHandoff` | `status: 'resolved'`, `checkout_handoff.status: 'warm_handoff_ready'`, `serviceability.orderable_offer: true` | the pre-existing `buildBlock('policy_not_supported')` — `status: 'blocked'` |
| `ucpWarmHandoffInternalRoute` (the click lane) | `{ continue_url, cart_id, preview }` | `{ continue_url: null, reason: 'fallback' }` — the caller cold-redirects |

**Why this and not somewhere else.** One insertion point covers both lanes; the fallback
mechanism, the metric and the log plumbing all already exist; the merchant domain is already
parameter #1; and a merchant we will not sell for is then never contacted at all, so we stop
creating an abandoned checkout on a store we are about to decline.

Placing it instead in `mcp-server/src/ucpCheckoutEscalation.js::escalationTargetOf` was
considered and rejected: that predicate is pure and synchronous, runs on the **UCP dialect only**,
and no market reaches it (`QUOTE_KEYS` has no market field and `mapQuote` drops
`checkout.context`) — so it would have been a larger change covering less.

### The market

The gate keys on the **request's** buyer market and never on a default.

* `checkoutHandoffResolver.requestBuyerMarket(input)` reads `metadata.market || payload.market` —
  this door's existing spelling (`src/server.js` reads `search.market || metadata.market` on the
  discovery lane, and the invoke handler threads `metadata` into the resolver verbatim).
* `ucpWarmHandoffInternalRoute` reads an optional `body.market`. Additive: a caller that sends
  none is exactly today's request.

> ⚠️ **`servedMarkets.primaryMarket()` is NOT an acceptable fallback here.** It returns the
> DEPLOYMENT's market (`'US'` by default) for a request that named none, and the fact is keyed on
> the BUYER's market. A positive fact from another vantage is evidence for a human, never
> permission for the door — judydoll.com resets direct TCP from one of our egresses while
> answering through another (backend runbook §6). **A request with no market is a question the
> gate cannot ask, so it keeps the previous behaviour.** A mutant that substitutes `'US'` is in
> the sweep, and it is killed.

---

## 3. Dials

| variable | default | what it does |
|---|---|---|
| `MERCHANT_PURCHASABILITY_GATE_ENABLED` | **unset = OFF** | **THE GATEWAY KILL SWITCH.** Truthy allowlist `1 / true / yes / on / enabled`, case- and space-insensitive, read per call. Off: nothing is asked of the backend and the lane is byte-identical. Armed independently of the backend dial, and the first thing to flip back on a rollback |
| `PIVOTA_OPS_ADMIN_TOKEN` | **unset** | An admin / super_admin **Bearer JWT** for the backend's ops routes. Read from the environment, never minted here. Unset is not an error: the gate keeps the previous behaviour and logs `merchant_purchasability_not_configured` once |
| `PIVOTA_API_BASE` | `http://localhost:8080` | Existing. The backend origin the ops read is issued against |

Not dials, on purpose: the **2 s** per-call ceiling and the **5-minute** cache ceiling. Both are
`Math.min`, so a caller (or a future config read) can shorten them and can never widen them.

---

## 4. Auth — the one place this repo contradicted the contract

The backend runbook says to reuse "the same ops credential the gateway already uses for its
store-audit reads". **Surveyed against this repo on 2026-09-22, no such caller exists.**

* The gateway calls **no** backend `/ops/...` route at all. This is the first one.
* There is no admin JWT anywhere: no `ADMIN_JWT`-shaped env var in `src`, `env.example`,
  `.env.example`, `infra/`, `config/` or `.github/`; `jsonwebtoken` is not a dependency; every
  `jose` use is **verification**, not signing.
* The gateway's one admin rail is `src/server.js::fetchBackendAdmin`, which sends
  `X-ADMIN-KEY: ADMIN_API_KEY` to `/agent/internal/*`. The runbook names that header explicitly
  as the thing that will **401** on these routes, because they depend on `require_admin` and
  deliberately not on `require_admin_or_key`. A gateway reaching for it "will look like a routing
  problem".
* `src/services/cloudRunIdentityToken.js` is a Google OIDC ID token for Cloud Run's own IAM
  invoker check. It carries no Pivota role and no backend route accepts it.

So the credential is **read from the environment and never minted**: `PIVOTA_OPS_ADMIN_TOKEN`
travels as `Authorization: Bearer <token>`. If this repo ever grows a real ops-JWT caller, point
`createMerchantPurchasabilityClient({ token })` at it and delete the env read — the client holds
no credential logic beyond reading that string.

**Ops action before arming:** issue an admin / super_admin JWT from the backend and set
`PIVOTA_OPS_ADMIN_TOKEN` on the gateway service. The token is not rotated by this code; a
rotation is an env change and a redeploy.

---

## 5. The rules, and where each one lives

| rule | where |
|---|---|
| `GET /ops/merchant-purchasability?domain=&market=` | `buildFactUrl` — exactly two query values, asserted by a test that greps the wire for buyer-ish tokens |
| act on `tier` **only** when `enforced === true` | `decide()` |
| cache ≤ 5 min per (domain, market), bounded | `MAX_TTL_MS` + `createTtlCache({ maxEntries: 500 })` |
| **fail OPEN** on transport error / timeout / non-200 / malformed | every `catch` and every `return null` in `fetchFact` |
| log loudly on `sweep_enabled=false && enforced=true` | `noteMisorderedArming` — `error` level, once per 5 min per merchant |

> **`enforced` is not a nicety.** With the backend dial off, `is_purchasable` returns False for
> every merchant — because nothing is enforced, not because the merchant is browse-only — so the
> route answers `browse_only` for the whole catalogue. A consumer that read `tier` alone would
> take every merchant browse-only on the day the field shipped.

> **Failing open is not symmetry with the backend, it is the opposite of it, on purpose.** The
> backend's `is_purchasable` fails CLOSED on a database error; that is the guarantee. A second
> fail-closed layer in front of it does not add a second guarantee — it turns one backend blip
> into a catalogue-wide outage. One is the guarantee; two is an incident.

`offer: false` is reachable **only** from `source: 'gate'`: the backend answered 200, is
enforcing, and said `browse_only`. Every other path answers `offer: true` with
`source: 'disabled' | 'previous' | 'failed'`.

### PII

The outbound URL carries a merchant domain and a two-letter market and nothing else. No buyer, no
email, no address, no variant, no cart id, no session. The logs carry the same two plus the
decision. A mutant that adds a third query parameter is in the sweep, and it is killed.

---

## 6. Arming order — across BOTH repos

Steps 1–6 are the backend's (`pivota-backend docs/runbooks/merchant_purchasability.md` §9) and
are **not negotiable**; step 7 is this repo's.

1. **Deploy dark.** All three dials unset.
2. **Set the vantage first** — `MERCHANT_PURCHASABILITY_BUYER_VANTAGE` (and `VANTAGE_PROXY_URL`
   if that is not the worker's own egress), **before** either backend dial.
3. **`MERCHANT_PURCHASABILITY_SWEEP_ENABLED=1`, ON THE WORKER.** (The normal backend deploy does
   not ship the worker; setting it on the backend arms nothing.) Nothing is refused yet.
4. **Wait for one full pass** over the population — `ceil(population / 20)` hourly ticks at the
   defaults. `errors` is the only count that should page anyone.
5. **Verify coverage merchant by merchant** through
   `GET /ops/merchant-purchasability?domain=…&market=…`. Every merchant you expect to be
   purchasable must read `"tier": "purchase"`. Do not skip this.
6. **`MERCHANT_PURCHASABILITY_ENFORCE=1`** on the backend. Only now does a missing fact refuse.
7. **`MERCHANT_PURCHASABILITY_GATE_ENABLED=1`** on the gateway, with `PIVOTA_OPS_ADMIN_TOKEN`
   already set. Watch for `merchant_purchasability_browse_only` (the gate declining a merchant)
   and `merchant_purchasability_read_failed` (the gate failing open).

> **Arming these in the other order is the outage.** With `ENFORCE` on and no facts gathered,
> every merchant reads `browse_only`.
>
> Arming step 7 before step 6 is **safe but inert**: `enforced: false` keeps the previous
> behaviour and logs `merchant_purchasability_not_enforced` once per merchant per 5 minutes.
> That is a deliberately harmless ordering mistake, which is why the gateway switch can be
> armed whenever it is convenient once step 6 is done.

### Rolling back

**Flip `MERCHANT_PURCHASABILITY_GATE_ENABLED` off FIRST.** It is the narrowest switch: it stops
the gateway consulting the fact at all and restores the warm-handoff lane byte-for-byte, without
touching the Reap rail, the sweep, or any backend behaviour. It takes effect on the next call —
the flag is read per call, not cached at import — but it is an **env change on Cloud Run, so it
needs a new revision** (see §7).

If the problem is wider than the gateway, unset `MERCHANT_PURCHASABILITY_ENFORCE` on the backend
next: that stops every refusal everywhere, the ops route's `enforced` goes `false`, and this
gateway falls back on its own at the next cache miss (≤ 5 minutes) even if its own switch is
still on.

Leave `MERCHANT_PURCHASABILITY_SWEEP_ENABLED` alone. The sweep keeps the facts fresh, so
re-arming later needs no second wait. Unsetting only the sweep dial while `ENFORCE` stays on is
the misordered state — facts age out through the TTL and merchants silently become `browse_only`
one by one. This client logs that pair at `error` level for exactly that reason.

---

## 7. Deploying this — it does NOT happen on merge

**The PIVOTA-Agent gateway never deploys on merge.** Since the 2026-08-22 cutover, production is
GCP Cloud Run behind `gateway.pivota.cc`, built from `infra/gcp/cloudbuild.gateway.yaml` and
deployed by:

```bash
# run from the pivota-backend repo, which is where both scripts live
infra/gcp/deploy_gateway.sh prod <sha>
```

`pivota-agent-production.up.railway.app` is a retired standby; its auto-deploy trigger was
removed on 2026-08-25 and `production-deploy-promote.yml` no longer runs on push. Whether
production is actually running `main` is answered by `.github/workflows/gateway-prod-drift.yml`,
and the deployed commit is checkable with `npm run deploy:verify:production`. Source:
`docs/deployment.md` §"Production Deploy Policy".

**Merging this PR therefore changes nothing in production.** The code reaches prod only on a
manual `deploy_gateway.sh` run, and even then it is inert until step 7 of §6.

---

## 8. What is gated, and what is NOT

Gated: the **warm-handoff** purchase affordance for observed merchants, on both its lanes.

Not gated by this PR, and each for a reason:

* **The contracted-merchant kernel path.** Those merchants transact through Pivota's own PSP
  rail; the backend's fact population is the union of the two Reap allowlists at merchant grain,
  which is the observed cohort, so a fact about a contracted merchant would not exist to read.
* **The UCP escalation checkout** (`mcp-server/src/ucpCheckoutEscalation.js`). It already answers
  `status: "requires_escalation"` with `payment_handlers: {}` — it is a handoff, not a purchase
  Pivota offers, so there is nothing to withdraw.
* **The native-MCP `create_checkout_session` door.** No merchant domain and no market reach it;
  gating it needs the merchant identity threaded first, which is a separate change.
* **The Reap rail.** Gated in the backend, behind `MERCHANT_PURCHASABILITY_ENFORCE`.

---

## 9. Observability

| event | level | when |
|---|---|---|
| `ucp_warm_handoff_merchant_not_purchasable` | warn | the seam declined a handoff. Carries `brand_domain`, `market`, `source` |
| `merchant_purchasability_browse_only` | warn | the client's own record of the same decision, with the tier |
| `merchant_purchasability_read_failed` | warn | non-200 / timeout / throw / malformed. **Once per 5 min per (domain, market, failure)**. Failing OPEN |
| `merchant_purchasability_not_enforced` | info | backend reports `enforced: false`. Once per 5 min per merchant |
| `merchant_purchasability_misordered_arming` | **error** | `sweep_enabled: false` with `enforced: true`. The one to alert on |
| `merchant_purchasability_not_configured` | warn | the switch is on but the base URL or the token is missing. Once |
| `merchant_purchasability_unkeyable` | info | the request carried no usable domain or market, so nothing was asked |

The declined handoff is also counted on the existing warm-handoff outcome metric as
`outcome=fallback, reason=merchant_not_purchasable`. That label is **module-local** and
deliberately not a new `FAILURE_REASON` member: that enum is the H1 taxonomy shared with
`classifyUcpFailure` and the receipt vocabulary, and widening a shared vocabulary needs its own
measured no-change invariant.
