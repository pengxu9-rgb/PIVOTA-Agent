CREATE SCHEMA IF NOT EXISTS pci_kb;

CREATE OR REPLACE FUNCTION pci_kb.normalize_ingredient_reference_key(input_text TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT LEFT(
    REGEXP_REPLACE(
      LOWER(COALESCE(input_text, '')) COLLATE "C",
      '[^[:alnum:]]+',
      '',
      'g'
    ),
    240
  );
$$;

CREATE OR REPLACE FUNCTION pci_kb.semicolon_text_to_array(input_text TEXT)
RETURNS TEXT[]
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT token
      FROM (
        SELECT MIN(ord)::bigint AS ord, token
        FROM (
          SELECT
            ord,
            NULLIF(BTRIM(part), '') AS token
          FROM UNNEST(REGEXP_SPLIT_TO_ARRAY(COALESCE(input_text, ''), ';')) WITH ORDINALITY AS t(part, ord)
        ) split_tokens
        WHERE token IS NOT NULL
        GROUP BY token
      ) deduped
      ORDER BY ord
    ),
    ARRAY[]::TEXT[]
  );
$$;

CREATE OR REPLACE VIEW pci_kb.ingredient_reference_dictionary_v1 AS
WITH staged AS (
  SELECT
    s.source_file,
    s.source_sheet,
    s.source_row_number,
    s.ingested_at,
    s.record_id,
    s.canonical_inci_name,
    COALESCE(NULLIF(BTRIM(s.canonical_display_name), ''), s.canonical_inci_name) AS canonical_display_name,
    s.ingredient_family,
    s.us_label_name,
    s.eu_label_name,
    pci_kb.semicolon_text_to_array(s.us_label_variants) AS us_label_variants_list,
    pci_kb.semicolon_text_to_array(s.eu_label_variants) AS eu_label_variants_list,
    s.cross_market_notes,
    s.normalized_key,
    pci_kb.semicolon_text_to_array(s.aliases_common) AS aliases_common_list,
    pci_kb.semicolon_text_to_array(s.parser_variants) AS parser_variants_list,
    pci_kb.semicolon_text_to_array(s.deprecated_aliases) AS deprecated_aliases_list,
    s.alias_quality,
    s.notes_for_parser,
    s.primary_bucket,
    pci_kb.semicolon_text_to_array(s.all_buckets) AS all_buckets_list,
    pci_kb.semicolon_text_to_array(s.function_tags) AS function_tags_list,
    pci_kb.semicolon_text_to_array(s.benefit_tags) AS benefit_tags_list,
    pci_kb.semicolon_text_to_array(s.risk_flags) AS risk_flags_list,
    s.is_humectant,
    s.is_barrier_support,
    s.is_retinoid,
    s.is_exfoliant,
    s.is_uv_filter,
    s.is_preservative,
    s.is_surfactant,
    s.is_fragrance_or_eo,
    s.regulatory_bucket,
    pci_kb.semicolon_text_to_array(s.source_urls) AS source_urls_list,
    pci_kb.semicolon_text_to_array(s.source_authorities) AS source_authorities_list,
    pci_kb.semicolon_text_to_array(s.source_types) AS source_types_list,
    s.review_status,
    s.confidence,
    s.last_reviewed_at,
    s.review_notes,
    s.notes,
    s.kb_version,
    ARRAY_REMOVE(
      ARRAY[
        NULLIF(BTRIM(s.canonical_inci_name), ''),
        NULLIF(BTRIM(COALESCE(NULLIF(BTRIM(s.canonical_display_name), ''), s.canonical_inci_name)), ''),
        NULLIF(BTRIM(s.us_label_name), ''),
        NULLIF(BTRIM(s.eu_label_name), '')
      ]::TEXT[],
      NULL
    )
      || pci_kb.semicolon_text_to_array(s.us_label_variants)
      || pci_kb.semicolon_text_to_array(s.eu_label_variants)
      || pci_kb.semicolon_text_to_array(s.aliases_common)
      || pci_kb.semicolon_text_to_array(s.parser_variants)
      || pci_kb.semicolon_text_to_array(s.deprecated_aliases) AS lookup_terms
  FROM seed_ingest.ingredient_reference_seed s
  WHERE LOWER(BTRIM(COALESCE(s.review_status, ''))) IN ('reviewed', 'approved')
)
SELECT
  staged.source_file,
  staged.source_sheet,
  staged.source_row_number,
  staged.ingested_at,
  staged.record_id,
  staged.canonical_inci_name,
  staged.canonical_display_name,
  staged.ingredient_family,
  staged.us_label_name,
  staged.eu_label_name,
  staged.us_label_variants_list,
  staged.eu_label_variants_list,
  staged.cross_market_notes,
  staged.normalized_key,
  staged.aliases_common_list,
  staged.parser_variants_list,
  staged.deprecated_aliases_list,
  staged.alias_quality,
  staged.notes_for_parser,
  staged.primary_bucket,
  staged.all_buckets_list,
  staged.function_tags_list,
  staged.benefit_tags_list,
  staged.risk_flags_list,
  staged.regulatory_bucket,
  staged.source_urls_list,
  staged.source_authorities_list,
  staged.source_types_list,
  staged.review_status,
  staged.confidence,
  staged.last_reviewed_at,
  staged.review_notes,
  staged.notes,
  staged.kb_version,
  staged.lookup_terms,
  ARRAY(
    SELECT normalized_term
    FROM (
      SELECT
        MIN(ord)::bigint AS ord,
        normalized_term
      FROM (
        SELECT
          ord,
          NULLIF(pci_kb.normalize_ingredient_reference_key(term), '') AS normalized_term
        FROM UNNEST(staged.lookup_terms) WITH ORDINALITY AS t(term, ord)
      ) normalized
      WHERE normalized_term IS NOT NULL
      GROUP BY normalized_term
    ) deduped_normalized
    ORDER BY ord
  ) AS lookup_terms_normalized,
  CASE LOWER(BTRIM(COALESCE(staged.is_humectant, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_humectant_bool,
  CASE LOWER(BTRIM(COALESCE(staged.is_barrier_support, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_barrier_support_bool,
  CASE LOWER(BTRIM(COALESCE(staged.is_retinoid, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_retinoid_bool,
  CASE LOWER(BTRIM(COALESCE(staged.is_exfoliant, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_exfoliant_bool,
  CASE LOWER(BTRIM(COALESCE(staged.is_uv_filter, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_uv_filter_bool,
  CASE LOWER(BTRIM(COALESCE(staged.is_preservative, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_preservative_bool,
  CASE LOWER(BTRIM(COALESCE(staged.is_surfactant, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_surfactant_bool,
  CASE LOWER(BTRIM(COALESCE(staged.is_fragrance_or_eo, '')))
    WHEN 'yes' THEN TRUE
    WHEN 'no' THEN FALSE
    ELSE NULL
  END AS is_fragrance_or_eo_bool,
  CASE LOWER(BTRIM(COALESCE(staged.confidence, '')))
    WHEN 'high' THEN 3
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 1
    ELSE 0
  END AS confidence_rank
FROM staged;
