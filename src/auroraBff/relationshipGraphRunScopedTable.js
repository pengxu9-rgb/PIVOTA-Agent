'use strict';

// A snapshot table that lives for one relationship-graph run, on ONE dedicated connection
// (src/db withClient). Target recall and KB evidence enrichment used to re-materialize the same
// expensive set inside every batch query (2026-10-14 Query Insights: 31-40 eligible-catalog scans
// at ~6.7 s and 14 KB identity scans at ~11 s per nightly run, the two pivota-pg CPU bursts).
// The set is built once, on first use, and every batch on the same connection reads it.
//
// No transaction: a failed statement must not poison the connection for the batches after it.
// Every caller must drop() in a finally; a temp table also dies with its session.
// ensure() memoizes the build, so a failed build (for example a missing source table) rejects
// with the same error for every batch, as each per-call query would have failed.
//
// The set is a snapshot taken when the stage starts: a row that changes mid-stage (a KB document
// rejected, a listing suppressed) is seen as it was at the build, for every batch of that stage.
// The per-call path re-read it per batch. Stages run minutes, and the next run rebuilds.
//
// A query that finds the table gone (the session was lost, or a transaction-mode pooler handed
// the statement to another backend) throws RUN_SCOPED_TABLE_LOST. It must never read as a missing
// source: recall would fail closed and KB would return no intel, silently.
const RUN_SCOPED_TABLE_LOST = 'RELGRAPH_RUN_SCOPED_TABLE_LOST';

function lostTableError(err, name) {
  const message = String(err?.message || '');
  if (!(String(err?.code || '') === '42P01' || /does not exist/i.test(message)) || !message.includes(name)) return null;
  // The original text stays in cause only: "relation ... does not exist" in this message would
  // match isSourceMissingError and be swallowed after all.
  const lost = new Error(`relgraph run-scoped table ${name} is gone from its session (lost connection or transaction-mode pooler)`);
  lost.code = RUN_SCOPED_TABLE_LOST;
  lost.cause = err;
  return lost;
}

function runScopedTable(client, { name, columns = null, populateSql, params = null }) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`invalid run-scoped table name ${name}`);
  const table = `pg_temp.${name}`;
  let build = null;
  let ready = false;
  return {
    table,
    ensure() {
      if (!build) {
        build = (async () => {
          try {
            await client.query(`DROP TABLE IF EXISTS ${table}`);
            if (columns) {
              // A bind parameter cannot appear in CREATE TABLE AS, so a parameterized set is inserted.
              await client.query(`CREATE TEMP TABLE ${name} (${columns})`);
              await client.query(`INSERT INTO ${table} ${populateSql}`, params || undefined);
            } else {
              await client.query(`CREATE TEMP TABLE ${name} AS ${populateSql}`);
            }
            await client.query(`ANALYZE ${table}`);
          } catch (err) {
            throw lostTableError(err, name) || err;
          }
          ready = true;
        })();
      }
      return build;
    },
    // Builds on first use, then runs sql (which reads the table) on the table's connection.
    async query(sql, params) {
      await this.ensure();
      try {
        return await client.query(sql, params);
      } catch (err) {
        throw lostTableError(err, name) || err;
      }
    },
    // 1 when the set was built, 0 when it never was (nothing queried, or the build failed).
    scanCount() { return ready ? 1 : 0; },
    async drop() { await client.query(`DROP TABLE IF EXISTS ${table}`); },
  };
}

function runScopedTablesDisabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.RELGRAPH_RUN_SCOPED_TABLES_DISABLED || '').trim());
}

// The pool size src/db creates (its DB_POOL_MAX default). A stage that holds the run-scoped
// connection while issuing pool queries alongside it needs at least two.
function configuredDbPoolMax() {
  const n = Number(process.env.DB_POOL_MAX || 12);
  return Number.isFinite(n) ? n : 12;
}

function isTransientConnectionError(err) {
  // Lazy: src/db is mocked whole in unit tests that never reach a run-scoped stage.
  const { isTransientDbError } = require('../db');
  return typeof isTransientDbError === 'function' && isTransientDbError(err);
}

// Runs stage(client) on a dedicated connection, ONCE more on a fresh one if the first attempt
// hit a transient connection error or lost its run-scoped table. The per-call path got the same
// single retry from src/db query() (DB_QUERY_RETRIES); a stage re-run rebuilds its table and
// recomputes from scratch, so its result is the same. Any other error is thrown at once.
async function withRunScopedConnection(withClientFn, stage, { label = 'relgraph_run_scoped_stage' } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withClientFn(stage);
    } catch (err) {
      const retryable = err?.code === RUN_SCOPED_TABLE_LOST || isTransientConnectionError(err);
      if (attempt >= 2 || !retryable) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[${label}] retrying once on a fresh connection: ${err?.code || ''} ${err?.message || err}`);
    }
  }
}

module.exports = { RUN_SCOPED_TABLE_LOST, runScopedTable, runScopedTablesDisabled, configuredDbPoolMax,
  withRunScopedConnection };
