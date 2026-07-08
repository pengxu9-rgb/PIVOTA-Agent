# Meta AI as an Audit Surface — Decision Brief

Status: **DECISION — DO NOT BUILD NOW; park with a tripwire** (2026-07-03). Grounded in a deep-research pass (workflow `wf_2ecd34a0-4c9`): 3 search angles → 13 sources → 48 claims → 25 adversarially verified (2-of-3 vote), **13 confirmed / 11 refuted / 1 unverified**. Every load-bearing claim below carries its source and vote.

The question this answers: *a friend reports lots of consumers now use "Meta's AI" for search and product analysis, and Facebook Marketplace is one of the largest US marketplaces — should the merchant AI-Readiness / AI-visibility audit add Meta AI as a scored answer-engine surface?*

**Verdict: No — not as a scored provider today.** Meta AI has enormous *reach* but its shopping surface is a **limited pilot**, it ranks **below the engines we already probe**, and there is **no faithful way to programmatically probe what a consumer actually sees**. Adding it would score merchants on a surrogate — the exact fake-signal failure our `coverage_unavailable` honesty gate exists to prevent. Revisit on a **capability tripwire**, not a calendar date.

---

## The reframe — the friend's observation bundles two different things

1. **Meta AI the assistant** (Llama-based, in WhatsApp/Instagram/Messenger + meta.ai) — a conversational answer engine like ChatGPT/Gemini. *This* is the only surface in scope for the AI-Readiness audit (which measures answer-engine citation).
2. **Facebook Marketplace / Meta commerce** (listings, Advantage+, Shops, ads) — a classic listings-and-ads marketplace with its own bidding/relevance engine, **not** LLM-citation ranking. Real traffic, but it belongs in the **BD / channel / paid** track, not the audit score. Conflating the two is where this goes wrong.

Only surface #1 is evaluated below. Surface #2 is addressed in §4.

---

## Surface #1 — Meta AI the assistant

