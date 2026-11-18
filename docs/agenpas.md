# AgenPas: the buyer's own checkout pages

AgenPas (working name) is Pivota's buyer-facing checkout page. A partner chat app hands the buyer an AgenPas link;
the buyer reviews the purchase on our page, adds a card and approves the purchase on the payment partner's own
hosted pages, and watches the order get placed. The card number is typed only on the payment partner's page: our
pages have no card fields anywhere, and Pivota never sees the card.

Underneath, the backend runs the purchase state machine on the A2A payment rail, and (behind
`AGENPAS_RAILS` + `AGENPAS_CONSENT_ENABLED`, both off by default) on the Reap rail
(pivota-backend `docs/agent_purchases_routes.md`). The gateway reads the purchase and shows it, and, while consent is
on, records the buyer's acceptance of Pivota's terms through one internal write (see "Terms and privacy consent").

Code: `src/agenpas/` (routes, link tokens, view projection, reader, dev fixtures, page assets). It is mounted
in `src/server.js` with a few lines, and `start_purchase` and `get_order` (`mcp-server/src/commerceToolSurface.js`)
add the link.

## Flags and environment

All read per request; no restart needed.

| Variable | Default | Meaning |
|---|---|---|
| `AGENPAS_ENABLED` | off | Off: every `/agenpas` path falls through to the app's normal not-found (byte-identical to before), and `start_purchase`, `get_order` and both tool descriptions are exactly as before. |
| `AGENPAS_LINK_SECRET` | none | HMAC-SHA256 key for link tokens, at least 32 characters. Missing or short: no link is minted and every link is refused (the page says AgenPas is unavailable). |
| `AGENPAS_LINK_TTL_SECONDS` | 1800 | Link lifetime. Clamped to 60..1800 (30 min is a hard maximum, also enforced on verify). |
| `AGENPAS_PUBLIC_BASE_URL` | none | The https origin minted links point at, and the ONLY host the AgenPas routes answer on. None: no link is minted and no route is served. It is also the token's audience (`aud`). `http://localhost` is accepted only while the dev fixtures are actually enabled. **The host is exclusive** (while `AGENPAS_ENABLED` is on): on it (matched by host NAME, so any port, a trailing dot and any case count; only the `Host` header decides, `X-Forwarded-Host` is ignored), every request answers 404 (`X-Agenpas-Guard: front`) unless it is a GET/HEAD of exactly one AgenPas route shape (or, only while `AGENPAS_CONSENT_ENABLED` is on, a POST of exactly `/agenpas/api/p/<id>/consent`; OPTIONS is always refused, so no preflight is ever answered): `/agenpas/p/<id>` (any id of plain characters `[A-Za-z0-9_-]`, so a malformed one gets the friendly "isn't valid" page), `/agenpas/api/p/<id>`, `/agenpas/assets/app.js|app.css` (and `/agenpas/dev/start` with the fixtures armed on a loopback Host). The shape is matched on the RAW request path, and any path containing `%`, `..`, `\` or `//` is refused, so no decoder downstream can resolve it elsewhere. This runs ahead of every other gateway middleware and route (the internal UI, `/health`, the APIs, `/mcp`); the internal UI's static handler also skips the host, and an admitted path the AgenPas router does not serve gets `X-Agenpas-Guard: back`. The routes themselves answer only on the exact origin (its port included). So no other gateway page shares the origin where the buyer's link token is kept. Give it a host name of its own (a dedicated origin): a host that also serves other gateway traffic would lose that traffic. Other hosts are unaffected. |
| `AGENPAS_INTERNAL_READ_KEY` | none | The dedicated key the gateway presents (`X-Internal-Key`) on the backend's internal buyer read. None: every read is unavailable. |
| `AGENPAS_HOSTED_HOSTS` | empty | Comma-separated exact host names the payment partner serves its hosted pages from. Empty refuses every hosted URL (the page shows no button, only "Getting the secure page ready"). |
| `AGENPAS_EMBED_HOSTED_PAGES` | off | Off: hosted pages open in a popup or a new tab. On: the page frames them (see below). |
| `AGENPAS_CONSENT_ENABLED` | off | On: the card and approval screens can take the buyer's acceptance of Pivota's Terms of Service and Privacy Policy (`POST /agenpas/api/p/<id>/consent`), the API view gains a `consent` member, and `start_purchase` / `get_order` (and, with the Reap rail served, UCP `create_checkout`) each gain one sentence. Off: that route does not exist (the host guard refuses it exactly as before), the view has exactly its old members, and every description is byte-identical. See "Terms and privacy consent". |
| `AGENPAS_INTERNAL_CONSENT_KEY` | none | The dedicated key (`X-Internal-Key`, at least 32 characters) the gateway presents on the backend's internal consent write. Separate from `AGENPAS_INTERNAL_READ_KEY`, which stays read-only. Missing or short: every consent write is unavailable (503; nothing recorded). |
| `AGENPAS_LEGAL_HOSTS` | `pivota.cc` | Comma-separated exact host names the terms and privacy links may point at (https, default port, no user-info, exact host, the same check as hosted pages). A link anywhere else drops the offer: "not available right now". |
| `AGENPAS_RAILS` | `a2a` | Comma-separated rails links are minted for (`start_purchase`, `get_order`). `reap` is honoured ONLY while `AGENPAS_CONSENT_ENABLED` is on: that is enforced in code (`config.rails`), so a Reap buyer can always accept the terms on our page first. A value that leaves no servable rail (a typo, or `reap` alone with consent off) falls back to `a2a`, with one warning per value (`agenpas_config` / `rails_fallback`): a2a is never dropped silently, only by a list naming another servable rail. |
| `AGENPAS_DEV_FIXTURES` | off | Local development only: canned purchases instead of the backend. It cannot arm on a managed platform (`K_SERVICE`, `K_REVISION`, `RAILWAY_*`, ...) or in a production environment (`src/config/platform.js`), whatever its value, and it serves only requests whose Host is loopback (`127.0.0.1`, `::1`, `localhost`). |

