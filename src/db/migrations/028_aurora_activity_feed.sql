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
-- by IF NOT EXISTS (which matches on NAME only, silently, even for a different definition) and
-- have never created anything. Prod carries `(…, occurred_at_ms DESC, id DESC)`, measured
-- 2026-09-16 from pg_indexes.
--
-- They are deleted rather than reconciled, because NEITHER tiebreak is worth a rebuild here and
-- leaving two contradictory declarations of one name is the actual defect. The readers disagree,
-- and not in 027's favour:
--
--   * activityStore.js listActivityForIdentity is the LIVE list reader (routes/activityRoutes.js
--     -> activityStore.js). Since 2026-09-17 it pages by keyset —
--     `(occurred_at_ms, activity_id COLLATE "C")`, one page plus one row per query — so it is the
--     one that would want an activity_id tiebreak. Neither index here supplies it: both break ties
--     on `id`, and 028's version would have used the database collation, not "C". EXPLAIN on PG 15,
--     2026-09-17, two different shapes:
--       - GUEST (aurora_uid only): Index Scan on the identity index with ONLY the identity as Index
--         Cond; the cursor predicate is a Filter over rows newer than the cursor; an Incremental
--         Sort on the presorted occurred_at_ms settles the tie. A deep page scans the newer rows.
--       - SIGNED-IN (user_id OR aurora_uid): a BitmapOr over BOTH partial indexes that reads the
--         identity's ENTIRE history on every page, page 1 included, then a Sort. The cursor is
--         again only a Filter. This was already the plan before keyset paging.
--     Negligible at prod's largest history (85 events); proportional to history size, not page size.
--   * memoryStore.js listActivityEventsForIdentity is the (occurred_at_ms, id) keyset reader that
--     027's shape fits exactly. It is exported and has NO callers as of 2026-09-16 — so "027's
--     shape is the one in use" would be an argument from dead code, and is not made here.
--
-- Do not read `activity_id` as a time ordering either way: it is mixed-format. memoryStore emits
-- `act_<base36 millis>_<rand>` (lexicographically time-ordered), activityStore emits
-- `act_<uuid4>` (random), and the backfill above emits `act_<md5>`.
--
-- At 536 rows / 288 kB (prod, 2026-09-16) none of this is worth a CREATE INDEX on a live table.
-- Prod keeps the shape it has. If activityStore's ordering ever needs index support, add a NEW
-- index under its own name rather than redeclaring one of these two.

CREATE INDEX IF NOT EXISTS idx_aurora_activity_events_event_type_time
  ON aurora_activity_events(event_type, occurred_at_ms DESC, activity_id DESC);
