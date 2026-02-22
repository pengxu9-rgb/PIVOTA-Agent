# Aurora Chat V2 KB v0 Summary

- **kb_version:** kb_v0_20260222
- **generated_utc:** 2026-02-22T04:15:00Z

## Counts
- concepts: 299
- ingredients: 403
- safety_rules: 60
- templates: 24
- interactions: 80
- climate regions/archetypes: 120

## Top sources used
- Note: sources are tagged as `verified_in_session` only when retrieved via in-session web browsing; otherwise `unverified_in_session` and `accessed_utc` is set to `uncertain`.
- [unverified_in_session] American Academy of Dermatology: Skin care during pregnancy (unverified URL) — uncertain
- [unverified_in_session] Cosmetic ingredient database (CosIng) - European Commission — https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en
- [verified_in_session] American Academy of Dermatology issues updated guidelines for the management of acne - News - Journal of the American Academy of Dermatology — https://www.jaad.org/article/S0190-9622(24)00465-2/fulltext
- [unverified_in_session] Dermatologist-approved pregnancy skin care (American Academy of Dermatology) — https://www.aad.org/public/everyday-care/skin-care-secrets/routine/pregnancy-skin-care
- [unverified_in_session] Fragrance and perfume contact allergy (DermNet NZ) — https://dermnetnz.org/topics/fragrance-mix-allergy
- [unverified_in_session] Commission Regulation (EU) 2023/1545 on labelling of fragrance allergens (EUR-Lex) — https://eur-lex.europa.eu/eli/reg/2023/1545/oj/eng
- [unverified_in_session] Topical retinoids (vitamin A creams) (DermNet NZ) — https://dermnetnz.org/topics/topical-retinoids
- [unverified_in_session] Topical Acne Treatments (MotherToBaby) — https://mothertobaby.org/fact-sheets/topical-acne-treatments-pregnancy/
- [unverified_in_session] Skin Care, Hair Care and Cosmetic Treatments in Pregnancy and Breastfeeding (NSW Health MotherSafe) — https://www.seslhd.health.nsw.gov.au/sites/default/files/groups/Royal_Hospital_for_Women/Mothersafe/documents/skinhairpregbr2021.pdf
- [unverified_in_session] Safety of skin care products during pregnancy (Canadian Family Physician, PDF) — https://www.cfp.ca/content/cfp/57/6/665.full.pdf
- [unverified_in_session] Is any acne treatment safe to use during pregnancy? (American Academy of Dermatology) — https://www.aad.org/public/diseases/acne/derm-treat/pregnancy
- [unverified_in_session] Methylisothiazolinone allergy (DermNet NZ) — https://dermnetnz.org/topics/methylisothiazolinone-allergy

## Safety stance
- This KB is designed for **safety-first** routing in a skincare assistant. It **does not provide medical diagnosis**.
- When evidence is unclear or user context is missing, rules default to **REQUIRE_INFO** or **WARN/BLOCK** and advise **consulting a clinician** when appropriate.

## Known gaps / next priorities
- **Source verification gap:** In this session, only a small subset of URLs were verified. Many sources are marked `uncertain`. Next step: run a dedicated crawling/verification pass to replace all `uncertain` sources with verified URLs + accessed times, and add ≥2 authoritative sources for each pregnancy/lactation/high-risk-med rule.
- **Ingredient evidence depth:** Many ingredient entries are taxonomy-level (class/attributes) with conservative notes. Next step: attach authoritative ingredient/function sources (e.g., CosIng entries per INCI, regulatory opinions for UV filters/preservatives).
- **Climate normals fidelity:** Current dataset is archetype-based with categorical quarter-month profiles. Next step: map popular destinations to archetypes with verified climatology sources and expand to 12-month profiles where needed.

## Non-diagnosis reminder
- Templates avoid diagnostic statements (e.g., 'you have X'). Guidance is framed as routine/safety advice and referral to clinicians when needed.