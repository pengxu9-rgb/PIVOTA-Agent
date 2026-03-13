-- Purpose: Persist Aurora activity detail snapshots for structured history detail pages.

CREATE TABLE IF NOT EXISTS aurora_activity_details (
  activity_id TEXT PRIMARY KEY REFERENCES aurora_activity_events(activity_id) ON DELETE CASCADE,
  detail_kind TEXT NOT NULL,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
