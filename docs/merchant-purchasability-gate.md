# The merchant-purchasability gate (gateway side)

`src/services/merchantPurchasabilityClient.js` (the client and the rule),
`src/services/ucpWarmHandoff.js` (seam 1), `src/services/checkoutHandoffResolver.js` and
`src/services/ucpWarmHandoffInternalRoute.js` (the two callers that supply that lane's market),
`mcp-server/src/ucpCheckoutEscalation.js` (seam 2), `src/offers/offersPriority.js` (seam 3, plus
`src/server.js` for the three call sites that supply its market),
`tests/merchant_purchasability_gate.node.test.cjs` and
`tests/merchant_purchasability_paths.node.test.cjs` (the pins).

**All three purchase-offering paths are now gated.** Path 3 has four annotate call sites: three in
`src/server.js` and a fourth inside `offersPriority.js` itself (`summarizeOfferCommerceMetadata`,
which `prioritizeOffersResolveResponse` calls).
One switch, one `shouldOfferPurchase`, one process singleton, one bounded cache. §8 is the table.

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

That function is **one of** the gateway's purchase-offering paths for an observed (crawled,
uncontracted) merchant — the one the flowerbeauty incident travelled: it builds a cart on the
merchant's own checkout and, with `UCP_INCHAT_PREVIEW_ENABLED` on, prices it in chat. It is not
the only one; §8 lists the others and why they are follow-ups rather than "not a purchase". Its two callers already treat a `null`
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
* `ucpWarmHandoffInternalRoute` reads an optional `body.market`.

> 🚨 **THE CLICK LANE IS INERT UNTIL THE BACKEND SENDS `market`, AND THAT IS THE LANE THE
> INCIDENT TRAVELLED.** The route's only caller is pivota-backend
> `services/outbound_warm_handoff.py`, which posts
> `{brand_domain, product_url, product_handle?, attribution?}` — **no market**. Every request on
> that lane therefore lands in `merchant_purchasability_unkeyable` and keeps the previous
> behaviour, however the dials are set.
>
> **`market` (ISO 3166-1 alpha-2) is a REQUIRED addition to that backend payload** before this
> gate protects the click lane. The gateway side of the contract is already in place and is
> pinned by a test; the backend change is tracked separately. Until it ships, the gate is armed
> only on the resolver lane, and the `unkeyable` line is emitted at **WARN** (once per 5 min per
> merchant) precisely so a mis-deployed or un-updated backend is visible in a log rather than
> silently un-gated.

**`metadata.market` is CALLER-SUPPLIED, and the door does not derive one.** Nothing in this lane
resolves a market from the request itself: the PDP resolve is market-free, `resolveBuyerMarketScope`
is a search-lane function on the other side of the executor, and no geo/IP inference happens
anywhere here. So **an agent that omits `market` opts out of the gate** — it keeps today's
behaviour and is logged, not refused. That is a deliberate consequence of never substituting a
default, and giving the door its own market resolution is a **separate follow-up**, not something
this PR does.

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
| `PIVOTA_OPS_OIDC_AUDIENCE` | **unset = OFF** | **THE PRODUCTION AUTH RAIL.** The audience for this service's Google Cloud Run identity token. Set it and the client asks the metadata server for an identity token and sends that instead of the static JWT. **Recommended value: the backend's canonical https origin, `https://api.pivota.cc`** — a bare origin, no path, no port, no trailing path segment. It must equal the backend's `OPS_GATEWAY_OIDC_AUDIENCE` byte for byte |
| `PIVOTA_OPS_ADMIN_TOKEN` | **unset** | An admin / super_admin **Bearer JWT** for the backend's ops routes. Read from the environment, never minted here. **Since the OIDC follow-up this is a DEV FALLBACK, not the production rail**: it is used only when no identity token could be obtained (no metadata server — i.e. local dev — or the audience env is unset). Unset is not an error: the gate keeps the previous behaviour and logs `merchant_purchasability_not_configured` once |
| `PIVOTA_API_BASE` | **unset in prod ⇒ no read** | Existing variable (`src/server.js` defaults it to `http://localhost:8080` for ITS own use; this client does no such thing — an unset base is treated as unconfigured, logged once, previous behaviour). The backend origin the ops read is issued against |

Not dials, on purpose: the **2 s** per-call ceiling, the **5-minute** cache ceiling and the
**300 ms** budget floor. The first two are `Math.min`, so a caller (or a future config read) can
shorten them and can never widen them.

