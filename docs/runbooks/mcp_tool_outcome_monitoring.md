# MCP tool outcome monitoring

Every MCP door answers `tools/call` with HTTP 200: a tool failure rides inside the JSON-RPC body. Cloud Run's
5xx metrics therefore never see a failing tool. The gateway writes one structured line per `tools/call`
instead, and the log-based metrics and alerts in `infra/gcp/monitoring/mcp_tool_outcomes/` are built on it.

## The line

`jsonPayload.msg="mcp tools/call complete"` (pino JSON on stdout, so the fields land in `jsonPayload`). It is
written once per `tools/call`, on response `finish`, on every door:

| door | route | callers |
|---|---|---|
| `public_mcp` | `POST /public/mcp`, and `POST /mcp` on a public app host | anonymous read tier |
| `mcp` | `POST /mcp` | MCP OAuth connectors, agent API keys, the first-party service key |
| `ucp_mcp` | `POST /ucp/mcp` | UCP-dialect agents (API key or OAuth) |

| field | meaning |
|---|---|
| `door`, `tool` | as above; `tool` is the wire tool name |
| `tier` | `public` · `first_party` (the configured service key) · `authenticated` (any other resolved caller) · `unauthenticated` (refused before a caller was resolved) |
| `status` | HTTP status written (200 for every dispatched call) |
| `latency_ms` | handler entry to response finish |
| `outcome` | `ok` · `tool_error` (`result.isError`) · `rpc_error` (JSON-RPC `error`) · `internal_error` (the adapter threw, or a 5xx) · `refused` (4xx before dispatch: door off, body too large, rate limit, auth challenge) · `unknown` (should not occur) |
| `is_error` | `outcome !== "ok"` |
| `error_code` | the code the caller saw: the tool code (`UNKNOWN_TOOL`, `MERCHANT_UNAVAILABLE`, `OPERATION_NOT_ALLOWED`, ...), `JSONRPC_<NAME>` (`JSONRPC_INVALID_PARAMS`, ...), `INTERNAL_ERROR`, or `HTTP_<status>` for a refusal. `null` when ok |
| `result_count` | rows in the result the caller received, after the public tier's sourcing and chain filters. Present only for list results (search, offers, alternatives); absent on errors |
| `cache_hit` | `true` · `false` · `"stale"` (served stale, refresh started). Present only when a result cache was consulted (search) |
| `lane`, `lane_source` | the search envelope's `metadata.primary_lane` / `metadata.query_source`, short tokens only. A cache hit reports the lane that produced the cached answer |
| `upstream_status` | the envelope's `status` when it is not `success`/`ok` (for example `failed`) |
| `degraded` | always present; `true` when any flag below is set |
| `upstream_timeout` | the upstream call hit its deadline (the tool error is then usually `MERCHANT_UNAVAILABLE`) |
| `upstream_degraded` | the envelope said it degraded (`status` not success, `success:false`, `ok:false`, `error`) |
| `fallback_used` | the search lane reports a fallback (route fallback, family fallback, stale products cache) |
| `heartbeat_committed` | the response outlived the heartbeat delay and was streamed |
| `caller_*` | who called (see `src/attribution/callerLogFields.js`); never a key, never the arguments |

A search can answer `status:"failed"` with rows attached. That logs `outcome="ok"`, `result_count` = the rows,
`upstream_degraded=true` and `upstream_status="failed"`: both facts, neither hidden.

Nothing in the line comes from the tool arguments. String fields are short tokens checked against a strict
pattern, so a query or a product title cannot reach the log.

## Metrics and alerts

Definitions only. Nothing in this repo applies them. Create the metrics first, wait for data, then create the
policies after filling in `notificationChannels`:

```sh
D=infra/gcp/monitoring/mcp_tool_outcomes
for m in mcp_tool_calls mcp_tool_call_errors mcp_search_answers mcp_search_zero_results mcp_tool_call_latency; do
  gcloud logging metrics create "$m" --project="$PROJECT" --config-from-file="$D/metric.$m.yaml"
done
for a in mcp_tool_error_rate mcp_search_zero_result_rate mcp_tool_latency_p95; do
  gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file="$D/alert.$a.yaml"
done
```

| alert | condition | why |
|---|---|---|
| `alert.mcp_tool_error_rate` | per tool, errors / answered calls > 2% over 10m, with at least 50 calls | the only signal that sees a failing tool. Refusals are excluded so a rate-limit flood cannot page as a tool fault |
| `alert.mcp_search_zero_result_rate` | `search_catalog` zero-result answers / answers > 40% over 30m, with at least 50 answers | a lane or filter regression shows up as empty pages, not errors |
| `alert.mcp_tool_latency_p95` | per tool p95 > 15s for 10m | a starting threshold below the edge's first-byte deadline. Tune it per tool after a week of data |

The metrics count only lines that carry `outcome`, so lines written before this change do not skew the ratios.

## Useful queries

```
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.is_error=true AND jsonPayload.outcome!="refused"
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.tool="search_catalog" AND jsonPayload.result_count=0
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.degraded=true
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.cache_hit=true
```
