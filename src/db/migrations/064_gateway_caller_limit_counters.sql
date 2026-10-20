-- Shared counters for the per-caller MCP door limits (src/guardrails/mcpCallerLimits.js).
--
-- Each gateway instance keeps its own counts in memory and, every couple of seconds while it has active
-- callers, writes its ABSOLUTE count per (caller, minute window) here and reads back the other instances'
-- totals. Nothing on the request path reads or writes this table.
--
-- UNLOGGED: these are approximate, minutes-lived counters. They need no WAL, no replica and no crash
-- durability; a crash or failover empties the table and limits fall back to per-instance accounting until
-- the next sync. Each instance writes only rows carrying its own instance_id, so instances never contend
-- on a row lock. `caller_key` is a hash; no address or credential is stored.

CREATE UNLOGGED TABLE IF NOT EXISTS gateway_caller_limit_counters (
  caller_key   text        NOT NULL,
  window_start timestamptz NOT NULL,
  instance_id  text        NOT NULL,
  requests     integer     NOT NULL DEFAULT 0,
  in_flight    integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_key, window_start, instance_id)
);

-- Drives the bounded prune of windows older than two minutes.
CREATE INDEX IF NOT EXISTS gateway_caller_limit_counters_window_start_idx
  ON gateway_caller_limit_counters (window_start);
