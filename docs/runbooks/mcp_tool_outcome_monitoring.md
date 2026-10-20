# MCP tool outcome monitoring

Every MCP door answers `tools/call` with HTTP 200: a tool failure rides inside the JSON-RPC body. Cloud Run's
5xx metrics therefore never see a failing tool. The gateway writes one structured line per `tools/call`
instead, and the log-based metrics and alerts in `infra/gcp/monitoring/mcp_tool_outcomes/` are built on it.

## The line

`jsonPayload.msg="mcp tools/call complete"`, severity INFO. The line is pino JSON on stdout, so the fields land in `jsonPayload`. `src/logger.js` adds
the `severity` field Cloud Logging reads; pino's numeric `level` is kept. It is
written once per `tools/call`, on response `finish`, on every door:

| door | route | callers |
|---|---|---|
| `public_mcp` | `POST /public/mcp`, and `POST /mcp` on a public app host | anonymous read tier |
| `mcp` | `POST /mcp` | MCP OAuth connectors, agent API keys, the first-party service key |
| `ucp_mcp` | `POST /ucp/mcp` | UCP-dialect agents (API key or OAuth) |

| field | meaning |
|---|---|
| `door` | as above |
| `tool` | the wire tool name, but only when a surface recognised it on this call or it is a name the gateway's own surfaces advertise. Anything else, including a blank name, is `other`. `params.name` is caller-chosen, so it never becomes an unbounded metric label or a log value |
| `tier` | `public` · `first_party` (the configured service key) · `authenticated` (any other resolved caller) · `unauthenticated` (refused before a caller was resolved) |
| `status` | HTTP status written (200 for every dispatched call) |
| `latency_ms` | handler entry to response finish |
| `outcome` | `ok` · `tool_error` (`result.isError`) · `rpc_error` (JSON-RPC `error`) · `internal_error` (the adapter threw, or a 5xx) · `refused` (4xx before dispatch: door off, body too large, rate limit, auth challenge) · `unknown` (should not occur) |
| `is_error` | `outcome !== "ok"` |
| `error_class` | `server`: a fault on our side. That is a retriable taxonomy code (for example `MERCHANT_UNAVAILABLE`), `UNEXPECTED_ERROR` from an uncurated exception, an internal error, `JSONRPC_INTERNAL_ERROR`, or a 5xx. `client`: the call will not succeed as sent. That is `UNKNOWN_TOOL`, `INVALID_ARGUMENTS`, `UNKNOWN_PRODUCT_ID`, `USER_AUTH_REQUIRED`, `OPERATION_NOT_ALLOWED`, any other non-retriable code, a protocol error, or a refusal. `null` when the call is ok |
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

Definitions only. Nothing in this repo applies them. Create the metrics first and wait for data. Then fill in
`notificationChannels` and create the policies:

```sh
D=infra/gcp/monitoring/mcp_tool_outcomes
for m in mcp_tool_calls mcp_tool_call_server_errors mcp_search_answers mcp_search_zero_results \
         mcp_search_degraded mcp_tool_call_latency llm_model_breaker_opens; do
  gcloud logging metrics create "$m" --project="$PROJECT" --config-from-file="$D/metric.$m.yaml"
done
for a in mcp_tool_error_rate mcp_search_zero_result_rate mcp_search_degraded_rate mcp_tool_latency_p95; do
  gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file="$D/alert.$a.yaml"
done
```

Every `mcp_*` metric applies three filters:

- only the `gateway` Cloud Run service;
- only lines that carry `outcome`, so lines from before this change are ignored;
- not `tier="first_party"`, so CI and probe traffic on Pivota's own service key cannot move a ratio.

Anonymous probes of the public tier cannot be told apart from real callers and are still counted.

| alert | condition | why |
|---|---|---|
| `alert.mcp_tool_error_rate` | per tool, server-class errors / answered calls > 2% over 30m, for 10m, with at least 15 server errors and 50 calls | the only signal that sees a failing tool. Caller and policy errors and refusals are excluded, so a caller sending bad ids or a rate-limit flood cannot page as an outage |
| `alert.mcp_search_zero_result_rate` | `search_catalog` zero-result answers / answers > 40% over 30m, for 10m, with at least 50 answers | a lane or filter regression shows up as empty pages, not errors |
| `alert.mcp_search_degraded_rate` | `search_catalog` answers whose envelope said it degraded / answers > 10% over 30m, for 10m, with at least 10 degraded | the public tier turns a `status:"failed"` envelope into an empty page logged `outcome=ok`. Without this, a degrading lane is visible to neither of the alerts above. 10% is a starting threshold |
| `alert.mcp_tool_latency_p95` | per tool p95 > 15s for 10m | a starting threshold below the edge's first-byte deadline. Tune it per tool after a week of data |

`llm_model_breaker_opens` counts the find_products_multi model breaker's openings (WARNING, `event=
llm_model_breaker_open`, see `docs/find_products_multi_signals.md`). A steady count means a configured model id
does not exist for its provider. `env_hint` on the line names the variable to change.

### Why the error-rate alert is 30m, at least 15 errors, sustained 10m

Assume the worst case: every tool error is server-class at a baseline of p0 = 1.28%, the rate of all
`search_catalog` tool errors in a recent week before any server/client split. With n answered calls in the
window, the alert's ratio condition is X/n > 2%, where X is binomial(n, p0). The table gives the chance that a
healthy window crosses it, and the chance that a real failure rate does:

| calls in window (n) | errors needed | P(false fire), p0 = 1.28% | P(fire), p = 5% | p = 10% | p = 25% |
|---|---|---|---|---|---|
| 50, 2% only (the original 10m / no-floor design) | 2 | 13% | 72% | 97% | 100% |
| 100, 2% only | 3 | 14% | 88% | 100% | 100% |
| 50, with the 15-error floor | 15 | 6e-17 | 0 | 0 | 25% |
| 100 | 15 | 4e-12 | 0 | 7% | 99.5% |
| 200 | 15 | 6e-8 | 8% | 91% | 100% |
| 400 | 15 | 3e-4 | 90% | 100% | 100% |
| 750 | 16 | 3.5% | 100% | 100% | 100% |
| 1000 | 21 | 2.1% | 100% | 100% | 100% |
| 2000 | 41 | 0.3% | 100% | 100% | 100% |

Without the floor, a healthy 10-minute window crosses 2% about one time in seven. With the 15-error floor, a
healthy window is essentially never above it below about 400 calls per 30 minutes. The worst case is about 5.8%
per 30-minute window, at about 740 calls, where 2% sits only about 1.9 standard deviations above 1.28%. The
10-minute `duration` requires the overlapping windows to stay above the line, which lowers that further. The
true server-class baseline is below 1.28%, because some of those errors are client-class, so these figures are
an upper bound.

The cost is sensitivity at low volume. Under about 100 calls per 30 minutes, only a large outage (25% and up)
can fire, and a 5% failure rate cannot be told from noise at that volume anyway. If traffic settles near the
worst-case band, raising the threshold to 3% cuts the worst case to about 0.2%.

## Useful queries

```
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.error_class="server"
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.tool="search_catalog" AND jsonPayload.result_count=0
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.degraded=true
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.upstream_degraded=true AND jsonPayload.door="public_mcp"
jsonPayload.msg="mcp tools/call complete" AND jsonPayload.cache_hit=true
```
