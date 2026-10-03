'use strict';
// Guard-only imports. No dotenv, app, logger, DB pool or migration module.
const schema = require('./storedCatalogSchema.json');
const TARGET = Object.freeze({ host: '10.122.0.3', port: 5432,
  database: 'reap_rehearsal_20261002_01a0f', actor: 'reap_rehearsal_01a0f_catalog',
  owner: 'reap_rehearsal_01a0f_migrator', project: 'pivota-staging',
  fixture: '20261002_01a0f', backendSource: 'ffae02260a8520eaa7e9cbf044a90b62d376d6ab' });
const TABLES = Object.freeze([...new Set(schema.map((c) => c.table_name))].sort());
const REQUIRED = Object.freeze({ PIVOTA_ENV: 'staging', GOOGLE_CLOUD_PROJECT: 'pivota-staging',
  REAP_GATEWAY_PREPARATION_ONLY: '1', GATEWAY_STORED_CATALOG_REHEARSAL: '1',
  SEARCH_BUDGET_REQUIRE_MARKER: 'true',
  REAP_AGENTIC_LANE_ENABLED: '0', REAP_AGENTIC_CREATE_ENABLED: '0',
  REAP_AGENTIC_CART_LINK_LANE_ENABLED: '0', REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED: '0' });
