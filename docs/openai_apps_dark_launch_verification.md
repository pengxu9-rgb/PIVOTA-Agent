# PR-7 — Dark-launch verification runbook (public read MCP tier)

**Purpose:** the final gate before submitting the ChatGPT app. Prove the public read tier works correctly
against a live, reachable endpoint — automated shape/leak/latency checks + manual MCP Inspector and ChatGPT
web/mobile runs + the 3 submission screenshots. Companion to `docs/openai_apps_submission_materials.md`.

## Preconditions (must all be true before running)

- [ ] The 6-PR code stack (#1741–#1746) is **merged and deployed** to the `PIVOTA-Agent` service.
- [ ] `PUBLIC_READ_MCP_ENABLED=1` on the service. (Optionally `PUBLIC_READ_MCP_HOSTS=mcp.pivota.cc`.)
- [ ] Intel flags on: `AURORA_BFF_PRODUCT_INTEL_AGENT_ENABLED`, `AURORA_BFF_RELATIONSHIP_GRAPH_AGENT_ENABLED`
      (both verified on 2026-07-10) and **`AGENT_INTEL_PUBLIC_CLAIMS_ENABLED=1`** (set 2026-07-10 — the
      cited-claims differentiator).
- [ ] Endpoint reachable: either `https://mcp.pivota.cc/mcp` (after DNS) or, pre-DNS,
      `https://pivota-agent-production.up.railway.app/public/mcp`.

## Step 1 — Automated verifier (`scripts/verify_public_read_mcp.mjs`)

Runs all the automatable acceptance criteria and exits non-zero on any hard failure.

```bash
# Pre-DNS (direct service, dedicated path):
node scripts/verify_public_read_mcp.mjs \
  --base https://pivota-agent-production.up.railway.app --path /public/mcp

# Post-DNS (branded origin, the real submission URL):
node scripts/verify_public_read_mcp.mjs --base https://mcp.pivota.cc

# Host-dispatch check (branded host routed onto /mcp):
node scripts/verify_public_read_mcp.mjs \
  --base https://pivota-agent-production.up.railway.app --path /mcp --host mcp.pivota.cc
```

**Hard checks (must PASS):** `initialize` → serverInfo.name=pivota + negotiated protocol; `tools/list` = exactly
the 4 read tools with `readOnlyHint:true`/`openWorldHint:false` and read-only descriptions; `get_product`
required=`[product_id]`; `search_catalog` returns `structuredContent.products`, **no denylisted field / timestamp
leaks**, within the ~25 KB budget, **no reseller URL** in any `pivota_url`, latency < 3s; `get_product` by bare
sig echoes `product_id` and drops `merchant_id`; a commerce/write tool (`create_checkout_session`) is **absent**
(→ `UNKNOWN_TOOL`).

**Differentiator check:** `get_intel` returns cited claims (`claims[].citations`) — this is the live proof that
`AGENT_INTEL_PUBLIC_CLAIMS_ENABLED` is on and the app actually cites Pivota. (Emitted as a WARN, not a hard
fail, so a product that legitimately has no reviewed intel doesn't red the run — but on a well-covered query it
should PASS.)

> **Prep validation (2026-07-10):** the verifier was run against a local boot of the app (test mode, public flag
> on). 9/10 checks passed; the only failure was `search_catalog` returning no products — expected, because the
> local boot has no reachable catalog backend. That confirms the structural checks and the mount are correct and
> that the data-dependent checks fire properly; they turn green against prod's real backend.

## Step 2 — MCP Inspector (manual)

Point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at the same URL (no auth). Confirm:
all 4 tools list with annotations; each tool call renders `structuredContent`; no errors/hangs.

## Step 3 — ChatGPT developer mode (manual, web AND mobile)

Add the connector in ChatGPT developer mode and run the `docs/openai_apps_submission_materials.md` §3 test
prompts on **both** web and mobile:
1. "Find a niacinamide serum for dark spots under $30." → product list, no reseller listings.
2. "Is there evidence that niacinamide helps with dark spots?" → graded claims with **visible citation URLs**.
3. "Show me a cheaper alternative to [product]." → alternatives with price comparison + tradeoffs.
4. "Give me the full details and ingredients for [product]." → detail via bare `product_id`.

Confirm: results are relevant, render cleanly on both surfaces, no crash/hang, latency acceptable.

## Step 4 — Screenshots (for submission)

Capture from Step 3 at the dashboard's required dimensions: (1) search results, (2) cited-intelligence answer
with citation URLs, (3) alternatives comparison. Save for the submission form.

## Sign-off

| Check | Result | Date |
|---|---|---|
| Automated verifier (Step 1) — all hard checks pass | ☐ | |
| get_intel cited-claims check passes on a covered query | ☐ | |
| MCP Inspector — 4 tools, structuredContent, no errors | ☐ | |
| ChatGPT dev mode — all 4 prompts pass on **web** | ☐ | |
| ChatGPT dev mode — all 4 prompts pass on **mobile** | ☐ | |
| Screenshots captured (3) | ☐ | |

When every row is checked, the app is ready to submit via the Platform Dashboard
(`docs/openai_apps_submission_materials.md` §6).
