-- Beauty Services initiative — Stage 1 schema.
-- See SESSION_HANDOFF_2026-05-22.md and project_pivota_services_initiative.md.
-- Tables: service_providers, service_listings, product_to_service_taxonomy, service_bookings.
-- Pivota owns the framework; Stage 2 will plug Vagaro/Mindbody/Booksy/Treatwell/Fresha in
-- as additional `source` values without further schema changes.

CREATE TABLE IF NOT EXISTS service_providers (
  provider_id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_external_id TEXT,
  name TEXT NOT NULL,
  display_name TEXT,
  website_url TEXT,
  email TEXT,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country_code TEXT,
  geo_lat NUMERIC(9, 6),
  geo_lng NUMERIC(9, 6),
  timezone TEXT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  hours JSONB NOT NULL DEFAULT '{}'::JSONB,
  photos JSONB NOT NULL DEFAULT '[]'::JSONB,
  rating NUMERIC(3, 2),
  rating_count INTEGER,
  status TEXT NOT NULL DEFAULT 'candidate',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_providers_geo
  ON service_providers (country_code, region, city);

CREATE INDEX IF NOT EXISTS idx_service_providers_status_source
  ON service_providers (status, source, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_providers_categories
  ON service_providers USING GIN (categories);

CREATE INDEX IF NOT EXISTS idx_service_providers_source_external_id
  ON service_providers (source, source_external_id)
  WHERE source_external_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS service_listings (
  listing_id UUID PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES service_providers(provider_id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  duration_minutes INTEGER,
  requires_consult BOOLEAN NOT NULL DEFAULT false,
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_listings_provider
  ON service_listings (provider_id, status);

CREATE INDEX IF NOT EXISTS idx_service_listings_service_type
  ON service_listings (service_type, status);


CREATE TABLE IF NOT EXISTS product_to_service_taxonomy (
  mapping_id UUID PRIMARY KEY,
  product_category_path TEXT NOT NULL,
  service_types TEXT[] NOT NULL,
  confidence NUMERIC(4, 3),
  source TEXT NOT NULL DEFAULT 'llm',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active mapping per product category path; superseded rows are kept with active=false.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_to_service_taxonomy_path_active
  ON product_to_service_taxonomy (product_category_path)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_product_to_service_taxonomy_service_types
  ON product_to_service_taxonomy USING GIN (service_types)
  WHERE active = true;


CREATE TABLE IF NOT EXISTS service_bookings (
  booking_id UUID PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES service_listings(listing_id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES service_providers(provider_id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  requested_slot TIMESTAMPTZ NOT NULL,
  alternate_slots JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL DEFAULT 'requested',
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  deposit_currency TEXT NOT NULL DEFAULT 'USD',
  deposit_payment_intent TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  notes TEXT,
  provider_notified_at TIMESTAMPTZ,
  provider_confirmed_at TIMESTAMPTZ,
  provider_rejected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_bookings_user
  ON service_bookings (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_service_bookings_provider_status
  ON service_bookings (provider_id, status, requested_slot);

CREATE INDEX IF NOT EXISTS idx_service_bookings_listing
  ON service_bookings (listing_id, requested_slot);

-- Sweep target for SLA expiry job.
CREATE INDEX IF NOT EXISTS idx_service_bookings_pending_expiry
  ON service_bookings (expires_at)
  WHERE status = 'requested';
