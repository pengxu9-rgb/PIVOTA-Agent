const fs = require('fs');
const path = require('path');
const { withClient } = require('./index');

const SEEDS_DIR = path.join(__dirname, 'seeds');
const SEEDS_LOCK_ID = 72403120;

function listSeedFiles() {
  if (!fs.existsSync(SEEDS_DIR)) return [];
  return fs
    .readdirSync(SEEDS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

async function ensureSeedsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_seeds (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function runSeeds() {
  const files = listSeedFiles();
  if (!files.length) return;
  return withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [SEEDS_LOCK_ID]);
    try {
      await ensureSeedsTable(client);
      const appliedRes = await client.query('SELECT id FROM schema_seeds');
      const applied = new Set(appliedRes.rows.map((r) => r.id));

      for (const filename of files) {
        if (applied.has(filename)) continue;
        const sql = fs.readFileSync(path.join(SEEDS_DIR, filename), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_seeds (id) VALUES ($1)', [filename]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SEEDS_LOCK_ID]);
    }
  });
}

module.exports = {
  runSeeds,
};
