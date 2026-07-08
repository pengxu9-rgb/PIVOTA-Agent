# Automation Frontier — Decision Brief (#3)

Status: **DECISION PENDING** (2026-06-21). Grounded in deployed `pivota-backend` origin/main @ `2fd5f83f` via a 2-agent investigation (workflow wf_b2fd4032-671). The moat being grown: *"Pivota measurably improves AI-readiness with **zero merchant work**"* — true today on exactly **one** surface (the Pivota-owned canonical PDP, via E1). #3 decides whether that moat **widens**, and how.

Prereq context: the two trust seams are now closed — #968 (factual gate before E1 publishes, **merged + live**) and #970 (verify-coverage disclosure, **merged**). So the owned-surface auto-publish path is now safe-by-construction; #3 is about extending automation **beyond** it.

---

## The reframe

Neither option is "flip a flag" or "build the CMS." Both are more nuanced:

- **Option A (GSC indexing)** is *two* flags, and the obvious one is the **wrong** one. The real lever is code-complete but blocked on **non-code** prerequisites + an **unrun experiment**.
- **Option B (write to the merchant's own store)** has **no write path at all today**, a real multi-platform build, and an App-Store-review risk — but a **cheaper middle path** captures most of the value at a fraction of the risk.

---

## Option A — Get Pivota's canonical PDPs indexed by Google (GSC)

**What it is.** Submit Pivota's own canonical PDP URLs (`agent.pivota.cc/products/sig_*`) to Google's Indexing API so they get crawled/indexed faster → more discoverable → more likely to be the page a frontier agent or search surface cites.

**The trap — two flags:**
- `gsc_integration_enabled` (the per-merchant OAuth path) is built for the **wrong principal**: it submits Pivota URLs under the *merchant's* Google token, but Google only accepts submissions from a verified **owner** of the URL's property. A merchant doesn't own `agent.pivota.cc` → **HTTP 403 loop** on every audit. **Do not flip this one.** (ADR-006 documents exactly this.)
- `gsc_pivota_submit_enabled` (Pivota service-account path) is the **correct** lever — Pivota's own service account submitting Pivota's own URLs. Code-complete, tested, wired to a real human-click CTA (`POST /sku/request-indexing`).

**What blocks the correct lever (non-code):**
1. Stand up a Pivota service account, enable the Indexing + Search Console APIs, and add it as a **verified owner** of `agent.pivota.cc` (external GCP/GSC ops; has lead time). Env vars `GSC_PIVOTA_SERVICE_ACCOUNT_JSON` + `GSC_PIVOTA_PROPERTY_URL` are empty in-repo.
2. **Run the ADR-006 go/no-go spike** (the long pole, ~1–2 weeks *calendar*): submit real `sig_*` URLs, hold a control set, measure whether the test set indexes materially faster. **Why it matters:** Google's Indexing API is *officially* scoped to `JobPosting`/`BroadcastEvent` only — it **may silently ignore product URLs** (200 OK, no effect). Flipping before the spike risks shipping a "we submitted this to Google" claim that does nothing — the exact over-promise ADR-006 exists to prevent.

**Effort:** M, but mostly **ops + a calendar experiment**, not engineering. **Reversibility:** HIGH (single env flip-back, fail-closed to the deterministic self-serve checklist). **Risk if done right:** low (Pivota's own URLs; quota-guarded ≤25/run, 23h idempotency — though no global cross-merchant daily cap on the 200/day project quota).

**Open unknown (operational, not in repo):** whether the service account / env vars are already configured and whether the spike has been run — that state lives in Railway. **Confirm before deciding.** (The DB side — have any `sig_*` URLs been submitted + their index status — is checkable read-only.)

**Bottom line:** the unblocking action isn't "flip" — it's **"run the spike"** (after the ops setup). Cheap, reversible, owned-surface, safe — *if* Google honors product URLs.

---

## Option B — Write generated content to the merchant's OWN store PDP

**What exists today: nothing.** Every merchant-catalog integration is **read/pull-only** (ingest). The content-brief executor produces a **draft only**. E1 writes the **Pivota-owned** PDP, explicitly *not* the merchant's store. The only external write capability anywhere is **order writeback** (creating an order after checkout) — not product/content.

**What a real build needs:**
- A per-platform **write client** (Shopify `productUpdate`/`metafieldsSet`, Wix product PATCH, Woo/BC each their own) — **N separate builds**.
- **`write_products` scope** added to the public Shopify app → **forces re-consent from every installed merchant** and a **new App Store review** (the app's read-only scopes are a load-bearing review property today; write scopes get scrutinized harder).
- Live-store **safety guardrails** + provenance (so re-runs don't clobber hand-tuned merchant copy).

**Dominant risk:** writing wrong/unverified copy to a merchant's **LIVE storefront** — overwrites brand copy, breaks SEO, shows a factual error to real shoppers. On Pivota's owned PDP that's recoverable (and now factually gated by #968); on the merchant's live store it is not. This is a much bigger trust leap than the owned surface.

**Effort:** M per platform + L for the cross-platform publish abstraction. Multi-platform fan-out = recurring N-platform maintenance.

**The cheaper middle path (recommended to evaluate first)** — all reuse the existing E1 grounded-content engine, no new content infra:
1. **Richer one-click copy-back** — surface finished E1-quality copy in the portal + a deep-link to the Shopify admin product; merchant pastes + saves. **No scope change, no review risk. S.**
2. **App-owned metafield the merchant approves** — write to a Pivota-namespaced metafield (never the live `body_html`); needs `write_products` but **never overwrites merchant copy**; reversible. **S–M.**
3. **Preview-then-publish draft** — write a draft / hold copy, render a side-by-side preview, `productUpdate` the live copy only on explicit merchant click. **M, safest way to ever touch live copy.**
- Reuse the existing `platform_order_writeback_readiness` **disabled→canary→enabled** state machine + global kill switch for content; pilot via the **headless/custom app** (already holds write scopes, not App-Store-reviewed) to sidestep review entirely.

---

## Recommendation (the call is the founder's)

1. **Option A: authorize the spike, not a blind flip.** First confirm the prod/ops state (service account + env vars + whether the spike already ran). If not done: do the GCP/GSC ownership setup, run `validate_pivota_indexing.py`, wait ~1–2 weeks, and flip `gsc_pivota_submit_enabled` **only if** the test set indexes faster. Leave `gsc_integration_enabled` **off**. Low risk, reversible, grows the owned-surface moat — *contingent on Google honoring product URLs.*
2. **Option B: do NOT build the full live-store write path now.** Pursue the **middle path** (copy-back → app-owned metafield → preview-publish), piloted on the headless app, behind a canary state machine. It reduces merchant work without the live-store blast radius or App Store relisting risk. Revisit full auto-publish-to-live only after the factual-gate primitive (#968) is proven and a preview-approve UX exists.

**Why this split:** A is cheap/reversible/safe and pure owned-surface — but its *value* is unproven (the spike answers that). B is where "zero merchant work" expands most, but full auto-write to a live store is the highest-blast-radius thing Pivota could do — the middle path gets most of the benefit at a fraction of the risk.

**The decision to make now:** (a) green-light the GSC spike (pending a prod-state check), (b) pick a middle-path rung for B to scope next, or (c) both / neither.

---

## PROD-STATE CHECK (2026-06-21, read-only) — the spike already ran, and it looks like a NO

Confirmed against the live DB (read-only) + a web-index check, this **materially refines Option A**:

- **`gsc_oauth_tokens`: 1 row — Chydan** (`merch_efbc46b4619cfbdf`), scopes `webmasters`+`indexing`, **`authorized_site_url = https://agent.pivota.cc/`**, granted 2026-05-08, not revoked. So a Google account that is a **verified owner of agent.pivota.cc** completed the OAuth flow — meaning submissions under it are **accepted, not 403'd**. The brief's central "403 loop / wrong principal" fear **does not apply to this setup** (the per-merchant token here owns the Pivota property).
- **`gsc_url_submissions`: 5 rows, all `agent.pivota.cc/products/sig_*`, all `last_status=submitted`, no errors, submitted 2026-05-08 → 05-14.** So the experiment was *started*: 5 canonical PDP URLs were accepted by Google's Indexing API ~6 weeks ago.
- **But all 5 have `indexed_at = NULL`**, and **`site:agent.pivota.cc/products` returns zero web-index results** today. The pages **serve fine** (HTTP 200, real PDP content) but render **client-side** ("Loading products" before hydration).

**Read:** the go/no-go spike effectively ran and matured (6 weeks) with a **negative-to-null result** — submitting product URLs to Google's Indexing API (officially JobPosting/BroadcastEvent-only) did **not** get them indexed, exactly the ADR-006 risk. (Caveat: the web-search engine isn't guaranteed to be Google; the *definitive* confirmation is a Google URL Inspection API call on the 5 `sig_*` URLs, or a manual `site:` in Google — but `indexed_at=NULL` + zero `site:` results is a strong negative signal.)

**CORRECTION (verified 2026-06-21) — it is NOT a rendering problem.** Direct inspection of the live PDP raw HTML (fetched as Googlebot) disproves the client-side-rendering hypothesis: the page is **server-rendered** (Next.js SSR) with `<title>`, meta description, full product content, and JSON-LD all in the first-pass HTML; `<meta name="robots" content="index, follow">` (no noindex); robots.txt allows Googlebot (`User-Agent: *` Allow `/`); and `sitemap-products.xml` lists **6,386** product URLs. All technical SEO fundamentals are correct — "Loading products" is a transient/secondary state, not a crawl blocker. The non-indexing is therefore **domain authority + scale** (a young domain seeking to index 6,386 pages → Google "Crawled/Discovered – currently not indexed"), NOT a code/rendering fix. And the design is deliberately **AI-crawler-first** (GPTBot/ClaudeBot/Google-Extended explicitly courted on `/products/`); for the "frontier agents cite Pivota" thesis the live channel is the agent JSON API + AI crawlers, not Google web-search — so weak Google indexing may not matter. This *strengthens* the "deprioritize A" call: there is no technical lever (Indexing API or SSR) that fixes it; only authority does.

### Revised recommendation
- **Option A: deprioritize.** Don't invest in the service-account ops setup to *scale* a lever the evidence says isn't indexing anything. Optional cheap confirmation: one URL Inspection API call (creds permitting) or a manual Google `site:` check. If a real fix is wanted, the higher-leverage diagnostic is **why the PDP isn't indexed** (client-side rendering / SSR for crawlers) — a findability fix, not the Indexing-API bet.
- **Option B: this is now the clearer automation-frontier move.** With A looking like a dud, the merchant-store **middle path** (richer copy-back → app-owned metafield → preview-publish) is where "less merchant work" actually grows. Recommend scoping the **copy-back rung** (S, no scope change, no App Store risk) first.

**Net:** the automation frontier is **B's middle path**, not A. A's "submit to Google" lever was already tried and shows no indexing payoff.
