-- Graph-only seller facts: never published to the public Insights KB.
CREATE TABLE IF NOT EXISTS public.relgraph_reviewed_seller_evidence (
  evidence_id text PRIMARY KEY CHECK(evidence_id ~ '^[a-f0-9]{64}$'),
  identity_key text NOT NULL CHECK(identity_key ~ '^[a-f0-9]{64}$'),
  source_observed_at timestamptz NOT NULL, source_url text NOT NULL CHECK(source_url LIKE 'https://%'),
  proof jsonb NOT NULL CHECK(proof @> '{"schema":"relgraph.reviewed_seller_evidence.v1","graph_only":true,"public_insights_eligible":false}'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(source_observed_at<=created_at)
);
CREATE INDEX IF NOT EXISTS relgraph_reviewed_seller_identity_idx ON public.relgraph_reviewed_seller_evidence(identity_key,source_observed_at DESC);
CREATE OR REPLACE FUNCTION public.relgraph_seller_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'reviewed seller evidence is append-only'; END;
$$;
DROP TRIGGER IF EXISTS relgraph_seller_evidence_immutable ON public.relgraph_reviewed_seller_evidence;
CREATE TRIGGER relgraph_seller_evidence_immutable BEFORE UPDATE OR DELETE ON public.relgraph_reviewed_seller_evidence
FOR EACH ROW EXECUTE FUNCTION public.relgraph_seller_evidence_append_only();
DROP TRIGGER IF EXISTS relgraph_seller_evidence_no_truncate ON public.relgraph_reviewed_seller_evidence;
CREATE TRIGGER relgraph_seller_evidence_no_truncate BEFORE TRUNCATE ON public.relgraph_reviewed_seller_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.relgraph_seller_evidence_append_only();
