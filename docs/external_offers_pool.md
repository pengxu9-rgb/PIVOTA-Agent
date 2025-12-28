# External Offers Pool (CSV → JSON)

This repo supports an **external-offer-first** Layer 3. The external offer URLs are maintained by Ops/BD in a CSV and compiled into deterministic JSON pools per market.

## Files

- Source of truth (Ops-maintained, optional in repo):
  - `src/layer3/data/external_offers_pool.csv`
- Template (always present):
  - `src/layer3/data/external_offers_pool.template.csv`
- Domain allowlists (one domain per line, lowercase recommended; subdomains allowed):
  - `src/layer3/data/external_allowlist_US.txt`
  - `src/layer3/data/external_allowlist_JP.txt`
- Optional partner defaults (domain → disclosure defaults):
  - `src/layer3/data/external_partners_US.json`
  - `src/layer3/data/external_partners_JP.json`
- Generated outputs (commit these):
  - `src/layer3/data/externalLinks_US.json`
  - `src/layer3/data/externalLinks_JP.json`

## CSV schema

Columns (required unless noted):

- `market` (US|JP)
- `scope` (role|category)
- `scope_id`
  - For `scope=category`: one of `prep,base,contour,brow,eye,blush,lip`
  - For `scope=role`: a role id like `ROLE:thin_felt_tip_liner` (must exist in `src/layer2/dicts/roles_v1.json` after stripping `ROLE:`)
- `url` (http/https only)
- `priority` (integer 0..100; higher = earlier)
- `partner_type` (none|affiliate|partner|unknown)
- `partner_program` (optional)
- `partner_name` (optional)
- `disclosure_text` (optional; overrides domain default)
- `tags` (optional; comma-separated)
- `notes` (optional)

## Commands

- Build pools (deterministic ordering):
  - `npm run external:build-pool`
  - Reads `external_offers_pool.csv` if present; otherwise builds empty pools from the template.
- Lint (CI-friendly; does not fetch URLs):
  - `npm run external:lint`
  - Passes with a warning if `external_offers_pool.csv` is missing.
- Optional local health check (best-effort network fetch; not for CI):
  - `npm run external:check-links`

## Operational workflow

1) Update `src/layer3/data/external_offers_pool.csv` and allowlist/partners files.
2) Run `npm run external:lint` and fix any errors.
3) Run `npm run external:build-pool`.
4) Commit:
   - `src/layer3/data/externalLinks_US.json`
   - `src/layer3/data/externalLinks_JP.json`
   - and the updated CSV/allowlists as needed.

## Notes

- URLs are canonicalized during build (tracking params stripped: `utm_*`, `fbclid`, `gclid`, `ttclid`, etc.).
- Deduplication is per `(market, scope, scope_id)` after canonicalization; highest priority wins.
- A domain diversity cap is applied during build (default max 2 offers per domain within each scope group).

