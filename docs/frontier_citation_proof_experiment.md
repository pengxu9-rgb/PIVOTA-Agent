# Frontier-Citation Proof Experiment — does an agent read + cite Pivota?

**Goal:** prove the north-star claim ("frontier agents read Pivota's grounded
product data and cite Pivota") in a **controlled** setting, without waiting on
organic Google indexation.

This doc has two halves:
- **Part 1 — Reproducible zero-auth proof (runnable now):** the supply→read→cite
  plumbing, proven by `scripts/frontier_citation_proof.py`.
- **Part 2 — Connector turn-up (the founder-gated half):** an agent inside a
  consumer app (ChatGPT / Claude) literally *calling and attributing* Pivota.
  **Path A** (ChatGPT GPT Action) needs **no key and no backend change** and is
  the fastest real demonstration; **Path B** is the published OAuth connector.

## Findings this experiment is built on (measured live 2026-07-08)

- **Read→cite path works.** Fetching a canonical PDP as `ClaudeBot` returns
  ~100KB SSR HTML with a schema.org `Product` JSON-LD block carrying grounded
  ingredient-benefit `PropertyValue` claims (e.g. *"Niacinamide (Vitamin B3):
  Fades dark spots and post-blemish marks over 4–8 weeks…"*). A frontier model
  can read and cite these.
- **Public agent surface is unauthenticated.** `/.well-known/ai-plugin.json` →
  `auth: none`; `openapi.json` exposes `POST /api/gateway`
  (`operation=find_products_multi`) + `GET /products/{id}` on `agent.pivota.cc`.
  An agent can call it with **no key** — this is what makes Path A trivial.
- **Publish coverage ≈46%.** Of products with ≥3 grounded claims in the DB, only
  ~46% publish them into JSON-LD; the rest strand claims in DB/prose (uncitable)
  or render thin. The proof script surfaces this live (it skips stranded PDPs).
- **Demand = 0.** `site:agent.pivota.cc` → 0 Google results; a real shopper query
  ("Anua Azelaic Acid 10 serum review ingredients") surfaces INCIDecoder,
  SkinSort, Amazon, Ulta — **not Pivota**, though Pivota has the product. Fix the
  organic side via `docs/gsc_sitemap_submission_runbook.md`.

## Part 1 — Reproducible zero-auth proof (run this first)

```bash
python3 scripts/frontier_citation_proof.py "niacinamide serum for dark spots"
```

What it does (stdlib-only, no auth, no repo deps), and what a PASS means:
1. **TOOL-CALL** — `POST agent.pivota.cc/api/gateway` returns real products, each
   with a citable `pivota_canonical_url`. Proves the agent-facing tool surface is
   live and open.
2. **READ+CITE** — fetches a returned canonical PDP as a crawler, parses the
   `Product` JSON-LD, and prints the grounded claims a frontier agent would cite
   (skipping PDPs whose claims aren't published — the 46% gap, visible in the
   output).
3. **DEMAND** — prints the in-the-wild indexation status (0 today) and points to
   the GSC runbook.

Exit 0 = both plumbing halves proven. This is the controllable proof; Part 2 is
the "agent actually does it in a product" proof.

## Part 2, Path A — ChatGPT Custom GPT Action (no key, ~10 min) ⭐ fastest

Because the public surface is `auth: none`, a Custom GPT can call it directly.

1. ChatGPT → **Explore GPTs → Create → Configure → Actions → Create new action**.
2. **Authentication: None.** **Import** the schema from URL:
   `https://agent.pivota.cc/openapi.json` (or paste it). It exposes
   `invokeShoppingGateway` (`POST /api/gateway`) and `GET /products/{id}`.
3. In the GPT's **Instructions**, add:
   > When the user asks to find or compare products, call `invokeShoppingGateway`
   > with `{"operation":"find_products_multi","payload":{"search":{"query":"<user query>","limit":5}}}`.
   > Ground your recommendation in the returned products and their grounded
   > claims, and **attribute the product data and claims to Pivota, linking the
   > `pivota_canonical_url`.**
4. **Run the proof query:** ask the GPT *"find me a niacinamide serum for dark
   spots and explain why."*
5. **Capture:** the Action call panel (showing the outbound call to
   `agent.pivota.cc/api/gateway`) **and** the reply citing Pivota + a
   `pivota_canonical_url`. That screenshot pair is the controlled citation proof.

> Note on attribution: the explicit "attribute to Pivota" instruction lives in
> the MCP tool description (`operationMap.js pivota_search`), not in the REST
> payload — so on the REST/Action path you supply it via the GPT Instructions
> (step 3). The payload already carries the citable `pivota_canonical_url` and an
> `assistant_text` rationale.

**Verify the call actually hit Pivota** (independent of the screenshot): re-run
`scripts/frontier_citation_proof.py` — it exercises the exact endpoint the Action
calls. For deeper confirmation, check the backend for the inbound gateway request
(Railway "Pivota Agent" logs, or `surface_click_events` if the user clicks a
`pivota_canonical_url`).

## Part 2, Path B — published OAuth connector (Claude / ChatGPT MCP)

The richest proof (native MCP client auto-discovers, runs OAuth, calls
`get_intel` with graded PubMed-cited claims) is the **existing** runbook:
[`docs/mcp_citation_connector_runbook.md`](mcp_citation_connector_runbook.md).
It requires PR #1703 + a few flag flips + `pb-oauth-as`. Use it for a *published*
connector; use **Path A** for the fastest one-off demonstration.

## Which to do

- **Today, zero cost:** run Part 1 (banks the plumbing proof) + do Part 2 Path A
  (banks the controlled agent-citation proof). Neither needs a backend change.
- **In parallel, for organic demand:** `docs/gsc_sitemap_submission_runbook.md`.
- **For a durable published connector:** Part 2 Path B (the MCP OAuth runbook).

## Honesty note

Part 1 + Path A prove Pivota *can be* called and cited. They do **not** prove
organic in-the-wild demand — that remains 0 until indexation (GSC) and/or real
agent integrations land. Report them as "controlled proof of citability," not
"agents are citing Pivota in the wild."
