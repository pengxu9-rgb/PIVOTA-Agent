'use strict';
// The relationship-graph review queue and serving read consult the catalog serving gate
// (src/auroraBff/relationshipCatalogServingGate.js), which reads catalog_products,
// external_product_seeds and index_pipeline_state. Prod always has them; a review test schema that
// builds only the label table needs them too, empty, or the queue's SELECT fails on a missing
// relation. The gate's columns plus the review supplement's (fetchSupplementsForRows); a row
// inserted without a sync_status is live, so a fixture that is not about catalog state keeps
// passing the gate.
const RELGRAPH_CATALOG_GATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS catalog_products (product_key text PRIMARY KEY, source_product_id text,
    pivota_signature_id text, content_key text, sync_status text DEFAULT 'live', suppressed_at timestamptz,
    suppression_reason text, title text, description text, brand text, product_type text, category text,
    category_path text, category_label text, canonical_url text, pivota_canonical_url text, tags jsonb,
    use_case_tags jsonb, updated_at timestamptz DEFAULT now());
  CREATE TABLE IF NOT EXISTS external_product_seeds (id text PRIMARY KEY, external_product_id text, attached_product_key text,
    title text, price_amount numeric, price_currency text, availability text, status text DEFAULT 'active',
    canonical_url text, domain text, seed_data jsonb);
  CREATE TABLE IF NOT EXISTS index_pipeline_state (content_key varchar(40) PRIMARY KEY, serving_eligible boolean);
`;

module.exports = { RELGRAPH_CATALOG_GATE_TABLES_SQL };
