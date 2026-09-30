-- Independent of label rewrites: protected labels and zero-edge builds still count as attempts.
CREATE TABLE IF NOT EXISTS relationship_graph_anchor_attempts (
  anchor_ref text NOT NULL CHECK (anchor_ref = lower(anchor_ref)),
  market text NOT NULL CHECK (market = upper(market)),
  vertical text NOT NULL DEFAULT 'beauty' CHECK (vertical = 'beauty'),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anchor_ref, market, vertical)
);
