# Pivota as the Citation-Channel Intermediary — BD Channel Marketplace (direction memo)

*Status: exploration / kickoff. Not a commitment. 2026-06-29.*

## The idea in one line

Pivota's audits already tell us, **grounded and across many brands**, exactly which
third-party channels each frontier model (Gemini, ChatGPT) cites — editorial, review
sites, KOLs/creators, subreddits/communities, media. Turn that measurement asset into a
**two-sided intermediary**: aggregate merchant *demand* to be cited, build supply-side
*relationships* with those channels, and broker "request-to-be-reviewed / request-to-be-cited"
at a scale no single merchant can reach. Track it all in the **employee (BD) portal**.

## Why Pivota is uniquely positioned (the moat)

1. **We know which channels actually move AI citations**, per category and per model — not
   vanity PR. It's grounded in real answers, and we can **prove lift** by re-auditing after a
   placement (the get-cited proof loop already exists).
2. **We aggregate demand across many brands.** A single merchant pitching Forbes is noise; Pivota
   saying "I have 40 beauty brands this desk would credibly cover" is a *pipeline*. That's the
   leverage an individual brand — or a generic PR agency — doesn't have.
3. **Closed-loop ROI.** PR/influencer agencies sell activity; we can sell *measured outcome*
   (citation appeared in Gemini/ChatGPT after the placement). That's the differentiator.
4. **Category timing.** This is the emerging **GEO / AEO** (Generative / Answer Engine
   Optimization) space. Measurement + a supply network is a defensible wedge before it
   commoditizes.

## What already exists (reuse-don't-rebuild)

- **Employee portal**: `pivota-employee-portal` (Next.js, JWT role-gated: employee/admin/
  super_admin). Already has `/dashboard/partners` (a CRM for `channel_partners`) and
  `/dashboard/agent-center/bd-report` (per-brand audit discovery surface).
- **Normalized channel store**: `citation_observations` (migration 157) —
  `(audit_run_id, merchant_id, content_key, provider, query, cited_host, host_type,
  first_party, is_competitor, evidence_url, observed_at)`. This is the truth source; channels
  accrete across sellers via `content_key`. **This is the table to aggregate.**
  **Caveat (data completeness):** rows are persisted only for *depositable* products (gated by
  `content_key_map`), not every audited product. So any "N merchants cite host X" figure is
  *over depositable audits*, not total coverage — fine as an internal demand signal, but never
  quote it to a channel as if it were the whole base. Sanity-check the deposit rate before
  publishing counts.
- **Cross-merchant aggregation pattern**: `niche_query_recurrence` (migration 153) +
  `services/niche_recurrence.py` — mirror this exact pattern for a `host_recurrence` rollup.
- **Channel classification**: `cited_host_classifier.py` + `data/cited_host_registry.json`
  (type/subtype/categories/outreach_hint/cadence/ai_grounding_weight). Curated, and the
  **editorial head already carries a `pitch_recipient` {email, submission_url, note}** for the
  top desks (6 of 63 hosts today — forbes `vetted@forbes.com`, nymag `tips@nymag.com`,
  wirecutter/GH via submission form) — and `classify_host` already passes it through to merchant
  pitch drafts, so it's reusable, not secret. Enrichment is a long-tail problem, not a head one.
- **Partner CRM shape**: `channel_partners` / `partner_contacts` / `partner_send_log`
  (migrations 108/137) — a reusable CRM + outbound-log model (today used for payment partners).
- **Per-merchant task lifecycle**: `merchant_tasks` (pending→in_progress→done/dismissed/
  superseded). Per-*action*, not per-*channel* — see gap below.
- **Get-cited proof loop**: mark_sent → re-verify → proof (already shipped for merchants) —
  reuse to close the ROI loop on brokered placements.

## What's net-new (the gaps)

1. **Cross-merchant channel aggregation** — `host_recurrence` rollup over
   `citation_observations` (distinct_merchants, model coverage, host_type, category). Ranks
   channels by *demand* (a host cited across 40 merchants > one cited by 1). Counts are over
   *depositable* audits (see caveat above), so carry a deposit-rate denominator alongside them.
2. **Per-merchant per-channel outreach tracker** — new `merchant_channel_outreach`
   (merchant_id, host/subreddit, host_type, outreach_type, status lifecycle, last_contacted,
   next_followup, proof-of-lift link). `merchant_tasks` is per-action and too coarse.