The backend read also uses `PIVOTA_API_BASE`, through the private backend hop.

## Abuse valves (the API)

Process-local, like the public read tier's limiter:

- a token bucket per client IP (30, refilling 5/s; looser because buyers share carrier NAT addresses), checked
  before any token work, and one per link token (10, refilling 2/s; a page polls every 2..15 s). Over either: 429
  `rate_limited` with `Retry-After`;
- a single-flight read with a 2 s cache per (agent id, purchase id): however many pages poll one purchase, the
  backend sees at most one read per 2 s (unavailable answers are cached too, so an outage is not amplified);
- refusal logs are sampled: the first 5 per reason per minute, then one line with the count not logged.

## Routes

| Route | What |
|---|---|
| `GET /agenpas/p/:purchaseId#t=<token>` | The page (HTML shell). The token is in the fragment, which the server never receives: the shell is the same for every well-formed id, and the page shows the expired / invalid screen from the API's 410 / 404. A malformed id: friendly 404 page. No secret configured: friendly 503 page. |
| `GET /agenpas/api/p/:purchaseId` | JSON for the page. Token ONLY in the `X-Agenpas-Link` header (a `?t=` query is ignored). 200 view, 404 `link_invalid` / `not_found`, 410 `link_expired`, 503 `unavailable` with `Retry-After`. |
| `GET /agenpas/assets/app.js`, `app.css` | The page's script and style, same origin. |
| `GET /agenpas/dev/start?scenario=<name>` | Dev fixtures only: mints a fixture link and redirects to it. |
| `POST /agenpas/api/p/:purchaseId/consent` | Only while `AGENPAS_CONSENT_ENABLED` is on (off: the front guard's 404, as before). The buyer accepted the terms for the current step. See "Terms and privacy consent" for its checks and answers. |

The page: `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, no inline script or style, no external
CDN or third-party script, `frame-ancestors 'none'`, `frame-src 'none'` (or the allowlisted hosts in embed mode),
`form-action 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

## The flow

1. The agent calls `start_purchase`. With AgenPas on, the answer for a purchase on a rail AgenPas serves (`AGENPAS_RAILS`:
   A2A by default; Reap only with consent on) carries an additive `agenpas_url`
   (`<base>/agenpas/p/<order_id>#t=<token>`), minted for the purchase it answers and for the verified caller (agent
   id and user ref from the server-side request context, never from tool arguments). The agent gives the link to the
   buyer. Every native `get_order` of an A2A-rail purchase (an `ap_` rail id) also carries a FRESHLY minted
   `agenpas_url`, the same way, so a buyer whose link expired can be given a new one. While links are minted (flag,
   secret and base URL all set), the `start_purchase` and `get_order` tool descriptions each gain one sentence
   saying so; otherwise they are byte-identical to before.
2. The buyer opens it. The page reads the token from `location.hash`, keeps it in memory (and in this tab's
   `sessionStorage`, so returning from a hosted page that replaced the tab still works), clears the fragment with
   `history.replaceState`, and sends the token only in the `X-Agenpas-Link` header. It polls `/agenpas/api/p/:id` at the backend's `poll_after_seconds` (clamped to
   2..15 s), backs off on errors (2, 4, 8, 15 s), and stops when the purchase is final or the link has expired. It
   polls at once when the buyer comes back to the tab or closes the popup.
