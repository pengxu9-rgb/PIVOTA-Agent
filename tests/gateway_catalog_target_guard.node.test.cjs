'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const guard = require('../src/rehearsal/catalogTargetGuard');
const { start } = require('../src/rehearsal/storedGateway');
function safeEnv() { return { ...guard.REQUIRED,
  DATABASE_URL: `postgresql://${guard.TARGET.actor}:synthetic@${guard.TARGET.host}:${guard.TARGET.port}/${guard.TARGET.database}`,
  REAP_GATEWAY_DATABASE_SECRET_REFERENCE: 'projects/pivota-staging/secrets/reap-rehearsal-20261002-01a0f-catalog-dsn/versions/1' }; }
for (const [field, value] of [['host','127.0.0.1'],['database','pivota'],['database','prod'],['actor','postgres'],['port','5433']]) {
  test(`DSN refuses alternate ${field}:${value}`, () => {
    assert.throws(() => guard.validateDsn(safeEnv().DATABASE_URL.replace(String(guard.TARGET[field]), value)), /^Error: gateway_guard_target$/);
  });
}
for (const suffix of ['?options=-crole=postgres','?host=elsewhere','#x','?',' ','\n']) {
  test(`DSN refuses options/whitespace ${JSON.stringify(suffix)}`, () => assert.throws(() => guard.validateDsn(safeEnv().DATABASE_URL + suffix), /gateway_guard_dsn/));
}
for (const name of Object.keys(guard.REQUIRED)) {
  test(`startup requires explicit ${name}`, () => {
    const env = safeEnv(); delete env[name]; assert.throws(() => guard.validateEnvironment(env), /gateway_guard_flags/);
  });
}
test('numeric secret version and ambient PG redirects refuse before driver construction', async () => {
  for (const version of ['latest','0','01','-1','1?x']) {
    const env = safeEnv(); env.REAP_GATEWAY_DATABASE_SECRET_REFERENCE = env.REAP_GATEWAY_DATABASE_SECRET_REFERENCE.replace('/1',`/${version}`);
    await assert.rejects(guard.runGuard({ env, Client: class { constructor() { throw Error('driver must not load'); } } }), /gateway_guard_numeric_secret/);
  }
  assert.throws(() => guard.validateEnvironment({ ...safeEnv(), PGHOST: 'foreign' }), /gateway_guard_ambient_pg/);
});
test('actual wrapper cannot import server or migrations after target refusal', async () => {
  let imported = false;
  await assert.rejects(start({ env: { ...safeEnv(), DATABASE_URL: safeEnv().DATABASE_URL.replace(guard.TARGET.database,'pivota') }, loadServer() { imported = true; } }), /gateway_guard_target/);
  assert.equal(imported,false);
  const child = spawnSync(process.execPath,['src/rehearsal/storedGateway.js'],{cwd:require('path').join(__dirname,'..'),env:{PATH:process.env.PATH,...safeEnv(),DATABASE_URL:'postgresql://password-must-not-log@bad'},encoding:'utf8',timeout:3000});
  assert.equal(child.status,2); assert.equal(child.stdout,''); assert.match(child.stderr,/gateway preparation guard rejected/); assert.doesNotMatch(child.stderr,/password-must-not-log/);
});


test('both cwd and package dotenv files refuse before app import; critical bindings cannot mutate', () => {
  const fs=require('fs'),os=require('os'),path=require('path');
  const {assertNoDotenv,lockCriticalEnvironment}=require('../src/rehearsal/storedGateway');
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'reap-cwd-')),source=fs.mkdtempSync(path.join(os.tmpdir(),'reap-src-'));
  try {
    fs.writeFileSync(path.join(cwd,'.env'),'DATABASE_URL=must-not-load');
    assert.throws(()=>assertNoDotenv({cwd,sourceRoot:source}),/gateway_guard_dotenv_file/);
    fs.unlinkSync(path.join(cwd,'.env'));fs.writeFileSync(path.join(source,'.env'),'PGHOST=must-not-load');
    assert.throws(()=>assertNoDotenv({cwd,sourceRoot:source}),/gateway_guard_dotenv_file/);
  } finally {fs.rmSync(cwd,{recursive:true});fs.rmSync(source,{recursive:true});}
  const locked=lockCriticalEnvironment({...safeEnv(),GATEWAY_BACKEND_ID_TOKEN_AUDIENCE:'original',AGENT_AUTH_INTROSPECT_INTERNAL_KEY:'synthetic'},['PDP_CORE_PREWARM_ENABLED','CATALOG_SERVING_INDEX_BASE_URL','CATALOG_SERVING_BASE_URL']);
  for (const [key,value] of [['DATABASE_URL','foreign'],['REAP_GATEWAY_DATABASE_SECRET_REFERENCE','other'],['PGHOST','foreign'],['GATEWAY_BACKEND_ID_TOKEN_AUDIENCE','other'],['AGENT_AUTH_INTROSPECT_INTERNAL_KEY','other'],['PDP_CORE_PREWARM_ENABLED','true'],['SEARCH_BUDGET_REQUIRE_MARKER','false'],['CATALOG_SERVING_INDEX_BASE_URL','https://remote.invalid'],['CATALOG_SERVING_BASE_URL','https://remote.invalid']]) assert.throws(()=>{locked[key]=value;},/gateway_guard_config_changed/);
  assert.throws(()=>{delete locked.DATABASE_URL;},/gateway_guard_config_changed/);
  locked.DATABASE_URL=locked.DATABASE_URL;
});