function reject(code) { const error = new Error(code); error.code = code; throw error; }
function validateEnvironment(env) {
  if (Object.entries(REQUIRED).some(([k, v]) => env[k] !== v)) reject('gateway_guard_flags');
  if (Object.keys(env).some((k) => /^PG[A-Z_]+$/.test(k) && env[k])) reject('gateway_guard_ambient_pg');
  if (!/^projects\/pivota-staging\/secrets\/reap-rehearsal-20261002-01a0f-catalog-dsn\/versions\/[1-9][0-9]*$/.test(env.REAP_GATEWAY_DATABASE_SECRET_REFERENCE || '')) reject('gateway_guard_numeric_secret');
}
function validateDsn(raw, target = TARGET) {
  if (typeof raw !== 'string' || !raw || /[\x00-\x20\x7f?#]/.test(raw)) reject('gateway_guard_dsn');
  let url; try { url = new URL(raw); } catch { reject('gateway_guard_dsn'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== target.host || Number(url.port) !== target.port
    || url.pathname !== `/${target.database}` || url.username !== target.actor || !url.password
    || (raw.match(/@/g) || []).length !== 1) reject('gateway_guard_target');
  return raw;
}
async function validateConnection(client, target = TARGET) {
  const identity = (await client.query(`SELECT current_database() AS db, host(inet_server_addr()) AS host,
    inet_server_port() AS port,current_user AS actor,session_user AS session_actor,
    pg_get_userbyid(d.datdba) AS owner,
    pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='public')) AS schema_owner,
    has_database_privilege(current_user,current_database(),'CREATE') AS db_create,
    has_database_privilege(current_user,current_database(),'TEMP') AS db_temp,
    has_schema_privilege(current_user,'public','CREATE') AS schema_create,
    has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
    current_setting('default_transaction_read_only') AS default_readonly
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  if (!identity || Object.entries({ db: target.database, host: target.host, port: target.port,
    actor: target.actor, session_actor: target.actor, owner: target.owner, schema_owner: target.owner,
    db_create: false, db_temp: false, schema_create: false, schema_usage: true, default_readonly: 'on' })
    .some(([k, v]) => identity[k] !== v)) reject('gateway_guard_identity_privileges');
  const role = (await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (!role || !role.rolcanlogin || ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].some((k) => role[k])) reject('gateway_guard_role');
  if (Number((await client.query('SELECT count(*) AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n)) reject('gateway_guard_memberships');
  // The shared instance currently fails this check because PUBLIC can CONNECT
  // to other databases. No existing ACL is changed by this guard.
  if (Number((await client.query("SELECT count(*) AS n FROM pg_database WHERE datallowconn AND datname<>current_database() AND has_database_privilege(current_user,oid,'CONNECT')")).rows[0].n)) reject('gateway_guard_other_database_access');
  if (Number((await client.query("SELECT count(*) AS n FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname NOT IN ('public','information_schema')")).rows[0].n)) reject('gateway_guard_extra_schema');
  if (Number((await client.query("SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')")).rows[0].n)) reject('gateway_guard_security_definer');
  const relations = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,
    pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
    has_table_privilege(current_user,c.oid,'SELECT') AS readable,
    has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
      WHERE acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user))
      AND (acl.privilege_type<>'SELECT' OR acl.is_grantable)) AS unsafe_acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')`)).rows;
  const allowed = new Set([...TABLES, 'reap_rehearsal_guard_manifest']);
  if (relations.some((r) => r.writable || r.unsafe_acl || (r.readable && (r.schema !== 'public' || !allowed.has(r.name)))
    || (allowed.has(r.name) && (r.owner !== target.owner || r.kind !== 'r' || r.rls || r.force_rls || !r.readable)))
    || [...allowed].some((name) => !relations.some((r) => r.schema === 'public' && r.name === name))) reject('gateway_guard_relation_privileges');
  // Privilege-name inspection is version-safe (including PG17 MAINTAIN),
  // unlike asking PG15 to parse a later-version privilege string.
  const columnAcls = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,
    acl.privilege_type,acl.is_grantable FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
    AND acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user))`)).rows;
  if (columnAcls.some((acl) => acl.schema !== 'public' || !allowed.has(acl.name)
    || acl.privilege_type !== 'SELECT' || acl.is_grantable)) reject('gateway_guard_column_acl');
  const sequences = (await client.query(`SELECT pg_get_userbyid(c.relowner) AS owner,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('s',c.relowner))) acl
      WHERE acl.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname=current_user))) AS accessible
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind='S'`)).rows;
  if (sequences.some((s) => s.owner !== target.owner || s.accessible)) reject('gateway_guard_sequence_acl');
  const columns = (await client.query(`SELECT c.relname AS table_name,a.attname AS column_name,
    format_type(a.atttypid,a.atttypmod) AS formatted_type,
    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped`, [TABLES])).rows;
  const canonical = (rows) => rows.map((r) => [r.table_name,r.column_name,r.formatted_type,r.is_nullable].join('\0')).sort();
  if (JSON.stringify(canonical(columns)) !== JSON.stringify(canonical(schema))) reject('gateway_guard_catalog_schema');
  const marker = (await client.query('SELECT fixture_id,source_base_commit,stage FROM public.reap_rehearsal_guard_manifest')).rows;
  if (marker.length !== 1 || marker[0].fixture_id !== target.fixture || marker[0].source_base_commit !== target.backendSource
    || !['prepared','owned'].includes(marker[0].stage)) reject('gateway_guard_marker');
  return { database: target.database, host: target.host, port: target.port, actor: target.actor,
    catalog_tables: TABLES.length, catalog_columns: schema.length, preparation_only: true };
}
async function runGuard({ env = process.env, target = TARGET, Client } = {}) {
  validateEnvironment(env); const dsn = validateDsn(env.DATABASE_URL, target);
  const PgClient = Client || require('pg').Client; // only after local config rejection
  const client = new PgClient({ connectionString: dsn, connectionTimeoutMillis: 3000, query_timeout: 3000 });
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    const receipt = await validateConnection(client, target);
    await client.query('ROLLBACK'); return receipt;
  } catch (error) {
    if (String(error?.code || '').startsWith('gateway_guard_')) throw error;
    reject('gateway_guard_database_probe');
  } finally { await client.end().catch(() => {}); }
}
module.exports = { TARGET, TABLES, REQUIRED, validateEnvironment, validateDsn, validateConnection, runGuard };
