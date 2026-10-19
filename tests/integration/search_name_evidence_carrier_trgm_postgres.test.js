'use strict';

// THE CARRIER CTE MUST BE SERVABLE FROM MIGRATION 261'S TRIGRAM INDEX, AND FIND THE SAME CARRIERS.
//
// With CANONICAL_CATALOG_STORED_NAME_NORM on, the carrier CTE reads np.name_norm so that 261's
// `gin (name_norm gin_trgm_ops)` can serve its LIKE prefilter. But the LIKEs sat only inside a
// `CASE WHEN <likes> THEN <regex> ELSE FALSE END`, and PostgreSQL takes index quals only from the
// top-level AND of a WHERE: on prod (EXPLAIN ANALYZE 2026-10-19) every armed query Seq Scanned
// catalog_products for the carriers (43-93 ms, 32.5k rows removed) with the index unused. The LIKEs
// are now ALSO top-level conjuncts ahead of the unchanged CASE.
//
// Two things are pinned, over the acceptance set's 600 production rows and every tracked query:
//   1. SAME CARRIERS: the CTE as built and the CTE with its WHERE put back to the CASE alone return
//      the same keys, and the uncapped carrier sets (no LIMIT) are equal too;
//   2. THE INDEX: with seq scans disabled, the built CTE scans catalog_products through the trigram
//      index, and the CASE-only form cannot (it has no indexable qual) -- so this suite can see the
//      difference it guards.
//
// Dedicated disposable DB only, same opt-in as the other *_postgres suites.

const { Client } = require('pg');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');
const quality = require('../../src/services/canonicalSearchQualitySql');
const probe = require('../../src/services/storedNameNormProbe');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const ROWS = require('../acceptance/fixtures/serving_rows_2026_09_16.json').rows;
const CASES = require('../acceptance/cases.json');
const QUERIES = [...new Set([
  ...CASES.cases.map((c) => c.query),
  ...(CASES.ratchet_queries || []).map((x) => x.query),
  // prod's shapes from the 2026-10-19 EXPLAIN (six and seven distinctive tokens).
  'lightweight hydrating gel moisturizer for sensitive dry skin',
  'long lasting matte red lipstick for dry lips',
])];

const ENV = { SEARCH_NAME_EVIDENCE_ADMISSION: 'on', [quality.STORED_NAME_NORM_FLAG]: 'on' };
const TRGM_INDEX = 'ne_trgm_idx_catalog_products_name_norm_trgm';

async function carrierCte(rawQuery) {
  probe._resetForTest();
  const contract = buildSearchQualityContract({ rawQuery });
  let captured = null;
  await fetchCanonicalChainRows({
    query: rawQuery, searchQualityContract: contract, brandFilter: contract.hard_constraints.brand,
    categoryPathPrefix: contract.hard_constraints.category_path_prefix, categoryMode: 'category_browse',
    deps: { query: async (sql, params) => {
      // The fold-drift probe: the database's fold equals identitySql (prod's state), so the stored read is on.
      if (sql.includes(`${probe.FUNCTION_NAME}(s)`)) return { rows: [{ n: probe.SAMPLES.length, same: probe.SAMPLES.length }] };
      if (!captured) captured = { sql, params };
      return { rows: [] };
    } },
  });
  if (!captured || !captured.sql.includes('name_evidence_carriers AS MATERIALIZED (')) return null;
  const { sql, params } = captured;
  // The CTE body: the balanced parentheses after `AS MATERIALIZED`, skipping quoted literals.
  const open = sql.indexOf('name_evidence_carriers AS MATERIALIZED (') + 'name_evidence_carriers AS MATERIALIZED '.length;
  let depth = 0; let end = -1; let quoted = false;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  return { body: sql.slice(open + 1, end), params };
}

// The WHERE as it was before the LIKEs were hoisted: the CASE alone.
const HOISTED = /\((np\.name_norm LIKE \$\d+(?: AND np\.name_norm LIKE \$\d+)*) AND (\(CASE WHEN \1 THEN np\.name_norm ~ \$\d+ ELSE FALSE END\))\)/;
function caseOnly(body) {
  const out = body.replace(HOISTED, '$2');
  if (out === body) throw new Error(`carrier WHERE is not in the hoisted shape: ${body.slice(0, 400)}`);
  return out;
}
// The carrier rows themselves, without the LIMIT that caps them at MAX_CARRIERS + 1.
function uncapped(body) {
  const m = body.match(/\(SELECT np\.product_key FROM catalog_products np WHERE ([\s\S]*) LIMIT \$\d+\) c/);
  return `SELECT np.product_key FROM catalog_products np WHERE ${m[1]}`;
}

