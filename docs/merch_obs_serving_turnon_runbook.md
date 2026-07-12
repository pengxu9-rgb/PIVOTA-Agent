# Runbook — turn on serving for `merch_obs_` observed sellers (Mojawa first)

**Date:** 2026-07-12 · **Pairs with:** Fix Plan F (`docs/fixplan_2026-07-12_F_merch_obs_serving_mojawa.md`), deposit-leg backfill (`docs/deposit_leg_377_backfill_scope_2026-07-12.md`).
**Owner action required:** yes — a live-read promotion (`--write`) and a live probe. Nothing here mutates prod until you run the `--write` step.

This runbook covers the **serving turn-on** leg only. Identity/trust backfill (deposit-eligibility) is a separate track (deposit ⊥ serving); see the 377 backfill doc.

---

## 0. What changed (this PR) and why it unblocks serving

The sellable-item-group member serving path (`fetchApprovedLiveIdentityGroupMembersForOffers` in `src/server.js`) special-cased the legacy `merchant_id='external_seed'` bucket in three spots. A *served* `merch_obs_` row would drop its own group siblings and lose its seller name. This PR reconciles all three against the ADR-009 external-supply predicates (shared with `pdpIdentityGraph.js`):

- **seller-name CASE** and **`cm_offer` join guard** — now gate seller-name resolution on the legacy anonymous lump only (`buildLegacyExternalSeedLumpPredicate`), so observed `merch_obs_` sellers resolve their real `catalog_merchants.merchant_name` ("Mojawa") while the placeholder "External Seed" name stays suppressed for the legacy bucket.
- **multi-offer member `EXISTS`** — de-duplicated onto the `#1775` shared helper `buildActiveExternalSeedIdentityPredicate('pil')`, which correlates the mirror row by `platform + source_system + source_product_id` (not the legacy merchant bucket). (This spot was already platform-correlated inline by `#1772`; this PR removes the duplicate so the correlation lives in one place.)

**T1 is a prerequisite for a _correct_ live-read turn-on**: without it, promoting live-read would surface `merch_obs_` rows but drop siblings and lose the seller name.

---

## 1. Prod-measured state (Mojawa, 2026-07-12)

`merch_9678f6352da21473` (url_audit / connected, "Mojawa (Pivota pilot)", status=`active`) + `merch_obs_022b65d47a58b87a` (external_seed mirror, "Mojawa", status=`observed`) — **3 shared content_keys**, correctly de-duplicated:

| content_key | serving_eligible | merch_obs_ offer | seller name resolves (post-T1) |
|---|---|---|---|
| ck_8a7bb68a… | TRUE | 1 in-stock brand_direct | Mojawa |
| ck_923dafa1… | TRUE | 1 in-stock brand_direct | Mojawa |
| ck_a6dc8c29… | TRUE | 1 in-stock brand_direct | Mojawa |

- `pdp_identity_listing` (merch_obs_): `identity_status=approved`, `identity_confidence=0.92`, `source_tier=brand`, **`live_read_enabled=false`** ← the remaining turn-on lever.
- `catalog_merchants`: merch_obs_022b… → "Mojawa" / `observed`; external_seed → "External Seed" / `active` (the placeholder the suppression protects against).

---

## 2. Gate trace — what actually gates serving after this PR deploys

