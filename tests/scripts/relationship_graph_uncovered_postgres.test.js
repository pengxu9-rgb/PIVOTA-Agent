const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { uncoveredLiveCatalogSql, recordAnchorAttempts, loadCoverageSuppressedIds } = require('../../src/auroraBff/relationshipGraphCoverage');
const { upsertRelationshipCandidateLabel } = require('../../src/auroraBff/productRelationshipGraph');
const selector = require('../../scripts/select-relationship-graph-affected-products');

const DATABASE_URL = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const BIN = process.env.RELGRAPH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@15/bin';
const postgresDescribe = (DATABASE_URL || process.env.RELGRAPH_TEST_POSTGRES === '1') ? describe : describe.skip;
postgresDescribe('uncovered-anchor semantics on throwaway local Postgres', () => {
  let dir;
  let client;
  let started = false;
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = (name, args) => execFileSync(path.join(BIN, name), args, { env, stdio: 'pipe' });
  beforeAll(async () => {
    if (DATABASE_URL) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DATABASE_URL).hostname)) throw new Error('relgraph Postgres tests require a local database');
      client = new Client({ connectionString: DATABASE_URL });
    } else {
      const net = require('node:net');
      const port = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
      });
      dir = fs.mkdtempSync('/tmp/relgraph-uncovered-');
      run('initdb', ['-D', dir, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
      run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-k /tmp -c listen_addresses=127.0.0.1 -p ${port}`, '-w', 'start']);
      started = true;
      client = new Client({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
    }
    await client.connect();
    await client.query('CREATE SCHEMA relgraph_uncovered_test; SET search_path TO relgraph_uncovered_test');
    await client.query(`
      CREATE TABLE catalog_merchants (merchant_id text PRIMARY KEY, status text);
      CREATE TABLE merchant_stores (merchant_id text, status text, domain text, platform text);
      CREATE TABLE catalog_products (
        pdp_will_render boolean DEFAULT true, pdp_will_render_computed_at timestamptz DEFAULT now(),
        pdp_lifecycle_stage text DEFAULT 'published', pivota_signature_minted_at timestamptz,
        product_key text PRIMARY KEY, source_product_id text, pivota_signature_id text, content_key text,
        merchant_id text, platform text, source_domain text, suppressed_at timestamptz, suppression_reason text,
        title text, description text, brand text, product_type text, category text, category_path text,
        category_label text, canonical_url text, pivota_canonical_url text, product_payload jsonb,
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
      CREATE INDEX idx_catalog_products_content_key ON catalog_products(content_key) WHERE content_key IS NOT NULL;
      CREATE TABLE product_group_members (merchant_id text, platform text, platform_product_id text,
        product_group_id text, is_primary boolean DEFAULT false, PRIMARY KEY (merchant_id, platform, platform_product_id));
      CREATE INDEX idx_product_group_members_group_id ON product_group_members(product_group_id);
      CREATE TABLE external_product_seeds (id text PRIMARY KEY, external_product_id text, attached_product_key text, attached_variant_id text,
        status text, market text, domain text, title text, canonical_url text, destination_url text,
        seed_data jsonb, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
      CREATE INDEX idx_external_product_seeds_attached ON external_product_seeds(attached_product_key,attached_variant_id);
      INSERT INTO catalog_merchants VALUES ('real', 'active'), ('inactive', 'inactive'), ('merch_test_ownist_001', 'active');
    `);
    for (const number of ['046', '048', '050', '051', '061']) {
      const file = fs.readdirSync(path.join(__dirname, '../../src/db/migrations')).find((name) => name.startsWith(`${number}_`));
      await client.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
    }
  }, 30000);
  afterAll(async () => {
    try { if (client) { await client.query('DROP SCHEMA IF EXISTS relgraph_uncovered_test CASCADE'); await client.end(); } } finally {
      if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    await client.query('TRUNCATE relationship_graph_anchor_attempts, relationship_candidate_labels, catalog_products, external_product_seeds, product_group_members, merchant_stores');
    await product('anchor');
  });
  async function product(key, { merchant = 'real', content = key } = {}) {
    await client.query(`INSERT INTO catalog_products(product_key, source_product_id, pivota_signature_id,
      content_key, merchant_id, platform, title, category) VALUES ($1,$2,$3,$4,$5,'shopify','Beauty serum','skincare')`,
    [key, `source_${key}`, `sig_${key}`, content, merchant]);
  }
  async function label(ref, { market = 'US', state = 'ai_approved', recent = false, expires = true } = {}) {
    await client.query(`INSERT INTO relationship_candidate_labels(id,anchor_type,anchor_ref,candidate_product_ref,
      relation_type,market,label_state,last_verified_at,expires_at,created_at,updated_at)
      VALUES ($1,'product',$2,'product:candidate','related_product',$3,$4,now(),
        now() + $5::interval,now() - $6::interval,now() - $6::interval)`, [ref, ref, market, state, expires ? '45 days' : '-1 day', recent ? '1 day' : '30 days']);
  }
  test.each(['INSERT', 'SELECT', 'INSERT, SELECT'])('job role preflight rejects a role with only %s', async (privilege) => {
    const { requireAnchorAttemptsTable } = require('../../src/auroraBff/relationshipGraphCoverage');
    await client.query('CREATE ROLE relgraph_priority_round5_job');
    try {
      await client.query('GRANT USAGE ON SCHEMA relgraph_uncovered_test TO relgraph_priority_round5_job');
      await client.query(`GRANT ${privilege} ON relationship_graph_anchor_attempts TO relgraph_priority_round5_job`);
      await client.query('SET ROLE relgraph_priority_round5_job');
      // PostgreSQL comma-separated privilege lists mean ANY, so the preflight
      // checks INSERT and SELECT individually rather than trusting this alone.
      expect((await client.query("SELECT has_table_privilege(current_user,'relationship_graph_anchor_attempts','INSERT,SELECT') AS any_privilege")).rows[0].any_privilege).toBe(true);
      await expect(requireAnchorAttemptsTable((sql, params) => client.query(sql, params)))
        .rejects.toMatchObject({ code: 'RELGRAPH_ANCHOR_ATTEMPTS_PRIVILEGES' });
      await client.query('RESET ROLE');
      await client.query('GRANT INSERT, SELECT, UPDATE ON relationship_graph_anchor_attempts TO relgraph_priority_round5_job');
      await client.query('SET ROLE relgraph_priority_round5_job');
      await expect(requireAnchorAttemptsTable((sql, params) => client.query(sql, params))).resolves.toBeUndefined();
      for (let i = 0; i < 2; i++) await recordAnchorAttempts({ anchors: [{ product_id: 'role_fixture' }], queryFn: (sql, params) => client.query(sql, params) });
      expect((await client.query("SELECT count(*)::int AS n FROM relationship_graph_anchor_attempts WHERE anchor_ref='product:role_fixture'")).rows[0].n).toBe(1);
    } finally {
      await client.query('RESET ROLE');
      await client.query('REVOKE ALL ON relationship_graph_anchor_attempts FROM relgraph_priority_round5_job');
      await client.query('REVOKE USAGE ON SCHEMA relgraph_uncovered_test FROM relgraph_priority_round5_job');
      await client.query('DROP ROLE relgraph_priority_round5_job');
    }
  });
  test('a real role with table privileges but no public schema USAGE gets a privilege error', async () => {
    const { requireAnchorAttemptsTable } = require('../../src/auroraBff/relationshipGraphCoverage');
    await client.query('BEGIN');
    try {
      await client.query('CREATE ROLE relgraph_priority_round6_no_schema');
      await client.query('CREATE TABLE public.relationship_graph_anchor_attempts (LIKE relgraph_uncovered_test.relationship_graph_anchor_attempts INCLUDING ALL)');
      await client.query('GRANT INSERT, SELECT, UPDATE ON public.relationship_graph_anchor_attempts TO relgraph_priority_round6_no_schema');
      // USAGE inherited from PUBLIC must be revoked too; all changes roll back.
      await client.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
      await client.query('SET LOCAL ROLE relgraph_priority_round6_no_schema');
      await client.query('SET LOCAL search_path TO public');
      expect((await client.query("SELECT to_regclass('relationship_graph_anchor_attempts') AS table_name")).rows[0].table_name).toBeNull();
      await expect(requireAnchorAttemptsTable((sql, params) => client.query(sql, params)))
        .rejects.toMatchObject({ code: 'RELGRAPH_ANCHOR_ATTEMPTS_PRIVILEGES', message: expect.stringContaining('USAGE on schema public') });
    } finally { await client.query('ROLLBACK'); }
  });
  async function priority(days = 7, coverageSiblingRefs = true) {
    const ids = await loadCoverageSuppressedIds({ queryFn: (sql, params) => client.query(sql, params), market: 'US' });
    const result = await client.query(`SELECT CASE WHEN ${uncoveredLiveCatalogSql('cp', { marketSql: '$1', suppressedIdsSql: '$2::text[]', cooldownDays: days, coverageSiblingRefs })}
      THEN true ELSE false END AS priority FROM catalog_products cp
      LEFT JOIN catalog_merchants cm ON cm.merchant_id=cp.merchant_id WHERE cp.product_key='anchor'`, ['US', ids]);
    return result.rows[0].priority;
  }
  test('uncovered active row is promoted', async () => expect(await priority()).toBe(true));
  test.each(['product:sig_anchor', 'product:source_anchor'])('served ref %s counts as covered', async (ref) => {
    await label(ref); expect(await priority()).toBe(false);
  });
  test('unattached source-id seed is covered', async () => {
    await client.query("INSERT INTO external_product_seeds(id,external_product_id,status,market) VALUES ('seed','source_anchor','active','US')");
    await label('product:source_anchor'); expect(await priority()).toBe(false);
  });
  test('attached seed is covered', async () => {
    await client.query("INSERT INTO external_product_seeds(id,external_product_id,attached_product_key) VALUES ('seed','external','anchor')");
    await label('product:external'); expect(await priority()).toBe(false);
  });
  test.each(['suppressed', 'inactive', 'test', 'demo_domain', 'inactive_store'])('%s row is not live', async (kind) => {
    if (kind === 'suppressed') await client.query("UPDATE catalog_products SET suppressed_at=now()");
    if (kind === 'inactive') await client.query("UPDATE catalog_products SET merchant_id='inactive'");
    if (kind === 'test') await client.query("UPDATE catalog_products SET merchant_id='merch_test_ownist_001'");
    if (kind === 'demo_domain') await client.query("UPDATE catalog_products SET source_domain='pivota-review-demo-3.myshopify.com'");
    if (kind === 'inactive_store') await client.query("INSERT INTO merchant_stores VALUES ('real','inactive','real.example','shopify')");
    expect(await priority()).toBe(false);
  });
  test('recent pending label rotates out; configurable cooldown lets it return', async () => {
    await label('product:sig_anchor', { state: 'generated', recent: true });
    expect(await priority()).toBe(false);
    await client.query("UPDATE relationship_candidate_labels SET created_at=now()-interval '8 days',updated_at=now()-interval '8 days'");
    expect(await priority(7)).toBe(true); expect(await priority(11)).toBe(false);
  });
  test('old rejected label returns to queue', async () => {
    await label('product:sig_anchor', { state: 'human_rejected' }); expect(await priority()).toBe(true);
  });
  test('market mismatch does not count as coverage or cooldown', async () => {
    await label('product:sig_anchor', { market: 'JP', recent: true }); expect(await priority()).toBe(true);
  });
  test('non-beauty label does not count as coverage or cooldown', async () => {
    await client.query("ALTER TABLE relationship_candidate_labels DROP CONSTRAINT relationship_candidate_labels_vertical_check");
    try {
      await label('product:sig_anchor', { recent: true });
      await client.query("UPDATE relationship_candidate_labels SET vertical='other'");
      expect(await priority()).toBe(true);
    } finally {
      await client.query("DELETE FROM relationship_candidate_labels; ALTER TABLE relationship_candidate_labels ADD CONSTRAINT relationship_candidate_labels_vertical_check CHECK(vertical='beauty')");
    }
  });
  test.each(['product:sig_sibling', 'product:source_sibling', 'product:pg_fixture'])('group ref %s counts as covered', async (ref) => {
    await product('sibling', { content: 'different' });
    await client.query("INSERT INTO product_group_members(merchant_id,platform,platform_product_id,product_group_id) VALUES ('real','shopify','source_anchor','pg_fixture'),('real','shopify','source_sibling','pg_fixture')");
    await label(ref); expect(await priority()).toBe(false);
  });
  test('content-cluster sibling signature counts as covered', async () => {
    await product('sibling', { content: 'anchor' });
    await label('product:sig_sibling'); expect(await priority()).toBe(false);
  });
  test('selector executes priority once, promotes uncovered before covered and suppressed', async () => {
    await product('covered'); await product('suppressed');
    await label('product:sig_covered');
    await client.query("UPDATE catalog_products SET suppressed_at=now() WHERE product_key='suppressed'");
    const rows = await selector.fetchCatalogProductRows({ queryFn: (sql, params) => client.query(sql, params),
      updatedSince: '2026-01-01', market: 'US', prioritizeUncovered: true });
    expect(rows[0].product_key).toBe('anchor');
    expect(rows.map((row) => row.relgraph_uncovered_live)).toEqual([true, false, false]);
  });
  test.each(['false', 'null', 'stale', 'unknown_time'])('render probe %s fails closed', async (kind) => {
    await client.query(`UPDATE catalog_products SET pdp_will_render=${kind === 'false' ? 'false' : kind === 'null' ? 'NULL' : 'true'},
      pdp_will_render_computed_at=${kind === 'unknown_time' ? 'NULL' : kind === 'stale' ? "now()-interval '8 days'" : 'now()'}`);
    expect(await priority()).toBe(false);
  });
  test('explicit sibling switch disables sibling and canonical group coverage', async () => {
    await product('sibling', { content: 'anchor' }); await label('product:sig_sibling');
    expect(await priority(7, false)).toBe(true);
    expect(await priority()).toBe(false);
  });
  test('unsigned members cannot cover an anchor', async () => {
    await product('sibling', { content: 'anchor' });
    await client.query("UPDATE catalog_products SET pivota_signature_id=NULL WHERE product_key='sibling'");
    await label('product:source_sibling'); expect(await priority()).toBe(true);
  });
  test('only serving canonical group covers an anchor', async () => {
    await product('sibling', { content: 'anchor' });
    await client.query(`INSERT INTO product_group_members VALUES
      ('real','shopify','source_anchor','pg_other',false),('real','shopify','source_sibling','pg_canonical',true)`);
    await label('product:pg_other'); expect(await priority()).toBe(true);
    await label('product:pg_canonical'); expect(await priority()).toBe(false);
  });
  test.each(['generated', 'human_rejected', 'needs_evidence', 'ai_approved', 'human_approved', 'prefilter_rejected'])
    ('recent independent attempt blocks %s regardless of label upsert', async (state) => {
      await label('product:sig_anchor', { state, expires: false });
      await recordAnchorAttempts({ anchors: [{ product_ref: 'product:sig_anchor' }], market: 'us', queryFn: (sql, params) => client.query(sql, params) });
      const before = (await client.query('SELECT * FROM relationship_candidate_labels')).rows[0];
      await upsertRelationshipCandidateLabel({ anchor_ref: 'product:sig_anchor', candidate_product_ref: 'product:candidate',
        relation_type: 'related_product', market: 'US', label_state: 'generated' }, { queryFn: (sql, params) => client.query(sql, params) });
      const after = (await client.query('SELECT * FROM relationship_candidate_labels')).rows[0];
      expect(after.created_at).toEqual(before.created_at);
      if (['human_rejected', 'needs_evidence', 'ai_approved', 'human_approved'].includes(state)) {
        expect(after.updated_at).toEqual(before.updated_at); expect(after.label_state).toBe(state);
      } else expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
      const rows = await selector.fetchCatalogProductRows({ queryFn: (sql, params) => client.query(sql, params),
        updatedSince: '2026-01-01', prioritizeUncovered: true });
      expect(rows).toHaveLength(0);
    });
  test('zero-edge attempts also cool down and are market scoped', async () => {
    await recordAnchorAttempts({ anchors: [{ product_ref: 'product:sig_anchor' }], market: 'JP', queryFn: (sql, params) => client.query(sql, params) });
    expect(await priority()).toBe(true);
    await recordAnchorAttempts({ anchors: [{ product_ref: 'product:sig_anchor' }], market: 'US', queryFn: (sql, params) => client.query(sql, params) });
    expect(await priority()).toBe(false);
  });
  test.each(['updated_at', 'reviewed_at'])('recent %s overrides old created_at', async (column) => {
    await label('product:sig_anchor', { state: 'human_rejected' });
    await client.query(`UPDATE relationship_candidate_labels SET ${column}=now()`);
    expect(await priority()).toBe(false);
  });
  test('never attempted comes first, then oldest pending, then terminal-only', async () => {
    await product('old_pending'); await product('new_pending'); await product('terminal');
    await label('product:sig_old_pending', { state:'generated' });
    await label('product:sig_new_pending', { state:'generated' });
    await label('product:sig_terminal', { state:'human_rejected' });
    await client.query("UPDATE relationship_candidate_labels SET updated_at=now()-interval '10 days' WHERE anchor_ref='product:sig_new_pending'");
    const rows = await selector.fetchCatalogProductRows({ queryFn: (sql,params)=>client.query(sql,params), updatedSince:'2026-01-01',prioritizeUncovered:true });
    expect(rows.map((row)=>row.product_key)).toEqual(['anchor','old_pending','new_pending','terminal']);
  });
  test('ten nightly selections preserve real upsert semantics and never-attempted precedence', async () => {
    await client.query('TRUNCATE catalog_products');
    for (let i = 0; i < 60; i += 1) await product(`night_${String(i).padStart(2, '0')}`);
    const start = Date.now();
    const seen = new Map();
    const states = ['generated', 'human_rejected', 'needs_evidence', 'ai_approved', 'prefilter_rejected'];
    // Old labels exercise both rewrites and the upsert's protected-state WHERE, while forty
    // anchors have no labels. Replacing SQL now() is a test clock; the production upsert is real.
    for (let i = 0; i < 20; i += 1) await label(`product:sig_night_${String(i).padStart(2, '0')}`, { state: states[i % states.length], expires: false });
    for (let night = 0; night < 10; night += 1) {
      const clock = new Date(start + night * 86400000).toISOString();
      const queryFn = (sql, params) => client.query(sql.replace(/now\(\)/g, `TIMESTAMPTZ '${clock}'`), params);
      await client.query(`UPDATE catalog_products SET pdp_will_render_computed_at=$1`, [clock]);
      const selected = await selector.fetchCatalogProductRows({ queryFn, updatedSince: '2026-01-01',
        prioritizeUncovered: true, limit: 5, uncoveredCooldownDays: 7 });
      expect(selected).toHaveLength(5);
      for (const row of selected) {
        const last = seen.get(row.product_key);
        if (last !== undefined) expect(night - last).toBeGreaterThan(7);
        if (night < 8) expect(row.relgraph_last_activity).toBeNull();
        seen.set(row.product_key, night);
        const ref = `product:${row.pivota_signature_id}`;
        const before = (await client.query('SELECT * FROM relationship_candidate_labels WHERE anchor_ref=$1', [ref])).rows[0];
        await recordAnchorAttempts({ anchors: [{ product_ref: ref }], market: 'US', queryFn });
        await upsertRelationshipCandidateLabel({ anchor_ref: ref, candidate_product_ref: 'product:candidate',
          relation_type: 'related_product', market: 'US', label_state: 'generated' }, { queryFn });
        const after = (await client.query('SELECT * FROM relationship_candidate_labels WHERE anchor_ref=$1', [ref])).rows[0];
        if (before) {
          expect(after.created_at).toEqual(before.created_at);
          if (['human_rejected', 'needs_evidence', 'ai_approved'].includes(before.label_state)) {
            expect(after.updated_at).toEqual(before.updated_at); expect(after.label_state).toBe(before.label_state);
          } else expect(after.updated_at.toISOString()).toBe(clock);
        }
      }
    }
    expect(seen.size).toBe(48); // Two eligible repeats occur after nine nights; none within cooldown.
  });

  test.each(['ai_dupe', 'nested_candidate', 'nested_anchor', 'shade', 'family', 'fenty'])('hidden %s approval never counts as serving coverage', async (kind) => {
    await label('product:sig_anchor');
    if (kind === 'ai_dupe') await client.query("UPDATE relationship_candidate_labels SET relation_type='dupe'");
    if (kind === 'nested_candidate') await client.query("UPDATE relationship_candidate_labels SET candidate_product_ref='product:product:broken'");
    if (kind === 'nested_anchor') {
      await client.query("UPDATE catalog_products SET pivota_signature_id='product:broken'; UPDATE relationship_candidate_labels SET anchor_ref='product:product:broken'");
    }
    if (['shade','family','fenty'].includes(kind)) {
      const titles = kind === 'shade' ? ['Daily Face Foundation - 100 Light','Daily Face Foundation - 200 Dark']
        : kind === 'family' ? ['False Lash Clusters - Demi Edgy','False Lash Clusters - Demi Bold']
        : ['Pro Foundation - Soft Matte','Different Concealer - Soft Glow'];
      await client.query('UPDATE relationship_candidate_labels SET anchor_snapshot=$1,candidate_snapshot=$2',
        [JSON.stringify({brand:kind==='fenty'?'Fenty':'Test',title:titles[0]}),JSON.stringify({brand:kind==='fenty'?'Fenty':'Test',title:titles[1]})]);
    }
    expect(await priority()).toBe(true);
    if (['ai_dupe','nested_candidate','nested_anchor'].includes(kind)) {
      const result = await client.query(`SELECT ${uncoveredLiveCatalogSql('cp',{marketSql:'$1', suppressedIdsSql: "'{}'::text[]"})} AS priority FROM catalog_products cp LEFT JOIN catalog_merchants cm ON cm.merchant_id=cp.merchant_id WHERE cp.product_key='anchor'`,['US']);
      expect(result.rows[0].priority).toBe(true);
    }
  });
  test('hidden AI approvals do not hide a serving-visible human edge on the same anchor', async () => {
    await label('product:sig_anchor'); await client.query("UPDATE relationship_candidate_labels SET relation_type='dupe'");
    await client.query(`INSERT INTO relationship_candidate_labels(id,anchor_type,anchor_ref,candidate_product_ref,relation_type,market,label_state,last_verified_at,expires_at,created_at,updated_at)
      VALUES ('human','product','product:sig_anchor','product:other','dupe','US','human_approved',now(),now()+interval '45 days',now()-interval '30 days',now()-interval '30 days')`);
    expect(await priority()).toBe(false);
  });
  test.each([
    ['The Ordinary', 'Saccharomyces Ferment 30% Milky Toner for Gentle Exfoliation and Hydra', 'Saccharomyces Ferment 30% Milky Toner'],
    ['Rare Beauty', 'Find Comfort Body & Hair Fragrance Mist Mini', 'Find Comfort Body & Hair Fragrance Mist - Awaken Confidence - Awaken C'],
    ['The Ordinary', 'Salicylic Acid 2% Anhydrous Solution, Gentle Exfoliating Serum for Ble', 'Salicylic Acid 2% Solution, Exfoliating Serum for Acne'],
  ])('coverage follows the installed shared guard for %s sample pair %s', async (brand, anchor, candidate) => {
    await label('product:sig_anchor');
    const anchorSnapshot = { brand:brand.toLowerCase(),title:anchor };
    const candidateSnapshot = { brand,title:candidate };
    await client.query('UPDATE relationship_candidate_labels SET anchor_snapshot=$1,candidate_snapshot=$2',[JSON.stringify(anchorSnapshot),JSON.stringify(candidateSnapshot)]);
    const { getRelationshipEdgeServingSuppressionReasons } = require('../../src/auroraBff/productRelationshipGraph');
    const hidden = getRelationshipEdgeServingSuppressionReasons({anchor_type:'product',anchor_ref:'product:sig_anchor',candidate_product_ref:'product:candidate',relation_type:'related_product',label_state:'ai_approved',anchor_snapshot:anchorSnapshot,candidate_snapshot:candidateSnapshot}).length>0;
    expect(await priority()).toBe(hidden);
  });
  test('missing migration fails for selectors and explicit affected products', async () => {
    const sources = require('../../src/auroraBff/productRelationshipGraphSources');
    await client.query('ALTER TABLE relationship_graph_anchor_attempts RENAME TO attempts_temporarily_absent');
    try {
      const queryFn = (sql, params) => client.query(sql, params);
      await expect(selector.fetchCatalogProductRows({ queryFn, prioritizeUncovered:true, updatedSince:'2020-01-01', limit:1 })).rejects.toMatchObject({ code:'RELGRAPH_ANCHOR_ATTEMPTS_MISSING' });
      await expect(sources.loadAffectedProductAnchorCandidates({ queryFn, prioritizeUncovered:true, refs:['sig_anchor'] })).rejects.toMatchObject({ code:'RELGRAPH_ANCHOR_ATTEMPTS_MISSING' });
    } finally { await client.query('ALTER TABLE attempts_temporarily_absent RENAME TO relationship_graph_anchor_attempts'); }
  });
  (process.env.RELGRAPH_TEST_EXPLAIN === '1' ? test : test.skip)('production-size indexed selector plans', async () => {
    await client.query(`TRUNCATE catalog_products;
      CREATE INDEX IF NOT EXISTS idx_catalog_products_source_product_id_lookup ON catalog_products(source_product_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_products_source_identity ON catalog_products(merchant_id,platform,source_product_id);
      INSERT INTO catalog_products(product_key,source_product_id,pivota_signature_id,content_key,merchant_id,platform,title,category,updated_at,created_at)
      SELECT 'cp_'||i,'source_'||i,'sig_'||i,'content_'||((i+1)/2),'real','shopify','Beauty serum','skincare',
        CASE WHEN i%20=0 THEN now()-interval '1 hour' ELSE now()-interval '10 days' END,now()-interval '30 days'
        FROM generate_series(1,29000) i;
      INSERT INTO product_group_members(merchant_id,platform,platform_product_id,product_group_id,is_primary)
      SELECT 'real','shopify','source_'||i,'pg_'||((i+1)/2),i%2=1 FROM generate_series(1,28000) i;
      INSERT INTO external_product_seeds(id,external_product_id,attached_product_key,status,market,title,updated_at,created_at)
      SELECT 'seed_'||i,'ext_'||i,'cp_'||(((i-1)%29000)+1),'active','US','Beauty serum',now()-interval '10 days',now()-interval '30 days'
        FROM generate_series(1,30000) i;
      INSERT INTO relationship_candidate_labels(id,anchor_type,anchor_ref,candidate_product_ref,relation_type,market,label_state,created_at,updated_at,last_verified_at,expires_at)
      SELECT 'label_'||i,'product','product:'||CASE i%4 WHEN 0 THEN 'sig_' WHEN 1 THEN 'source_' WHEN 2 THEN 'ext_' ELSE 'pg_' END||
        CASE WHEN i%4=3 THEN (((i-1)%14000)+1) ELSE (((i-1)%29000)+1) END,
        'product:candidate_'||i,'related_product','US',CASE i%3 WHEN 0 THEN 'generated' WHEN 1 THEN 'human_rejected' ELSE 'ai_approved' END,
        now()-interval '30 days',now()-interval '15 days',now()-interval '15 days',
        CASE WHEN i%7=0 THEN now()+interval '20 days' ELSE now()-interval '1 day' END FROM generate_series(1,70000) i;
      UPDATE relationship_candidate_labels SET
        anchor_snapshot = jsonb_build_object('brand','Test','title',CASE WHEN substring(id from 7)::int % 5 = 0 THEN 'Daily Face Foundation - 100 Light' ELSE 'Hydrating Face Cream' END),
        candidate_snapshot = jsonb_build_object('brand','Test','title',CASE WHEN substring(id from 7)::int % 5 = 0 THEN 'Daily Face Foundation - 200 Dark' ELSE 'Gentle Face Cleanser' END)
      WHERE label_state = 'ai_approved' AND expires_at > now();
      INSERT INTO relationship_graph_anchor_attempts(anchor_ref,market,vertical,last_attempt_at)
      SELECT 'product:'||CASE i%3 WHEN 0 THEN 'sig_' WHEN 1 THEN 'source_' ELSE 'ext_' END||(((i-1)%29000)+1),
        'US','beauty',now()-interval '12 days' FROM generate_series(1,35000) i
      ON CONFLICT DO NOTHING;
      ANALYZE;
    `);
    const plans = {};
    const scanStart = performance.now();
    const coverageSuppressedIds = await loadCoverageSuppressedIds({ queryFn: (sql, params) => client.query(sql, params), market: 'US' });
    plans.guard_scan = { milliseconds: performance.now() - scanStart, suppressed_ids: coverageSuppressedIds.length };
    for (const [name, since] of [['24h', new Date(Date.now()-86400000).toISOString()], ['full', '2020-01-01']]) {
      for (const [source, fetch] of [['catalog',selector.fetchCatalogProductRows],['seeds',selector.fetchExternalSeedRows]]) {
        await fetch({ updatedSince: since, prioritizeUncovered: true, coverageSuppressedIds, limit: 200,
          queryFn: async (sql, params) => {
            const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,params);
            const plan = result.rows[0]['QUERY PLAN'][0]; plans[`${name}_${source}`] = plan;
            const nodes = []; const visit = (node) => { nodes.push(node); (node.Plans || []).forEach(visit); }; visit(plan.Plan);
            expect(nodes.some((node) => node['Index Name'] === 'idx_rcl_anchor_lookup')).toBe(true);
            expect(nodes.some((node) => node['Relation Name'] === 'relationship_candidate_labels' && node['Node Type'] === 'Seq Scan')).toBe(false);
            return { rows: [] };
          },
        });
      }
    }
    fs.mkdirSync(path.join(__dirname,'../../work'),{ recursive:true });
    fs.writeFileSync(path.join(__dirname,'../../work/relgraph-query-plans.json'),JSON.stringify(plans,null,2));
  }, 120000);

});
