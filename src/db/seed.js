const fs = require('fs');
const path = require('path');
const { withClient } = require('./index');

const SEEDS_DIR = path.join(__dirname, 'seeds');

function listSeedFiles() {
  if (!fs.existsSync(SEEDS_DIR)) return [];
  return fs
    .readdirSync(SEEDS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

async function runSeeds() {
  const files = listSeedFiles();
  if (!files.length) return;
  return withClient(async (client) => {
    for (const filename of files) {
      const sql = fs.readFileSync(path.join(SEEDS_DIR, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  });
}

async function ensureSeededGlobalFashion() {
  return withClient(async (client) => {
    const res = await client.query(
      "SELECT 1 FROM taxonomy_view WHERE view_id = 'GLOBAL_FASHION' LIMIT 1",
    );
    if (res.rowCount > 0) return;

    const files = listSeedFiles();
    if (!files.length) return;
    const sql = files.map((f) => fs.readFileSync(path.join(SEEDS_DIR, f), 'utf8')).join('\n');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

module.exports = {
  runSeeds,
  ensureSeededGlobalFashion,
};