| Lane | Gate | Mojawa merch_obs_ | Verdict |
|---|---|---|---|
| **commerce-index / serving_eligible** (`canonicalCatalogSearch.js`) | `ips.serving_eligible=TRUE` + `activeCatalogProductSourceWhere` (admits `status='observed'` via **#1773**) + `externalSeedUnavailableWhere` (platform-gated, **#1776**) + query match. **No `live_read` requirement.** | serving_eligible=TRUE; observed admitted; not source_unavailable | **Serves once #1773/#1776 deploy.** This is the recall lane. |
| **products_cache** (`activeProductsCacheSourceWhere`) | `merchant_id='external_seed'` **OR** an active `merchant_stores` row for the merchant. Does **not** admit `merch_obs_` (no store row, id≠external_seed). | excluded | merch_obs_ never served via this legacy cache lane — expected; they serve via commerce-index. |
| **pivot semantic-core** (lives in **pivota-backend**, not this repo) | `lower(coalesce(m.status))<>'inactive'` (#1360). `observed`≠`inactive`. | admitted | Probe cross-repo after deploy; gate admits observed. |
| **PDP identity live-read** (`maybeBuildLiveSyntheticPdp`, `fetchApprovedLiveIdentityGroupMembersForOffers`) | `pdp_identity_listing.live_read_enabled IS TRUE` + approved + not review_required + `buildActiveExternalSeedIdentityPredicate`. | **live_read_enabled=false** | **Gated. This is the explicit turn-on step (§4).** Drives the rich grouped PDP + both-offer hydration that T1 fixed. |

**`pdp_scope='unverified'` / `readiness_tier='referral_only'`:** traced all consumers in `src/server.js` + services — both are **carried as output fields, not hard serving gates**. They do not block recall or PDP render. (`resolved_vertical=NULL` + `category='electronics'`: only matters for *vertical-filtered* lanes; a text query like "bone conduction headphones" is not vertical-hard-filtered, so it is unaffected. Vertical-scoped recall won't pick Mojawa up until Plan B sets `resolved_vertical`.)

**Net:** after the ADR-009 sweep + this PR deploy, Mojawa is **recall-servable with no further DB change**. The live-read promotion (§4) is needed for the **rich grouped PDP with both offers and the "Mojawa" seller name** — the exact path T1 corrected.

---

## 3. Precondition — deploy gate (do this first)

Serving flips are meaningless until the code is live. Confirm prod is at/after the commit that merges this PR (which also carries the ADR-009 sweep: **#1773, #1775, #1776, #1778, #1779**).

```
curl -s https://api.pivota.cc/version | jq '{full_sha, branch}'
```

- **As of writing, prod = `fcdd07ad`, which predates the ADR-009 sweep** (the sweep commits are on `origin/main`, dated 2026-07-12, and are not ancestors of the prod SHA). Do **not** proceed to §4 until prod includes this PR's merge SHA.

---

## 4. Turn on Mojawa (rich PDP live-read) — ordered steps

Run from a checkout at the merged SHA. Uses `DATABASE_URL` (prod, ssl `rejectUnauthorized:false`); no secrets printed.

1. **Dry-run the promotion** (no writes; default is dry-run):
   ```
   node scripts/promote-pdp-identity-live-read.js --brand mojawa
   ```
   Expect `groups_eligible: 3`, `rows_to_enable: 3`, `require_brand_source: true`, 3 `sample_refs`. If `rows_to_enable` ≠ 3, STOP and inspect (brand_norm mismatch or a group missing a brand-tier source).

2. **Apply** (flips `live_read_enabled=true` on the 3 merch_obs_ pil rows + writes an `approve_live_read` override, in one transaction):
   ```
   node scripts/promote-pdp-identity-live-read.js --brand mojawa --write --created-by <you>
   ```
   Expect `updated_rows: 3`.

3. **Live probe (verify):**
   - `find_products("bone conduction headphones")` (and/or `find_products_multi`) → Mojawa appears; response-metadata `query_source` confirms the serving lane (expect the commerce-index/canonical lane).
   - PDP fetch for a Mojawa content_key → seller name **"Mojawa"**, grouped as **one sellable item group with both lane members** (connected url_audit + observed merch_obs_), neither dropping the other, in-stock brand_direct offer present.

4. **Rollback (fully reversible):**
   ```sql
   -- revert live-read for the 3 Mojawa observed rows
   UPDATE pdp_identity_listing
      SET live_read_enabled = false, updated_at = now()
    WHERE merchant_id = 'merch_obs_022b65d47a58b87a'
      AND source_kind = 'external_seed';
   -- deactivate the promotion overrides
   UPDATE pdp_identity_override
      SET active = false, updated_at = now()
    WHERE action_type = 'approve_live_read'
      AND source_listing_ref IN (
        SELECT source_listing_ref FROM pdp_identity_listing
        WHERE merchant_id = 'merch_obs_022b65d47a58b87a'
      );
   ```
   Do **not** hand-edit `index_pipeline_state.serving_eligible` — it is pipeline-owned.

---

## 5. Remaining `merch_obs_` cohort — founder decision (do NOT blanket-turn-on)

**43 observed sellers / 1,359 live `merch_obs_` catalog_products; 926 serving_eligible.** Top sellers by product count:

| seller | merch_obs_ id | products | serving_eligible |
|---|---|---|---|
| Paul Mitchell | merch_obs_2f4c3218b94929d0 | 250 | 209 |
| TONYMOLY USA | merch_obs_5239b11b1dd11d40 | 189 | 60 |
| ~Pourri | merch_obs_c33423d5f0c28101 | 89 | 85 |
| KUNDAL | merch_obs_d8355ade38899abb | 72 | 50 |
| FORBEAUT | merch_obs_7d65d696184c1023 | 54 | 0 |
| I DEW CARE | merch_obs_797322ed31d9ae01 | 54 | 34 |
| GOONGBE | merch_obs_8887b6c53f029191 | 49 | 47 |
| Lador | merch_obs_feb858b14bb7b8ba | 49 | 45 |
| IUNIK GLOBAL | merch_obs_9771ea61329c8cf0 | 45 | 44 |
| Rovectin | merch_obs_7374d4aba789b98b | 44 | 42 |
| Vital Proteins | merch_obs_3d5125ac57d3b38f | 36 | 35 |
| … (32 more sellers) | | | |

### ⚠️ Correction to the plan's "offers-missing" caveat
The plan / deposit-leg §5 says **"344/380 have no offer row … Paul Mitchell offer-less … only 36 brand_direct+first-party."** **This is now stale.** Prod-measured 2026-07-12: **all 1,359 `merch_obs_` products carry a `catalog_offers` row** with `offer_type='brand_direct'`, `is_first_party=true`, `channel='external_referral'`, `source_system='external_product_seeds_mirror_v1'` (Paul Mitchell: 250/250). Offers were evidently backfilled since the doc was written.

**Nuance that still holds:** these are **mirror / external-referral** offers — citable, priced, and referral-attributable (redirect to the brand's own site), but **not wired to an in-Pivota hosted checkout** (no transactional Shopify/Wix connector for observed brands). So the "citable-but-not-buyable" framing survives at the **checkout** grain, not at the "has an offer row" grain.

**Founder decision (do not decide unilaterally):**
- Turn-on gate per seller is `live_read_enabled` promotion (§4, `--brand <name>`) — but only **after** each seller's identity/trust backfill lands (deposit-leg 377 doc); many of the 377 are still identity-dark (`pdp_identity_listing` keyed on the legacy bucket or absent), so a promotion today would find `rows_to_enable: 0` for them.
- `serving_eligible` coverage is uneven (e.g. FORBEAUT 0/54) — those rows won't recall regardless of live-read; that's a quality/index-pipeline signal, not a turn-on lever.
- Recommend: turn on **per verified seller** (dry-run → probe → apply), not a blanket sweep. Mojawa first (§4), then evaluate Paul Mitchell / GOONGBE (high serving_eligible ratio) after their backfill.

---

## 6. Regression guards (in this PR's tests)

- Pure legacy `external_seed` group: seller name stays **NULL** (no "External Seed" leak) — golden behavior unchanged.
- `merch_obs_` row: resolves seller name; surfaces as a member.
- MIXED group (Mojawa shape: connected url_audit + observed merch_obs_): **both** members surface, neither drops the other.
- NULL / 3-valued cases: a `merch_obs_` member with a NULL seller name still surfaces (not dropped); a row missing merchant_id/product_id is dropped without dropping valid siblings.
- A `merch_obs_` row that fails quality gates (`serving_eligible=false`) still does not serve — the recall gate is unchanged.
