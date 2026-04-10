CREATE TABLE IF NOT EXISTS pdp_identity_listing (
  source_listing_ref text PRIMARY KEY,
  merchant_id text NOT NULL,
  product_id text NOT NULL,
  source_kind text NOT NULL,
  source_tier text NOT NULL,
  live_read_enabled boolean NOT NULL DEFAULT false,
  sellable_item_group_id text NOT NULL,
  product_line_id text NOT NULL,
  review_family_id text NOT NULL,
  identity_status text NOT NULL,
  identity_confidence numeric(6, 4),
  matched_by_rule text,
  match_basis jsonb NOT NULL DEFAULT '[]'::jsonb,
  strong_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  soft_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  variant_axes jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  official_url text,
  official_domain text,
  brand_norm text,
  title_norm text,
  title_core_norm text,
  review_required boolean NOT NULL DEFAULT false,
  review_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_listing_sellable_item_group
ON pdp_identity_listing (sellable_item_group_id, live_read_enabled, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_listing_product_line
ON pdp_identity_listing (product_line_id, live_read_enabled, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_listing_review_family
ON pdp_identity_listing (review_family_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_listing_brand_status
ON pdp_identity_listing (brand_norm, identity_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_listing_source_lookup
ON pdp_identity_listing (merchant_id, product_id);

CREATE TABLE IF NOT EXISTS pdp_identity_review_queue (
  id text PRIMARY KEY,
  source_listing_ref text NOT NULL REFERENCES pdp_identity_listing(source_listing_ref) ON DELETE CASCADE,
  candidate_listing_ref text,
  queue_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_sellable_item_group_id text,
  proposed_product_line_id text,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_review_queue_status
ON pdp_identity_review_queue (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_review_queue_source
ON pdp_identity_review_queue (source_listing_ref, updated_at DESC);

CREATE TABLE IF NOT EXISTS pdp_identity_override (
  id text PRIMARY KEY,
  source_listing_ref text NOT NULL,
  action_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_override_source
ON pdp_identity_override (source_listing_ref, active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pdp_identity_override_action
ON pdp_identity_override (action_type, active, updated_at DESC);