3. Screens, from the unified state:

| State | Screen |
|---|---|
| `routing` | Getting your order ready |
| `needs_payment_method` (+ `card_binding` page) | Add a card: "Your card is added on our payment partner's secure page. Pivota never sees your card number." Then "Waiting for your card…" |
| `locking` | Confirming your total (the merchant prices the exact cart; nothing is approved yet) |
| `awaiting_buyer_authorization` (+ `approval` page) | "Approve $X at merchant with Face ID or fingerprint", then "Waiting for your approval…" |
| `placing` | "Placing your order at merchant…" (or "Confirm with your bank" while a bank check page is offered) |
| a card / approval step that is consent GATED and not satisfied, with nothing the buyer can accept here | "This step isn't available right now" (screen `unavailable`; polling goes on). Never a dead approve screen. See "Terms and privacy consent". |
| not final, the rail paused for contact details (Reap `contact_reentry_required: true`) | "Some details are needed — go back to the chat" (screen `details_needed`): no card button, no consent, polling goes on. A held code still wins. |
| ANY state not yet final with a hold / outcome-unknown code | "We're checking with the store — don't try again. This can take a while…" (polling goes on). No buyer step is offered at all, even if the rail still lists one (a held row can still be in `awaiting_buyer_authorization`). Before `placing` only an EXPLICIT HELD code does this: the backend's read-retry codes (`vic_status:unrecognised`, `paid_sent:<n>:await:await_answer_unrecognised`, `vic_quote:unrecognised:<n>`) have the hold shape but keep the buyer's step; the shape fallback applies from `placing` on and in final states. |
| a state not yet final (other than `placing`), with a parked code and no buyer step | "Getting things ready…" (polling goes on). In `placing` a parked code gets the checking wording above: a confirm may already have gone out. |
| `completed` | Order placed: order number, total charged, store, link to the store's order page when it is on the store's domain |
| `failed` / `refused` / `expired` | Plain-language reason from the backend's codes (never the code or any raw text). An unknown code gets neutral wording: no "try again" on `failed` / `refused`; `expired` keeps "start again from the chat" (the backend expires only pre-pay rows with no pending write and no money result). |
| outcome-unknown or hold code | "We're checking with the store — don't try again." No retry is ever suggested. |