**The gate is also clamped to the CALLER's remaining budget.** The click lane runs on a 2000 ms
total budget (`UCP_WARM_HANDOFF_CLICK_BUDGET_MS`) inside the backend's 2.5 s `asyncio.wait_for`.
Unclamped, a slow-but-not-dead backend would spend that whole budget in the gate and the cart it
is gating would never be built — fail-open in name, cold redirect in fact, for every merchant at
once. So `resolveWarmHandoff` passes `budgetMs = totalBudgetMs - elapsed`, the read is capped at
`min(timeoutMs, budgetMs)`, and below `MIN_GATE_BUDGET_MS` (300 ms) the gate is skipped entirely
(`source: 'skipped_budget'`, previous behaviour).

---

## 4. Auth — a Google identity token, with the standing JWT demoted to a dev fallback

### 4.1 What the client sends, in order

1. **`PIVOTA_OPS_OIDC_AUDIENCE` is set** → ask the Cloud Run metadata server for an identity
   token for that audience and send it as `Authorization: Bearer <id token>`.
   `GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=<aud>&format=full`
   with `Metadata-Flavor: Google`, a **1 s** ceiling, cached and refreshed **5 minutes before
   `exp`**. Concurrent reads collapse into one metadata call.
2. **No identity token came back** (no metadata server — local dev — a timeout, a non-200, an
   empty body) → fall back to `PIVOTA_OPS_ADMIN_TOKEN` if it is set, and log
   `merchant_purchasability_identity_unavailable` once per 5 minutes. On a deployed revision
   that line means an **arming mistake**, not local dev: a wrong audience, or the service
   account missing its role.
3. **Neither** → the existing "not configured" behaviour: `merchant_purchasability_not_configured`
   once, previous behaviour, nothing refused.

**Every step of that chain is inside the fail-open rule.** A token failure must never make the
gate refuse a purchase — the backend already fails closed, and a second fail-closed layer turns
one blip into a catalogue-wide outage. This is asserted, not promised: a browse_only fact waiting
behind an unreachable metadata server still resolves to `offer: true`.

The implementation reuses the repo's **existing owner** of Google identity tokens,
`src/services/cloudRunIdentityToken.js`, rather than growing a second metadata client. It adds
`createRefreshingCloudRunIdTokenProvider` there and leaves `createCloudRunIdTokenProvider`
byte-identical for its four existing store-audit callers — that one caches its in-flight promise
**forever**, which is survivable for a restarted batch worker and is not survivable for a serving
process that would then 401 an hour after boot.

### 4.2 ⚠️ THE AUDIENCE MUST MATCH THE BACKEND BYTE FOR BYTE

The backend compares `aud` to `OPS_GATEWAY_OIDC_AUDIENCE` with `!=` — a **string** compare, not a
URL compare. `https://api.pivota.cc/` is a different audience from `https://api.pivota.cc`, and
`http://` is a different audience again. A mismatch is a 401, a 401 **fails open**, and failing
open is silent: the gate disarms and every dial still reads "on".

Two things reduce the blast radius, and neither replaces getting it right:

* `cloudRunAudience()` **refuses** anything that is not a bare https origin (no path, no port, no
  query, no credentials) and normalises a single trailing slash to the origin, so what goes on
  the wire is the canonical spelling.
* A refused audience **disables the rail** rather than sending a token nobody will accept — it
  falls back to step 2 above and logs.

### 4.3 Why the standing admin JWT was demoted

Say it plainly, because it will not announce itself:

* **It was over-scoped.** An `admin` / `super_admin` JWT is a role, not a capability for one
  read-only route. A gateway that only ever needs `GET /ops/merchant-purchasability` was holding
  a credential that opens every admin route the backend has.
* **It expired silently, and the failure was invisible.** When the JWT lapses the backend answers
  **401**, which this client — correctly, per the fail-open rule — treats as "no fact" and keeps
  the previous behaviour. So an expired token did not break anything loudly; it **disarmed the
  gate permanently** while every dial still read "on". The only evidence is
  `merchant_purchasability_read_failed` with `failure: status_401`, once per 5 minutes.
  **Alert on that line specifically**, and treat a sustained `status_401` as "the gate is off" —
  this is still true of the identity rail, for a wrong audience or a missing IAM binding.

The identity token removes all three: audience-scoped rather than role-scoped, rotated hourly by
the metadata server, never stored in an env var, accepted by exactly one backend route.

### 4.4 The backend side of the contract

