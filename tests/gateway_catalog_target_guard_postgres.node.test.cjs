'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client } = require('pg');
const g = require('../src/rehearsal/catalogTargetGuard');
const file = process.env.REAP_GATEWAY_GUARD_TEST_MANIFEST;
let fixture;
if (file) {
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  fixture = JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(fixture.disposable,true); assert.equal(fixture.host,'127.0.0.1'); assert.equal(fixture.port,55439);
}
const target = { ...g.TARGET,host:'127.0.0.1',port:55439 };
function env() { return { ...g.REQUIRED,DATABASE_URL:fixture.catalog_database_url,
  REAP_GATEWAY_DATABASE_SECRET_REFERENCE:'projects/pivota-staging/secrets/reap-rehearsal-20261002-01a0f-catalog-dsn/versions/1' }; }
async function probe() { return g.runGuard({env:env(),target}); }
async function admin() {
  const c = new Client({connectionString:fixture.admin_database_url});await c.connect();
  const x=(await c.query('SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port')).rows[0];
  assert.deepEqual(x,{db:target.database,host:target.host,port:target.port});return c;
}
test('fresh real PostgreSQL restricted catalog role passes exact278-column guard', {skip:!fixture}, async () => {
  const result=await probe();assert.equal(result.catalog_tables,10);assert.equal(result.catalog_columns,278);assert.equal(result.actor,g.TARGET.actor);
});
test('prepare a guard-owned inaccessible synthetic sequence for permission negatives', {skip:!fixture},async()=> {
  const c=await admin();try {await c.query(`CREATE SEQUENCE IF NOT EXISTS guard_fixture_sequence; ALTER SEQUENCE guard_fixture_sequence OWNER TO ${target.owner}; REVOKE ALL ON guard_fixture_sequence FROM PUBLIC, ${target.actor}`);}finally {await c.end();}await probe();
});
test('real PG null sequence ACL uses scoped owner defaults and remains inaccessible', {skip:!fixture}, async()=> {
  const c=await admin();try {
    await c.query(`CREATE SEQUENCE guard_null_acl_sequence; ALTER SEQUENCE guard_null_acl_sequence OWNER TO ${target.owner}`);
    assert.equal((await c.query("SELECT relacl IS NULL AS default_acl FROM pg_class WHERE relname='guard_null_acl_sequence'")).rows[0].default_acl,true);
    await probe();
    await c.query(`GRANT USAGE ON SEQUENCE guard_null_acl_sequence TO PUBLIC`);
    await assert.rejects(probe(),/gateway_guard_sequence_acl/);
  } finally {try {await c.query('DROP SEQUENCE IF EXISTS guard_null_acl_sequence');}finally{await c.end();}}
  await probe();
});
const cases = [
 ['sequence USAGE',`GRANT USAGE ON SEQUENCE guard_fixture_sequence TO ${target.actor}`,`REVOKE USAGE ON SEQUENCE guard_fixture_sequence FROM ${target.actor}`,'sequence_acl'],
 ['sequence UPDATE',`GRANT UPDATE ON SEQUENCE guard_fixture_sequence TO ${target.actor}`,`REVOKE UPDATE ON SEQUENCE guard_fixture_sequence FROM ${target.actor}`,'sequence_acl'],
 ['sequence SELECT grant option',`GRANT SELECT ON SEQUENCE guard_fixture_sequence TO ${target.actor} WITH GRANT OPTION`,`REVOKE SELECT ON SEQUENCE guard_fixture_sequence FROM ${target.actor}`,'sequence_acl'],
 ['foreign sequence owner',`ALTER SEQUENCE guard_fixture_sequence OWNER TO ${target.actor}`,`ALTER SEQUENCE guard_fixture_sequence OWNER TO ${target.owner}`,'sequence_acl'],
 ['runtime CREATE database',`GRANT CREATE ON DATABASE ${target.database} TO ${target.actor}`,`REVOKE CREATE ON DATABASE ${target.database} FROM ${target.actor}`,'identity_privileges'],
 ['runtime TEMP database',`GRANT TEMP ON DATABASE ${target.database} TO ${target.actor}`,`REVOKE TEMP ON DATABASE ${target.database} FROM ${target.actor}`,'identity_privileges'],
 ['runtime CREATE schema',`GRANT CREATE ON SCHEMA public TO ${target.actor}`,`REVOKE CREATE ON SCHEMA public FROM ${target.actor}`,'identity_privileges'],
 ['runtime catalog write',`GRANT UPDATE ON catalog_products TO ${target.actor}`,`REVOKE UPDATE ON catalog_products FROM ${target.actor}`,'relation_privileges'],
 ['runtime marker write',`GRANT INSERT ON reap_rehearsal_guard_manifest TO ${target.actor}`,`REVOKE INSERT ON reap_rehearsal_guard_manifest FROM ${target.actor}`,'relation_privileges'],
 ['table SELECT grant option',`GRANT SELECT ON catalog_products TO ${target.actor} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR SELECT ON catalog_products FROM ${target.actor}`,'relation_privileges'],
 ['column UPDATE privilege',`GRANT UPDATE(title) ON catalog_products TO ${target.actor}`,`REVOKE UPDATE(title) ON catalog_products FROM ${target.actor}`,'column_acl'],
 ['broad role membership',`GRANT synthetic_broad_membership TO ${target.actor}`,`REVOKE synthetic_broad_membership FROM ${target.actor}`,'memberships'],
 ['PUBLIC cross database CONNECT','GRANT CONNECT ON DATABASE postgres TO PUBLIC','REVOKE CONNECT ON DATABASE postgres FROM PUBLIC','other_database_access'],
 ['role readonly off',`ALTER ROLE ${target.actor} SET default_transaction_read_only=off`,`ALTER ROLE ${target.actor} SET default_transaction_read_only=on`,'identity_privileges'],
 ['foreign readable relation',`CREATE TABLE foreign_fixture(x INT); GRANT SELECT ON foreign_fixture TO ${target.actor}`,'DROP TABLE foreign_fixture','relation_privileges'],
 ['wildcard lookalike pgx schema','CREATE SCHEMA pgx','DROP SCHEMA pgx','extra_schema'],
 ['extra schema','CREATE SCHEMA foreign_fixture','DROP SCHEMA foreign_fixture','extra_schema'],
 ['wrong fixture marker',"UPDATE reap_rehearsal_guard_manifest SET fixture_id='foreign'","UPDATE reap_rehearsal_guard_manifest SET fixture_id='20261002_01a0f'",'marker'],
 ['changed numeric typmod','ALTER TABLE catalog_offers ALTER COLUMN estimated_best_price TYPE numeric(13,2)','ALTER TABLE catalog_offers ALTER COLUMN estimated_best_price TYPE numeric(12,2)','catalog_schema'],
 ['missing canonical election','ALTER TABLE content_canonical_election RENAME TO election_fixture','ALTER TABLE election_fixture RENAME TO content_canonical_election','relation_privileges'],
 ['public security definer','CREATE FUNCTION public.foreign_fixture() RETURNS INT LANGUAGE SQL SECURITY DEFINER AS $$ SELECT 1 $$','DROP FUNCTION public.foreign_fixture()','security_definer'],
];
for (const [name,sql,undo,reason] of cases) {
  test(`real PG guard refuses ${name}`,{skip:!fixture},async()=> {
    const c=await admin();
    try {await c.query(sql);await assert.rejects(probe(),new RegExp('gateway_guard_'+reason));}
    finally {try {await c.query(undo);} finally {await c.end();}}
    await probe();
  });
}
test('actual connection actor must match, regardless of valid DSN-shaped metadata', {skip:!fixture},async()=> {
  const c=await admin();try {await assert.rejects(g.validateConnection(c,target),/gateway_guard_identity_privileges/);}finally {await c.end();}
});
