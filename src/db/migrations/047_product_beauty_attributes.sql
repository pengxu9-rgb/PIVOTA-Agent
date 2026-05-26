-- 047_product_beauty_attributes.sql
-- Beauty-specific structural attributes for SKU relation graph preflight gates.
-- Keyed by product_key (matches external_product_seeds.id / catalog_products
-- product_key, without the 'product:' prefix used in relation graph anchors).
-- Phase C of the relation-graph rejection-rate reduction work.

CREATE TABLE IF NOT EXISTS product_beauty_attributes (
  product_key                       TEXT PRIMARY KEY,

  -- Form factor: lipstick, foundation, serum, cream, oil, mask, brush, etc.
  product_form                      TEXT,
  product_form_source               TEXT,
  product_form_confidence           NUMERIC CHECK (product_form_confidence IS NULL OR (product_form_confidence >= 0 AND product_form_confidence <= 1)),

  -- Granular category leaf: "matte_lipstick", "tinted_finishing_powder", etc.
  -- More specific than catalog_products.category_taxonomy.
  category_leaf                     TEXT,
  category_leaf_source              TEXT,
  category_leaf_confidence          NUMERIC CHECK (category_leaf_confidence IS NULL OR (category_leaf_confidence >= 0 AND category_leaf_confidence <= 1)),

  -- Where on the body the product is used: face, lips, eyes, hair, body, nails.
  target_area                       TEXT,
  target_area_source                TEXT,
  target_area_confidence            NUMERIC CHECK (target_area_confidence IS NULL OR (target_area_confidence >= 0 AND target_area_confidence <= 1)),

  -- Shade/color family for makeup: warm, cool, neutral, brown, red, pink, etc.
  -- NULL for non-shaded products (e.g., serums).
  shade_or_color_family             TEXT,
  shade_or_color_family_source      TEXT,
  shade_or_color_family_confidence  NUMERIC CHECK (shade_or_color_family_confidence IS NULL OR (shade_or_color_family_confidence >= 0 AND shade_or_color_family_confidence <= 1)),

  -- Scent family for fragrances + scented products: floral, woody, citrus, etc.
  -- NULL for unscented or scent-irrelevant products.
  scent_family                      TEXT,
  scent_family_source               TEXT,
  scent_family_confidence           NUMERIC CHECK (scent_family_confidence IS NULL OR (scent_family_confidence >= 0 AND scent_family_confidence <= 1)),

  -- SPF / OTC drug classification: 'cosmetic' (default), 'spf', 'otc_drug', 'spf_otc', 'unknown'.
  -- Used to gate cross-classification candidates (a moisturizer with SPF is not
  -- a direct alternative to a moisturizer without SPF for compliance reasons).
  spf_or_otc_flag                   TEXT,
  spf_or_otc_flag_source            TEXT,
  spf_or_otc_flag_confidence        NUMERIC CHECK (spf_or_otc_flag_confidence IS NULL OR (spf_or_otc_flag_confidence >= 0 AND spf_or_otc_flag_confidence <= 1)),

  -- Primary skin concerns the product targets. Array — many products target
  -- multiple concerns. Vocabulary: acne, anti_aging, brightening, hydration,
  -- redness, sensitivity, oiliness, dryness, hyperpigmentation, etc.
  skin_concern                      TEXT[],
  skin_concern_source               TEXT,
  skin_concern_confidence           NUMERIC CHECK (skin_concern_confidence IS NULL OR (skin_concern_confidence >= 0 AND skin_concern_confidence <= 1)),

  -- Claim risk level: low/medium/high. High = explicit drug-like claims (treats
  -- acne, prevents wrinkles, etc.) per FDA cosmetic vs drug guidance. Used to
  -- gate alternative pairings between cosmetic and OTC-drug products.
  claim_risk_level                  TEXT,
  claim_risk_level_source           TEXT,
  claim_risk_level_confidence       NUMERIC CHECK (claim_risk_level_confidence IS NULL OR (claim_risk_level_confidence >= 0 AND claim_risk_level_confidence <= 1)),

  -- Provenance + audit trail
  extractor_version                 TEXT,
  raw_extraction                    JSONB,
  audit_status                      TEXT NOT NULL DEFAULT 'pending' CHECK (audit_status IN ('pending', 'codex_reviewed', 'manually_corrected', 'rejected')),
  audit_notes                       TEXT,

  extracted_at                      TIMESTAMPTZ,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pba_audit_status         ON product_beauty_attributes (audit_status);
CREATE INDEX IF NOT EXISTS idx_pba_product_form         ON product_beauty_attributes (product_form);
CREATE INDEX IF NOT EXISTS idx_pba_target_area          ON product_beauty_attributes (target_area);
CREATE INDEX IF NOT EXISTS idx_pba_category_leaf        ON product_beauty_attributes (category_leaf);
CREATE INDEX IF NOT EXISTS idx_pba_skin_concern_gin     ON product_beauty_attributes USING GIN (skin_concern);
