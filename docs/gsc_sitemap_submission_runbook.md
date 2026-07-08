# GSC Sitemap Submission Runbook — start Google indexation of agent.pivota.cc

**Goal:** get `agent.pivota.cc` product pages into Google's index so web-search
agents (ChatGPT-search, Perplexity, Gemini, Google's AI answers) can *discover*
and cite them. This is the single highest-leverage cheap **demand** action.

**Why this and not code:** the supply side is live (7,408-URL sitemap, robots
allows the AI crawlers, PDPs render schema.org JSON-LD with grounded claims), but
`site:agent.pivota.cc` on Google returns **0 results** — the pages have never
been crawled/indexed. IndexNow was already fired (covers Bing, which powers
ChatGPT search) but **Google ignores IndexNow**, so Google needs an explicit
sitemap submission in Search Console. This is a **UI action that requires the
founder's Google account** — it cannot be scripted from here.

> Do **not** rely on the backend `services/gsc_integration.py` /
> `GSC_PIVOTA_SUBMIT_ENABLED` path for this. That uses the Google **Indexing
> API**, which officially only indexes `JobPosting`/`BroadcastEvent` pages and
> silently ignores product URLs (confirmed: 5 sig URLs submitted 2026-05, still
> `indexed_at=NULL` weeks later). The **sitemap-in-Search-Console** path below is
> the correct tool for product pages.

## Preconditions (verified live 2026-07-08)

- Sitemap index live: `https://agent.pivota.cc/sitemap.xml` → `sitemap-static.xml`
  + `sitemap-products.xml` (**7,408** product URLs). `robots.txt` advertises it
  (`Sitemap: https://agent.pivota.cc/sitemap.xml`).
- Google verification file live: `https://agent.pivota.cc/google5231568749b010a9.html`
  (200) — so a **URL-prefix property** for `https://agent.pivota.cc/` is (or can
  be) verified by the HTML-file method with no new setup. `gsc_oauth_tokens` also
  holds a Chydan token authorized for `agent.pivota.cc`.

## Steps (founder, ~10 min in the browser)

1. Go to **Google Search Console** (search.google.com/search-console) signed in
   as the account that owns the property.
2. Confirm/add the property for **`https://agent.pivota.cc/`** (URL-prefix). If it
   asks to verify, use **HTML file** — `google5231568749b010a9.html` is already
   served, so it verifies immediately. (A Domain property also works if DNS
   access is easier.)
3. Left nav → **Indexing → Sitemaps**. Under "Add a new sitemap" enter:
   `sitemap.xml`  → **Submit**. (Submitting the index pulls in both child
   sitemaps; you may also add `sitemap-products.xml` explicitly.)
4. Expected immediate state: "Success — Sitemap could be read," discovered URLs
   climbing toward ~7,408 over the next hours/days.
5. **Prime a few pages** to pull the first crawls forward: **URL Inspection** on
   3–5 high-value canonical URLs (ones that publish grounded claims — get them
   from `python3 scripts/frontier_citation_proof.py`), then **Request Indexing**
   on each. Good seeds are claim-bearing K-beauty PDPs, e.g.
   `https://agent.pivota.cc/products/sig_1c7611cfd2520d64ad08f3c36b2ef016`
   (The Ordinary Niacinamide, 5 published claims).

## Verify (over days/weeks — Google is not instant)

- **GSC → Pages (Indexing):** watch "Indexed" rise and read the "Not indexed"
  reasons. On a young domain expect a lot of **"Crawled – currently not indexed"**
  / **"Discovered – not indexed"** at first (see caveat).
- **GSC → Sitemaps:** "Discovered URLs" should reach ~7,408.
- **In the wild:** `site:agent.pivota.cc` on Google should go from 0 → nonzero.
  Re-run periodically. `scripts/frontier_citation_proof.py` reports the current
  supply state each run.

## Realistic expectation (do not over-promise)

Indexation is a **domain-authority + scale** problem, not a technical one — the
pages are already server-rendered, crawlable, and JSON-LD-rich. A young domain
publishing thousands of thin-ish product pages typically sees Google **crawl but
withhold** many at first ("Discovered – not indexed"). Submission is necessary
but not sufficient; authority (links, freshness, engagement) builds over weeks.

**Strategic note:** Pivota's design is **AI-crawler-first** (robots courts
GPTBot/ClaudeBot/Google-Extended; IndexNow already feeds Bing→ChatGPT-search).
So weak *Google web-search* indexing may matter less than it looks for the
"agents cite Pivota" thesis — the faster proof is the **connector turn-up**
(`docs/frontier_citation_proof_experiment.md`), which does not wait on any crawl.
Run both in parallel: GSC submission (this doc) for organic Google demand, and
the connector proof for a controlled, immediate demonstration.

## Rollback / risk

None. Submitting a sitemap is read-only from Pivota's side and reversible in GSC
(remove the sitemap). No prod change, no flag, no data.