`pivota-backend` `utils/gateway_oidc_auth.py::require_admin_or_gateway_identity`, used on
`GET /ops/merchant-purchasability` **and no other route**. It runs `require_admin` first and
unchanged, then — and only when **both** of its envs are set — verifies the bearer as a Google ID
token requiring all of: RS256 against Google's certs, `iss ∈ {accounts.google.com,
https://accounts.google.com}`, `aud == OPS_GATEWAY_OIDC_AUDIENCE`, `email_verified === true`,
`email ∈ OPS_GATEWAY_SERVICE_ACCOUNTS`, and `exp`/`iat` within a 10 s skew. Any failure is the
**same 401 body** a bad admin JWT gets, so nothing about this path is discoverable from a
response.

**`X-ADMIN-KEY` is still refused**, here and on every other ops route. Nothing about this change
widens `require_admin_or_key` to anything.

**The backend's app-level check is the only guarantee**, because prod `web` is deployed
`--allow-unauthenticated`: Cloud Run IAM does not stand in front of this route.

### 4.5 Ops actions

| where | variable | value |
|---|---|---|
| backend `web` | `OPS_GATEWAY_OIDC_AUDIENCE` | `https://api.pivota.cc` |
| backend `web` | `OPS_GATEWAY_SERVICE_ACCOUNTS` | the gateway's runtime SA — `sa-gateway@pivota-prod.iam.gserviceaccount.com` per `pivota-backend infra/gcp/deploy_gateway.sh` (`--service-account "sa-gateway@$PROJECT.iam.gserviceaccount.com"`, `PROJECT=pivota-prod`). Confirm against the live revision with `gcloud run services describe gateway --project pivota-prod --region us-west1 --format='value(spec.template.spec.serviceAccountName)'` |
| gateway | `PIVOTA_OPS_OIDC_AUDIENCE` | the **same string**, `https://api.pivota.cc` |
| gateway | `PIVOTA_OPS_ADMIN_TOKEN` | keep only as a dev fallback; it may be unset in prod once the rail is confirmed |

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
7. **AUTH, BACKEND FIRST.** Set `OPS_GATEWAY_OIDC_AUDIENCE=https://api.pivota.cc` **and**
   `OPS_GATEWAY_SERVICE_ACCOUNTS=sa-gateway@pivota-prod.iam.gserviceaccount.com` on the backend
   `web` service. Both, or neither: the backend treats either one alone as DISABLED. Nothing
   changes for any existing caller — `require_admin` still runs first and unchanged.
8. **THEN the gateway audience.** Set `PIVOTA_OPS_OIDC_AUDIENCE` to the **same string**. Keep
   `PIVOTA_OPS_ADMIN_TOKEN` set through the switch-over as the fallback; unset it afterwards once
   the identity rail is confirmed.
9. **`MERCHANT_PURCHASABILITY_GATE_ENABLED=1`** on the gateway. Watch for `merchant_purchasability_browse_only` (the gate declining a merchant),
   `merchant_purchasability_read_failed` (the gate failing open) and
   `merchant_purchasability_unkeyable` (a caller sending no market — on the click lane that is
   expected until the backend payload change of §2 ships, and it means the gate is inert there).
   All of these reach the shared structured logger on the production construction path.

> **Arming these in the other order is the outage.** With `ENFORCE` on and no facts gathered,
> every merchant reads `browse_only`.
>
> **Steps 7 and 8 are ordered, and the order is backend-then-gateway.** Setting the gateway
> audience first means the gateway sends an identity token to a backend that does not yet accept
> one: every read 401s, and because the gate FAILS OPEN that is completely silent — the gate is
> disarmed and every dial reads "on". Backend first means the worst case is a backend that
> accepts a token nobody is sending yet, which changes nothing. **The two audience strings must
> match byte for byte** (§4.2); this is the single most likely arming mistake and it has no
> symptom other than `merchant_purchasability_read_failed / status_401`.
>
> Steps 7–8 are also safe to do **before** step 6, and before step 9: while
> `PIVOTA_OPS_ADMIN_TOKEN` is still set, the rail switch-over is observable (the backend's
> `utils.gateway_oidc_auth` debug line names the accepted service account) with nothing riding
> on it.
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

### Then, the Reap agentic lane (WP5) — its own switch, armed after the steps above

