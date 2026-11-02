# Agent API readiness eval (partner simulator)

`scripts/agent-readiness-eval/` tests the agent API the way an integrating partner would. It speaks MCP over
HTTP to `/public/mcp` or `/mcp`, sends realistic beauty-shopping queries, follows results through the tools,
and scores the answers against SLOs. Use it to check readiness ourselves instead of waiting for a partner to
find the gaps.

> **Production only as our eval client.** For an ordinary caller, a production `search_catalog` /
> `get_product` / `get_offers` call can mint attribution links and click rows, and can trigger live reads
> against merchant stores. Production skips all of that only for our own eval OAuth client, and only in
> `enforce` ([synthetic callers](synthetic_callers.md)).
>
> The harness therefore only addresses targets on a compiled-in **allowlist**: loopback IP literals, an
> exact-hostname eval-clone list that is **empty today**, and the production commerce door as the eval client
> ([target C](#c-production-as-our-eval-client---target-kind-prod-synthetic)). Every response must also carry
> the target's attestation header, or the run halts: `X-Pivota-Deployment: eval-clone` for loopback and the
> clone, `X-Pivota-Synthetic: enforce` for production. See [Safety](#safety-caps).
>
> On 2026-10-20 a test reached production after its refusal was mutated away. Every eval test now installs
> a loopback-only network guard first (`tests/agent_readiness_eval/_net_guard.cjs`).

## Quick start

```bash
# 1. See the plan and the safety verdict. This makes no network calls.
npm run eval:agent-readiness -- --dry-run --base-url http://127.0.0.1:3000

# 2. Run against a local target: public read tier, no auth. The target must answer every request with
#    X-Pivota-Deployment: eval-clone (a plain local gateway does not; see "Safety").
READINESS_EVAL_BASE_URL=http://127.0.0.1:3000 npm run eval:agent-readiness

# 3. Run against the commerce door with an API key. The key comes from env only, never a flag.
READINESS_EVAL_BASE_URL=http://127.0.0.1:3000 READINESS_EVAL_API_KEY=ak_live_… \
  npm run eval:agent-readiness -- --tier commerce

# 4. Compare with an earlier run.
npm run eval:agent-readiness -- --base-url … --diff-against /path/to/previous/results.json
node scripts/agent-readiness-eval/run.cjs diff previous/results.json current/results.json
```

Each run writes into a new directory of its own, `run_<timestamp>_<pid>_<random>`, under `--out`. It
writes three files:

- `results.json`: every call record, per-query scores, metrics, SLO verdicts and the optional diff.
- `scorecard.md`: the scorecard as Markdown.
- `scorecard.html`: the same scorecard as self-contained HTML.

`--out` defaults to the OS temp directory, because results contain measured metrics and **this repository is
public**. A `--out` inside any git checkout is refused.

At start, the run prints its run directory and the path of its KILL file.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Pass: every SLO that is not switched off was measured and met |
| 1 | Fail (an SLO missed), or incomplete (an SLO had no data: switch it off explicitly with `--slo key=off` to accept that) |
| 2 | Refused: config or safety check failed |
| 3 | Aborted: kill switch, failed handshake, missing attestation, a redirect, the wall-clock limit, or the call budget |
| 4 | Fatal error |

## What it does

| Journey | Calls |
|---|---|
| handshake | `initialize` → `notifications/initialized` → `tools/list`. It then reads each tool's `inputSchema` and `annotations`, as a client must. |
| discovery | `search_catalog` once per query in the set, with `market` when the query has one and `page_size` from `--page-size`. Structured price-cap queries also pass `price_max` and `currency`. |
| follow | For the top `--follow-top` results of every in-catalog query (sampled by `--follow-sample`): `get_product`, then `get_offers`, then `get_alternatives`. Each runs only if the tier advertises it. |
| recommend | `recommend_products` for need-shaped prompts, mostly makeup archetypes. Commerce tier only. |
| consistency | Re-runs `--consistency-sample` queries `--consistency-repeats` times and compares the top-k results. |
| load | Off unless `--load` is passed. See [Load mode](#load-mode). |

Tool arguments are built from each tool's advertised schema. Properties the schema does not declare are
dropped and reported, because the gateway refuses undeclared arguments.

**Checkout and order tools are never called.** A tool is callable only if `tools/list` marks it
`readOnlyHint: true`. The server has no dry-run or never-complete mode for checkout, so mutating tools
(`create_checkout_session`, `complete_checkout_session`, `create_payment_link`, …) are listed under *Tools not
called* with that reason.

**Links are never fetched.** Following a `/r` link writes a click row. Product, offer and cart links are
checked for syntax only.

Every request carries `X-Pivota-Synthetic-Traffic: readiness-eval`. Today no server code reads that header. It
is there so the server-side designation has a hook to use.

## Query set

The set lives in `fixtures/queries.v1.json`, which is generated by `fixtures/build_query_set.cjs`. Do not edit
the JSON by hand. A test fails if the JSON and the builder disagree.

It has 301 search queries and 18 recommend needs. Each entry carries **expected properties**: category terms,
ingredient terms, exclusions, brand, price cap and currency. It never names expected products, so it stays
valid as the catalog changes.

| Class | Count | Examples |
|---|---:|---|
| `makeup_shade` | 97 | lipstick shades, foundation by undertone or shade number, blush, eyeliner, concealer, eyeshadow, gloss, bronzer, brow, mascara |
| `skincare_concern` | 53 | "moisturizer for dry skin", "toner for large pores" |
| `skincare_ingredient` | 32 | "niacinamide serum", "ceramide cleanser" |
| `ingredient_bare` | 25 | "retinol", "hyaluronic acid", "玻尿酸" |
| `negation` | 18 | "fragrance-free moisturizer", "alcohol-free toner", "无香精保湿霜" |
| `brand` | 30 | 20 brand-only queries and 10 brand + category queries (globally known consumer brands) |
| `price_capped` | 20 | 14 in USD for US and 6 in SGD for SG. 11 pass a structured `price_max`; 9 say the cap only in text ("under $20") |
| `negative_non_beauty` | 10 | "laptop charger" |
| `negative_nonsense` | 8 | "asdfghjkl", emoji-only |
| `negative_unsafe` | 8 | mercury whitening, prescription-strength bleaching, injectables |

**By language:** 231 queries are in English (`en`). The rest are 12 each in `zh-Hans`, `ja`, `ko`, `fr` and
`es`, plus 10 in `zh-Hant`.

**By market:** 144 queries are for US, 76 for SG and 81 send no market.

To add deployment-specific queries without committing them, use `--query-overlay <json>`. The file holds
`{ "queries": [...], "recommend": [...] }` in the same shape as the main set.

## Scorers

All scorers are deterministic and live in `lib/scorers.cjs`. Each check returns `pass`, `fail` or `unknown`.
`unknown` means the response does not give a partner enough to verify the property. It is reported as the
*unverifiable* share, not counted as a pass.

### Relevance

The score is precision@k (`--top-k`, default 5) over products that pass every applicable check:

- **Category:** a category term must appear in the title or category. The description counts only when the
  product has no category at all.
Term matching needs a word boundary on both sides, and only a plural "s" or "es" may follow the term. So
"lipsticks" matches "lipstick", but "scent" does not match "scentless" and "lip" does not match "tulip".
CJK terms match as substrings.

- **Ingredient:** the ingredient must be *claimed* in the title, actives, INCI list or description. Two kinds of
  mention do not count as a claim:
  - a negated mention (see *Exclusion* below);
  - an "alternative" mention, such as "Retinol Alternative Bakuchiol", "gentler than retinol" or "instead of
    retinol".

  If the product has ingredient data that lacks it, the check fails. If the product has no ingredient data at
  all, the check is unknown.
- **Exclusion (negation queries):** an affirmed mention fails the check. Absence statements are recognized as
  follows:
  - **A cue before the term** scopes forward over a list within the same sentence, up to 8 words. Cues include
    "free of / from", "no", "not", "without", "sans", "sin", "zero" and "0%". So "free of parabens, sulfates,
    and fragrance", "no added fragrance", "made without … fragrance" and "does not contain fragrance" each
    count as free of every listed item.
  - **The scope ends** at a word that reintroduces content ("with", "but", "contains", …) or at a sentence end.
    So "free of parabens with a rose fragrance" still contains fragrance.
  - **A cue after the term:** "X-free" and "A and X free".
  - **CJK cues:** "无 / 無 / 不含 X", "X フリー" and "무X".
  - **"unX" and "Xless":** for example "unscented" and "scentless".
  - **Benign compounds** are ignored, so "cetyl alcohol" does not break "alcohol-free".
- **Brand:** the brand field must match, or the title must start with the brand.
- **Price cap:** the amount must be at or under the cap *and* in the requested currency. If the price is
  missing, or either currency is missing or invalid, the check is unknown, never a pass.

A query passes relevance when its precision is at least `--query-pass-threshold` (default 0.6).

### Other checks

- **Zero-result rate:** measured over in-catalog classes. Empty pages are split by the class the response
  states: `empty_reason` (public tier: `no_match`, `filtered_out`, `upstream_degraded`), or in `metadata`:
  `strict_empty_reason`, `products_empty_reason`, `reason`, or a future `empty_class`. Pages that state no
  class count as `unspecified`.
- **Negative controls:**
  - `non_beauty` and `nonsense` pass only on an empty page.
  - `unsafe` passes if the page is empty, or if no row affirmatively names the hazard ("mercury-free"
    passes).
- **Row integrity:** checked on search rows, the PDP, offers, alternatives and recommendations:
  - The price must be present, positive, and in a valid ISO currency.
  - The currency must match the market: US→USD, SG→SGD.
  - Rows for queries with **no market** are still checked for price and link, and their currencies are
    recorded. If those rows come back almost all in USD, the scorecard's *Findings* section reports that the
    service silently defaults to the US market. Pages that mix currencies are also reported. The harness
    itself never defaults a market.
  - The link must be present and well-formed: http(s), a real host, and no
    `undefined`/`null` path segments.
- **Duplicates:** the same product id, or the same brand + title, appearing twice on one page.
- **Shade/variant presence:** for shade queries, whether a search row or PDP exposes variant or shade names.
  This is informational.
- **Failed envelopes with hits:** a degraded response (`status` ≠ success, `success: false`, or an `error`)
  that still carries products. Both facts are kept.
- **Consistency:** Jaccard similarity of the top-k ids against the first run of the same query. The query is
  stable if Jaccard ≥ 0.8. Identical ordering is reported separately.
- **Offer vs search price:** the search row price is compared with the best (or first) offer, in the same
  currency only, within `--price-tolerance` (default 5%).
- **Chain resolve:** the search id resolves on `get_product`.

### Optional LLM judge

The judge is off by default and enabled with `--judge-module <path>`. The module exports
`async judge(payload) -> { scores: number[] }`.

`lib/judge.cjs` builds the payload, and the module receives only that: the query text, its language and
market, and, for each product, title, brand, category, up to 5 actives, and price. It never sees ids, links,
merchant identifiers or raw responses. `judges/example_keyword_judge.cjs` is an offline template.

## SLOs

Override any threshold with `--slo key=value`, or `--slo key=off` to make it informational.

| Key | Default | What it means |
|---|---|---|
| `availability_min` | ≥ 99.5% | Calls that got a JSON-RPC answer. Failures are transport errors, timeouts, non-2xx HTTP, unparseable bodies and JSON-RPC errors. 429s and 401/403s are counted and shown separately: a 429 is a configured limit working, and a 401/403 is a harness config problem. |
| `tool_error_rate_max` | ≤ 1% | Tool results with `isError: true`. Codes are listed in the scorecard. |
| `search_p95_ms_max` | ≤ 3000 ms | Client-side p95 of `search_catalog` in discovery, from request sent to body complete. Time to first byte is recorded too. The gateway's edge heartbeat commits headers early, so first byte can be far below latency. |
| `in_catalog_zero_result_rate_max` | ≤ 10% | Empty pages on in-catalog classes, split by stated empty class. |
| `relevance_pass_rate_min` | ≥ 90% | In-catalog queries with a non-empty page that pass deterministic relevance. |
| `currency_market_mismatch_max` | 0 | Priced rows a buyer would see (search, PDP, offers) whose currency is not the market's. |
| `missing_price_max` | 0 | Rows a buyer would see whose price is missing, non-positive, or has an invalid currency. |
| `missing_link_max` | 0 | Rows a buyer would see whose link is missing or malformed. |
| `negative_control_pass_rate_min` | ≥ 90% | Added: negative controls handled. |
| `duplicate_query_rate_max` | ≤ 5% | Added: non-empty pages that contain a duplicate. |
| `consistency_stable_rate_min` | ≥ 90% | Added: repeated queries that are stable. |
| `offer_search_price_agreement_min` | ≥ 90% | Added: offer price agrees with search price. |
| `chain_resolve_rate_min` | ≥ 98% | Added: search ids that `get_product` resolves. |

An SLO with no data shows as `NO_DATA`. One unmeasured SLO makes the whole verdict `incomplete`, never
`pass`. For example, `get_offers` does not exist on the public tier, so run that tier with
`--slo offer_search_price_agreement_min=off`.

Every metric is also broken down **per tool**, **per query class**, **per language** and **per market**.

## Safety caps

- **Target allowlist (`lib/safety.cjs`):** an allowlist, never a denylist.
  - Allowed: loopback IP literals (127.0.0.0/8 and `::1`), over http or https.
  - Allowed: exact hostnames in the compiled-in `EVAL_CLONE_HOSTS`, https only. **The list is empty today.**
    A clone host is added in a reviewed change once the clone exists and is verified to have its own
    attribution tables and no merchant egress.
  - Everything else is refused, including:
    - names that need resolving, such as `localhost`, `*.localhost`, `*.test` and `*.nip.io`
    - Cloud Run service and revision URLs, and hosting-provider default domains
    - IP literals in any spelling other than loopback
    - URLs carrying credentials
  - The final endpoint is judged, not just the base URL, so an MCP path cannot move the host.
  - The client re-checks the endpoint at construction, so removing one guard does not open the network.
  - Allowed: `commerce.mcp.pivota.cc` (`PROD_SYNTHETIC_HOSTS`), https, no port, as the eval client only
    ([target C](#c-production-as-our-eval-client---target-kind-prod-synthetic)).
  - `--target-kind` must match: `local` for loopback, `prod-clone` for a clone host, `prod-synthetic` for
    production.
- **Deployment attestation:** every response must carry `X-Pivota-Deployment: eval-clone` (loopback and
  clone) or `X-Pivota-Synthetic: enforce` (production).
  - The first response without it halts the client, and nothing more is sent. One request reaches the
    target at most.
  - This is what defeats a loopback port that is forwarded or tunnelled to production.
  - Only the clone deployment, or a local test stub, may set the header. A plain local gateway does not set
    it. To run against one, put a loopback wrapper in front that adds it, as
    `tests/agent_readiness_eval/real_gateway_e2e` does.
- **Redirects are never followed.** Requests use `redirect: 'manual'`, and a 3xx halts the client.
- **Removed flags:** `--host-header`, `--allow-remote-target` and `--synthetic-flag-ack` are hard errors, as
  flags or as env vars.
- **Hard caps:** these are compiled in. Config can lower them but never raise them.

  | Cap | Value |
  |---|---|
  | Load rate | ≤ 20 rps |
  | Discovery start rate (`--rps`, default 4) | ≤ 50 rps, shared by all workers |
  | Run wall clock (`--max-wall-seconds`, default 3600) | ≤ 4 h |
  | Concurrency | 1–32, integer |
  | Load requests | ≤ 5000 |
  | Load duration | ≤ 900 s |
  | Calls per non-load run | ≤ 20000 |
  | Timeout | 1–120 s |
  | Pacing | ≥ 1 ms |

  Every numeric option is range-checked, and out-of-range or negative values are refused.
- **Tool allowlist:** `McpClient.callTool` will only ever call `search_catalog`, `get_product`, `get_offers`,
  `get_alternatives` and `recommend_products`; on production, only the first four. The list is compiled in and
  checked before any I/O.
- **Kill switch:** any of these stops the run.
  - Create the KILL file printed at start (or `--kill-file`).
  - Press Ctrl-C or send SIGTERM.
  - Have the load breaker trip.
  - Have a client halt.
  - Set `READINESS_EVAL_KILL=1`, which stops the run before anything is sent.

  Stopping also aborts in-flight requests through a run-wide AbortSignal. A **second** Ctrl-C or SIGTERM exits
  at once with code 130.
- **Secrets:** API keys, bearer tokens and caller keys come from env only. `--caller-keys`, `--api-key` and
  `--bearer-token` are refused. Secrets are sent only in auth headers and never written to logs or results.
  Load callers are identified by `caller_N` plus an 8-character hash.

## Load mode

Load mode is disabled by default. Pass `--load` to enable it.

- **Ramp:** the request rate rises linearly from `--rps-start` to `--rps-end` over `--ramp-seconds`, then
  holds for `--hold-seconds`.
- **Per-caller identity:** set `READINESS_EVAL_CALLER_KEYS=key1,key2,…` to open one MCP session per key.
  Arrivals are spread round-robin across the sessions, which exercises per-caller rate limits the way several
  partners would. The scorecard shows 429s, failures and p95 per caller.
- **Open loop:** an arrival that finds `--load-concurrency` requests already in flight is dropped and recorded
  as `client_saturated`, not queued. This keeps latency honest by avoiding coordinated omission.
- **Stopping:** the run stops at schedule end, at `--max-requests`, on the kill switch, or when the error
  breaker trips. The breaker trips when the unavailable share of the last `--breaker-window` calls is at least
  `--breaker-error-rate`.

Load mode only calls `search_catalog`.

## Target options

The harness only needs a base URL, an MCP path and credentials. Which environment it runs against is decided
separately, from these two options.

### A. Prod-data clone (recommended first)

This is a gateway and backend stack pointed at a copy of production catalog data, with no merchant egress.
Its click and attribution tables are disposable. Before the harness will address it:

1. Add the clone's exact hostname to `EVAL_CLONE_HOSTS` in `lib/safety.cjs`, in a reviewed change.
2. Make the clone, and only the clone, answer every request with `X-Pivota-Deployment: eval-clone`.
3. Check that the clone does not share production's attribution or click tables, or anything that reports
   them.
4. Check that merchant egress is blocked, or that the live-read flags are off. The live-read flags are
   `UCP_LIVE_*_READ`, `UCP_LIVE_PDP_REFRESH`, `SERVE_LIVE_MERCHANT_PRICE`, `GET_OFFERS_LIVE_CART`,
   `MERCHANT_VARIANT_SOURCING_ENABLED`, and the backend's live offer verification.

```bash
READINESS_EVAL_BASE_URL=https://<clone-host> READINESS_EVAL_API_KEY=… \
  npm run eval:agent-readiness -- --tier commerce --target-kind prod-clone
```

### B. Production with a synthetic-traffic designation

This is target C below: production marks our own eval OAuth client synthetic
([synthetic callers](synthetic_callers.md)), rather than an API key or agent.

### C. Production as our eval client (`--target-kind prod-synthetic`)

The harness calls the production commerce door, `https://commerce.mcp.pivota.cc/mcp`, with an access token
our authorization server issued to the eval client listed in the gateway's `SYNTHETIC_CALLERS_JSON`. In
`enforce`, production serves that client read tools only, with no writes and no live merchant reads, and says
so on every response with `X-Pivota-Synthetic: enforce`. Prices, offers and latency from such a run are not
representative of live reads (decision A2).

**Sign in once.** The authorization server grants `authorization_code` and `refresh_token` only, so a person
signs the eval client in through a browser. The issuer, the endpoints, the resource and the loopback redirect
(`http://127.0.0.1:8765/callback`) are compiled into `lib/oauth.cjs`. The client id and secret come from the
environment only. The token is stored at `~/.pivota-eval/oauth-token.json` (0600, refused inside any git
checkout; `--token-file` to move it), and nothing secret is printed.

```bash
READINESS_EVAL_OAUTH_CLIENT_ID=<eval client id> \
READINESS_EVAL_OAUTH_CLIENT_SECRET="$(gcloud secrets versions access <version> --secret=<eval client secret> --project=<project>)" \
  node scripts/agent-readiness-eval/oauth-login.cjs
```

Later runs refresh the token themselves when less than 55 minutes of it is left, so a run never outlives its
token. The refresh needs the same two variables.

**Check the classification (observe or enforce).** This sends `initialize` and `tools/list` only, and never
calls a tool. It passes when every response carries `X-Pivota-Synthetic: observe` or `enforce`, and
`tools/list` offers exactly the five read tools. Run it in `observe` to prove the token is the listed client
before `enforce`: it adds `synthetic_classified` lines, and nothing else.

```bash
npm run eval:agent-readiness -- --target-kind prod-synthetic --tier commerce --auth bearer \
  --base-url https://commerce.mcp.pivota.cc --check-classification
```

**Canaries first (enforce only).** `--canary <tool>` makes ONE `tools/call` after the full preflight below,
prints when it ran and what came back (never the payload), and stops. The arguments are flags, and each tool
takes exactly these. `market` is never sent.

| Tool | Flags |
|---|---|
| `get_alternatives` | `--canary-merchant-id`, `--canary-product-id` |
| `get_product` | `--canary-merchant-id`, `--canary-product-id` |
| `search_catalog` | `--canary-query` |
| `get_offers` | `--canary-merchant-id`, `--canary-product-id` |

Take the ids from a read-only database lookup, never from a production search. Run the tools in the order of
[the rollout](synthetic_callers.md#order-of-rollout), and check each tool's log lines before the next.
Exit 0 means the call answered. 1 means it failed or the tool answered an error (`error_code`). 3 means the
answer was not marked `enforce`.

```bash
npm run eval:agent-readiness -- --target-kind prod-synthetic --tier commerce --auth bearer \
  --base-url https://commerce.mcp.pivota.cc \
  --canary get_alternatives --canary-merchant-id <merchant id> --canary-product-id <product id>
```

**Run (enforce only).** Before any tool call, the preflight (`lib/prodSynthetic.cjs`) refuses unless:

1. the token is fresh;
2. `gcloud run services describe`, under your own credentials, shows the gateway in `enforce`, and the gateway
   and the backend mounting the **same pinned version** of `SYNTHETIC_ASSERTION_SECRET`, each from its latest
   revision, Ready and serving all traffic;
3. `initialize` carries `X-Pivota-Synthetic: enforce`, and `tools/list` offers exactly the five read tools.

After that, the first response not marked `enforce` halts the run, and nothing more is sent. The run caps are
lower than the hard caps: at most 2 workers, 1 rps, 200 queries and 3000 s (one access token). There is no
load mode, and no `recommend` journey (`recommend_products` is not a synthetic tool).

```bash
npm run eval:agent-readiness -- --target-kind prod-synthetic --tier commerce --auth bearer \
  --base-url https://commerce.mcp.pivota.cc \
  --journeys discovery,follow,consistency --rps 1 --concurrency 1 --limit 20 --max-wall-seconds 1800
```

**Reconcile afterwards**, over the run's start and finish times (`results.json`):

- the gateway's `mcp tools/call complete` lines with `synthetic: true` equal the tool calls the run made;
- the backend's `synthetic_assertion_accepted` lines are at least that many (one call can make several hops);
- the backend's `synthetic_assertion_rejected` count is 0;
- no outcome line from the eval client lacks `synthetic: true`.

## Tests

```bash
node --test tests/agent_readiness_eval/*.node.test.cjs
```

| File | Covers |
|---|---|
| `responses_framing` | MCP framing (JSON, SSE, heartbeat-padded bodies, every failure class), reading both doors' result shapes, empty-class parsing, failed-with-hits. Uses hand-made fixtures. |
| `scorers` | Relevance rules, negation, currency, price, link, duplicates, consistency, price agreement, negatives. |
| `net_guard` | The loopback-only network guard every eval test installs first: fetch/undici, http/https, net/tls and DNS are all refused for non-loopback targets. |
| `safety_config_queryset` | Target allowlist (including every bypass seen on 2026-10-20), hard caps, kill switch, secret redaction, schema-driven arguments, read-only tool policy, SLO evaluation, judge data boundary, query-set composition and builder sync. |
| `stub_mcp_e2e` | The CLI over HTTP against a stub server built from the gateway's own MCP adapter and tool surfaces, over an invented catalog with planted defects. Proves each defect is caught, checkout tools are never called, no link is fetched, per-caller 429s are attributed, and dry-run makes no requests. |
| `real_gateway_e2e` | The CLI against the real `src/server.js` on a local port. Only the loopback search hop is stubbed with nock, and all external network is disabled. |
| `prod_synthetic_target` | Target C against a fake door, a fake token endpoint and a fake `gcloud`: the allowlist entry and its caps, the `X-Pivota-Synthetic` halt, the four-tool restriction, PKCE, the token exchange, refresh and file, the loopback callback, every preflight refusal, the canary's arguments and its single call, and the CLI's check and refusal paths. Nothing reaches production. |
