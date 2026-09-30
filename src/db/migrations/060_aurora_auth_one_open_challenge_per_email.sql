-- Purpose: at most ONE open (consumed_at IS NULL) Aurora login challenge per email.
--
-- authStore.createOtpChallenge closes the open code and inserts the new one in a single transaction
-- under a per-email advisory lock. This index is the backstop: if anything ever writes around that
-- lock, the second open code for an address fails to insert instead of widening the guess budget.
--
-- Racing /start calls under the old code could leave several open rows per email, and index
-- creation would fail on them (and a failed migration fails the boot). So, under a lock that blocks
-- concurrent writers for the duration of this transaction (the table is small: pruned after 15
-- minutes), close every open row except the newest per email, then build the index.

LOCK TABLE aurora_auth_challenges IN SHARE ROW EXCLUSIVE MODE;

UPDATE aurora_auth_challenges AS older
SET consumed_at = now()
WHERE older.consumed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM aurora_auth_challenges AS newer
    WHERE newer.email = older.email
      AND newer.consumed_at IS NULL
      AND (newer.created_at, newer.challenge_id) > (older.created_at, older.challenge_id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_aurora_auth_challenges_one_open_per_email
  ON aurora_auth_challenges (email)
  WHERE consumed_at IS NULL;
