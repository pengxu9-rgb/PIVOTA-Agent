const { Client } = require('pg');

// The brand-page seed scan (discoveryFeed's fetchBrandScopedExternalSeedCandidates) was the top
// statement in prod pg_stat_statements on 2026-09-15: 30,605 calls, 5.26s mean, 161,057s total. It
// matched brands with six OR'd JSONB expressions, four of them `LIKE ANY(array)` — unindexable — so
// every brand page scanned every attached seed.
//
// It now probes TWO brand chains (the seed's own brand, and the brand-or-domain chain the retired
// predicate ORed in) over `left(..., 512)`-bounded `text_pattern_ops` expression indexes. Each lane
// runs TWO statements: a UNION of one indexed branch per probe that returns candidate ids, then a
// by-primary-key fetch that applies the catalog/serving-trust gate. The brand chain is probed by
// prefix for every alias over the 4-character floor and by equality for the rest (never both for one
// alias); the domain chain is probed by EQUALITY ONLY, as the retired predicate did.
//
// This runs the REAL fetcher against real PostgreSQL. It pins:
//   1.  MEMBERSHIP. The old predicate is kept below verbatim (origin/main src/services/discoveryFeed.js,
//       `brandMatchSql`, with its $3 normalized aliases / $4 prefix patterns / $6 compact aliases) and
//       is executed side by side with the statement the fetcher actually issues. Every fixture row
//       must land on the same side for both, EXCEPT the divergences in KNOWN_DIVERGENCES, each of
//       which is pinned individually. Together those are as strong as plain set equality.
//   1b. The FIVE LOSS CLASSES the adversarial review found, each old-vs-new, each its own test.
//   2a. STRUCTURE: every probe is a UNION branch, never another OR'd filter on one scan.
//   2b. INDEXABILITY (`enable_seqscan = off`): EXPLAIN must produce an `Index Cond` on each index.
//       An expression index only yields one when the query expression matches the index expression
//       CHARACTER FOR CHARACTER, so this is the drift alarm between query and index definition.
//   2c. PLAN CHOICE: a 20k-row, ~34MB fixture with the planner left ALONE, asserting the statement
//       does not fall back to a full `Seq Scan on external_product_seeds`. 2b proves an index COULD
//       answer the predicate; only 2c proves the planner picks it.
//   3.  Wildcard escaping, the 2704-byte btree key bound, the 16-alias cap, and the products returned.
//
// Each excluded fixture row is excluded by exactly ONE condition, so removing that condition from
// production changes the member set.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const IDENTITY_INDEX = 'idx_external_seeds_brand_identity_prefix_v1';
const DOMAIN_INDEX = 'idx_external_seeds_brand_domain_identity_prefix_v1';
const TITLE_INDEX = 'idx_external_seeds_attached_title_prefix_v1';

// Substrings unique to each expression as PostgreSQL renders it in a plan: the brand chain ends with
// derived.recall.brand_name, only the domain chain calls split_part, only the title chain reads
// snapshot.title.
const BRAND_PLAN_MARKER = '{derived,recall,brand_name}';
const DOMAIN_PLAN_MARKER = 'split_part';
const TITLE_PLAN_MARKER = "-> 'snapshot'::text) ->> 'title'";

// Distinct brands used only by the plan-choice fixture.
const PLANNER_BRANDS = ['Mixsoon', 'Round Lab', 'Tocobo', 'Lancome', 'Beauty of Joseon', 'Anua', 'Skin1004',
  'Torriden', 'Dr Jart', 'Innisfree', 'Laneige', 'Cosrx', 'Etude House', 'Sulwhasoo', 'Hera Seoul', 'Amorepacific'];

// ---------------------------------------------------------------------------
// The OLD predicate, verbatim from `git show origin/main:src/services/discoveryFeed.js`
// (fetchBrandScopedExternalSeedCandidates, ~line 8857-8872), with the ${...} interpolations of
// epsBrandFieldSql / normalizedBrandSql / compactBrandSql / indexedBrandSql expanded in place. It is
// a frozen literal on purpose: it must not follow any later edit to the shared SQL constants.
// ---------------------------------------------------------------------------
const OLD_EPS_BRAND_SQL =
  "lower(coalesce(eps.seed_data->'derived'->'recall'->>'brand', eps.seed_data->>'brand', eps.seed_data->>'brand_name', eps.seed_data->>'vendor', eps.seed_data->>'vendor_name', eps.seed_data->'snapshot'->>'brand', eps.seed_data->'snapshot'->>'brand_name', eps.seed_data->'snapshot'->>'vendor', eps.seed_data->'snapshot'->>'vendor_name', ''))";
const OLD_BRAND_MATCH_SQL = `(
        ${OLD_EPS_BRAND_SQL} = ANY($3::text[])
        OR ${OLD_EPS_BRAND_SQL} LIKE ANY($4::text[])
        OR trim(regexp_replace(${OLD_EPS_BRAND_SQL}, '[^a-z0-9]+', ' ', 'g')) = ANY($3::text[])
        OR trim(regexp_replace(${OLD_EPS_BRAND_SQL}, '[^a-z0-9]+', ' ', 'g')) LIKE ANY($4::text[])
        OR regexp_replace(${OLD_EPS_BRAND_SQL}, '[^a-z0-9]+', '', 'g') = ANY($6::text[])
        OR lower(regexp_replace(coalesce(eps.seed_data->>'brand', eps.seed_data->'snapshot'->>'brand', split_part(eps.domain, '.', 1), ''), '[^a-z0-9]+', '', 'g')) = ANY($6::text[])
      )`;
// The rest of the old primary statement, also verbatim — including its old row scope
// (`attached_product_key IS NOT NULL`), the JOIN and the serving/trust gate — so the two sides are
// compared over the same rows, and the scope change is itself one of the pinned divergences.
const OLD_PRIMARY_SQL = `
  SELECT eps.id
  FROM external_product_seeds eps
  JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
  JOIN catalog_row_trust crt
    ON crt.subject_type = 'product'
   AND crt.subject_key = cp.product_key
   AND crt.serving_decision = 'public'
  WHERE eps.status = 'active'
    AND eps.attached_product_key IS NOT NULL
    AND eps.market = $1
    AND (eps.tool = '*' OR eps.tool = $2)
    AND ${OLD_BRAND_MATCH_SQL}
  ORDER BY eps.id
  LIMIT $5
`;

// Rows where the new predicate deliberately does NOT agree with the old one. Each is pinned by its
// own assertion below; nothing else in the fixture may move. Restoring the old field precedence and
// re-adding the domain chain removed two entries the first cut of this work had here:
// `recall_brand_precedence` and `domain_only_brand` are now matched identically by both.
const KNOWN_DIVERGENCES = {
  // The brand chain appends `derived.recall.brand_name` LAST — a path the old chain never read, so
  // it can only add reachability, never move a row another path already names.
  recall_brand_name_only: 'new',
  // identitySql folds Latin accents with translate(); the old regexp turned 'ô' into a separator, so
  // "Lancôme" normalized to 'lanc me' and no unaccented alias could ever reach it.
  accent_lancome: 'new',
  // Compact identity makes the prefix arm cross word boundaries: alias "round lab" -> 'roundlab%'
  // now reaches the brand "Roundlabus". The old prefix patterns kept the space ('round lab%').
  compact_prefix_roundlabus: 'new',
  // Each chain wraps its fields in `nullif(trim(...), '')` where the old predicate used a bare
  // coalesce. An EMPTY derived.recall.brand stopped the old coalesce dead (it is not NULL), so the
  // row resolved to '' and reached no brand page at all; it now falls through to the next path.
  // Reachability gain only — a row an earlier path already names cannot move.
  empty_recall_brand_fallthrough: 'new',
  // Row scope: the old `attached_product_key IS NOT NULL` admitted the empty string; the new
  // `coalesce(attached_product_key, '') <> ''` (which the partial indexes carry) does not.
  attached_empty_key: 'old',
};

// The btree key limit is checked AFTER pglz compression, so a repeated character ('q'.repeat(3000))
// compresses to nothing and sails past 2704 bytes even with the bound removed — it would make the
// test below assert nothing. These are deterministic but incompressible.
const incompressible = (prefix, length) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let seed = 7;
  let out = prefix;
  while (out.length < length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[seed % alphabet.length];
  }
  return out;
};
const LONG_BRAND = incompressible('Zqbrand', 3000);
const LONG_TITLE = incompressible('Zqtitle ', 3000);