The UCP door's Reap lane (`mcp-server/src/ucpReapAgenticLane.js`, `docs/reap-agentic-lane.md`)
consults this gate exactly as path 2 does — same switch, same client, same fail-open rule, same
market source — before it opens a purchase. Its own arming, continuing the order above:

10. **Backend**: `REAP_AGENTIC_ENABLED=1` **and** Reap **production** credentials, **and** the
    `reap_agentic_eligibility` rows for the first merchants × markets (pivota-backend
    `docs/runbooks/reap_agentic_purchase.md`, "Before arming"). With `ENFORCE` on (step 6) those
    merchants also need a fresh `purchase` fact, or the backend refuses `merchant_not_purchasable`
    (which the door treats as a fall-through, not an error).
11. **Deploy the gateway** — manually, as §7 says: `infra/gcp/deploy_gateway.sh prod <sha>` from the
    pivota-backend repo, then `npm run deploy:verify:production`. It never deploys on merge.
12. **`REAP_AGENTIC_LANE_ENABLED=1`** on the gateway. Only now does an eligible UCP
    `create_checkout` open a Reap purchase; until then the door is byte-identical.

Either half alone is inert — the backend on with the gateway switch off opens nothing, and the
gateway switch on in front of a dark rail gets 404 `not_available_on_this_rail` on every POST and
falls through — so the order is about the FIRST eligible create: backend first means it transacts
the moment the gateway switch flips, instead of silently falling through while someone wonders why.
Confirm Minds sends `checkout.buyer.consent_version` before step 12, or every eligible create is
refused `reap_consent_required`. **Rolling back**: unset `REAP_AGENTIC_LANE_ENABLED`
first; it is the narrowest switch and touches nothing on the backend.

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

Gated: **all three** of this gateway's purchase-offering paths for observed merchants. All three run
behind `MERCHANT_PURCHASABILITY_GATE_ENABLED` and through the same `shouldOfferPurchase`, so there is
one cache, one `enforced` rule and one fail-open rule for the whole gateway.

| # | path | what it offers | market source | fallback when `offer === false` |
|---|---|---|---|---|
| 1 | `src/services/ucpWarmHandoff.js::resolveWarmHandoff` | a pre-built cart on the merchant's own checkout, priced in chat | `metadata.market \|\| payload.market` (resolver lane); `body.market` (click lane — still absent from the backend payload, §2) | the pre-existing `null` = cold redirect; `outcome=fallback, reason=merchant_not_purchasable` |
| 2 | `mcp-server/src/ucpCheckoutEscalation.js::tryEscalateUcpCheckout` | a UCP `requires_escalation` checkout whose `continue_url` is the merchant's storefront | `ucpArgs.checkout.context.address_country` — the RAW UCP wire body, ISO-2 | the pre-existing `null` = "not an escalation cart", i.e. the kernel path this door already takes for any row not eligible for a `continue_url` |
| 3 | `src/offers/offersPriority.js::enrichOfferCommerceMetadata` | `merchant_checkout_url` on every served offer | `payload.search.market \|\| payload.market \|\| metadata.market` (`offersGateBuyerMarket`, which lives in `offersPriority.js` so a test can reach it) at **all four** `src/server.js` annotate call sites | the key is **DELETED on a declined decision, whichever pass stamped it** — and every other field carrying that merchant's checkout URL goes with it. The OFFER SURVIVES with `commerce_mode`, `checkout_handoff`, its price and its PDP/browse links unchanged |

Nothing else about any response moves. No new ucpTool name, no new canonical op, no new failure
reason: the only difference a declined merchant produces is a URL that is not there.

### Path 2 — the escalation door, and the claim this PR had to correct

The previous revision of this document said the escalation module could not be gated because "no
market reaches that module (`QUOTE_KEYS` has no market field and `mapQuote` drops
`checkout.context`)". **That is true of `params` and false of the module.**
`commerceToolSurface.callTool` hands `tryEscalateUcpCheckout` BOTH `params` (post-allowlist — the
quote really does carry no market) **and `ucpArgs`, the raw UCP wire body**, which carries
`checkout.context.address_country` — the field this repo's own UCP tool descriptions call "buyer
market, ISO 3166-1 alpha-2". So the request's own market was one argument away the whole time.

`quote.shipping_address.country` is also in scope and is **deliberately not read**: it is a field of
a buyer's postal address, and no buyer data may key the ops query or appear in a log. `checkout.context`
is a destination HINT that is forwarded into nothing, which is why it is safe to key on.

