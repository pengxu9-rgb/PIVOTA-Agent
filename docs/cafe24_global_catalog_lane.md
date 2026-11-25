# Cafe24 Global Catalog lane (search-only, shadow-only)

Code: `src/services/cafe24GlobalCatalog.js`. Hook: `maybeShadowCafe24CatalogSearch` in `src/server.js`, called
from `maybeOverlayLiveSearchPrice`. Tests: `tests/cafe24_global_catalog.node.test.cjs`.

**Coverage.** That overlay runs on the two beauty search paths only: the external-seed mainline and the public
beauty discovery bridge. A door search served by any other lane (the canonical direct lane, upstream v2 search) and
a door search answered from the door's cache never reach the hook. Shadow counts therefore describe beauty door
searches that missed the door cache, not all searches.

## What it does

- In `shadow` mode, a page-1 beauty search (see Coverage) from an MCP / UCP door's `search_catalog` (the commerce kernel's own loopback
  hop, `isKernelSearchHop` in `src/invokeEgress.js`) with a market we price starts one bounded Cafe24
  `search_catalog` call for the same query and market, once per request. No other caller is observed: the chat
  re-invoke, recommendation recall, the commerce-resolution fallback, admin tools and synthetic calls never are.
- A search that sent a request logs one `cafe24_catalog_shadow` line containing only counts: products, variants,
  priced, priced in the market's currency, currency mismatches, in stock, and distinct sellers. It also logs the
  outcome `reason`, `http_status` and `latency_ms`. `mcp_error_code` / `ucp_error_code` are logged as an integer
  JSON-RPC code, a code from the lane's known-code list, or `other` for any other string.
- A search refused before sending (no market, ceiling, breaker, a remembered discovery failure, ...) is only counted.
  The counts are logged at most once a minute as `cafe24_catalog_shadow_refusals`, on a timer, so the last window is
  logged even when traffic stops.
- The served page is never changed. The call is never awaited. A failure in the lane never reaches the page.
- Every normalized candidate has `buyable: false` and `execution.eligible: false`. Its blockers always include
  `execution_route_unverified` and `seller_not_admitted`. Others are added as they apply: `merchant_unresolved`,
  `variants_missing`, `price_unreadable`, `currency_not_market`, `availability_unknown`.
- Nothing is cached or stored except the discovery check (one per process per hour, or five minutes after a failure).

## What it is not

- No checkout, cart, payment, order or post-purchase call exists in this lane.
- No `enforce` mode exists. Serving Cafe24 listings needs three things first: a seller-admission record for each
  seller (ADR-033, Proposed), its own change, and an owner decision.
- The lane carries no credentials. It builds the shared UCP buyer client with `forceAnonymous: true` and
  `allowTokenTier: false`, and refuses (`credential_tier_refused`) any client that still reports a non-anonymous tier
  or would sign. Bearer tokens, client credentials and signing keys configured for other UCP work are never sent to
  Cafe24.

## Contract it is written to

| Item | Value |
| --- | --- |
| Discovery | `https://mcp-catalog.cafe24.com/.well-known/ucp`. The MCP endpoint it names must be exactly `https://mcp-catalog.cafe24.com/api/ucp/mcp` (scheme, host, port, path), or the lane stops (`endpoint_not_pinned`). |
| UCP version | `UCP_SPEC_VERSION` (`safety-kernel/src/protocol/ucpSpecVersion.cjs`, 2026-04-08). Any other advertised version stops the lane (`ucp_version_unsupported`). |
| Capability | The business profile must advertise `dev.ucp.shopping.catalog.search`. |
| Tool | `tools/list` must list `search_catalog` with a `catalog` input. |
| Call | `tools/call search_catalog { meta: { "ucp-agent": { profile } }, catalog: { query, context: { address_country }, pagination: { limit <= 10 } } }` |
| MCP | Stateless JSON-RPC with no `initialize`, which is the shared client's behavior. A server that requires a session is reported as `mcp_session_required`. JSON and SSE answers are both read. |
| Cafe24 REST API version | Not used. |

The fixtures in the tests are constructed from the UCP 2026-04-08 catalog shape. None of them was captured from a live
Cafe24 answer.

## Configuration (names only)

| Name | Default | Meaning |
| --- | --- | --- |
| `CAFE24_CATALOG_SEARCH` | off | `shadow` (case-insensitive, trimmed) turns the lane on. Any other value means off. Read on every call. |
| `CAFE24_CATALOG_DENY` | unset | `1`/`true` is the kill switch. It wins over the mode. |
| `CAFE24_CATALOG_SHADOW_PER_MIN` | 10 | The per-process call ceiling: an integer clamped to 1..60; anything else is 10. |
| `UCP_AGENT_PROFILE_URL` | (existing) | The agent profile URL sent in `meta.ucp-agent.profile`. If no profile URL resolves, nothing is sent (`no_profile_url`). |

Fixed bounds: one page of at most 10 products, at most 2 calls in flight, a 2.5 s timeout per call, and no retries. A
breaker opens after 3 consecutive 429, 5xx, timeout or transport failures, for 60 s at first and doubling up to
10 min. A `Retry-After` header is honored, up to 1 h.

## Verifying it

Offline:

```bash
node --test tests/cafe24_global_catalog.node.test.cjs
```

Pre-flip checklist (before any environment turns `shadow` on):

1. Check the gateway service's CPU allocation. The shadow call can outlive the response, and CPU throttled outside
   requests would inflate `latency_ms`, cause timeouts and trip the breaker.
2. Confirm `SELF_INVOKE_BASE` is unset on the gateway service (a presence check only). The door-search marker is
   accepted only over a loopback socket, so a self-invoke base that leaves the process would stop every observation.
3. Read the Coverage note above before reading any counts.

Live access has not been verified. The first live check should run from the gateway's normal egress in staging, with
`CAFE24_CATALOG_SEARCH=shadow`. Read the `cafe24_catalog_shadow` lines and their `reason` values. `ok` with a non-zero
`products` count is the first evidence that Cafe24 accepts our agent profile from our runtime.
