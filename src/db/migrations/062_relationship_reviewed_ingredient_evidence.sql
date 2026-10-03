-- Optional exact-listing reviewed ingredient lane. No backfill or legacy record mutation.
CREATE TABLE IF NOT EXISTS public.relgraph_reviewed_ingredient_evidence (
  evidence_id text PRIMARY KEY CHECK (evidence_id ~ '^[a-f0-9]{64}$'),
  identity_key text NOT NULL CHECK (identity_key ~ '^[a-f0-9]{64}$'),
  product_key text NOT NULL DEFAULT '', pivota_signature_id text NOT NULL DEFAULT '',
  product_id text NOT NULL DEFAULT '', source_product_id text NOT NULL DEFAULT '',
  merchant_id text NOT NULL DEFAULT '', platform text NOT NULL DEFAULT '', market text NOT NULL CHECK (market <> ''),
  variant_title text NOT NULL DEFAULT '', variant_detail_label text NOT NULL DEFAULT '',
  ingredient_text text NOT NULL CHECK (length(ingredient_text) BETWEEN 1 AND 24000),
  formula_sha256 text NOT NULL CHECK (formula_sha256 ~ '^[a-f0-9]{64}$'),
  raw_source_sha256 text NOT NULL CHECK (raw_source_sha256 ~ '^[a-f0-9]{64}$'),
  source_url text NOT NULL CHECK (source_url LIKE 'https://%'),
  source_observed_at timestamptz NOT NULL,
  proof jsonb NOT NULL CHECK (proof @> '{"schema":"relgraph.reviewed_ingredient_evidence.v1","parse_status":"OK","review_status":"APPROVED","audit_status":"PASS","ingest_allowed":true}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (product_key <> '' OR pivota_signature_id <> '' OR product_id ~* '^ext_' OR source_product_id ~* '^ext_'),
  CHECK (source_observed_at <= created_at)
);
CREATE INDEX IF NOT EXISTS relgraph_reviewed_ingredient_identity_idx ON public.relgraph_reviewed_ingredient_evidence(identity_key, source_observed_at DESC);
CREATE INDEX IF NOT EXISTS relgraph_reviewed_ingredient_product_idx ON public.relgraph_reviewed_ingredient_evidence(product_key, market);
CREATE INDEX IF NOT EXISTS relgraph_reviewed_ingredient_signature_idx ON public.relgraph_reviewed_ingredient_evidence(pivota_signature_id, market);
CREATE OR REPLACE FUNCTION public.relgraph_ingredient_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'reviewed ingredient evidence is append-only'; END;
$$;
DROP TRIGGER IF EXISTS relgraph_ingredient_evidence_immutable ON public.relgraph_reviewed_ingredient_evidence;
CREATE TRIGGER relgraph_ingredient_evidence_immutable BEFORE UPDATE OR DELETE ON public.relgraph_reviewed_ingredient_evidence
FOR EACH ROW EXECUTE FUNCTION public.relgraph_ingredient_evidence_append_only();
DROP TRIGGER IF EXISTS relgraph_ingredient_evidence_no_truncate ON public.relgraph_reviewed_ingredient_evidence;
CREATE TRIGGER relgraph_ingredient_evidence_no_truncate BEFORE TRUNCATE ON public.relgraph_reviewed_ingredient_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.relgraph_ingredient_evidence_append_only();