suite('brand-page external seed scan on PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;
  let indexDefinitions;
  let epsIndexDefinitions;

  const createFixtureTables = async (client) => {
    // `id` is the primary key in production; the rewritten statement resolves its CTE through
    // `eps.id IN (...)`, so whether that is a key lookup or a table scan depends on it existing.
    await client.query(`
      CREATE TABLE external_product_seeds(id text PRIMARY KEY, external_product_id text, market text, tool text,
        destination_url text, canonical_url text, domain text, title text, image_url text,
        price_amount numeric, price_currency text, availability text, seed_data jsonb,
        updated_at timestamptz, created_at timestamptz, status text, attached_product_key text);
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, content_key text, pivota_signature_id text,
        pivota_canonical_url text, canonical_url text, title text);
      CREATE TABLE catalog_row_trust(subject_type text, subject_key text, serving_decision text);
      CREATE INDEX ON catalog_row_trust(subject_key);
    `);
  };
  const createEpsIndexes = async (client) => {
    for (const definition of epsIndexDefinitions) {
      // CONCURRENTLY cannot run inside a transaction block and is irrelevant to whether the planner
      // can use the index.
      await client.query(definition.sql.replace(' CONCURRENTLY', ''));
    }
  };

  const seedRow = async ({
    id,
    seedData,
    title = 'Some Product',
    domain = 'shop.example',
    market = 'US',
    tool = 'creator_agents',
    status = 'active',
    attachedKey = undefined,
    servingDecision = 'public',
  }) => {
    const key = attachedKey === undefined ? `pk_${id}` : attachedKey;
    if (key !== null) {
      await db.query(
        `INSERT INTO catalog_products(product_key, content_key, pivota_signature_id, pivota_canonical_url, canonical_url, title)
         VALUES ($1, $2, $3, $4, $4, $5) ON CONFLICT DO NOTHING`,
        [key, `ck_${id}`, `sig_${id}`, `https://agent.pivota.cc/products/sig_${id}`, String(title).slice(0, 80)],
      );
      await db.query(
        `INSERT INTO catalog_row_trust(subject_type, subject_key, serving_decision) VALUES ('product', $1, $2)`,
        [key, servingDecision],
      );
    }
    await db.query(
      `INSERT INTO external_product_seeds(id, external_product_id, market, tool, destination_url, canonical_url,
         domain, title, image_url, price_amount, price_currency, availability, seed_data, updated_at, created_at,
         status, attached_product_key)
       VALUES ($1, $1, $2, $3, $4, $4, $5, $6, 'https://img.example/x.jpg', 20, 'USD', 'in_stock', $7,
         now(), now(), $8, $9)`,
      [id, market, tool, `https://shop.example/${id}`, domain, title, JSON.stringify(seedData), status, key],
    );
  };

  beforeAll(async () => {
    const { primaryBrandIndexDefinitions } = require('../../scripts/catalog/primary_brand_indexes');
    indexDefinitions = primaryBrandIndexDefinitions();
    epsIndexDefinitions = indexDefinitions.filter((definition) => definition.table === 'external_product_seeds');

    db = new Client({ connectionString: url });
    await db.connect();
    schema = `brand_seed_scan_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await createFixtureTables(db);

    // ---- exact identity through the brand chain's paths ----
    await seedRow({ id: 'exact_brand_name', seedData: { brand_name: 'Mixsoon' }, title: 'Bean Essence 50ml' });
    await seedRow({ id: 'exact_snapshot_brand', seedData: { snapshot: { brand: 'Mixsoon' } }, title: 'Glow Serum' });
    await seedRow({ id: 'exact_vendor', seedData: { vendor: 'Mixsoon' }, title: 'Cleansing Bar' });
    await seedRow({ id: 'recall_brand_name_only', seedData: { derived: { recall: { brand_name: 'Mixsoon' } } }, title: 'Toner Pad' });
    // derived.recall.brand is FIRST in the chain, as it was in the retired predicate.
    await seedRow({ id: 'recall_brand_precedence', seedData: { brand_name: 'Tocobo', derived: { recall: { brand: 'Mixsoon' } } }, title: 'Barrier Cream' });
    await seedRow({ id: 'exact_tool_star', seedData: { brand_name: 'Mixsoon' }, title: 'Cotton Pads', tool: '*' });

    // ---- accents, punctuation, prefix, and the prefix floor ----
    await seedRow({ id: 'accent_lancome', seedData: { brand_name: 'Lancôme' }, title: 'Teint Idole' });
    await seedRow({ id: 'punct_drjart', seedData: { brand_name: 'Dr. Jart+' }, title: 'Cicapair Cream' });
    // The real prod case the design had to keep: a "<brand> <market>" seed on a brand page.
    await seedRow({ id: 'prefix_roundlab_us', seedData: { brand_name: 'Round Lab US' }, title: 'Dokdo Toner' });
    await seedRow({ id: 'compact_prefix_roundlabus', seedData: { brand_name: 'Roundlabus' }, title: 'Birch Cleanser' });
    // Only an alias whose SPACED normalization is >= 4 chars may prefix-match.
    await seedRow({ id: 'short_alias_abcdef', seedData: { brand_name: 'Abcdef Labs' }, title: 'Mystery Thing' });
    // A 3-character brand can only be reached by the equality arm, never by a prefix.
    await seedRow({ id: 'exact_short_nyx', seedData: { brand_name: 'NYX' }, title: 'Butter Gloss' });
    // "e.l.f." normalizes to "e l f" (5 chars) but compacts to "elf" (3): the floor must be measured
    // on the spaced form or this row loses its only match.
    await seedRow({ id: 'prefix_elf_cosmetics', seedData: { brand_name: 'e.l.f. Cosmetics' }, title: 'Halo Glow Filter' });
    // "anua" is exactly 4 chars spaced: the floor is >= 4, not > 4.
    await seedRow({ id: 'prefix_anua_skincare', seedData: { brand_name: 'Anua Skincare' }, title: 'Heartleaf Toner' });

    // ---- the domain chain: brand, snapshot.brand, then the domain's first label ----
    await seedRow({ id: 'domain_only_brand', seedData: { note: 'no brand fields' }, title: 'Unnamed Item', domain: 'mixsoon.com' });

    // ---- prefix DECOYS: what the bound pattern must and must not reach ----
    // Shares only 'mix' with the alias 'mixsoon'. Truncating the bound prefix pattern to 3
    // characters would pull it onto the Mixsoon page.
    await seedRow({ id: 'brand_short_prefix_decoy', seedData: { brand_name: 'Mixture Labs' }, title: 'Blending Balm' });
    // Named ONLY by its domain, whose identity starts with the whole alias. The domain chain is
    // equality-only, so this must stay out; giving it a prefix arm (as one revision of this work did)
    // puts every mixsoonish-* merchant on the Mixsoon page.
    await seedRow({ id: 'domain_prefix_decoy', seedData: { note: 'no brand fields' }, title: 'Teapot Set', domain: 'mixsoonish-teashop.com' });
    // The BRAND chain does prefix-match, and always did: the retired predicate's `LIKE ANY($4)` over
    // the spaced normalization reached 'mixsoonish teashop' too. Kept as the positive control that
    // separates "the brand chain prefixes" from "the domain chain does not".
    await seedRow({ id: 'brand_full_prefix_match', seedData: { brand_name: 'Mixsoonish Teashop' }, title: 'Oolong Gift Box', domain: 'shop.example' });

    // ---- two aliases that collide on ONE identity key ----
    // 'elf' (3 spaced chars, no prefix arm) and 'e.l.f.' ('e l f', 5, prefix arm) both key to 'elf'.
    // Taking `prefixable` from whichever alias came first dropped the prefix arm and with it every
    // row the old predicate reached by prefix, so the two must be OR'd.
    await seedRow({ id: 'exact_elf_dotted', seedData: { brand_name: 'e.l.f.' }, title: 'Power Grip Primer' });
    await seedRow({ id: 'exact_elf_plain', seedData: { brand_name: 'elf' }, title: 'Camo Concealer' });

    // ---- a diacritic OUTSIDE the SQL translate() table ----
    // identitySql folds the Latin-1 set only; 'n-tilde' is not in it, so the indexed row identity
    // keeps it. Any JS key that folds it cannot equal the row identity, and the page goes empty.
    await seedRow({ id: 'diacritic_senora', seedData: { brand_name: 'Se\u00f1ora Skin' }, title: 'Se\u00f1ora Skin Cream' });

    // ---- the domain is the domain chain's LAST resort, not its first field ----
    // Same domain as loss_e_two_pages, but this row fills the chain's own brand path, so the domain
    // is never reached: it belongs on the Tocobo page and NOT on the Mixsoon page.
    await seedRow({ id: 'domain_last_resort', seedData: { brand: 'Tocobo' }, title: 'Vita Serum', domain: 'mixsoon.com' });

    // ---- more candidates than the limit, with distinct recency ----
    // The by-key fetch must ORDER BY before it LIMITs. With exactly `limit` candidates the LIMIT
    // never chooses, so slicing the candidate ids first would look identical.
    for (let i = 0; i < 30; i += 1) {
      await seedRow({ id: `recency_${String(i).padStart(2, '0')}`, seedData: { brand_name: 'Recencybrand' }, title: `Recencybrand Item ${i}` });
    }
    await db.query(`UPDATE external_product_seeds
      SET updated_at = timestamptz '2026-01-01 00:00:00+00' + (substring(id from '[0-9]+$')::int * interval '1 hour'),
          created_at = timestamptz '2026-01-01 00:00:00+00'
      WHERE id ~ '^recency_[0-9]+$'`);

    // ---- top-level vendor must not outrank top-level brand (distinct from loss (b)'s snapshot) ----
    await seedRow({ id: 'top_level_vendor_tatcha', seedData: { vendor: 'Ulta Beauty', brand: 'Tatcha' }, title: 'Rice Wash Cleanser' });

    // ---- an EMPTY high-precedence field falls through instead of resolving to '' ----
    await seedRow({ id: 'empty_recall_brand_fallthrough', seedData: { derived: { recall: { brand: '   ' } }, brand_name: 'Mixsoon' }, title: 'Cica Ampoule' });

    // ---- the five loss classes the adversarial review found ----
    // (a) a retailer in brand_name must not displace the brand in derived.recall.brand.
    await seedRow({ id: 'loss_a_fenty', seedData: { brand_name: 'Sephora', derived: { recall: { brand: 'Fenty Beauty' } } }, title: 'Pro Filtr Foundation' });
    // (b) a Shopify snapshot routinely carries the STORE in vendor and the brand in brand.
    await seedRow({ id: 'loss_b_tatcha', seedData: { brand: 'Tatcha', snapshot: { vendor: 'Ulta Beauty' } }, title: 'The Dewy Skin Cream' });
    // (c) same shape with the marketplace in brand_name.
    await seedRow({ id: 'loss_c_glossier', seedData: { brand_name: 'Amazon', brand: 'Glossier' }, title: 'Cloud Paint' });
    // (e) a seed is named by its brand AND its domain, and belongs on BOTH pages.
    await seedRow({ id: 'loss_e_two_pages', seedData: { brand_name: 'Tocobo' }, title: 'Bio Watery Sun Cream', domain: 'mixsoon.com' });

    // ---- rows that must stay OUT, one condition each ----
    await seedRow({ id: 'out_wrong_market', seedData: { brand_name: 'Mixsoon' }, market: 'SG' });
    await seedRow({ id: 'out_wrong_tool', seedData: { brand_name: 'Mixsoon' }, tool: 'shopping_agents' });
    await seedRow({ id: 'out_status_paused', seedData: { brand_name: 'Mixsoon' }, status: 'paused' });
    await seedRow({ id: 'out_attached_null', seedData: { brand_name: 'Mixsoon' }, attachedKey: null });
    await seedRow({ id: 'attached_empty_key', seedData: { brand_name: 'Mixsoon' }, attachedKey: '' });
    await seedRow({ id: 'out_other_brand', seedData: { brand_name: 'Tocobo' }, title: 'Lip Balm' });
    await seedRow({ id: 'out_trust_not_public', seedData: { brand_name: 'Mixsoon' }, servingDecision: 'private' });

    // ---- backfill lane: brand does not match, title starts with "<alias> " ----
    // seedTitleSql's coalesce order is snapshot.title, then seed_data.title, then the column. Each
    // backfill row puts the matching text at a different position, with decoys at the others, so any
    // reordering of that coalesce drops one of them.
    await seedRow({
      id: 'title_backfill_snapshot',
      seedData: { brand_name: 'Unrelated Co', snapshot: { title: 'Mixsoon Bean Cream 100ml' }, title: 'Zz Bean Cream' },
      title: 'Qq Bean Cream',
    });
    await seedRow({
      id: 'title_backfill_seed_data',
      seedData: { brand_name: 'Unrelated Co', title: 'Mixsoon Glow Toner 150ml' },
      title: 'Ww Glow Toner',
    });
    // The alias must be followed by a SPACE: "Mixsoonish" is a different word.
    await seedRow({
      id: 'title_no_space_after_alias',
      seedData: { brand_name: 'Unrelated Co', snapshot: { title: 'Mixsoonish Copycat Cream' } },
      title: 'Mixsoonish Copycat Cream',
    });

    // ---- LIKE wildcards ----
    // "100% PURE" is a real brand. normalizeBrandText keeps the '%', so the TITLE lane binds it.
    await seedRow({
      id: 'wildcard_genuine',
      seedData: { brand_name: 'Unrelated Co', snapshot: { title: '100% Pure Rose Water Toner' } },
      title: '100% Pure Rose Water Toner',
    });
    // Unescaped, the pattern '100% pure %' matches this too — '100' + anything + ' pure ' + anything.
    await seedRow({
      id: 'wildcard_decoy',
      seedData: { brand_name: 'Unrelated Co', snapshot: { title: '100 Percent Pure Glow Serum' } },
      title: '100 Percent Pure Glow Serum',
    });
    await seedRow({
      id: 'underscore_decoy',
      seedData: { brand_name: 'Unrelated Co', snapshot: { title: 'axb Recovery Cream' } },
      title: 'axb Recovery Cream',
    });

    // ---- a brand with enough primary matches to fill the limit, plus a title-only row ----
    for (let i = 0; i < 24; i += 1) {
      await seedRow({ id: `full_${String(i).padStart(2, '0')}`, seedData: { brand_name: 'Fullbrand' }, title: `Fullbrand Item ${i}` });
    }
    await seedRow({ id: 'full_title_only', seedData: { brand_name: 'Unrelated Co' }, title: 'Fullbrand Extra Item' });
    // The backfill lane orders by recency and takes only (limit - primary rows); make this row the
    // most recent so the assertion below is about the lane running, not about tie-breaking.
    await db.query(`UPDATE external_product_seeds SET updated_at = now() + interval '1 hour' WHERE id = 'full_title_only'`);

    // Indexes LAST for the main fixture, so the oversized rows in the bounded-key test are inserted
    // against a table that already carries them — which is the ordering that actually fails when the
    // expressions are not bounded.
    await createEpsIndexes(db);
    await db.query('ANALYZE external_product_seeds');
    await db.query('ANALYZE catalog_products');
    await db.query('ANALYZE catalog_row_trust');
  }, 180000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  let calls;
  beforeEach(() => {
    priorEnv = { ...process.env };
    process.env.DATABASE_URL = url;
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    calls = [];
    jest.resetModules();
    jest.doMock('../../src/db', () => ({
      // `db` is read at call time, so the plan-choice block can point the fetcher at its own schema.
      query: async (sql, params) => {
        calls.push({ sql, params });
        return db.query(sql, params);
      },
      withClient: async (fn) => fn({ query: async (sql, params) => db.query(sql, params) }),
    }));
  });
  afterEach(() => {
    process.env = priorEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
  });

  // Runs the REAL fetcher. Returns the products it built plus the statements it issued.
  const runFetcher = async (brandAliases, options = {}) => {
    calls.length = 0;
    const discovery = require('../../src/services/discoveryFeed');
    const products = await discovery._internals.fetchBrandScopedExternalSeedCandidates({
      brandAliases,
      limit: 24,
      ...options,
    });
    return { products, calls: [...calls] };
  };
  const primaryCall = (issued) => issued.find((call) => call.sql.includes('brand_seed_ids')) || null;
  const backfillCall = (issued) => issued.find((call) => call.sql.includes('title_seed_ids')) || null;
  const branchCount = (sql) => (sql.match(/\n\s*UNION\b/g) || []).length + 1;

  // The ids the fetcher's OWN statements select, replayed the way production chains them: the
  // candidate-id statement, then the by-key fetch that applies the catalog/trust serving gate. Both
  // are re-executed verbatim, so the membership under test is the membership of the exact text
  // production sends — and it is compared with the old predicate at the same point, AFTER the gate.
  const fetchCall = (issued) => issued.find((call) => call.sql.includes('eps.id = ANY(')) || null;
  // The fetch SQL text is shared by both lanes, so a lane's own fetch is the statement issued
  // immediately after that lane's candidate-ids statement.
  const fetchAfter = (issued, marker) => {
    const at = issued.findIndex((call) => call.sql.includes(marker));
    if (at === -1) return null;
    const next = issued[at + 1];
    return next && next.sql.includes('eps.id = ANY(') ? next : null;
  };
  // The candidate set BEFORE the serving gate — used only where a test needs to say which side of
  // the gate a row was excluded on.
  const newCandidateIds = async (brandAliases) => {
    const { calls: issued } = await runFetcher(brandAliases, { limit: 500 });
    const primary = primaryCall(issued);
    if (!primary) return [];
    return (await db.query(primary.sql, primary.params)).rows.map((row) => row.id).sort();
  };
  const newPrimaryIds = async (brandAliases, options = {}) => {
    const { calls: issued } = await runFetcher(brandAliases, { limit: 500, ...options });
    const primary = primaryCall(issued);
    if (!primary) return [];
    const candidates = (await db.query(primary.sql, primary.params)).rows.map((row) => row.id);
    const fetch = fetchCall(issued);
    if (!candidates.length || !fetch) return [];
    const res = await db.query(fetch.sql, [candidates, 500]);
    return res.rows.map((row) => row.id).sort();
  };

  const oldPrimaryIds = async (brandAliases) => {
    const { normalizeBrandText } = require('../../src/findProductsMulti/brandLexicon');
    const normalizedAliases = [...new Set(brandAliases.map((alias) => normalizeBrandText(alias)).filter(Boolean))];
    const prefixPatterns = normalizedAliases.filter((alias) => alias.length >= 4).map((alias) => `${alias}%`);
    const compactAliases = [...new Set(normalizedAliases.map((alias) => alias.replace(/\s+/g, '')).filter(Boolean))];
    const res = await db.query(OLD_PRIMARY_SQL, ['US', 'creator_agents', normalizedAliases, prefixPatterns, 500, compactAliases]);
    return res.rows.map((row) => row.id);
  };

  // [label, aliases, the seeds BOTH predicates must select]. The third element is spelled out rather
  // than derived, so an assertion cannot pass by both sides going empty together.
  const ALIAS_SETS = [
    ['a long alias over several brand-chain paths', ['Mixsoon'],
      ['brand_full_prefix_match', 'domain_only_brand', 'exact_brand_name', 'exact_snapshot_brand',
        'exact_tool_star', 'exact_vendor', 'loss_e_two_pages', 'recall_brand_precedence']],
    ['an unaccented alias for an accented brand', ['Lancome'], []],
    ['an accented alias', ['Lancôme'], []],
    ['a punctuated alias', ['Dr. Jart+'], ['punct_drjart']],
    ['a two-word alias that must prefix-match', ['Round Lab'], ['prefix_roundlab_us']],
    ['a 3-character alias (below the prefix floor)', ['Abc'], []],
    ['a 3-character alias that is an exact brand', ['NYX'], ['exact_short_nyx']],
    ['a dotted alias whose compact form is 3 chars', ['e.l.f.'],
      ['exact_elf_dotted', 'exact_elf_plain', 'prefix_elf_cosmetics']],
    ['two aliases colliding on one identity key', ['elf', 'e.l.f.'],
      ['exact_elf_dotted', 'exact_elf_plain', 'prefix_elf_cosmetics']],
    ['the same collision in the other order', ['e.l.f.', 'elf'],
      ['exact_elf_dotted', 'exact_elf_plain', 'prefix_elf_cosmetics']],
    ['a brand reached through the domain chain', ['Tocobo'],
      ['domain_last_resort', 'loss_e_two_pages', 'out_other_brand']],
    ['an alias that is exactly 4 chars spaced', ['Anua'], ['prefix_anua_skincare']],
    ['a brand hidden behind a retailer brand_name', ['Fenty Beauty'], ['loss_a_fenty']],
    ['a brand hidden behind a store vendor', ['Tatcha'], ['loss_b_tatcha', 'top_level_vendor_tatcha']],
    ['a brand hidden behind a marketplace brand_name', ['Glossier'], ['loss_c_glossier']],
    ['several aliases at once', ['Mixsoon', 'Round Lab', 'Lancome', 'NYX', 'Dr Jart'],
      ['brand_full_prefix_match', 'domain_only_brand', 'exact_brand_name', 'exact_short_nyx',
        'exact_snapshot_brand', 'exact_tool_star', 'exact_vendor', 'loss_e_two_pages', 'prefix_roundlab_us',
        'punct_drjart', 'recall_brand_precedence']],
    ['an alias that matches nothing', ['Nosuchbrand'], []],
  ];

  // ---------------------------------------------------------------------------
  // 1. Equivalence
  // ---------------------------------------------------------------------------
  describe.each(ALIAS_SETS)('membership: %s', (_label, aliases, shared) => {
    test('the new predicate selects the same seeds as the old one', async () => {
      const oldIds = await oldPrimaryIds(aliases);
      const newIds = await newPrimaryIds(aliases);
      const drop = (ids) => ids.filter((id) => !(id in KNOWN_DIVERGENCES));
      expect(drop(newIds)).toEqual(drop(oldIds));
      // ...and both are the set this fixture says they must be, so neither can pass by selecting
      // nothing at all.
      expect(drop(newIds)).toEqual(shared);
    });
  });

  test('the only rows the two predicates disagree on are the enumerated divergences', async () => {
    const seen = {};
    for (const [, aliases] of ALIAS_SETS) {
      const oldIds = await oldPrimaryIds(aliases);
      const newIds = await newPrimaryIds(aliases);
      for (const id of newIds) if (!oldIds.includes(id)) seen[id] = 'new';
      for (const id of oldIds) if (!newIds.includes(id)) seen[id] = 'old';
    }
    expect(seen).toEqual(KNOWN_DIVERGENCES);
  }, 60000);

  // ---------------------------------------------------------------------------
  // 1b. The five loss classes the adversarial review found
  // ---------------------------------------------------------------------------
  test('loss (a): a retailer in brand_name does not displace derived.recall.brand', async () => {
    expect(await newPrimaryIds(['Fenty Beauty'])).toContain('loss_a_fenty');
    expect(await oldPrimaryIds(['Fenty Beauty'])).toContain('loss_a_fenty');
    // ...and the row does not leak onto the retailer's page in either predicate.
    expect(await newPrimaryIds(['Sephora'])).not.toContain('loss_a_fenty');
    expect(await oldPrimaryIds(['Sephora'])).not.toContain('loss_a_fenty');
  });

  test('loss (b): a store in snapshot.vendor does not displace the brand', async () => {
    expect(await newPrimaryIds(['Tatcha'])).toContain('loss_b_tatcha');
    expect(await oldPrimaryIds(['Tatcha'])).toContain('loss_b_tatcha');
    expect(await newPrimaryIds(['Ulta Beauty'])).not.toContain('loss_b_tatcha');
  });

  test('loss (c): a marketplace in brand_name does not displace brand', async () => {
    expect(await newPrimaryIds(['Glossier'])).toContain('loss_c_glossier');
    expect(await oldPrimaryIds(['Glossier'])).toContain('loss_c_glossier');
    expect(await newPrimaryIds(['Amazon'])).not.toContain('loss_c_glossier');
  });

  test('loss (d): the prefix floor reads the spaced form, so "e.l.f." keeps its prefix arm', async () => {
    expect(await newPrimaryIds(['e.l.f.'])).toEqual(['exact_elf_dotted', 'exact_elf_plain', 'prefix_elf_cosmetics']);
    expect(await oldPrimaryIds(['e.l.f.'])).toEqual(['exact_elf_dotted', 'exact_elf_plain', 'prefix_elf_cosmetics']);
    // Control: the floor is >= 4 on the spaced form, and "anua" is exactly 4.
    expect(await newPrimaryIds(['Anua'])).toEqual(['prefix_anua_skincare']);
    // Control: a 3-character SPACED alias still has no prefix arm.
    expect(await newPrimaryIds(['Abc'])).toEqual([]);
  });

  test('loss (e): a seed named by both its brand and its domain appears on BOTH pages', async () => {
    expect(await newPrimaryIds(['Tocobo'])).toContain('loss_e_two_pages');
    expect(await newPrimaryIds(['Mixsoon'])).toContain('loss_e_two_pages');
    expect(await oldPrimaryIds(['Tocobo'])).toContain('loss_e_two_pages');
    expect(await oldPrimaryIds(['Mixsoon'])).toContain('loss_e_two_pages');
  });

  test('M20: the bound prefix pattern is the WHOLE alias, on the brand chain only', async () => {
    const page = await newPrimaryIds(['Mixsoon']);
    // Shares only 'mix'. A pattern truncated to 3 characters would reach it.
    expect(page).not.toContain('brand_short_prefix_decoy');
    // Named only by a domain whose identity starts with the whole alias. The domain chain compares
    // by equality, so it stays out; a prefix arm there puts every mixsoonish-* merchant on the page.
    expect(page).not.toContain('domain_prefix_decoy');
    // Positive control, so "returns neither" is not just "the prefix arm is dead": the BRAND chain
    // does prefix-match, and the retired predicate did too.
    expect(page).toContain('brand_full_prefix_match');
    expect(await oldPrimaryIds(['Mixsoon'])).toContain('brand_full_prefix_match');
    // ...and neither decoy is even a CANDIDATE, so this is the predicate refusing them, not the
    // serving gate quietly dropping them afterwards.
    const candidates = await newCandidateIds(['Mixsoon']);
    expect(candidates).not.toContain('brand_short_prefix_decoy');
    expect(candidates).not.toContain('domain_prefix_decoy');
    expect(candidates).toContain('brand_full_prefix_match');
    // Both decoys ARE reachable by their own names, so the fixture is not inert.
    expect(await newPrimaryIds(['Mixture'])).toEqual(['brand_short_prefix_decoy']);
    expect(await newPrimaryIds(['Mixsoonish Teashop'])).toEqual(['brand_full_prefix_match', 'domain_prefix_decoy']);
  });

  test('M20: the domain chain carries no LIKE at all', async () => {
    const { seedDomainIdentitySql } = require('../../src/services/brandSeedScanSql');
    for (const aliases of [['Mixsoon'], ['NYX'], ['Mixsoon', 'Round Lab', 'NYX']]) {
      const primary = primaryCall((await runFetcher(aliases)).calls);
      const domainSql = seedDomainIdentitySql('eps');
      expect(primary.sql).toContain(`${domainSql} = ANY(`);
      expect(primary.sql).not.toContain(`${domainSql} LIKE`);
      // Exactly one domain branch, whatever the alias count.
      expect(primary.sql.split(`${domainSql} = ANY(`)).toHaveLength(2);
    }
  });

  test('colliding aliases OR their prefixability, whichever order they arrive in', async () => {
    // The regression this pins: ['elf', 'e.l.f.'] both key to 'elf'. Reading `prefixable` from the
    // first alias to reach the key gave 'elf' equality only, and the brand page silently lost every
    // row the retired predicate matched by prefix.
    const expected = ['exact_elf_dotted', 'exact_elf_plain', 'prefix_elf_cosmetics'];
    for (const aliases of [['elf', 'e.l.f.'], ['e.l.f.', 'elf']]) {
      expect(await newPrimaryIds(aliases)).toEqual(expected);
      expect(await oldPrimaryIds(aliases)).toEqual(expected);
      const primary = primaryCall((await runFetcher(aliases)).calls);
      // The prefix arm must actually be in the statement, bound to the whole key.
      expect(primary.params).toContain('elf%');
      // One key, so: one brand prefix branch + one domain equality branch, and no duplicate binds.
      expect(branchCount(primary.sql)).toBe(2);
      expect(primary.params).toHaveLength(4);
      expect(primary.params[3]).toEqual(['elf']);
      expect(new Set(primary.params.slice(2, 3)).size).toBe(1);
    }
    // Control: the sub-floor alias ALONE still gets equality only, so the OR above is doing the work
    // rather than the floor having been abandoned.
    const soloShort = primaryCall((await runFetcher(['elf'])).calls);
    expect(soloShort.params).not.toContain('elf%');
    expect(soloShort.params[2]).toEqual(['elf']);
    expect(await newPrimaryIds(['elf'])).toEqual(['exact_elf_dotted', 'exact_elf_plain']);
  });

  // The index stores the SQL value. A bound key that does not equal it CHARACTER FOR CHARACTER
  // matches nothing, so brandIdentityKey has to agree with normalizedBrandIdentitySql. These are two
  // separate contracts and are asserted separately: the function's own, and the one the scan relies
  // on (it binds brandIdentityKey(normalizeBrandText(alias)), not brandIdentityKey(alias)).
  const TWIN_NAMES = ['Lanc\u00f4me', 'Beyonc\u00e9', 'Se\u00f1ora Skin', '\u0160koda Care', 'M\u0101ori Botanics', 'Mixsoon'];
  const sqlRowIdentity = async (name) => {
    const { seedBrandIdentitySql } = require('../../src/services/brandSeedScanSql');
    const res = await db.query(
      `SELECT ${seedBrandIdentitySql('eps')} AS identity
       FROM (SELECT $1::jsonb AS seed_data, ''::text AS domain) eps`,
      [JSON.stringify({ brand_name: name })],
    );
    return res.rows[0].identity;
  };

  test('brandIdentityKey is the JS twin of the SQL row identity', async () => {
    const { brandIdentityKey } = require('../../src/services/canonicalSearchQualitySql');
    const mismatches = [];
    for (const name of TWIN_NAMES) {
      const rowIdentity = await sqlRowIdentity(name);
      const key = brandIdentityKey(name);
      if (key !== rowIdentity) mismatches.push({ name, rowIdentity, key });
    }
    expect(mismatches).toEqual([]);
  });

  test('the key the scan actually binds equals the SQL row identity', async () => {
    const { brandIdentityKey } = require('../../src/services/canonicalSearchQualitySql');
    const { normalizeBrandText } = require('../../src/findProductsMulti/brandLexicon');
    const mismatches = [];
    const foldedTwice = [];
    for (const name of TWIN_NAMES) {
      const rowIdentity = await sqlRowIdentity(name);
      // The scan keys off the RAW alias, which is what makes this hold.
      if (brandIdentityKey(name) !== rowIdentity) {
        mismatches.push({ name, rowIdentity, key: brandIdentityKey(name) });
      }
      // ...and keying off the SPACED form does not, for any diacritic outside the SQL fold
      // table: normalizeBrandText folds every combining mark (NFKD), translate() folds only
      // Latin-1. Pinned in both directions so the cheaper-looking composition cannot return.
      if (brandIdentityKey(normalizeBrandText(name)) !== rowIdentity) foldedTwice.push(name);
    }
    expect(mismatches).toEqual([]);
    expect(foldedTwice.length).toBeGreaterThan(0);
    // An alias can arrive decomposed ("n" + U+0303) from any caller. Without the NFC pass the
    // combining mark is stripped as non-alphanumeric and the key silently loses the accent,
    // while PostgreSQL keeps it — the same mismatch, arriving through the input instead.
    const decomposed = 'Señora Skin';
    expect(decomposed.normalize('NFC')).toBe('Señora Skin');
    expect(brandIdentityKey(decomposed)).toBe(brandIdentityKey('Señora Skin'));
    expect(brandIdentityKey(decomposed)).toBe(await sqlRowIdentity('Señora Skin'));
  });

  test('a brand whose diacritic is outside the SQL fold table is still reachable', async () => {
    // End-to-end form of the twin contract above. The title lane cannot rescue it either: the bound
    // title pattern is folded the same way and the row's title is not.
    expect(await newPrimaryIds(['Se\u00f1ora Skin'])).toEqual(['diacritic_senora']);
  });

  test('the domain chain reaches the domain only after its own brand paths', async () => {
    // domain_last_resort carries seed_data.brand, the domain chain's FIRST field, so its
    // mixsoon.com domain is never consulted. Moving the domain ahead of brand/snapshot.brand would
    // put it on the Mixsoon page.
    expect(await newPrimaryIds(['Tocobo'])).toContain('domain_last_resort');
    expect(await oldPrimaryIds(['Tocobo'])).toContain('domain_last_resort');
    expect(await newPrimaryIds(['Mixsoon'])).not.toContain('domain_last_resort');
    expect(await oldPrimaryIds(['Mixsoon'])).not.toContain('domain_last_resort');
    // Contrast, on the SAME domain: loss_e_two_pages leaves both brand paths empty, so the domain is
    // reached and the row is on both pages. Without this pair the ordering is untestable.
    expect(await newPrimaryIds(['Mixsoon'])).toContain('loss_e_two_pages');
    expect(await newPrimaryIds(['Tocobo'])).toContain('loss_e_two_pages');
  });

  test('M7: a top-level vendor does not outrank a top-level brand', async () => {
    // Distinct from loss (b), which carries the store in snapshot.vendor: this one is the bare
    // `seed_data->>'vendor'` path, which sits between brand_name and the snapshot paths.
    expect(await newPrimaryIds(['Tatcha'])).toContain('top_level_vendor_tatcha');
    expect(await oldPrimaryIds(['Tatcha'])).toContain('top_level_vendor_tatcha');
    expect(await newPrimaryIds(['Ulta Beauty'])).not.toContain('top_level_vendor_tatcha');
    expect(await oldPrimaryIds(['Ulta Beauty'])).not.toContain('top_level_vendor_tatcha');
  });

  test('F5: an empty high-precedence field falls through instead of resolving to empty', async () => {
    // `nullif(trim(...), '')` per field, where the old predicate used a bare coalesce: an empty
    // derived.recall.brand used to stop the chain and strand the row on no brand page at all.
    expect(await newPrimaryIds(['Mixsoon'])).toContain('empty_recall_brand_fallthrough');
    expect(await oldPrimaryIds(['Mixsoon'])).not.toContain('empty_recall_brand_fallthrough');
    // Reachability only: the row is not reachable under any other name either way.
    expect(await newPrimaryIds(['Tocobo'])).not.toContain('empty_recall_brand_fallthrough');
  });

  test('the domain chain is a SECOND probe, not a fallback of the first', async () => {
    const { seedBrandIdentitySql, seedDomainIdentitySql } = require('../../src/services/brandSeedScanSql');
    const { calls: issued } = await runFetcher(['Mixsoon']);
    const primary = primaryCall(issued);
    expect(primary.sql).toContain(seedBrandIdentitySql('eps'));
    expect(primary.sql).toContain(seedDomainIdentitySql('eps'));
    // A seed with no brand field at all is named only by the domain chain...
    expect(await newPrimaryIds(['Mixsoon'])).toContain('domain_only_brand');
    // ...and the two chains resolve the SAME row to two different brands.
    expect(await newPrimaryIds(['Tocobo'])).toContain('loss_e_two_pages');
  });

  // ---------------------------------------------------------------------------
  // 1c. Remaining divergences, pinned one by one
  // ---------------------------------------------------------------------------
  test('new only: derived.recall.brand_name is a brand path the old chain never read', async () => {
    expect(await newPrimaryIds(['Mixsoon'])).toContain('recall_brand_name_only');
    expect(await oldPrimaryIds(['Mixsoon'])).not.toContain('recall_brand_name_only');
  });

  test('new only: accent folding makes "Lancome" reach "Lancôme"', async () => {
    expect(await newPrimaryIds(['Lancome'])).toContain('accent_lancome');
    expect(await newPrimaryIds(['Lancôme'])).toContain('accent_lancome');
    expect(await oldPrimaryIds(['Lancome'])).toEqual([]);
  });

  test('new only: the compact prefix crosses word boundaries', async () => {
    expect(await newPrimaryIds(['Round Lab'])).toContain('compact_prefix_roundlabus');
    expect(await oldPrimaryIds(['Round Lab'])).not.toContain('compact_prefix_roundlabus');
  });

  test('OLD only: an empty attached_product_key is no longer in scope', async () => {
    const { brandSeedScanPredicateSql } = require('../../src/services/brandSeedScanSql');
    expect(await oldPrimaryIds(['Mixsoon'])).toContain('attached_empty_key');
    expect(await newPrimaryIds(['Mixsoon'])).not.toContain('attached_empty_key');
    expect(brandSeedScanPredicateSql('eps')).toBe("eps.status = 'active' AND coalesce(eps.attached_product_key, '') <> ''");
    for (const definition of epsIndexDefinitions) {
      expect(definition.predicate).toBe(brandSeedScanPredicateSql());
    }
    const { calls: issued } = await runFetcher(['Mixsoon']);
    // The row scope sits on every candidate-id statement. The by-key fetch is scoped by the ids those
    // produced, so it carries no predicate of its own — and must not, or it could re-widen the scope.
    const idStatements = issued.filter((call) => !call.sql.includes('eps.id = ANY('));
    const fetchStatements = issued.filter((call) => call.sql.includes('eps.id = ANY('));
    expect(idStatements.length).toBeGreaterThan(0);
    expect(fetchStatements.length).toBeGreaterThan(0);
    for (const call of idStatements) expect(call.sql).toContain("coalesce(eps.attached_product_key, '') <> ''");
    // The by-key fetches are scoped by the ids those produced, so they carry no predicate of their
    // own — and must not, or a fetch could re-widen the scope the candidate statements bounded.
    for (const call of fetchStatements) expect(call.sql).toContain('WHERE eps.id = ANY($1::text[])');
  });

  test('every excluded row is excluded by exactly one condition', async () => {
    const ids = await newPrimaryIds(['Mixsoon']);
    for (const excluded of [
      'out_wrong_market',
      'out_wrong_tool',
      'out_status_paused',
      'out_attached_null',
      'attached_empty_key',
      'out_other_brand',
      'out_trust_not_public',
    ]) {
      expect(ids).not.toContain(excluded);
    }
    // Control: the same brand on an otherwise identical row IS returned.
    expect(ids).toContain('exact_brand_name');
    expect(ids).toContain('exact_tool_star');
  });

  // ---------------------------------------------------------------------------
  // 2a. Structure: every probe is a UNION branch, not another OR'd filter
  // ---------------------------------------------------------------------------
  test('the primary statement is a UNION CTE of one branch per chain per probe', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon', 'Round Lab']);
    const primary = primaryCall(issued);
    expect(primary.sql).toContain('WITH brand_seed_ids AS (');
    // Candidate ids are their OWN statement, and the rows are then fetched by primary key. As a CTE
    // of the fetch, the outer query seq-scanned the table again from 8 branches on, because the
    // planner estimates a parameterized LIKE over an expression index at ~16% of the table.
    expect(primary.sql).toContain('SELECT id FROM brand_seed_ids');
    expect(primary.sql).not.toContain('JOIN catalog_products');
    expect(fetchCall(issued).sql).toContain('WHERE eps.id = ANY($1::text[])');
    // Both aliases clear the 4-char floor, so the brand chain contributes ONE PREFIX BRANCH EACH and
    // no equality branch — `alias%` already matches `alias`, so binding both was pure duplicate work.
    // The domain chain contributes exactly one equality branch. 2 + 1 = 3.
    expect(branchCount(primary.sql)).toBe(3);
    // The shape this replaces: the identity expression must never sit inside an OR'd filter on one
    // scan, which made PostgreSQL re-evaluate the 10-path JSONB extraction per clause per row.
    expect(primary.sql).not.toMatch(/LIKE ANY\(/);
    expect(primary.sql).not.toContain('FROM unnest(');
  });

  test('the backfill statement is a UNION CTE of one branch per alias', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon', 'Round Lab']);
    const backfill = backfillCall(issued);
    expect(backfill.sql).toContain('WITH title_seed_ids AS (');
    expect(backfill.sql).toContain('SELECT id FROM title_seed_ids');
    expect(backfill.sql).not.toContain('JOIN catalog_products');
    expect(branchCount(backfill.sql)).toBe(2);
    expect(backfill.sql).not.toMatch(/LIKE ANY\(/);
  });

  test('an alias set with no identity key never issues the primary statement', async () => {
    // Every bind is pushed as its clause is added, so a skipped lane cannot leave an unreferenced
    // parameter behind (42P18 kills the whole statement).
    const { calls: issued, products } = await runFetcher(['%%%']);
    expect(primaryCall(issued)).toBeNull();
    expect(backfillCall(issued)).not.toBeNull();
    expect(Array.isArray(products)).toBe(true);
  });

  test('the 16-alias cap bounds both the binds and the branch count', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Brandalias${String(i).padStart(3, '0')}`);
    const { calls: issued } = await runFetcher(many);
    const primary = primaryCall(issued);
    // Every fabricated alias clears the floor, so: 16 brand prefix branches + 1 domain equality
    // branch = 17. Binds = market, tool, 16 prefix patterns, 1 domain identity array = 19.
    expect(branchCount(primary.sql)).toBe(17);
    expect(primary.params).toHaveLength(19);
    expect(primary.params[18]).toHaveLength(16);
    expect(primary.params.slice(2, 18).every((pattern) => typeof pattern === 'string' && pattern.endsWith('%'))).toBe(true);
    const backfill = backfillCall(issued);
    expect(branchCount(backfill.sql)).toBe(16);
    expect(backfill.params).toHaveLength(18);
    // 40 fabricated aliases match nothing, so no by-key fetch is issued at all: the fetch only ever
    // runs on ids a candidate statement actually returned.
    expect(fetchCall(issued)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2b. Indexability: EXPLAIN with the sequential scan taken away
  // ---------------------------------------------------------------------------
  const indexConditions = (plan) => {
    const lines = plan.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const scan = lines[i].match(/(?:Bitmap Index Scan on|Index Scan using|Index Only Scan using) (\w+)/);
      if (!scan) continue;
      const next = String(lines[i + 1] || '').trim();
      out.push({ index: scan[1], cond: next.startsWith('Index Cond:') ? next : '' });
    }
    return out;
  };
  const explainPlan = async ({ sql, params }, { noSeqScan = false } = {}) => {
    await db.query('BEGIN');
    try {
      if (noSeqScan) await db.query('SET LOCAL enable_seqscan = off');
      const res = await db.query(`EXPLAIN (COSTS OFF) ${sql}`, params);
      return res.rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await db.query('ROLLBACK');
    }
  };

  test('both arms of both brand chains are answered by their own index', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon']);
    const conds = indexConditions(await explainPlan(primaryCall(issued), { noSeqScan: true }));
    const hit = (index, marker, operator) =>
      conds.some((entry) => entry.index === index
        && entry.cond.includes(marker)
        && entry.cond.includes(operator)
        // The index leads with (market, tool); dropping those makes them a post-scan Filter instead
        // of part of the index condition.
        && entry.cond.includes('market = '));
    // 'Mixsoon' clears the floor, so the brand chain is probed by prefix only.
    expect(hit(IDENTITY_INDEX, BRAND_PLAN_MARKER, '~>=~')).toBe(true);
    expect(hit(DOMAIN_INDEX, DOMAIN_PLAN_MARKER, '= ANY (')).toBe(true);
    // The DOMAIN chain is equality only. A prefix over a domain-derived brand reaches unrelated
    // merchants, and the predicate this replaces never did it.
    expect(hit(DOMAIN_INDEX, DOMAIN_PLAN_MARKER, '~>=~')).toBe(false);
    // A short alias has no prefix arm, so it is the equality arm that must be indexed.
    const shortConds = indexConditions(await explainPlan(primaryCall((await runFetcher(['NYX'])).calls), { noSeqScan: true }));
    expect(shortConds.some((entry) => entry.index === IDENTITY_INDEX
      && entry.cond.includes(BRAND_PLAN_MARKER) && entry.cond.includes('= ANY (') && entry.cond.includes('market = '))).toBe(true);
    // Negative control: an index scan whose expression sat only in `Filter:` leaves cond empty.
    expect(conds.filter((entry) => entry.index === IDENTITY_INDEX && entry.cond).length).toBeGreaterThanOrEqual(1);
  });

  test('the by-key fetch is a primary-key probe, not a scan', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon']);
    const fetch = fetchCall(issued);
    expect(fetch).not.toBeNull();
    // Indexability here; whether the planner PICKS it on a realistic table is asserted on the 20k
    // fixture in the plan-choice block below, which now EXPLAINs this statement too.
    const plan = await explainPlan(fetch, { noSeqScan: true });
    // Plain or bitmap — either is a key probe; what matters is that the id list is the Index Cond
    // and not a post-scan Filter.
    expect(plan).toMatch(/(?:Bitmap )?Index (?:Only )?Scan (?:on|using) external_product_seeds_pkey/);
    const idCond = plan.split('\n').map((line) => line.trim())
      .find((line) => line.startsWith('Index Cond:') && line.includes('id = ANY ('));
    expect(idCond).toBeTruthy();
    // The serving gate runs in THIS statement, after the probe — the candidate-ids statement does
    // not carry it, so a row the trust table rejects is a candidate but never a returned row.
    expect(fetch.sql).toContain('catalog_row_trust');
    expect((await newCandidateIds(['Mixsoon']))).toContain('out_trust_not_public');
    expect((await newPrimaryIds(['Mixsoon']))).not.toContain('out_trust_not_public');
  });

  test('the backfill title arm is answered by its own index', async () => {
    const { calls: issued } = await runFetcher(['Mixsoon']);
    const conds = indexConditions(await explainPlan(backfillCall(issued), { noSeqScan: true }));
    expect(
      conds.some((entry) => entry.index === TITLE_INDEX
        && entry.cond.includes('~>=~')
        && entry.cond.includes(TITLE_PLAN_MARKER)
        && entry.cond.includes('market = ')),
    ).toBe(true);
  });

  test('the index definitions are bounded, text_pattern_ops, and lead with (market, tool)', () => {
    const { seedBrandIdentitySql, seedDomainIdentitySql, seedTitleSql, IDENTITY_MAX_CHARS } =
      require('../../src/services/brandSeedScanSql');
    const byName = Object.fromEntries(indexDefinitions.map((definition) => [definition.name, definition]));
    expect(IDENTITY_MAX_CHARS).toBe(512);
    for (const [name, expression] of [
      [IDENTITY_INDEX, seedBrandIdentitySql()],
      [DOMAIN_INDEX, seedDomainIdentitySql()],
      [TITLE_INDEX, seedTitleSql()],
    ]) {
      expect(byName[name]).toBeTruthy();
      // The query and the index must read their expression from the same module, or an edit to one
      // silently un-indexes the other.
      expect(byName[name].expression).toBe(expression);
      expect(byName[name].expression).toContain('left(');
      expect(byName[name].sql).toContain('text_pattern_ops');
      expect(byName[name].sql).toContain('ON external_product_seeds (market, tool, (');
      expect(byName[name].sql).toContain("WHERE status = 'active' AND coalesce(attached_product_key, '') <> ''");
    }
  });

  // ---------------------------------------------------------------------------
  // 2c. Plan CHOICE, with the planner left alone
  // ---------------------------------------------------------------------------
  describe('plan choice on a realistic table, planner settings untouched', () => {
    let big;
    let bigSchema;
    const FILLER = 20000;

    beforeAll(async () => {
      big = new Client({ connectionString: url });
      await big.connect();
      bigSchema = `${schema}_planner`;
      await big.query(`CREATE SCHEMA ${bigSchema}`);
      await big.query(`SET search_path TO ${bigSchema}`);
      await createFixtureTables(big);
      await big.query(`INSERT INTO catalog_products(product_key) SELECT 'pkf' || g FROM generate_series(1, ${FILLER}) g`);
      await big.query(`INSERT INTO catalog_row_trust SELECT 'product', 'pkf' || g, 'public' FROM generate_series(1, ${FILLER}) g`);
      // Wide rows (~1.4KB) kept inline, so the heap really is ~34MB: prod's table is 326MB for
      // 14,043 rows, and a narrow fixture makes a sequential scan look free to the planner.
      await big.query(`
        INSERT INTO external_product_seeds
        SELECT 'f' || g, 'f' || g, 'US', 'creator_agents', 'https://s/' || g, 'https://s/' || g,
          'brand' || (g % 900) || '.example', 'Filler Item ' || g, 'https://i/x', 20, 'USD', 'in_stock',
          jsonb_build_object('brand_name', 'Filler Brand ' || (g % 900),
            'snapshot', jsonb_build_object('title', 'Filler Item ' || g),
            'pad', repeat('x', 1200)),
          now(), now(), 'active', 'pkf' || g
        FROM generate_series(1, ${FILLER}) g`);
      await big.query('ALTER TABLE external_product_seeds ALTER COLUMN seed_data SET STORAGE PLAIN');
      // Rows the probe aliases actually match, so the semi-join's hash side is not empty. An empty
      // hash short-circuits the outer scan and hides what that scan would really cost.
      const branded = PLANNER_BRANDS.length * 20;
      await big.query(`INSERT INTO catalog_products(product_key) SELECT 'pkr' || g FROM generate_series(1, ${branded}) g`);
      await big.query(`INSERT INTO catalog_row_trust SELECT 'product', 'pkr' || g, 'public' FROM generate_series(1, ${branded}) g`);
      for (let b = 0; b < PLANNER_BRANDS.length; b += 1) {
        await big.query(`
          INSERT INTO external_product_seeds
          SELECT 'r' || (${b * 20} + g), 'r' || (${b * 20} + g), 'US', 'creator_agents', 'https://s/r', 'https://s/r',
            'shop.example', $1::text || ' Item ' || g, 'https://i/x', 20, 'USD', 'in_stock',
            jsonb_build_object('brand_name', $1::text,
              'snapshot', jsonb_build_object('title', $1::text || ' Item ' || g),
              'pad', repeat('y', 1200)),
            now(), now(), 'active', 'pkr' || (${b * 20} + g)
          FROM generate_series(1, 20) g`, [PLANNER_BRANDS[b]]);
      }
      await createEpsIndexes(big);
      await big.query('ANALYZE external_product_seeds');
      await big.query('ANALYZE catalog_products');
      await big.query('ANALYZE catalog_row_trust');
    }, 300000);

    afterAll(async () => {
      if (big) {
        await big.query(`DROP SCHEMA ${bigSchema} CASCADE`);
        await big.end();
      }
    });

    const onBig = async (fn) => {
      const saved = db;
      db = big;
      try {
        return await fn();
      } finally {
        db = saved;
      }
    };

    // Reports what the planner chose, with the sequential-scan knob LEFT ALONE.
    const plannerVerdict = async (aliases) => onBig(async () => {
      const { calls: issued } = await runFetcher(aliases, { limit: 24 });
      const out = {};
      // Every statement the lane issues, not just the candidate-ids union: the by-key fetch is where
      // the whole-table scan used to live, so leaving it out would measure the half that was never
      // in doubt.
      for (const [lane, call] of [
        ['primary', primaryCall(issued)],
        ['primaryFetch', fetchAfter(issued, 'brand_seed_ids')],
        ['backfill', backfillCall(issued)],
        ['backfillFetch', fetchAfter(issued, 'title_seed_ids')],
      ]) {
        if (!call) continue;
        const res = await big.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${call.sql}`, call.params);
        const plan = res.rows.map((row) => row['QUERY PLAN']).join('\n');
        const line = plan.split('\n').find((row) => row.includes('Seq Scan on external_product_seeds')) || '';
        out[lane] = {
          branches: branchCount(call.sql),
          seqScan: Boolean(line),
          rowsScanned: Number((line.match(/actual rows=(\d+)/) || [0, 0])[1]),
          buffers: [...plan.matchAll(/shared hit=(\d+)(?: read=(\d+))?/g)]
            .reduce((total, match) => total + Number(match[1]) + Number(match[2] || 0), 0),
        };
      }
      return out;
    });

    test('the fixture is big and wide enough for the planner to have a real choice', async () => {
      const res = await big.query(
        `SELECT c.relpages AS pages, c.reltuples AS rows FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'external_product_seeds' AND n.nspname = $1`,
        [bigSchema],
      );
      expect(Number(res.rows[0].rows)).toBeGreaterThan(20000);
      expect(Number(res.rows[0].pages)).toBeGreaterThan(3000);
    });

    // This is the regression guard for the review's blocker. While the union was a CTE of the row
    // fetch, the OUTER query hash-joined against a full scan of external_product_seeds from 8
    // branches on: PostgreSQL estimates a parameterized LIKE / `= ANY(array)` over an expression
    // index at ~16% of the table (3,192 of 20,320 measured) where it returns ~17. Resolving the ids
    // in their own statement and fetching by primary key takes that estimate out of the decision,
    // and all three counts below now pass.
    //
    // Sizing, for anyone tempted to add a cap: prod's largest brand page probes 784 candidates, and
    // the measured crossover where this shape loses to the old predicate is ~3,000-4,000.
    test.each([
      ['1 alias', 1],
      ['8 aliases', 8],
      ['16 aliases', 16],
    ])('%s: the primary statement does not fall back to a full seq scan', async (_label, count) => {
      const verdict = await plannerVerdict(PLANNER_BRANDS.slice(0, count));
      // Fail with the numbers attached, not just `true !== false`.
      expect({ aliases: count, ...verdict.primary }).toMatchObject({
        aliases: count,
        seqScan: false,
        rowsScanned: 0,
      });
      // The by-key fetch must be there (these aliases match rows) and must be scan-free too.
      expect(verdict.primaryFetch).toBeDefined();
      expect({ aliases: count, ...verdict.primaryFetch }).toMatchObject({
        aliases: count,
        seqScan: false,
        rowsScanned: 0,
      });
      for (const [lane, measured] of Object.entries(verdict)) {
        expect([lane, measured.seqScan]).toEqual([lane, false]);
      }
    }, 120000);

    test('a real single-brand page never falls back to a full seq scan', async () => {
      // buildBrandScopeAliases emits 1-3 aliases for a single brand, which is what a brand page
      // actually sends; the counts above are the multi-brand scope tail.
      const discovery = require('../../src/services/discoveryFeed');
      const seqScanByBrand = {};
      for (const brand of ['Mixsoon', 'Round Lab', 'Beauty of Joseon', 'Dr. Jart+', 'e.l.f.', 'Fenty Beauty']) {
        const aliases = discovery._internals.buildBrandScopeAliases([brand]);
        expect(aliases.length).toBeGreaterThan(0);
        const verdict = await plannerVerdict(aliases);
        seqScanByBrand[brand] = Object.values(verdict).some((measured) => measured.seqScan);
      }
      expect(seqScanByBrand).toEqual({
        Mixsoon: false,
        'Round Lab': false,
        'Beauty of Joseon': false,
        'Dr. Jart+': false,
        'e.l.f.': false,
        'Fenty Beauty': false,
      });
    }, 180000);
  });

  // ---------------------------------------------------------------------------
  // 3a. LIKE wildcards
  // ---------------------------------------------------------------------------
  test('likePrefixPattern escapes every LIKE metacharacter', () => {
    const { likePrefixPattern } = require('../../src/services/brandSeedScanSql');
    expect(likePrefixPattern('100% pure', ' ')).toBe('100\\% pure %');
    expect(likePrefixPattern('a_b')).toBe('a\\_b%');
    expect(likePrefixPattern('back\\slash')).toBe('back\\\\slash%');
    expect(likePrefixPattern('plain')).toBe('plain%');
  });

  test('a % in an alias cannot behave as a wildcard in the title lane', async () => {
    const { products, calls: issued } = await runFetcher(['100% Pure']);
    const seedIds = products.map((product) => product.external_seed_id);
    expect(seedIds).toContain('wildcard_genuine');
    // Unescaped, '100% pure %' also matches "100 Percent Pure Glow Serum".
    expect(seedIds).not.toContain('wildcard_decoy');
    expect(backfillCall(issued).params).toContain('100\\% pure %');
  });

  test('an _ in an alias cannot behave as a wildcard in either lane', async () => {
    const { products, calls: issued } = await runFetcher(['a_b']);
    expect(products.map((product) => product.external_seed_id)).not.toContain('underscore_decoy');
    // Both lanes neutralise '_' before binding — normalizeBrandText turns it into a space and
    // brandIdentityKey drops it — so no alias-derived bind can carry one. likePrefixPattern's escape
    // is the belt on top of that, asserted directly above. $1/$2 are market and tool, not aliases.
    for (const call of issued) {
      for (const param of call.params.slice(2)) {
        for (const value of Array.isArray(param) ? param : [param]) {
          expect(String(value)).not.toContain('_');
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 3b. The bounded btree key
  // ---------------------------------------------------------------------------
  test('a 3000-character brand and title insert cleanly and still match by their prefix', async () => {
    // A btree key over 2704 bytes makes the INSERT fail permanently. The indexes already exist on
    // this table (built in beforeAll), so this is the real ordering: index first, oversized row after.
    //
    // F8, noted rather than tested: `left()` truncates the ROW side only, so an alias longer than
    // 512 characters can never match by equality — the bound row identity is at most 512 characters
    // and the alias is compared whole. Prefix matching is unaffected (a long alias's pattern simply
    // matches nothing past the bound). No brand name is anywhere near that, and clamping the alias
    // would silently widen equality to a prefix, which is worse.
    await expect(seedRow({ id: 'bounded_brand', seedData: { brand_name: LONG_BRAND }, title: 'Oversize Brand Item' }))
      .resolves.not.toThrow();
    await expect(seedRow({
      id: 'bounded_title',
      seedData: { brand_name: 'Boundedtitle Co', snapshot: { title: LONG_TITLE } },
      title: LONG_TITLE,
    })).resolves.not.toThrow();
    try {
      expect(await newPrimaryIds([LONG_BRAND.slice(0, 40)])).toEqual(['bounded_brand']);
      const { products } = await runFetcher(['Zqtitle'], { limit: 500 });
      expect(products.map((product) => product.external_seed_id)).toContain('bounded_title');
    } finally {
      await db.query(`DELETE FROM external_product_seeds WHERE id IN ('bounded_brand', 'bounded_title')`);
      await db.query(`DELETE FROM catalog_row_trust WHERE subject_key IN ('pk_bounded_brand', 'pk_bounded_title')`);
      await db.query(`DELETE FROM catalog_products WHERE product_key IN ('pk_bounded_brand', 'pk_bounded_title')`);
    }
  }, 60000);

  // ---------------------------------------------------------------------------
  // 3c. The products the fetcher returns
  // ---------------------------------------------------------------------------
  const seedIdsOf = (products) => products.map((product) => product.external_seed_id).sort();

  test('the fetcher returns products for exactly the matching seeds, plus the backfill', async () => {
    const { products } = await runFetcher(['Mixsoon']);
    expect(seedIdsOf(products)).toEqual([
      'brand_full_prefix_match',
      'domain_only_brand',
      'empty_recall_brand_fallthrough',
      'exact_brand_name',
      'exact_snapshot_brand',
      'exact_tool_star',
      'exact_vendor',
      'loss_e_two_pages',
      'recall_brand_name_only',
      'recall_brand_precedence',
      'title_backfill_seed_data',
      'title_backfill_snapshot',
    ]);
    for (const product of products) {
      expect(product.source).toBe('external_seed');
      expect(product.pivota_signature_id).toBe(`sig_${product.external_seed_id}`);
      expect(product.product_id).toBe(`sig_${product.external_seed_id}`);
    }
  });

  test('the backfill requires a SPACE after the alias', async () => {
    const seedIds = seedIdsOf((await runFetcher(['Mixsoon'])).products);
    expect(seedIds).toContain('title_backfill_snapshot');
    // 'Mixsoonish Copycat Cream' starts with the alias but is a different word.
    expect(seedIds).not.toContain('title_no_space_after_alias');
  });

  test('the by-key fetch orders BEFORE it limits, so the newest candidates win', async () => {
    // 30 candidates, limit 24: the LIMIT actually has to choose. Slicing the candidate ids to
    // safeLimit before the fetch would hand the ORDER BY a set that already dropped rows, and the
    // union returns ids in index order, not recency order.
    const candidates = await newCandidateIds(['Recencybrand']);
    expect(candidates).toHaveLength(30);
    const { products } = await runFetcher(['Recencybrand'], { limit: 24 });
    const returned = products.map((product) => product.external_seed_id);
    expect(returned).toHaveLength(24);
    // Newest first, and it is the 24 newest of the 30 — recency_00..05 are the ones dropped.
    expect(returned).toEqual(Array.from({ length: 24 }, (_, i) => `recency_${String(29 - i).padStart(2, '0')}`));
  });

  test('the backfill lane runs only when the primary lane underfills', async () => {
    const full = await runFetcher(['Fullbrand']);
    expect(backfillCall(full.calls)).toBeNull();
    expect(seedIdsOf(full.products)).toHaveLength(24);
    expect(seedIdsOf(full.products)).not.toContain('full_title_only');
    const partial = await runFetcher(['Fullbrand'], { limit: 40 });
    expect(backfillCall(partial.calls)).not.toBeNull();
    expect(seedIdsOf(partial.products)).toContain('full_title_only');
  });

  test('the backfill matches the title through each arm of seedTitleSql\'s coalesce', async () => {
    const seedIds = seedIdsOf((await runFetcher(['Mixsoon'])).products);
    expect(seedIds).toEqual(expect.arrayContaining(['title_backfill_snapshot', 'title_backfill_seed_data']));
  });

  test('an alias that matches nothing returns no products and still issues both statements', async () => {
    const { products, calls: issued } = await runFetcher(['Nosuchbrand']);
    expect(products).toEqual([]);
    expect(issued).toHaveLength(2);
  });
});
