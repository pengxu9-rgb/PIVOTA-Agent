# Wave114 Rejection Fix Closeout - 2026-06-01

## Scope

Fixed the product-intel generator path that caused wave110-wave113 validation rejections, then rebuilt and published the affected rows through the same dry-run/write/ready-audit gates.

## Code Fix

Updated `scripts/build-reviewed-official-seed-product-intel-report.cjs` public-copy sanitization:

- converts generic marketing terms such as `flawless`, `ultimate`, `must-have`, `go-to`, `ready-to-go`, `unique`, `popular`, `high-quality`, and `perfect` into neutral source-bound copy
- removes or neutralizes public sensitive certification/suitability terms such as `vegan`, `cruelty-free`, `dermatologist-tested`, `ophthalmologist-tested`, `non-comedogenic`, `hypoallergenic`, `pregnancy-safe`, `reef-safe`, and `clean beauty`
- falls back from truncated sanitized source sentences to complete source-bound description text

Syntax check:

- `node --check scripts/build-reviewed-official-seed-product-intel-report.cjs`

## Fixed And Published

### Sigma Beauty

Previously rejected:

- wave110, 10 rows rejected for `public_generic_marketing_copy`

Fixed result:

- validated replacement report: `wave110_sigmabeauty_official_seed_20260601/sigmabeauty_rejection_fix_product_intel_report.json`
- dry-run rows: 10
- write rows: 10
- skipped rows: 0
- post-audit: 10 scanned, 10 DB-serving-ready, 10 public-index-ready, 0 action-required

### Luna Nectar

Previously rejected:

- wave111, 3-row batch blocked by public-copy safety/truncation issues

Fixed result:

- validated replacement report: `wave111_lunanectar_official_seed_20260601/lunanectar_rejection_fix_product_intel_report.json`
- dry-run rows: 3
- write rows: 3
- skipped rows: 0
- post-audit KB state: 3 direct displayable, 3 direct high-quality-ready
- remaining blocker: `index_doc_shadow_only` x3

Reviewer note: Luna Nectar product-intel content is fixed. The rows are not DB-serving-ready yet because the commerce/public doc builder still produces 0 public docs for the slice, so the next lane is identity/index/public-doc recovery rather than another KB rewrite.

### Sofie Pavitt Face

Previously held:

- `ext_6c7b1ee909303169dc9c2ee4` - Omega Rich Moisturizer, rejected for `public_sensitive_claim`

Fixed result:

- validated replacement report: `wave112_safe_singletons_product_intel_20260601/sofiepavittface_rejection_fix_product_intel_report.json`
- dry-run rows: 1
- write rows: 1
- skipped rows: 0
- post-audit wave112 slice: 3 scanned, 3 DB-serving-ready, 3 public-index-ready, 0 action-required

### KraveBeauty

Previously held:

- `ext_5ffe1c0b5195b36d2bdcffa9` - Oil La La, rejected for `public_sensitive_claim`

Fixed result:

- validated replacement report: `wave113_kravebeauty_product_intel_20260601/kravebeauty_rejection_fix_product_intel_report.json`
- dry-run rows: 1
- write rows: 1
- skipped rows: 0
- post-audit wave113 slice: 3 scanned, 3 DB-serving-ready, 3 public-index-ready, 0 action-required

## Final Outcome

- fixed/published product-intel rows: 15
- fixed/published rows fully DB-serving-ready after fix: 12
- product-intel fixed but still public-doc/index blocked: 3 Luna Nectar rows
- remaining product-intel validation rejections from this set: 0

## Deployment Note

No `railway up` was run. Production writes were limited to reviewed product-intel KB entries after dry-run validation.
