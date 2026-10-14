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
          await client.query(`DROP TABLE IF EXISTS ${table}`);
          if (columns) {
            // A bind parameter cannot appear in CREATE TABLE AS, so a parameterized set is inserted.
            await client.query(`CREATE TEMP TABLE ${name} (${columns})`);
            await client.query(`INSERT INTO ${table} ${populateSql}`, params || undefined);
          } else {
            await client.query(`CREATE TEMP TABLE ${name} AS ${populateSql}`);
          }
          await client.query(`ANALYZE ${table}`);
          ready = true;
        })();
      }
      return build;
    },
    // 1 when the set was built, 0 when it never was (nothing queried, or the build failed).
    scanCount() { return ready ? 1 : 0; },
    async drop() { await client.query(`DROP TABLE IF EXISTS ${table}`); },
  };
}

function runScopedTablesDisabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.RELGRAPH_RUN_SCOPED_TABLES_DISABLED || '').trim());
}

module.exports = { runScopedTable, runScopedTablesDisabled };
