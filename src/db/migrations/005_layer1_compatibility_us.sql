CREATE TABLE IF NOT EXISTS layer1_face_profile_samples_us (
  id UUID PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL, -- selfie | reference
  market TEXT NOT NULL, -- always US
  locale TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  face_profile_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS layer1_face_profile_samples_us_session_created_idx
  ON layer1_face_profile_samples_us (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS layer1_face_profile_samples_us_created_idx
  ON layer1_face_profile_samples_us (created_at DESC);

CREATE TABLE IF NOT EXISTS layer1_similarity_report_samples_us (
  id UUID PRIMARY KEY,
  session_id TEXT NOT NULL,
  market TEXT NOT NULL, -- always US
  locale TEXT NOT NULL,
  preference_mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ref_face_profile_sample_id UUID,
  user_face_profile_sample_id UUID,
  similarity_report_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS layer1_similarity_report_samples_us_session_created_idx
  ON layer1_similarity_report_samples_us (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS layer1_similarity_report_samples_us_created_idx
  ON layer1_similarity_report_samples_us (created_at DESC);

CREATE INDEX IF NOT EXISTS layer1_similarity_report_samples_us_preference_idx
  ON layer1_similarity_report_samples_us (preference_mode, created_at DESC);

