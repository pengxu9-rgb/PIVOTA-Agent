CREATE TABLE IF NOT EXISTS service_booking_notifications_outbox (
  outbox_id UUID PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES service_bookings(booking_id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES service_providers(provider_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  ops_acknowledged_at TIMESTAMPTZ,
  ops_acknowledged_by TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_booking_notifications_pending
  ON service_booking_notifications_outbox (status, created_at ASC)
  WHERE status IN ('pending', 'manual_pending');

CREATE INDEX IF NOT EXISTS idx_service_booking_notifications_booking
  ON service_booking_notifications_outbox (booking_id, created_at DESC);
