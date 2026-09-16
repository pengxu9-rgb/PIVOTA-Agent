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

-- idx_aurora_activity_events_aurora_time and idx_aurora_activity_events_user_time are
-- deliberately NOT declared here. 027 already creates both, with `id DESC` as the tiebreak
-- instead of `activity_id DESC`, and 027 sorts first — so these two redeclarations were skipped
-- by IF NOT EXISTS and have never created anything on any database. Prod confirms it: both
-- indexes carry `(…, occurred_at_ms DESC, id DESC)`.
--
-- `id` is also the shape that is WANTED, so the skip was luck rather than a near miss:
-- memoryStore.js reads this table with a keyset cursor over (occurred_at_ms, id) —
--   WHERE (occurred_at_ms < $n OR (occurred_at_ms = $n AND id < $n+1))
--   ORDER BY occurred_at_ms DESC, id DESC
-- which 027's shape answers as a pure index range scan. The `activity_id` tiebreak below would
-- have forced a sort on every page of that reader, and `activity_id` is a random 'act_<md5>', so
-- it is not a meaningful "most recent first" ordering the way a BIGSERIAL `id` is.
--
-- activityStore.js does order by `activity_id DESC`, but consistently: its comparator, its cursor
-- encoding and its cursor filter are all on activity_id, so it is a self-contained scheme that
-- re-sorts in JS. It is not served by either index's tiebreak today and does not need to be at
-- 536 rows. If this table grows enough for that to matter, the answer is a NEW index under its own
-- name, not another declaration of one of these two.

CREATE INDEX IF NOT EXISTS idx_aurora_activity_events_event_type_time
  ON aurora_activity_events(event_type, occurred_at_ms DESC, activity_id DESC);
