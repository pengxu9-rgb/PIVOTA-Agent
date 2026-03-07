-- Purpose: Persist Aurora activity timeline events for guest/account identities.
-- Compatibility:
--   - Supports existing legacy table shape:
--       id, activity_id, payload, occurred_at_ms
--   - Avoids assumptions about newer timestamp/json column names.

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS activity_id TEXT;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS aurora_uid TEXT;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS user_id TEXT;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS event_type TEXT;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS payload JSONB;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS deeplink TEXT;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS occurred_at_ms BIGINT;

ALTER TABLE IF EXISTS aurora_activity_events
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'aurora_activity_events'
      AND column_name = 'activity_id'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE aurora_activity_events
      ALTER COLUMN activity_id TYPE TEXT USING activity_id::text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'aurora_activity_events'
      AND column_name = 'payload_json'
  ) THEN
    UPDATE aurora_activity_events
    SET payload = payload_json
    WHERE payload IS NULL AND payload_json IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'aurora_activity_events'
      AND column_name = 'occurred_at'
  ) THEN
    UPDATE aurora_activity_events
    SET occurred_at_ms = (EXTRACT(EPOCH FROM occurred_at) * 1000)::BIGINT
    WHERE occurred_at_ms IS NULL AND occurred_at IS NOT NULL;
  END IF;
END $$;

UPDATE aurora_activity_events
SET payload = '{}'::jsonb
WHERE payload IS NULL;

ALTER TABLE IF EXISTS aurora_activity_events
  ALTER COLUMN payload SET DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS aurora_activity_events
  ALTER COLUMN payload SET NOT NULL;

UPDATE aurora_activity_events
SET occurred_at_ms = (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT
WHERE occurred_at_ms IS NULL;

ALTER TABLE IF EXISTS aurora_activity_events
  ALTER COLUMN occurred_at_ms SET NOT NULL;

UPDATE aurora_activity_events
SET activity_id = CONCAT('act_', SUBSTR(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT), 1, 24))
WHERE activity_id IS NULL OR BTRIM(activity_id) = '';

ALTER TABLE IF EXISTS aurora_activity_events
  ALTER COLUMN activity_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS aurora_activity_events_activity_id_key
  ON aurora_activity_events(activity_id);

CREATE INDEX IF NOT EXISTS idx_aurora_activity_events_aurora_time
  ON aurora_activity_events(aurora_uid, occurred_at_ms DESC, activity_id DESC)
  WHERE aurora_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aurora_activity_events_user_time
  ON aurora_activity_events(user_id, occurred_at_ms DESC, activity_id DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aurora_activity_events_event_type_time
  ON aurora_activity_events(event_type, occurred_at_ms DESC, activity_id DESC);