Codes are read segment by segment (mirroring pivota-backend 732733b93: its 23 `_CHECKOUT_HOLD_CODES`, 7 `_VIC_HOLD_CODES` and `money_result_seen` are the explicit HELD list): the backend writes compound codes
(`paid_sent:<n>:<variant>:<code>`, `bound_sent:<n>:<code>`, `checkout_card_unavailable:<why>`,
`checkout_setup_refused:<kind>:<status>`, `checkout_confirm_refused:http_error:422`), so each is lower-cased and split
on `:`, and every segment is checked; a suffixed code matches on its head segment. The step prefixes (`paid_sent`,
`bound_sent`) are bookkeeping and are skipped: `paid` is the approval-page step (the rail mints a token, nothing is
charged). **The rule is HELD > FAILED** (since 2e3500a89; the subject of the earlier 0ff3a4bfe says
"FAILED > HELD", which is NOT the rule). Precedence, highest first, across every code on the purchase (`refusal_reason` and `last_error_code`
alike): an explicit HELD code (the backend's `_CHECKOUT_HOLD_CODES`, `_VIC_HOLD_CODES` and `money_result_seen`) gives
"We're checking with the store — don't try again" (in `placing` too, where polling goes on): if anything says money
may have moved, the page never says "no order was sent"; then an explicit FAILED code (terminal, nothing was
submitted: `checkout_relay_refused`, `checkout_setup_unrecognised`, `checkout_confirm_refused`, ...) gives "no order
was sent to the store"; then the other named lists (declined, approval
timed out, card, price, the rail's refusals `checkout_currency_unsupported` / `checkout_ceiling_*`, ...); then a
hold-shaped heuristic for new codes; then neutral generic wording. Explicit lists always beat the heuristic. A PARKED
code (`checkout_step_disabled`, `checkout_schema_incomplete`) on a purchase that is not final shows "Getting things
ready…" while polling goes on. Pre-store terminal failures whose names look like holds (`binding_answer_unrecognised`,
`approval_answer_unrecognised`, `token_answer_unrecognised`, `token_mismatch`, `vic_quote_unrecognised`,
`vic_quote_currency_mismatch`, `vic_order_unresolved`) are on the FAILED list. `operator_confirmed_not_charged` (an operator ended a held checkout after checking the provider's side: no order,
no charge) is FAILED with its own wording, "This purchase didn't go through and you weren't charged. You can start
again from the chat.": the only code whose wording says the buyer was not charged, and only when no other code on the purchase is held or
even hold-shaped (otherwise the checking wording); HELD still beats it. An operator resolution usually lands long after
the link's 30-minute lifetime, so the buyer learns the outcome through the fresh link a `get_order` in the chat
returns. A completed purchase always carries its
verified final total; only two disagreeing (or a non-ISO, e.g. lower-case,)
currencies hide it ("see your email receipt").

**The Reap rail's codes** (pivota-backend `services/reap_agentic_purchase.py`, enumerated from its code, not from
memory):

