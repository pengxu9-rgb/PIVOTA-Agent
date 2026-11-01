# Synthetic callers: our own eval traffic on the production MCP door

Code: `src/guardrails/syntheticCallers.js` (who is listed, what they may send, and the backend assertion), `src/guardrails/loopbackCallerAssertion.js` (the loopback marker) and `src/guardrails/syntheticContext.js` (the gateway-side gates).

## What it is for
An eval harness calls the production MCP read tools as a partner would, so that readiness is measured on the real system. Its calls are:
- kept out of partner-facing analytics, usage counters and alerts;
- unable to reach any money or order tool.

The gateway half (this repo) decides who is synthetic, carries a signed marker to every hop, and applies the gateway-side gates below. The backend verifies the marker and skips its own writes (pivota-backend#2686 and #2688).

## Configuration (gateway)
| Variable | Meaning |
|---|---|
| `SYNTHETIC_TRAFFIC_MODE` | `off` (default), `observe` or `enforce` |
| `SYNTHETIC_CALLERS_JSON` | `[{"iss": "<our authorization server>", "client_id": "<eval OAuth client>"}]` |
| `SYNTHETIC_ASSERTION_SECRET` | HMAC secret shared with the backend only. Mount it from Secret Manager, **pinned to a version**, never `:latest`. |
| `SYNTHETIC_LLM_MAX_CALLS_PER_HOUR` | Synthetic LLM passes per instance per hour (default 120; `0` turns them off). |

**Pin the secret version** on the gateway and on the backend `web` service alike. With `:latest`, a new version reaches each instance only when it starts: during a scale-out some instances sign with the new secret while the backend verifies with the old one, and every such hop is served as a real call. A new version shorter than 32 characters also stops every new gateway instance from booting. Rotate by setting the old value as the backend's `SYNTHETIC_ASSERTION_SECRET_PREVIOUS`, then moving both services to the new version.

Rules:
- **Matching:** a call is listed only when the verified access token's `iss` and `client_id` both equal an entry. `azp` alone never matches.
- **Our issuer naming the eval client only as `azp`:** refused.
- **A broken config refuses the boot.** The revision logs `synthetic_config_invalid` at ERROR (parse status, mode, entry count, the index and reason of each bad entry, never a client id) and exits, so traffic stays on the previous revision. Broken means any of:
  - `SYNTHETIC_CALLERS_JSON` that is not valid JSON, not an array, or an empty array;
  - an entry that is not an object, has a key other than `iss` and `client_id`, or lacks either;
  - an `iss` that is not one of `MCP_OAUTH_AUTHORIZATION_SERVERS`;
  - a `SYNTHETIC_TRAFFIC_MODE` other than empty, `off`, `observe` or `enforce`;
  - a `SYNTHETIC_ASSERTION_SECRET` shorter than 32 characters;
  - an `iss` or `client_id` longer than 512 characters (the backend would refuse the marker and serve the call as real).

  A valid config logs `synthetic_config_loaded` with the mode and entry count. After any change, check for one of the two lines on the new revision before anything else.
- **Eval client setup:** OAuth only, read scopes only, no API key, and **never a client registered to a partner agent.**
  - It is a **confidential** client registered by dynamic client registration on our authorization server (`token_endpoint_auth_method: client_secret_basic`; the server mints its `mcpc_…` id). Do **not** provision it with `scripts/agent_oauth_client.py`: that registers the client to an agent, which is exactly what the backend refuses (`partner_client`).
  - The owner of the eval programme creates the client and stores its secret in Secret Manager personally. No session or script does it for them.
  - Registration is open, so anyone can register a client. Only an `(iss, client_id)` pair in `SYNTHETIC_CALLERS_JSON` makes one synthetic, and that list changes only with a deploy, on the owner's go.
  - The gateway cannot see the agent registry, so check it before listing a client (read-only, in the backend database). This must return no rows:
    ```sql
    SELECT agent_id FROM agent_oauth_clients
    WHERE issuer = '<our authorization server>' AND client_id = '<eval client id>' AND disabled_at IS NULL;
    ```
    A partner client listed by mistake would be restricted to five tools in every mode, and in enforce would lose its writes and attribution. The backend refuses the marker for such a client too (`partner_client`, pivota-backend#2686).
- **Commerce host only.** The harness calls `commerce.mcp.pivota.cc`. The branded host and `/public/mcp` serve the anonymous public tier, where a token is not identity: a listed token there runs as an ordinary anonymous call, with its writes. The harness refuses any other host (below).

## What a listed caller may do, in every mode (`off` included)
- One JSON-RPC object per request. Batches and non-objects are refused.
- `initialize`, `notifications/initialized`, `ping`, `tools/list`.
- `tools/call` for `search_catalog`, `get_product`, `get_offers`, `get_alternatives` and `get_intel` only. Every other name, including any tool added later, gets `OPERATION_NOT_ALLOWED` before dispatch.
- `tools/list` shows it only those five tools.
- The UCP dialect door refuses it outright.

## Modes
- **off:** nobody is synthetic. Listed callers are still restricted (above).
- **observe:** a listed caller is logged (`synthetic_classified`, and `synthetic_classified: true` on its outcome line), and its calls run as ordinary ones. **Run observe with no eval traffic.** It proves no real caller is ever classified; the expected count is 0.
- **enforce:** the call is marked and carried:
  - `synthetic: true` on the outcome and price-verification lines;
  - the loopback marker (`X-Pivota-Loopback-Synthetic`) on every self-invoke;
  - the backend assertion (`X-Pivota-Synthetic-Assertion`) on every backend hop.

  It is refused (`carrier_not_ready`) when the secret is missing, or when `SELF_INVOKE_BASE` is not this host's loopback on the port it listens on (`PORT`, when set). Either way the marker could not reach every hop.

## What a synthetic call does not do on the gateway (enforce)
Decision A2 for phase 1: **no live reads.** A synthetic call answers from what we hold. The scorecard labels its prices, offer correctness, offer counts, the price-verified share and latency "not representative (no live reads)".
- **No live merchant read:**
  - search: the storefront `.json` overlay and the UCP search read (the price line says `search_overlay_skipped: synthetic_no_live_reads`);
  - get_product: the UCP product read, the get_pdp_v2 background read, its live-refresh token, and merchant variant sourcing;
  - get_offers: the UCP offer read, and the freshness-gated seed offers, which are served only behind an enforcing live read and would otherwise answer empty. No live cart is minted.
- **No fleet state:** no verified price and no `host_backoff` document in Firestore.
- **Shared caches are read-through:** it may read the product-detail, product-group and other request-path caches, but never writes one (positive or negative entries) and never leads an in-flight join. A real request is never answered with something built for a synthetic one, such as links marked synthetic or a cache-only not-found.
- **The search result cache is bypassed:** no read, no write, no revalidation. Search latency is a cold-path number.
- **LLM passes** (the search intent rewrite and the rerank): one synthetic pass in flight per instance, within `SYNTHETIC_LLM_MAX_CALLS_PER_HOUR`. Past either it takes the deterministic fallback (`llm_synthetic_cap`). It reads the shared model breaker and respects it when open, never takes its half-open probe, and never reports a success or failure into it.
- **Retries** re-sign the backend assertion on every attempt, so a late retry is never refused as expired.

## Order of rollout
1. The backend's gates are live (pivota-backend#2686, #2688) and its `SYNTHETIC_ASSERTION_SECRET` is mounted, pinned.
2. The gateway runs this code with the same secret, mode `off`, and `synthetic_config_loaded` on the new revision.
3. `observe` with no eval traffic: 0 `synthetic_classified` lines.
4. `enforce`, then the harness, canaries first: `get_alternatives`, unscoped `get_product`, `search_catalog`, `get_offers`.

## One id per call
The MCP door mints a request id for every commerce-door call and logs it as `gateway_request_id` on `mcp tools/call complete`, the same field name the invoke completion line uses. For a synthetic call:
- the loopback hop adopts it;
- it goes into the backend body's `request_context.request_id`;
- it is signed into the assertion.

A run's outcome lines therefore name every backend hop that should have carried the marker.

## Metrics and alerts
Every log-based metric under `infra/gcp/monitoring/mcp_tool_outcomes/` and `price_verification/` has `AND NOT jsonPayload.synthetic=true` (a missing field is counted). After a change to a filter, update each metric that already exists:
```bash
gcloud logging metrics update <name> --project=<project> --config-from-file=infra/gcp/monitoring/<dir>/metric.<name>.yaml
```

## Before the first harness call
The harness refuses to run unless:
- `tools/list` returns exactly the five read tools (anything else means the caller is not listed, or the config is not the one you deployed);
- the configured host is the commerce host.

## Rollback
1. Stop the harness.
2. Set `SYNTHETIC_TRAFFIC_MODE=off`. This changes only that variable, and listed callers stay restricted:
   ```bash
   gcloud run services update gateway --project=<project> --region=<region> --update-env-vars=SYNTHETIC_TRAFFIC_MODE=off
   ```
3. Confirm the new revision is Ready **and** serving all traffic, and that it logged `synthetic_config_loaded` with `mode: off`. A revision that is created but not serving leaves the old mode live.
   ```bash
   gcloud run services describe gateway --project=<project> --region=<region> --format='value(status.latestReadyRevisionName,status.traffic)'
   ```
4. Hard stop: disable the eval OAuth client at the authorization server.