// Run a text that uses some of the statement's binds: renumber them to $1..$k, because PostgreSQL
// rejects a bind it cannot type (one the text never references).
function run(db, text, params) {
  const used = [...new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const renumber = new Map(used.map((n, i) => [n, i + 1]));
  return db.query(text.replace(/\$(\d+)/g, (_, n) => `$${renumber.get(Number(n))}`), used.map((n) => params[n - 1]));
}

function nodes(plan, out = []) {
  out.push(plan);
  for (const child of plan.Plans || []) nodes(child, out);
  return out;
}

suite('name-evidence carriers: hoisted LIKEs use the trigram index and find the same carriers (PostgreSQL)', () => {
  let db; let schema; let savedEnv; const built = new Map();
  jest.setTimeout(300000);

  beforeAll(async () => {
    savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    const { rows: [{ ext_schema: extSchema }] } = await db.query(
      "SELECT n.nspname AS ext_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'");
    schema = `ne_trgm_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}, ${extSchema}`);
    await db.query(`CREATE TABLE catalog_products (product_key varchar(255) PRIMARY KEY, title text, product_type text, name_norm text)`);
    await db.query(
      `INSERT INTO catalog_products (product_key, title, product_type)
       SELECT r->>'product_id', r->>'title', r->>'product_type' FROM jsonb_array_elements($1::jsonb) r`,
      [JSON.stringify(ROWS)]);
    // The stored fold as the backend's trigger stamps it: identitySql over (title, product_type).
    await db.query(`UPDATE catalog_products SET name_norm = ${quality.identitySql("concat_ws(' ', title, product_type)")}`);
    // An unstamped row carries NULL: invisible to the carrier CTE either way.
    await db.query(`INSERT INTO catalog_products (product_key, title, product_type, name_norm)
      VALUES ('unstamped_metal_serum_gloss', 'LIP-PRESSION Metal Serum Gloss', 'Lip Gloss', NULL)`);
    await db.query(`CREATE INDEX ${TRGM_INDEX} ON catalog_products USING gin (name_norm gin_trgm_ops)`);
    await db.query('ANALYZE catalog_products');
    for (const q of QUERIES) {
      const cte = await carrierCte(q);
      if (cte) built.set(q, cte);
    }
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv || {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await db.end();
    }
  });

  test('premise: the tracked queries arm the carrier CTE, and the fixture has carriers for them', async () => {
    expect(built.size).toBeGreaterThanOrEqual(20);
    let nonEmpty = 0;
    for (const { body, params } of built.values()) {
      const { rows } = await run(db, uncapped(body), params);
      if (rows.length > 0) nonEmpty += 1;
    }
    // Not a vacuous comparison: many queries find real carriers in the production rows.
    expect(nonEmpty).toBeGreaterThanOrEqual(10);
  });

  test('every tracked query: same carrier keys, and the same uncapped carrier set, as the CASE-only WHERE', async () => {
    const diffs = [];
    for (const [q, { body, params }] of built) {
      const keys = async (cte) => {
        const { rows: [{ keys: k }] } = await run(db, `WITH name_evidence_carriers AS MATERIALIZED (${cte}) SELECT keys FROM name_evidence_carriers`, params);
        return [...k].sort();
      };
      const set = async (cte) => (await run(db, uncapped(cte), params)).rows.map((r) => r.product_key).sort();
      const [newKeys, oldKeys, newSet, oldSet] = [await keys(body), await keys(caseOnly(body)), await set(body), await set(caseOnly(body))];
      if (JSON.stringify(newKeys) !== JSON.stringify(oldKeys) || JSON.stringify(newSet) !== JSON.stringify(oldSet)) {
        diffs.push({ q, newKeys, oldKeys, newSet, oldSet });
      }
    }
    expect(diffs).toEqual([]);
  });

  test('a NULL (unstamped) name is never a carrier, in either form', async () => {
    const { body, params } = built.get('Metal Serum Gloss') || (await carrierCte('Metal Serum Gloss'));
    for (const cte of [body, caseOnly(body)]) {
      const { rows } = await run(db, uncapped(cte), params);
      expect(rows.map((r) => r.product_key)).not.toContain('unstamped_metal_serum_gloss');
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  test.each([
    'lightweight hydrating gel moisturizer for sensitive dry skin',
    'long lasting matte red lipstick for dry lips',
    'Metal Serum Gloss',
  ])('"%s": the carrier scan uses the trigram index; the CASE-only form cannot', async (q) => {
    const { body, params } = built.get(q);
    const scanOf = async (cte) => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL enable_seqscan = off');
        const { rows } = await run(db, `EXPLAIN (FORMAT JSON) WITH name_evidence_carriers AS MATERIALIZED (${cte}) SELECT keys FROM name_evidence_carriers`, params);
        return nodes(rows[0]['QUERY PLAN'][0].Plan).filter((n) => n.Alias === 'np' || n['Index Name'] === TRGM_INDEX);
      } finally {
        await db.query('ROLLBACK');
      }
    };
    const hoisted = await scanOf(body);
    expect(hoisted.map((n) => n['Index Name']).filter(Boolean)).toContain(TRGM_INDEX);
    expect(hoisted.map((n) => n['Node Type'])).not.toContain('Seq Scan');
    const caseOnlyScan = await scanOf(caseOnly(body));
    expect(caseOnlyScan.map((n) => n['Index Name']).filter(Boolean)).not.toContain(TRGM_INDEX);
  });
});
