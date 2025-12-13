const fs = require('fs');
const path = require('path');
const { withClient } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_LOCK_ID = 72403119;

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function runMigrations() {
  return withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_LOCK_ID]);
    try {
      await ensureMigrationsTable(client);
      const appliedRes = await client.query('SELECT id FROM schema_migrations');
      const applied = new Set(appliedRes.rows.map((r) => r.id));
      const files = listMigrationFiles();

      for (const filename of files) {
        if (applied.has(filename)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [filename]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_LOCK_ID]);
    }
  });
}

module.exports = {
  runMigrations,
};

