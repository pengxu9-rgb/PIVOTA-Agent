const fs = require('fs');
const path = require('path');

// The root cause of the brand-search index mess: TWO migrations declared
// `idx_external_product_seeds_brand_search_fastpath` with DIFFERENT expressions. The runner sorts
// by filename and every definition is `CREATE INDEX IF NOT EXISTS`, so the alphabetically earlier
// file won the name and the later one silently created nothing — on every database, forever, while
// still reading as coverage that existed. 032's own header calls the hazard out; nothing enforced
// it, so it happened again.
//
// This is a RATCHET, not a clean-sheet assertion. The collisions below already exist and are NOT
// fixed here (see the note on each). It asserts the set is EXACTLY those, so a new collision fails
// and a fixed one has to be removed from the list rather than quietly leaving it stale.
const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

// SCOPE, stated because a scanner that silently under-reports is worse than none: this reads
// explicit `CREATE [UNIQUE] INDEX` statements ONLY. Index names created as a side effect of a
// constraint share the same namespace and are invisible here — `027_aurora_activity_events.sql:5`
// declares `activity_id TEXT NOT NULL UNIQUE`, which creates
// `aurora_activity_events_activity_id_key`, and `028_aurora_activity_feed.sql:116` then declares
// `CREATE UNIQUE INDEX IF NOT EXISTS aurora_activity_events_activity_id_key`. That is a THIRD
// 027/028 collision this test cannot see (benign — same shape — but real). A constraint added over
// an existing index name is worse: `ALTER TABLE ... ADD CONSTRAINT` fails outright with 42P07
// rather than being skipped. So KNOWN_COLLISIONS below is exhaustive for what the scanner covers,
// not for the database.
//
// Pre-existing collisions, each verified by reading both definitions.
//
// Both are in the Aurora activity feed: 028 redeclares 027's index name with `activity_id` as the
// third column where 027 used `id`. 027 sorts first, so 027 wins and 028's definition has NEVER
// been created on any database. Prod therefore carries the `id` shape, not the `activity_id` one
// 028 intended. Left alone deliberately — deciding which shape is wanted, and rebuilding it on a
// live table, is not this cleanup's business. Recorded so it is a known debt with a name.
const KNOWN_COLLISIONS = {
  idx_aurora_activity_events_aurora_time: ['027_aurora_activity_events.sql', '028_aurora_activity_feed.sql'],
  idx_aurora_activity_events_user_time: ['027_aurora_activity_events.sql', '028_aurora_activity_feed.sql'],
};

// Matches the runner's own filter in src/db/migrate.js.
const migrationFiles = () =>
  fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

// Comments are stripped first: several files discuss `CREATE INDEX CONCURRENTLY` in prose, and a
// scanner that reads those captures the word CONCURRENTLY as an index name.
const stripSqlComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const indexNamesIn = (sql) => {
  const names = [];
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/gi;
  const scannable = stripSqlComments(sql);
  let match = re.exec(scannable);
  while (match) {
    names.push(match[1].replace(/"/g, '').toLowerCase());
    match = re.exec(scannable);
  }
  return names;
};

const collisions = () => {
  const owners = new Map();
  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const name of indexNamesIn(sql)) {
      if (!owners.has(name)) owners.set(name, []);
      if (!owners.get(name).includes(file)) owners.get(name).push(file);
    }
  }
  return Object.fromEntries(
    Array.from(owners.entries()).filter(([, files]) => files.length > 1),
  );
};

describe('migration index names', () => {
  test('no NEW migration reuses an index name another migration already creates', () => {
    // Equality, not a subset: a collision that gets fixed must be deleted from KNOWN_COLLISIONS,
    // or this list rots into a permanent exemption for whatever is added to it next.
    expect(collisions()).toEqual(KNOWN_COLLISIONS);
  });

  test('the scanner actually sees the definitions it is asserting about', () => {
    // A control. Without it, a regex that matched nothing would make the test above pass by
    // finding no collisions at all — an absence assertion passing because the mechanism is absent.
    const all = migrationFiles().flatMap((file) =>
      indexNamesIn(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')));
    expect(all.length).toBeGreaterThan(50);
    expect(all).toContain('idx_external_product_seeds_brand_search_norm_recency');
    // ...and it does NOT mistake prose for a definition.
    expect(all).not.toContain('concurrently');
    expect(all).not.toContain('index');
  });

  test('the brand-search fastpath name is now declared exactly once', () => {
    // The file this PR deletes declared it a second time and could never create anything, because
    // 031_external_product_seeds_* sorts first and takes the name — confirmed against prod, whose
    // indexdef for that name is the winner's expression. Pinned so it does not come back.
    const owners = migrationFiles().filter((file) =>
      indexNamesIn(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
        .includes('idx_external_product_seeds_brand_search_fastpath'));
    expect(owners).toEqual(['031_external_product_seeds_brand_search_fastpath.sql']);
  });

  test('the migration runner sorts by filename, which is what decides who wins a collision', () => {
    // The mechanism every assertion above rests on. If the runner stops sorting by filename, which
    // definition wins stops being predictable from the names and this file needs revisiting.
    const source = fs.readFileSync(path.join(MIGRATIONS_DIR, '..', 'migrate.js'), 'utf8');
    expect(source).toMatch(/readdirSync\(MIGRATIONS_DIR\)/);
    expect(source).toContain('.sort()');
  });
});
