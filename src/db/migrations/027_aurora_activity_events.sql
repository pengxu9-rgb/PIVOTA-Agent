-- Purpose: Persist Aurora activity stream events for Home recent activity and activity timeline.

CREATE TABLE IF NOT EXISTS aurora_activity_events (
  id BIGSERIAL PRIMARY KEY,
  activity_id TEXT NOT NULL UNIQUE,
  aurora_uid TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  deeplink TEXT,
  source TEXT,
  occurred_at_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (aurora_uid IS NOT NULL OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_aurora_activity_events_user_time
  ON aurora_activity_events(user_id, occurred_at_ms DESC, id DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aurora_activity_events_aurora_time
  ON aurora_activity_events(aurora_uid, occurred_at_ms DESC, id DESC)
  WHERE aurora_uid IS NOT NULL;