The seam is the two lines where `continueUrl` is resolved, **before `buildEscalationCheckout` is
called at all** — the URL is never built into a response that is then edited. The `get_checkout_session`
branch is gated identically and is **inert in practice**: the UCP `get_checkout` body carries no
`checkout.context`, so that lane is always `unkeyable`. It is gated anyway so the asymmetry is not a
hole somebody re-opens when that body gains a market.

**The gate is budgeted here too.** It is a BLOCKING read on the checkout critical path, so it is
clamped to what is left of the door's own `timeoutMs`, capped again at `ESCALATION_GATE_MAX_MS`
(800 ms), and below the client's 300 ms floor it is skipped outright (`source: 'skipped_budget'`,
previous behaviour). The first cut passed no budget at all and ran on the client's 1500 ms default.

`AGENT_CHECKOUT_UCP_ESCALATION_ENABLED` is still off by default, so this path remains dark either way.

### Path 3 — the offer stamp: four call sites, a delete, and a real deadline

**There are four annotate call sites, not two — three in `src/server.js` and one inside
`offersPriority.js` itself (`summarizeOfferCommerceMetadata`) — and the one that matters is the
innermost server-side pass.**
`buildOffersFromGroupMembers` (`src/server.js:11066`) annotates first, and **both** downstream sites
— `buildProductIntelOffersDataForContext` and the PDP offers module — re-annotate *that* output.
A conditional spread can only ADD a key, so `...offer` faithfully re-emitted whatever the first,
ungated pass had stamped: gating only the outer two was a **measured no-op on both serving lanes**.
All four are now gated, and:

> **The suppression DELETES the key, it does not decline to add it.** That is what makes the
> decision hold whichever pass stamped it, and it makes suppression idempotent, so the order of the
> passes stops mattering.

**And withholding one key is not withholding the checkout.** The same storefront cart URL is served
under `external_redirect_url`, `url`, `action.url`, `checkout_url` and inside
`merchant_checkout_session` — `offerDedupeKey` reads five spellings for exactly that reason. For a
declined merchant, **every field anywhere in the offer** whose value is that merchant's *checkout*
URL is removed (compared as `offerDedupeKey` compares: host, no query/fragment, no trailing slash;
matching a `/cart`-or-`/checkout`-shaped path on that host, or the exact URL that would have been
stamped when that URL is itself checkout-shaped). **PDP and browse links stay** — a redirect offer
whose only URL is the product page keeps it, because that link *is* the fallback.

**A URL is not the only thing that says "buyable here".** A declined merchant loses the whole claim:
`internal_checkout`, `merchant_checkout_session` and `checkout_session` are removed,
`purchase_route` becomes `affiliate_outbound`, `checkout_handoff` becomes `redirect`, and
`commerce_mode` is computed **after** the strip (`links_out`). All three are the repo's existing
links-out vocabulary — `isCurrentPolicyDirect` refuses each of them, `inferStructuredDataMode` maps
the mode to `product_snippet`, and `offerIsInternalCheckoutCandidate` (which `src/server.js`
`compareOffersForDefaultSelection` ranks on) reads the route, so a declined offer can no longer be
promoted to `default_offer_id`. Computing the mode BEFORE the strip — what the first cut did, then
froze with a flag — reads the very signals the strip removes and answers
`merchant_embedded_checkout` for a merchant we have just declined to sell for. There is no label to
freeze now: `purchase_route` makes the row externally-routed, so a later pass recomputes the same
values and suppression stays idempotent.

**The URL matcher recognises the shapes that actually occur.** Anchoring a cart/checkout path at the
start of the path missed `https://merchant.com/12345678/checkouts/abcdef` (classic Shopify, shop-id
prefixed) and `https://merchant.com/en-gb/cart/12345:1` (locale-prefixed), both of which survived
verbatim. An optional locale segment and an optional numeric shop segment are allowed, and the
byte-equal-to-the-stamped-URL arm is no longer gated on the shape being recognised — it switched
itself off in exactly the case the shape arm had already missed.

**The batch is bounded four ways**, all asserted:

1. **Dedupe.** N offers for one merchant × market are ONE question, plus the client's ≤5-minute cache.
2. **Concurrency.** At most `GATE_CONCURRENCY` (4) reads in flight.
3. **A start-gate floor.** Each read is clamped to what is left of `GATE_BATCH_BUDGET_MS` (1200 ms);
   below the client's `MIN_GATE_BUDGET_MS` (300 ms) the rest of the page is not asked at all.
