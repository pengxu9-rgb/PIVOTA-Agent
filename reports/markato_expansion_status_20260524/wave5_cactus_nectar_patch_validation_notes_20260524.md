# Wave5 Cactus Nectar Patch Validation Notes - 2026-05-24

## Candidate

- Product: `CACTUS NECTAR Hydrating Cream Mist`
- External product ID: `ext_ab1e091b3576e74f9c8c69a4`
- Source URL: `https://joujoubotanicals.com/products/cactus-nectar-hydrating-cream-mist`
- Manifest: `wave5_cactus_nectar_reviewed_inci_manifest.json`

## Why This Is A Patch Candidate

Final live PDP audit still marks this row thin for `missing_ingredients`.

The catalog extract dry-run captured:

- `Ingredients` official PDP section with comma-delimited INCI-like text.
- `How to Use` official PDP section.

The current serving/live blocker is consistent with the old polluted raw ingredient field containing Shopify variant JSON rather than structured `ingredients_inci`.

## Local Manifest Validation

Local validation through `apply-reviewed-external-seed-pdp-content-patch.cjs` internals passed:

- `validateEntry`: no blockers.
- Parsed structured INCI count: 14.
- Parsed INCI items:
  - AQUA
  - BETAINE
  - PROPANEDIOL
  - ETHYLHEXYL PELARGONATE
  - GLYCERYL CITRATE/LACTATE/LINOLEATE/OLEATE
  - GLYCERYL CAPRYLATE
  - POLYGLYCERYL-3 CAPRATE
  - POLYGLYCERYL-4 COCOATE
  - BENZYL ALCOHOL
  - ECTOIN
  - OPUNTIA FICUS-INDICA FRUIT EXTRACT
  - PARFUM (natural identical)
  - DEHYDROACETIC ACID
  - LACTOBACILLUS FERMENT

## DB Dry-Run Status

DB dry-run command attempted:

```bash
node scripts/apply-reviewed-external-seed-pdp-content-patch.cjs --manifest reports/markato_expansion_status_20260524/wave5_cactus_nectar_reviewed_inci_manifest.json --out reports/markato_expansion_status_20260524/wave5_cactus_nectar_reviewed_inci_dry_run.json
```

Result:

- Sandbox run failed on DB/network access.
- Escalated non-sandbox run did not write anything, but failed because this shell has no valid `DATABASE_URL`; it defaulted to local database `pengchydan`, which does not exist.
- No dry-run JSON was generated.

## Next Required Step

Run the same command in an environment with the correct production/staging `DATABASE_URL`, still without `--write`.

If the DB dry-run reports exactly one changed row and patches only ingredients/how-to/details fields for `ext_ab1e091b3576e74f9c8c69a4`, then the apply step can be considered as a narrow reviewed write:

```bash
node scripts/apply-reviewed-external-seed-pdp-content-patch.cjs --manifest reports/markato_expansion_status_20260524/wave5_cactus_nectar_reviewed_inci_manifest.json --out reports/markato_expansion_status_20260524/wave5_cactus_nectar_reviewed_inci_apply.json --write --confirm APPLY_REVIEWED_EXTERNAL_SEED_PDP_CONTENT_PATCH
```

After any apply, resync serving/index state and rerun live PDP audit for Wave5.
