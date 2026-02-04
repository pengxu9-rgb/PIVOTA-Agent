-- Purpose: Add password-based auth for Aurora accounts (optional, OTP remains primary).
-- Adds password hash + lockout fields to aurora_users.

ALTER TABLE aurora_users
  ADD COLUMN IF NOT EXISTS password_salt TEXT,
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_alg TEXT,
  ADD COLUMN IF NOT EXISTS password_params JSONB,
  ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_failed_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS password_locked_until TIMESTAMPTZ;

