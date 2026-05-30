# Wave74 Oiluj, Byra, and Miss Nella Source-Gap Probe Closeout - 2026-05-30

## Scope

Probed the strongest remaining identity-ready source-gap rows after Wave73:

- `ext_ab35eb07e8635bb1e1be3ebf` - Oiluj Life Oil
- `ext_1493a61baf165a6c00e4977b` - Oiluj Life Oil: Organic Moringa / French Lavender Blend
- `ext_07cfaab25950196c3ec1b5f3` - Oiluj Life Oil: Organic Moringa / Sandalwood Blend
- `ext_d2be72abe173e52d5baa6879` - Byra Deep Calm Eau De Parfum 30ml
- `ext_6f491538dbf9a790b66cf269` - Miss Nella Sweet Like Me Roll On Perfume

No production write was performed for this wave. No deploy was run, and `railway up` was not used.

## Review Decision

No row passed the source-quality gate for apply.

The three Oiluj rows are identity-ready, high-quality-KB, and DB/public-doc ready, but the official PDPs expose common-name blend descriptions rather than full INCI. Manual source review found examples such as moringa oil plus essential oil blend language, but not a complete INCI list. These rows should stay held until full official INCI is available or a separate reviewed non-INCI policy is approved.

The Byra row is identity-ready and high-quality-KB, but it is still blocked by missing category and the official HTML dry-run only found one details section. It did not find INCI or how-to evidence, so a details-only patch would not clear the source gap.

The Miss Nella Sweet Like Me roll-on perfume is the sibling of the earlier Cool Like Me terminal hold. Readiness confirmed the same terminal hold reason: `official_ingredient_text_not_full_inci`. The official HTML dry-run skipped it, and the fetch returned HTTP 503.

## Validation Snapshot

Oiluj + Byra readiness:

- Scanned: 4
- Terminal holds: 0
- Action required: 1
- DB serving ready: 3/4
- Public commerce doc dry-run: 4/4
- Direct high-quality product intel ready: 4/4
- Identity ready: 4/4
- Main blockers: `db_serving_ready` for 3, `seed_content_blocked` for 1

Oiluj + Byra official HTML dry-run:

- Scanned: 4
- Dry-run patchable: 1
- Updated: 0
- Skipped: 3
- Failed: 0
- Patchable field count: `pdp_details_sections` only, 1 row
- No INCI fields found
- No how-to fields found

Miss Nella Sweet Like Me readiness:

- Scanned: 1
- Terminal holds: 1
- Action required: 0
- DB serving ready: 0/1
- Public commerce doc dry-run: 1/1
- Direct high-quality product intel ready: 1/1
- Identity ready: 1/1
- Terminal hold reason: `official_ingredient_text_not_full_inci`

Miss Nella Sweet Like Me official HTML dry-run:

- Scanned: 1
- Updated: 0
- Skipped: 1
- Failed: 0
- HTTP status: 503
- Skip reason: `no_official_html_fields`

## Next Move

The immediate source-gap lane has no safe apply candidates. The next productive lane is identity/index review for rows that already have reviewed product intel, or a targeted extractor improvement for official PDP templates that contain source text but are not being parsed into INCI/how-to fields.

Do not force Oiluj or Miss Nella perfume rows into serving without full official INCI review. Do not apply a Byra details-only patch as a source-gap recovery.

## Artifacts

- `readiness_before_source_probe/`
- `official_html_dry_run/dry-run.json`
- `missnella_sweet_like_me_readiness/`
- `missnella_sweet_like_me_official_html_dry_run/dry-run.json`