- HELD (the checking wording, in every state, never "no order was sent"): `checkout_unresolvable` (the head of
  `checkout_unresolvable:<n>:<why>`, including `:operator_found_completed`), `checkout_dispatch_unresolved`,
  `checkout_created_hosted_url_refused`. `checkout_read_permanent:<n>:<why>` (one permanent-shaped read failure, below
  the backend's limit of 3, after which it is `checkout_unresolvable`) is HELD from `placing` on and in final states;
  before placing it keeps the buyer's step, as the UCP lane keeps the hosted page for it. The hold shape also matches
  `unresolvab`, and any `reap_*` code the lists do not name (`reap_status_500`, ...) reads as a hold from `placing` on.
- PROGRESS (`REAP_PROGRESS_CODES`, the state's own wording, never the checking copy; a HELD code beside one still wins):
  `reap_status_503`, `checkout_read_failed`, `transport_error` (`transport_error:<Type>`). Each is written only by a READ
  (the checkout poll's GET) or by a quote / enrollment call, which moves no money; the checkout create never writes
  them (pivota-backend 0b2749d28; the sources are in `src/agenpas/view.js`). `checkout_read_recovered` is NOT on the
  list: it is also written on a row whose create answer was lost and that an operator attached.
- FAILED ("no order was sent"), ONLY the codes written before any Reap checkout exists: `enrollment_no_hosted_action`,
  `enrollment_id_conflict`, `enrollment_row_unreadable`, `enrollment_not_activatable`, `enrollment_dead`,
  `enrollment_create_failed`, `enrollment_read_failed`, `no_active_enrollment`, `enrollment_not_active` (Reap's
  `ENROLLMENT_NOT_ACTIVE` refusal of the checkout create, which creates nothing), `quote_id_missing`.
- Post-checkout, the state's generic wording (never "no order was sent", never the card wording, and they keep a FAILED
  code beside them from saying it either): `checkout_failed`, `checkout_expired`, `checkout_id_missing`,
  `partner_id_malformed`. `approval_window_lapsed` is "The approval didn't go through in time, so the order wasn't
  placed. You can start again from the chat." (it does not claim the buyer failed to approve: the backend's code is a
  best reading), and it also keeps FAILED away.
- `buyer_email_missing` (resolving -> failed): "some details were missing".
- The codes the Reap worker releases on a live row before placing (`enrollment_settling`, `enrollment_pending`,
  `quote_expired`, `checkout_quote_replayed`, transport codes, ...) leave the buyer's step alone; any other partner code
  on a final row gets the neutral generic wording, except an unlisted `reap_*` one (the checking wording).

The summary card shows the product, variant, quantity, store and price, and "You'll approve up to <quoted total>"
once the backend has a quoted total, with the line that the final total includes shipping and tax and cannot exceed
what the buyer approves.

## Terms and privacy consent

Reap's production rule: the buyer sees Pivota's Terms of Service AND Privacy Policy, and accepts them, before a card is
stored and again before every approval, and the acceptance is recorded in our system. AgenPas takes it, for both
rails, behind `AGENPAS_CONSENT_ENABLED` (off). The backend decides whether a step needs it, which versions are current,
and records it (pivota-backend `AGENPAS_CONSENT_GATE`, its own dial).

**The gate.** A card (`card_binding`) or approval step is GATED when the purchase is on the Reap rail (`rail: reap`, or
an `rp_` id anywhere in the body or the link: always, whatever the flags, R3-4), or when the body says consent is
required (`next_action.consent_required` / `detail.buyer_step.consent_required`, or `consent.required`). A gated step's
hosted page reaches the page ONLY when the backend's consent block says THAT step is satisfied; until then no hosted URL
is passed on, even one the body carried. So a Reap body with no consent block is "This step isn't available right
now", and with the backend's gate on but the gateway flag off, the page says the same: never a dead approve screen.
The bank check (`authenticate`, in `placing`) is never gated. A held purchase, and one paused for contact details,
offer no consent.

**The offer.** With the flag on, a gated, unsatisfied step whose consent block is complete (`required`, `available`,
the step of the current state, both links https on `AGENPAS_LEGAL_HOSTS`, both versions at most 32 printable
characters, and an `offer: {id, issued_at}`) shows, before any hosted button: "Before you add your card / approve,
read Pivota's Terms of Service (version X) and Privacy Policy (version Y)" (both links open in a new tab,
`rel="noopener noreferrer"`; the versions shown are the very values the acceptance records), an
UNCHECKED checkbox "I agree to the Terms of Service and Privacy Policy", and "Agree and continue", disabled until the
box is ticked and for a dwell after the offer is first shown: the backend's `min_dwell_seconds` plus 1 s when the
consent block (or its offer) states it, else 4 s (the backend's default is 3 s). The approval's
consent may be taken while the total is confirmed (`locking`) or on the approval screen. The view's `consent` member
carries the step, the two links, the two versions (the same read's values the POST records) and the offer, nothing
else (never the flags or a record). New versions are a new offer (tick cleared, dwell restarted). The page keeps
the FIRST offer it showed for a step (a new one per read would never age past the dwell) for up to 25 minutes measured on
its own clock from when it first saw the offer (never from `issued_at`, so a phone clock that is off does not matter);
then it takes the newest offer, clears the tick, restarts the dwell and redraws. It otherwise re-renders only when
something other than the offer changes, so a tick or focus is never dropped by a poll.

**The POST.** `POST /agenpas/api/p/:id/consent`, link token in `X-Agenpas-Link`, body exactly
`{step, offer_id, issued_at}` (strict JSON, at most 1 kB, parsed by the route itself: the app's global JSON parser
skips the AgenPas host whenever AgenPas is on, consent or not: so with AgenPas on, a GET to an AgenPas path that
carries a malformed `application/json` body is served normally there, where before this change the global parser
answered 400 `Invalid JSON`; nothing else on the host changes). Checked in this order: the per-IP bucket; the exact `Origin` (= `AGENPAS_PUBLIC_BASE_URL`) and
`Sec-Fetch-Site`, which refuses only when it is SENT and is not `same-origin` (older Safari / iOS 15 send none; the
exact Origin, the JSON content type, the link header and the refused preflight remain) (else 403 `forbidden`); `Content-Type: application/json` (else 415); the link (404 /
410 / 503 as for the read); the per-link bucket (429); the body (400, or 413 over 1 kB). Then the gateway's OWN latest
read (the same 2 s single-flight cache the page's poll fills): the step must be the one that read offers now, or 409
`consent_stale`; the versions sent to the backend are that read's, never the browser's. Answers: 200
`{recorded: true}` (the read cache entry is dropped, so the next poll sees the hosted page), 409 `consent_stale` and
400 `consent_refused` (the page takes the newest offer, clears the tick, restarts the dwell and asks to read again), 409
`consent_too_soon` (the backend's dwell has not passed: the page keeps the tick and lets the buyer press again after the
dwell), 503 `unavailable`, 429 `rate_limited` (the page keeps the tick and lets the buyer retry after the wait). A 404
from a guard in front of the route (plain text with `X-Agenpas-Guard`, e.g. the flag switched off) is "not available
right now" and the link token is kept; only the API's own JSON `link_invalid` ends the link.

**What is recorded, and what it proves.** The backend records "accepted on Pivota's page by the link holder"
(`evidence = link_holder_on_pivota_page`). Plainly: the agent that was handed the link holds it too, and the Origin,
Sec-Fetch-Site and dwell checks stop only naive automation, not an agent that drives a real browser. Whether that
suffices is a question for Reap.

**Agent surfaces.** With consent on, a `start_purchase` / `get_order` answer whose `next_action` is gated
(`consent_required: true`, no URL) also carries the freshly minted link as `next_action.action_url`, with `expires_at`
the earlier of the step's deadline and the link's; their descriptions gain one sentence saying so (only while a rail is
served; it also says that a gated answer with neither link means "not available yet, poll again", which is what a
gated answer on a rail not in `AGENPAS_RAILS` carries). A REAP purchase gets `agenpas_url` only when its answer is gated
or its consent block says satisfied: with the backend's gate still off, a Reap answer is exactly today's answer. The UCP Reap lane
(`ucpReapAgenticLane.js`), while AgenPas serves the Reap rail, answers a gated `needs_enrollment` / `awaiting_approval`
(no `hosted_url`, `buyer_step.consent_required` for that step, a future deadline) as `requires_escalation` with
`continue_url` = the buyer's AgenPas link for the `rp_` id (minted for the verified caller, put in AFTER the money
filter) and `expires_at` = the earlier of the step's deadline and the link's; its state message says the buyer accepts
the terms there first, and `create_checkout`'s description gains one sentence. A held, paused or expired step is not
swapped, nor one whose backend says it cannot take the consent now (`available: false` on the marker or on a consent
block): no dead-end link. Off, every answer and `tools/list` is byte-identical.

**Flag order.** Gateway first: `AGENPAS_CONSENT_ENABLED`, then `AGENPAS_RAILS=a2a,reap`, then the backend's
`AGENPAS_CONSENT_GATE` (and its consent write). Gateway-first is safe: until the backend gates, a Reap answer gets no
AgenPas link and keeps today's hosted page, so no buyer is sent to a page that would say "not available right now".
Backend-first is NOT: gated Reap answers then carry neither the partner's URL nor an AgenPas link (and the A2A ones no
link either while the gateway's consent is off) until the gateway is on. Either way the page never shows a Reap step
without a satisfied consent block (R3-4). `AGENPAS_HOSTED_HOSTS` must also
list Reap's exact hosted-page host names (measured from one sandbox page) before a Reap page can show.

**Backend contract (consent).**

```
GET  .../agent/internal/commerce/purchases/{purchase_id}     (the read above) adds
  consent: {required, available, step, satisfied, terms_url, privacy_url, terms_version, privacy_version,
            offer: {id, issued_at}}      (offer only while unsatisfied and available)
  and while gated: no hosted_url; detail.buyer_step = next_action = {kind, expires_at, consent_required: true}
POST {PIVOTA_API_BASE}/agent/internal/commerce/purchases/{purchase_id}/consents
  X-Internal-Key:      AGENPAS_INTERNAL_CONSENT_KEY
  X-Agenpas-Agent-Id:  <agent id from the verified link>
  {step, offer_id, issued_at, terms_version, privacy_version}
  201 / 200 recorded · 409 consent_stale (or consent_too_soon) · 400 / 404 refused · 503 unavailable
  (optional) consent.min_dwell_seconds or consent.offer.min_dwell_seconds: the backend's dwell, whole seconds 0..120
```

Not built here: the legal text itself (buyer Terms of Service with a payment-partner purchase clause, and a buyer
Privacy Policy, with version tags) is Peng's / legal's.

## Hosted pages cannot be framed

The payment partner's card page and approval page send `frame-ancestors 'none'` and `X-Frame-Options: SAMEORIGIN`.
So they open:

- desktop (fine pointer, wide window): a popup, opened as `about:blank`, its opener cut, then navigated, so our page
  can notice it close; if the popup is blocked, this tab navigates there and the buyer comes back to the link;
- mobile and in-app webviews: a plain `target="_blank" rel="noopener noreferrer"` link (a webview that ignores
  `_blank` navigates in place; coming back reloads the page, which resumes from the purchase's current state).

Switching to framing later is the one flag `AGENPAS_EMBED_HOSTED_PAGES`: the API marks each action
`open_mode: "embed"`, the page renders a sandboxed iframe instead of the button, and the page's CSP `frame-src` and
`Permissions-Policy` (passkey delegation) open up to exactly the allowlisted hosts.

Before any hosted URL reaches the page it passes two gates: the backend's own allowlist (`hosted_url_is_allowed`)
and the gateway's (`AGENPAS_HOSTED_HOSTS`: https, default port, no user-info, exact host). It must also be the right
kind for the state and unexpired. The page itself opens only `https:` URLs.

## Security model of the link token

- Format `v1.<payload>.<sig>`, base64url. Payload `{v, aud: public origin, p: purchase id, a: agent id, u: agent user
  ref, iat, exp, n: nonce}`; `sig = HMAC-SHA256(AGENPAS_LINK_SECRET, "agenpas-link:v1." + payload)`.
- Verified with a constant-time compare, and only in its canonical base64url spelling (a re-spelled signature that
  decodes to the same bytes is refused, so no altered token verifies). Then `aud` must be this deployment's
  `AGENPAS_PUBLIC_BASE_URL`, the purchase id must equal the route's, `iat` must not be in the future (60 s skew), the
  lifetime must be at most 30 min, and it must not be expired.
- The page forgets the token (memory and its tab's `sessionStorage` copy) once the purchase is final or the link is
  refused. Buyer- and agent-facing copy about the lifetime is derived from the configured TTL.
- It is a bearer grant to SEE one purchase's status and open its hosted pages, which themselves require the buyer's
  card or passkey, and (only while `AGENPAS_CONSENT_ENABLED` is on) to record the acceptance of the terms for that
  purchase's current step. It grants no other purchase, no other write, and nothing on the backend directly.
- The payload is signed, not encrypted: it holds only pseudonymous identifiers (the gateway's `usr_…` user ref, the
  agent id), never buyer details. The page and the API never show the agent id or user ref.
- No secret configured: the feature refuses. Rotating the secret invalidates every outstanding link (at most 30 min
  of them).
- Keeping it out of logs: the token is never in a URL a server sees. It travels in the link's fragment (`#t=`),
  which browsers do not send, then only in the `X-Agenpas-Link` request header, which access logs do not record.
  The page clears the fragment from the address bar and history. Our request log records `req.path`; AgenPas logs
  carry outcome codes only. `Referrer-Policy: no-referrer` stops the page URL leaking to the hosted page.

## Backend contract

The existing purchase read authenticates the CALLER's agent key and buyer token, which the gateway never stores and
the buyer does not have. The page therefore reads server-to-server:

```
GET {PIVOTA_API_BASE}/agent/internal/commerce/purchases/{purchase_id}
  X-Internal-Key:            AGENPAS_INTERNAL_READ_KEY (a dedicated key for this one read)
  X-Agenpas-Agent-Id:        <agent id from the verified link>
  X-Agenpas-Agent-User-Ref:  <agent user ref from the verified link (gateway usr_… form)>
200 -> the same unified body as GET /agent/v2/commerce/purchases/{id}
404 {"error": "purchase_not_found"} -> not that agent's, or does not exist
```

The backend scopes this read by **(agent_id, purchase_id) only**. The gateway still sends
`X-Agenpas-Agent-User-Ref`, but the backend does not scope by it: the gateway's `usr_…` ref is not the backend's own
agent-user ref. The binding to one buyer is the link token itself, which is signed for one purchase, one agent and
one user ref, and is only ever minted for the verified caller of `start_purchase` / `get_order`.

Until the backend serves the route, the API answers 503 and the page says it cannot load the purchase right now.

Fields the projection reads (tolerant of extra fields, and of the same names at the top level instead of in
`detail`): `state`, `totals.{currency, our_price_minor, quoted_total_minor, final_total_minor, shipping_minor,
tax_minor}`, `next_action.{kind, url, expires_at, consent_required}` (or `action`), `order_reference`,
`poll_after_seconds`, `rail` / `rail_purchase_id` (only to tell the rail), `consent` (see "Terms and privacy consent"),
`detail.{merchant_domain, product_name, variant_title, quantity, currency, refusal_reason, last_error_code,
merchant_order_status_url, buyer_step, contact_reentry_required}`. Never passed to the page: `rail`, `executor`,
`rail_purchase_id`, the `pp_` id when the link names a rail id, `detail` itself, owner hashes, consent records and
versions, raw codes.

## Trying it locally

```
AGENPAS_ENABLED=1 AGENPAS_DEV_FIXTURES=1 AGENPAS_HOSTED_HOSTS=hosted.example \
AGENPAS_PUBLIC_BASE_URL=http://localhost:<port> AGENPAS_LINK_SECRET=<any 32+ characters> npm start
open http://localhost:<port>/agenpas/dev/start?scenario=happy   # redirects to /agenpas/p/<id>#t=…
```

Scenarios: `happy` (about a minute from routing to completed), `outcome_unknown`, `refused`, `declined`,
`unknown_state`, `expired`, and `consent` (a Reap-rail purchase: add `AGENPAS_CONSENT_ENABLED=1`; the card page and then
the approval page appear only after the terms are accepted on the page; the fixture links point at `pivota.cc`). Hosted page buttons point at `hosted.example`, which resolves nowhere; the purchase
advances on its own timeline either way.
