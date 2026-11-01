# Synthetic callers: our own eval traffic on the production MCP door

Code: `src/guardrails/syntheticCallers.js` (who is listed, what they may send, and the backend assertion) and `src/guardrails/loopbackCallerAssertion.js` (the loopback marker).

## What it is for
An eval harness calls the production MCP read tools as a partner would, so that readiness is measured on the real system. Its calls are:
- kept out of partner-facing analytics, usage counters and alerts;
- unable to reach any money or order tool.

The gateway half (this repo) decides who is synthetic and carries a signed marker to every hop. The skips themselves live with the writers that skip: the backend verifies the marker, and gateway-side gates follow in later changes.

## Configuration (gateway)
| Variable | Meaning |
|---|---|
| `SYNTHETIC_TRAFFIC_MODE` | `off` (default), `observe` or `enforce` |
| `SYNTHETIC_CALLERS_JSON` | `[{"iss": "<our authorization server>", "client_id": "<eval OAuth client>"}]` |
| `SYNTHETIC_ASSERTION_SECRET` | HMAC secret shared with the backend only. Mount it from Secret Manager. |

Rules:
- **Matching:** a call is listed only when the verified access token's `iss` and `client_id` both equal an entry. `azp` alone never matches.
- **Our issuer naming the eval client only as `azp`:** refused.
- **A broken config refuses the boot.** The revision logs `synthetic_config_invalid` at ERROR (parse status, mode, entry count, the index and reason of each bad entry, never a client id) and exits, so traffic stays on the previous revision. Broken means any of:
  - `SYNTHETIC_CALLERS_JSON` that is not valid JSON, not an array, or an empty array;
  - an entry that is not an object, has a key other than `iss` and `client_id`, or lacks either;
  - an `iss` that is not one of `MCP_OAUTH_AUTHORIZATION_SERVERS`;
  - a `SYNTHETIC_TRAFFIC_MODE` other than empty, `off`, `observe` or `enforce`;
  - a `SYNTHETIC_ASSERTION_SECRET` shorter than 32 characters.

  A valid config logs `synthetic_config_loaded` with the mode and entry count. After any change, check for one of the two lines on the new revision before anything else.
- **Eval client setup:** OAuth only, read scopes only, no API key, and **never a client registered to a partner agent.** The gateway cannot see that registry, so check it before listing a client (read-only, in the backend database): `SELECT agent_id FROM agent_oauth_clients WHERE client_id = '<eval client id>' AND disabled_at IS NULL;` must return no rows. A partner client listed by mistake would be restricted to five tools in every mode, and in enforce would lose its writes and attribution. The backend also refuses the marker for such a client (`partner_client`).
- **Commerce host only.** The harness calls `commerce.mcp.pivota.cc`. The branded host and `/public/mcp` serve the anonymous public tier, where a token is not identity: a listed token there runs as an ordinary anonymous call.

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

  It is refused (`carrier_not_ready`) when the secret is missing, or when `SELF_INVOKE_BASE` is not this host's loopback. Either way the marker could not reach every hop.

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
3. Hard stop: disable the eval OAuth client at the authorization server.