4. **A REAL DEADLINE.** A budget checked only *between* reads bounds how many reads are STARTED, not
   how long the batch TAKES — measured on the first cut at **5003 ms for a "1200 ms budget"** with 12
   merchants and one 5 s read. The whole batch now races a timer; a result that lands after it is
   **discarded** and that merchant keeps the previous behaviour.

**And the client's credential step now runs INSIDE the caller's deadline.** `fetchFact` used to
`await resolveCredential()` *before* arming its `AbortController`, so the metadata server's own 1 s
ceiling sat outside both `timeoutMs` and `budgetMs`: a caller handing the gate 300 ms could still
wait 1300 ms. The controller is armed first and the credential wait is raced against it. This
tightens the warm-handoff lane too, and is pinned by its own test.

### Not gated, and genuinely out of scope

* **The contracted-merchant kernel path.** Those merchants transact through Pivota's own PSP
  rail; the backend's fact population is the union of the two Reap allowlists at merchant grain —
  the observed cohort — so a fact about a contracted merchant would not exist to read.
* **The native-MCP `create_checkout_session` door.** No merchant domain and no market reach it;
  gating it needs the merchant identity threaded first.
* **The Reap rail.** Gated in the backend, behind `MERCHANT_PURCHASABILITY_ENFORCE`.

## 9. Observability

| event | level | when |
|---|---|---|
| `ucp_warm_handoff_merchant_not_purchasable` | warn | the seam declined a handoff. Carries `brand_domain`, `market`, `source` |
| `merchant_purchasability_browse_only` | warn | the client's own record of the same decision, with the tier |
| `merchant_purchasability_read_failed` | warn | non-200 / timeout / throw / malformed. **Once per 5 min per (domain, market, failure)**. Failing OPEN |
| `merchant_purchasability_not_enforced` | info | backend reports `enforced: false`. Once per 5 min per merchant |
| `merchant_purchasability_misordered_arming` | **error** | `sweep_enabled: false` with `enforced: true`. The one to alert on |
| `merchant_purchasability_not_configured` | warn | the switch is on but the base URL or **every** credential rail is missing. Once |
| `merchant_purchasability_identity_unavailable` | warn | `PIVOTA_OPS_OIDC_AUDIENCE` is set but the metadata server did not answer with an identity. **On a deployed revision this is an arming mistake** (wrong audience, or the SA lacks its role); off GCP it is local dev. Falling back to the static JWT. Once per 5 min |
| `merchant_purchasability_unkeyable` | **warn** | the request carried no usable domain or market, so nothing was asked. **This is what a mis-deployed caller looks like** — see §2 on the click lane. Once per 5 min per merchant |
| `merchant_purchasability_skipped_budget` | info | too little of the caller's wall-clock budget was left to ask (< 300 ms). Previous behaviour |

> **These events reach a log on the production shape, and that had to be fixed to be true.** The
> first cut discarded the logger on the path both production construction sites take
> (`checkoutHandoffResolver.js` and `ucpWarmHandoffInternalRoute.js`, the latter passing
> `logger: deps.logger || null`), so the client was built with `logger: null` and none of the
> table above was emitted anywhere — including the `error`-level alarm. The client now defaults
> to the shared module logger when no `logger` key is supplied, and a test constructs it exactly
> as both prod sites do and asserts the alarm fires.
>
> **No log line on any path carries the credential.** The outbound-URL test greps the wire only,
> which a `token:` field added to a log would pass; a separate test captures every log call
> across the whole success/failure matrix and asserts no `Authorization`, bearer, JWT-shaped or
> `token`-named value appears.

**Paths 2 and 3 add no event of their own.** Everything they produce is the client's own table above —
`merchant_purchasability_browse_only` when a merchant is declined, `merchant_purchasability_unkeyable`
when a request carries no market (the normal state of the escalation `get_checkout` lane and of any
offers request without one), `merchant_purchasability_read_failed` when the gate fails open. A
declined offer is observable as a served offer with no `merchant_checkout_url`; a declined escalation
is observable as a cart that took the kernel path. Adding a per-path event would have meant a second
vocabulary for one decision.

The declined handoff is also counted on the existing warm-handoff outcome metric as
`outcome=fallback, reason=merchant_not_purchasable`. That label is **module-local** and
deliberately not a new `FAILURE_REASON` member: that enum is the H1 taxonomy shared with
`classifyUcpFailure` and the receipt vocabulary, and widening a shared vocabulary needs its own
measured no-change invariant.
