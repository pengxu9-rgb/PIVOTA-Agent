# AgenPas: the buyer's own checkout pages

AgenPas (working name) is Pivota's buyer-facing checkout page. A partner chat app hands the buyer an AgenPas link;
the buyer reviews the purchase on our page, adds a card and approves the purchase on the payment partner's own
hosted pages, and watches the order get placed. The card number is typed only on the payment partner's page: our
pages have no card fields anywhere, and Pivota never sees the card.

Underneath, the backend runs the purchase state machine on the A2A payment rail
(pivota-backend `docs/agent_purchases_routes.md`). The gateway only reads the purchase and shows it.

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
| `AGENPAS_PUBLIC_BASE_URL` | none | The https origin minted links point at. None: no link is minted. When set, the pages answer only on that host. |
| `AGENPAS_HOSTED_HOSTS` | empty | Comma-separated exact host names the payment partner serves its hosted pages from. Empty refuses every hosted URL (the page shows no button, only "Getting the secure page ready"). |
| `AGENPAS_EMBED_HOSTED_PAGES` | off | Off: hosted pages open in a popup or a new tab. On: the page frames them (see below). |
| `AGENPAS_DEV_FIXTURES` | off | Local development only: canned purchases instead of the backend. It cannot arm on a managed platform (`K_SERVICE`, `K_REVISION`, `RAILWAY_*`, ...) or in a production environment (`src/config/platform.js`), whatever its value. |

The backend read also uses `PIVOTA_API_BASE` and `AGENT_AUTH_INTROSPECT_INTERNAL_KEY` (already configured), through
the private backend hop.

## Routes

| Route | What |
|---|---|
| `GET /agenpas/p/:purchaseId#t=<token>` | The page (HTML shell). The token is in the fragment, which the server never receives: the shell is the same for every well-formed id, and the page shows the expired / invalid screen from the API's 410 / 404. A malformed id: friendly 404 page. No secret configured: friendly 503 page. |
| `GET /agenpas/api/p/:purchaseId` | JSON for the page. Token ONLY in the `X-Agenpas-Link` header (a `?t=` query is ignored). 200 view, 404 `link_invalid` / `not_found`, 410 `link_expired`, 503 `unavailable` with `Retry-After`. |
| `GET /agenpas/assets/app.js`, `app.css` | The page's script and style, same origin. |
| `GET /agenpas/dev/start?scenario=<name>` | Dev fixtures only: mints a fixture link and redirects to it. |

The page: `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, no inline script or style, no external
CDN or third-party script, `frame-ancestors 'none'`, `frame-src 'none'` (or the allowlisted hosts in embed mode),
`form-action 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

## The flow

1. The agent calls `start_purchase`. With AgenPas on, the answer carries an additive `agenpas_url`
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
| `completed` | Order placed: order number, total charged, store, link to the store's order page when it is on the store's domain |
| `failed` / `refused` / `expired` | Plain-language reason from the backend's codes (never the code or any raw text) |
| outcome-unknown code | "We're checking with the store — don't try again." No retry is ever suggested. |
| anything else | "Checking on your purchase…", keep polling, claim nothing |

The summary card shows the product, variant, quantity, store and price, and "You'll approve up to <quoted total>"
once the backend has a quoted total, with the line that the final total includes shipping and tax and cannot exceed
what the buyer approves.

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

- Format `v1.<payload>.<sig>`, base64url. Payload `{v, p: purchase id, a: agent id, u: agent user ref, iat, exp, n:
  nonce}`; `sig = HMAC-SHA256(AGENPAS_LINK_SECRET, "agenpas-link:v1." + payload)`.
- Verified with a constant-time compare; then the purchase id must equal the route's, `iat` must not be in the future
  (60 s skew), the lifetime must be at most 30 min, and it must not be expired.
- It is a bearer grant to SEE one purchase's status and open its hosted pages, which themselves require the buyer's
  card or passkey. It grants no other purchase, no write, and nothing on the backend directly.
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
  X-Internal-Key:            AGENT_AUTH_INTROSPECT_INTERNAL_KEY
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
tax_minor}`, `next_action.{kind, url, expires_at}` (or `action`), `order_reference`, `poll_after_seconds`,
`detail.{merchant_domain, product_name, variant_title, quantity, currency, refusal_reason, last_error_code,
merchant_order_status_url}`. Never passed to the page: `rail`, `executor`, `rail_purchase_id`, the `pp_` id when the
link names a rail id, `detail` itself, owner hashes, consent records, raw codes.

## Trying it locally

```
AGENPAS_ENABLED=1 AGENPAS_DEV_FIXTURES=1 AGENPAS_HOSTED_HOSTS=hosted.example \
AGENPAS_LINK_SECRET=<any 32+ characters> npm start
open http://localhost:<port>/agenpas/dev/start?scenario=happy   # redirects to /agenpas/p/<id>#t=…
```

Scenarios: `happy` (about a minute from routing to completed), `outcome_unknown`, `refused`, `declined`,
`unknown_state`, `expired`. Hosted page buttons point at `hosted.example`, which resolves nowhere; the purchase
advances on its own timeline either way.
