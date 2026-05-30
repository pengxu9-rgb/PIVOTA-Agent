# Wave68 Miss Nella Legacy Source Probe Closeout - 2026-05-30

## Scope

Reviewed the next Miss Nella source-gap lane after the prior wave recovered current official Miss Nella and UpCircle rows.

The probe targeted 10 older Miss Nella nail-polish rows whose stored canonical URLs still point at legacy `www.missnella.com/products/mnXX-...-3-pack` handles.

## Result

The official HTML extractor dry-run scanned 10 rows and made no write plan:

- Scanned: 10
- Dry-run changes: 0
- Updated: 0
- Skipped: 10
- Failed: 0
- Skip reason: `no_official_html_fields` for all rows

The current official US Miss Nella storefront appears to expose some equivalent single-product pages under `us.missnella.com`, but these rows are legacy 3-pack/wholesale-style listings with different URLs and stale commerce identity. I did not remap or promote them because that would mix current single-SKU source evidence into older 3-pack rows without identity review.

## Decision

No production writes were made for this lane.

The next safe Miss Nella move is a reviewed identity/remap package, not a source-field patch:

- verify exact current official `us.missnella.com` PDP for each legacy `mnXX` row,
- decide whether the old row should be retired, remapped, or held as a distinct 3-pack/wholesale product,
- only then apply source fields and serving/index sync.

## Artifact

- `missnella_old_nail_polish_official_html_dry_run/dry-run.json`