### Usage & intent — reach is real, shopping intent is undocumented
- **1B+ monthly actives**, 60+ countries, 13+ languages. ([TechCrunch, May 2025](https://techcrunch.com/2025/05/29/meta-ai-now-has-1b-monthly-users/); [demandsage](https://www.demandsage.com/meta-ai-users/)) — *confirmed 3-0.*
- For **shopping specifically**, rated **medium priority, explicitly below ChatGPT and Google AI Overviews**. ([lumengeo](https://lumengeo.co/blog/ai-search-engines-complete-guide)) — *confirmed 3-0.*
- **Honesty note:** every stat that would have *quantified* shopping intent was **refuted 0-3** as unsupported/misattributed — "only 2% of buyers start with AI," "0.02% chatbot market share," "500M MAU," "1B+ shop on Marketplace." The honest state is **"reach huge, commercial-query share undocumented."** We have no defensible intent number.

### Answer quality & grounding — specific products, but pilot-gated, backend unknown
- When the shopping feature fires it returns a **carousel with brand, retailer, price, and bullet rationales** — specific named products, not vague answers. ([eMarketer](https://www.emarketer.com/content/meta-ai-shopping-assistant-test-competition)) — *confirmed 3-0.*
- **But it is a test:** as of March 2026 the "Shopping research" button is **select US users, desktop web only — NOT WhatsApp/Instagram/Messenger** (i.e. not where the billion users are), discovery-only, click-through to merchant. ([medianama](https://www.medianama.com/2026/03/223-meta-ai-shopping-assistant-chatgpt-google-gemini/)) — *confirmed 3-0.*
- The claim that **Meta AI grounds on Bing's index with inline sources was refuted 0-3** — no one could substantiate the backend. So we cannot even assume redundancy with our Bing-grounded ChatGPT probe; the grounding source is **unknown**.

### Programmatic access — the disqualifier
- The **Llama API is raw model inference only** — no grounding, no RAG, no citations, no consumer-product output. ([Meta docs](https://llama.developer.meta.com/docs/overview/)) — *confirmed 3-0.* **No endpoint returns the grounded consumer Meta AI output** — *confirmed 3-0.*
- **One caveat (verifier dissent, 2-1 not unanimous):** Meta's tool-calling docs reportedly now expose a **built-in `web_search` tool** on the Llama API. That is the *closest probe-able proxy* — but it measures "Llama + generic web search," **not** the consumer Meta AI ranking/product surface. One notch better than raw-Llama; still not the real thing.

**Crux:** any probe we could build measures a surrogate, not the surface that generates traffic. Scoring a merchant on it and labeling it "Meta AI readiness" is precisely the over-promise the honesty gate forbids.

---

## §4 — Facebook Marketplace (separate track, out of audit scope)
- Meta is adding AI to Marketplace: **AI-powered listing insights** (vehicle specs/safety/price) and **AI-suggested buyer questions**. ([about.fb.com, Nov 2025](https://about.fb.com/news/2025/11/facebook-marketplace-gets-a-glow-up/)) — *confirmed 3-0.*
- These are **buyer-assist inside listings**, not answer-engine citation. Marketplace-scale stats ("1B+ shop monthly," "491M log in to shop") were **refuted 0-3** as unsupported.
- **Disposition:** route the Marketplace-presence insight to the **BD / channel** track as a merchant-facing observation. Keep it out of the audit score.

---

## §5 — Trajectory (why this is a fast-follow, not a dead end)
Meta *is* investing in AI shopping (the March 2026 pilot; "Muse/Spark" shopping-mode signals), so this is a **candidate to revisit**, not a no. But every shipped commerce feature is **test-stage as of early 2026**, US-desktop-gated, and off the high-reach surfaces.

---

## Decision & the tripwire

**Park it. Do not engineer a scored provider now.** Re-evaluate on a **capability trigger**, not a date:

**Revisit the moment BOTH hold:**
1. Meta's shopping/answer surface goes **GA beyond US-desktop-web**, AND
2. it lands on **WhatsApp / Instagram / Messenger** (where the billion users actually are).

That conjunction is the signal that the traffic is real and the surface is worth the engineering.

**Until then:**
- **No scored Meta AI provider** — fails the faithful-probe bar; would violate `coverage_unavailable`.
- **If any internal signal is wanted**, the *only* defensible option is a **Llama-API `web_search` proxy probe, run internally and labeled a proxy** — never surfaced to merchants as "Meta AI readiness." Recommend skipping even this until GA; low signal, maintenance cost.
- **Marketplace** → BD/channel track (§4), not the audit.

**Why this is the cheap call:** the current provider set (ChatGPT, Gemini, DeepSeek-verify, premium tiers) already covers the surfaces where shopping intent demonstrably flows. Meta AI adds reach on paper but no probe-able, merchant-honest signal today. The tripwire keeps us from missing the inflection without paying to build for a pilot.

---

## Evidence ledger (verified claims)

| # | Claim | Source | Vote |
|---|-------|--------|------|
| 1 | Llama API = raw inference; no web grounding / RAG | llama.developer.meta.com/docs | 2-1 ✓ |
| 2 | Llama API docs have no citation / consumer-output features | llama.developer.meta.com/docs | 3-0 ✓ |
| 3 | Only Meta-sanctioned paths = raw model (download / cloud hosts) | llama.developer.meta.com | 3-0 ✓ |
| 4 | No programmatic path to grounded consumer Meta AI output | llama.developer.meta.com | 2-1 ✓ |
| 5 | Meta AI embedded in Marketplace (suggested buyer questions) | about.fb.com (Nov 2025) | 3-0 ✓ |
| 6 | Meta AI 1B+ MAU, 60+ countries | demandsage | 3-0 ✓ |
| 7 | Shopping assistant is a **test**, not GA | eMarketer | 3-0 ✓ |
| 8 | Carousel shows brand/retailer/price/rationale (specific products) | eMarketer | 3-0 ✓ |
| 9 | 1B MAU as of May 2025 (Zuckerberg, shareholder mtg) | TechCrunch | 3-0 ✓ |
| 10 | Shopping-research = select US users, **desktop web only** | medianama (Mar 2026) | 3-0 ✓ |
| 11 | Meta AI **medium priority, below ChatGPT & Google** for shopping | lumengeo | 3-0 ✓ |
| 12 | Llama chat-completion framed for user-supplied input, not web answers | llama.developer.meta.com/docs | 3-0 ✓ |
| 13 | AI product insights added to Marketplace (vehicle listings) | about.fb.com (Nov 2025) | 3-0 ✓ |

**Refuted (0-3 unless noted) — do NOT cite these as fact:** Bing-index grounding w/ inline sources; 2% of buyers start with AI; 0.02% chatbot market share; 500M MAU; 1B+ shop on Marketplace / 491M log in to shop; Llama API being retired entirely (1-2); "in-platform checkout unlike ChatGPT/Google/Copilot"; Meta 2025 focus = personalization-not-commerce.

*Synthesis note: the research workflow's final synthesis step was cut off by a session limit; this brief is hand-synthesized from the verified claim set above.*