3. **Contact / enrichment layer** — host → editorial contact / email / social. Manual first;
   integrate (Clearbit/Apollo-style) later.
4. **Two employee-portal pages** (below).
5. **Reddit/community tracking** — subreddit follow-list, per-merchant participation status,
   sentiment/objections. Today only per-audit discovery, nothing persistent.

## The two employee-portal pages

### Page A — Channel Graph / BD pipeline (cross-merchant)
- **Backed by** the new `host_recurrence` aggregation. For each channel: type, categories,
  which models trust it + weight, **# merchants who'd benefit (demand signal)**, citation
  frequency, contact (enrichment), and a **BD pipeline status** (prospect → contacted →
  in-talks → partnered → live → churned), owner, notes, deals.
- **Reuse**: extend `/dashboard/partners` with a "content channels" tab; reuse
  `partner_contacts`/`partner_send_log` for outreach logging.
- **BD value statement**: "These 12 editorial desks are cited by Gemini across 40 of our
  beauty merchants — partner once, unlock citations for all 40."

### Page B — Per-merchant per-channel tracker + Reddit topic tracker
- **Backed by** `merchant_channel_outreach`. Shows a merchant's audit-detected channels with
  per-channel status, next follow-up, and proof-of-lift (via re-audit).
- **Reddit sub-view**: per subreddit/topic, our merchants' participation status
  (identified → engaged → posted → cited), sentiment, recurring objections. Framed as
  **community-relationship management, not PR** (see risk below).

## Business-model options (to decide; compare in research)

| Model | What it is | Industry analog |
|---|---|---|
| **Managed service / retainer** | Pivota runs outreach for the merchant | digital-PR agencies |
| **Brokerage / take-rate** | match brand ↔ channel, take a cut of facilitated deals | HARO/Connectively, influencer marketplaces |
| **Channel rev-share / affiliate** | partner channels earn on conversions | affiliate networks (Impact, PartnerStack) |
| **SaaS tier** | sell the tracking tooling itself | influencer-CRM platforms (Grin, Aspire) |

Likely a **hybrid**: keep SaaS measurement (existing), add **managed/brokered placements** as
new revenue, with a take-rate on facilitated deals once supply density exists.

## Critical risks / tensions (do not skip)

- **Editorial integrity = the golden goose.** Legit review/editorial outlets are AI-cited
  *because* they're trusted. If we make them pay-to-play, we erode the very trust that gives
  the citation value. Must separate *facilitating a genuine review/story* (send product, pitch
  a real angle) from *buying placement*.
- **Reddit/community authenticity.** Communities punish astroturfing. The Reddit track is
  relationship + authentic participation (AMAs, genuine value), **not** brokered citations.
  Possibly the highest-trust-but-hardest-to-monetize surface.
- **Conflict of interest.** Pivota serves competing brands; brokering the same channel for
  rivals needs an explicit policy.
- **FTC / disclosure.** Sponsored content must be disclosed — and undisclosed paid placements
  may also be discounted by the models over time.
- **Non-stationarity.** Model citation patterns shift; channel value decays. Need continuous
  re-measurement (which we have).
- **Two-sided cold-start.** Need enough demand to attract channels and vice versa. Aggregated
  demand across our existing merchant base is the unlock.

## MVP sequence (don't boil the ocean)

1. **`host_recurrence` aggregation** (backend, read-only rollup over `citation_observations`;
   mirror `niche_recurrence`).
2. **Channel Graph page** (employee portal, read-only): rank channels by cross-merchant demand
   + model coverage. *Pure BD insight, zero outreach plumbing — immediately useful.*
3. **BD pipeline state** on channels (status/owner/notes).
4. **Per-merchant per-channel tracker** + reuse the proof loop for ROI.
5. **Reddit topic tracker.**
6. **Contact/enrichment layer** (manual entry first).
   *Defer*: payments/take-rate, automated outreach.

## Open strategic questions (for the new session + external research)

- Managed service vs marketplace vs SaaS feature — which is the wedge, which is the scale play?
- How to monetize without killing editorial/community trust?
- Can Reddit be brokered at all, or only coached?
- Conflict-of-interest policy across competing brands?
- Defensibility vs influencer platforms / PR agencies entering GEO?
- Is "request-to-be-cited" a real, repeatable transaction or a bespoke service?
