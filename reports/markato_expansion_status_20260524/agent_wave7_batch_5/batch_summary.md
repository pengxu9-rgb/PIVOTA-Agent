# Wave7 Markato Batch 5 Summary

Generated: 2026-05-24T06:20:42.390Z

## Guardrails

- No DB apply/production write, no `railway up`, and no git push were run.
- No seller-only fallback and no force-filled ingredients were used.
- Manifest extraction used escalated network access only after sandbox DNS blocked catalog-intelligence.
- No-DB dry-runs were executed with `DATABASE_URL` absent.

## Key Counts

- Brands assigned: 8
- Manifest extractions completed: 7
- Manifest extractions blocked: 1
- Extracted products seen: 0
- Manifest rows emitted by extractor: 0
- Repo review-gate OK brands: 0
- Repo review-gate blocked brands: 8
- Repo review structurally accepted rows: 0
- Conservative DB-ready candidate rows: 0
- Conservative held rows: 0
- No-DB dry-run files: 8
- No-DB dry-run scanned rows: 0
- No-DB dry-run would_insert_unverified rows: 0

## Brand Results

| Brand | Manifest | Review gate | Extracted | Manifest rows | Review accepted | DB-ready | Held | Dry-run scanned/would_insert_unverified | Main blockers |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| KHUS KHUS | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | zero_accepted_items_from_extractor; failure_category:dead_sitemap |
| Apiceuticals | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | zero_accepted_items_from_extractor; failure_category:timeout |
| Pairfum | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | zero_accepted_items_from_extractor; anti_abuse_signal:cloudflare; failure_category:bot_challenge; block_provider:cloudflare |
| LIME | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | zero_accepted_items_from_extractor; failure_category:bot_challenge |
| Lazy Society | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | zero_accepted_items_from_extractor; failure_category:timeout |
| ADVANCED COSMETICA | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | zero_accepted_items_from_extractor; failure_category:no_product_urls |
| Ilmma Beauty | completed | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | zero_accepted_items_from_extractor; failure_category:no_product_urls |
| Vegan Fox | blocked | blocked | 0 | 0 | 0 | 0 | 0 | 0/0 | manifest_extraction_timeout; failure_category:timeout |

## Hold Reason Totals

- None

## Blocker Reason Totals

- zero_accepted_items_from_extractor: 7
- anti_abuse_signal:cloudflare: 1
- manifest_extraction_timeout: 1

## Diagnostic Totals

- failure_category:timeout: 3
- failure_category:bot_challenge: 2
- failure_category:no_product_urls: 2
- block_provider:cloudflare: 1
- failure_category:dead_sitemap: 1

## Exact Next Steps

- Do not apply this batch to the DB; conservative DB-ready candidate count is 0.
- Recover official brand-owned PDP discovery for KHUS KHUS, Apiceuticals, LIME, Lazy Society, ADVANCED COSMETICA, Ilmma Beauty, and Vegan Fox before any future seed creation.
- For Pairfum, clear the Cloudflare/bot-challenge source blocker or use a reviewed official PDP/catalog source; do not use seller-only or marketplace fallback rows.
- For Vegan Fox, address catalog-intelligence timeout behavior or provide direct official PDPs; the command timed out at both 90s and 120s.
- After rerun, only promote official brand-owned PDP rows that are USD, in_stock, commerce facts gate ok, priced below 250 USD, image/title/description complete, and single sellable beauty products.

## Brand Next Steps

- KHUS KHUS: Dead sitemap/no-row extraction; rerun with direct official PDPs or sitemap/source remediation before any seed work.
- Apiceuticals: Timeout/no-row extraction; rerun with direct official PDPs, preferred titles, or extractor remediation before any seed dry-run with real rows.
- Pairfum: Resolve Cloudflare/bot-challenge access or provide an official reviewed PDP/catalog source before rerunning; no seed rows from this output.
- LIME: Bot-challenge/no-row extraction; recover a clean official source or direct PDP list before reconsidering US seeds.
- Lazy Society: Timeout/no-row extraction; rerun with direct official PDPs, preferred titles, or extractor remediation before any seed dry-run with real rows.
- ADVANCED COSMETICA: No product URLs discovered; supply official PDP URLs or improve discovery before rerunning review/curation.
- Ilmma Beauty: No product URLs discovered; supply official PDP URLs or improve discovery before rerunning review/curation.
- Vegan Fox: Extractor timed out at 90s and 120s; retry only after catalog-intelligence timeout/source handling is improved or provide official PDPs for reviewed manifest creation.

## Artifact Root

/Users/pengchydan/dev/_worktrees/pivota-agent-markato-wave7-20260524/reports/markato_expansion_status_20260524/agent_wave7_batch_5
