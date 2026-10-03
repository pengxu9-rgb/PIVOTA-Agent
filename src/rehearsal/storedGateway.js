'use strict';
// Dedicated preparation entrypoint. Never use the ordinary production command.
function assertNoDotenv({ cwd = process.cwd(), sourceRoot = require('path').resolve(__dirname, '../..') } = {}) {
  const fs = require('fs'), path = require('path');
  if ([cwd,sourceRoot].some((root) => ['.env','.env.vault'].some((name) => fs.existsSync(path.join(root,name))))) throw new Error('gateway_guard_dotenv_file');
}
function lockCriticalEnvironment(env, policyFlags = []) {
  const critical = (key) => key === 'DATABASE_URL' || key === 'PIVOTA_API_BASE' || key === 'PIVOTA_API_KEY'
    || Object.hasOwn(require('./catalogTargetGuard').REQUIRED, key) || key === 'PORT' || key === 'GOOGLE_CLOUD_PROJECT' || key === 'PIVOTA_ENV' || policyFlags.includes(key)
    || /^(?:PG|AGENT_|IDENTITY_|MCP_OAUTH_|REAP_|GATEWAY_)/.test(key);
  return new Proxy(env, {
    set(target,key,value) { if (critical(String(key)) && String(target[key]) !== String(value)) throw new Error('gateway_guard_config_changed'); return Reflect.set(target,key,value,target); },
    deleteProperty(target,key) { if (critical(String(key)) && Object.hasOwn(target,key)) throw new Error('gateway_guard_config_changed'); return Reflect.deleteProperty(target,key); },
    defineProperty(target,key,descriptor) { if (critical(String(key))) throw new Error('gateway_guard_config_changed'); return Reflect.defineProperty(target,key,descriptor); },
  });
}
async function start({ env = process.env, loadServer = () => require('../server'), guard } = {}) {
  assertNoDotenv();
  if (Object.keys(env).some((key) => /^DOTENV/.test(key) && env[key])) throw new Error('gateway_guard_dotenv_config');
  const { runGuard, validateEnvironment } = require('./catalogTargetGuard');
  const receipt = await (guard || runGuard)({ env }); // before app/logger/pool/migrations
  // The separately reviewed stored-catalog policy must be present in the
  // combined candidate. Missing dependency refuses launch, never relaxes it.
  const { assertStoredCatalogRehearsal, DISABLED_FLAGS, REQUIRED_TRUE_FLAGS = [], REMOTE_INDEX_CONFIG = [] } = require('../config/storedCatalogRehearsal');
  assertStoredCatalogRehearsal(env);
  const dsn = env.DATABASE_URL;
  if (env === process.env) process.env = lockCriticalEnvironment(env, [...DISABLED_FLAGS, ...REQUIRED_TRUE_FLAGS, ...REMOTE_INDEX_CONFIG]);
  const app = loadServer();
  validateEnvironment(env); assertStoredCatalogRehearsal(env);
  if (env.DATABASE_URL !== dsn) throw new Error('gateway_guard_config_changed');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('gateway_guard_port');
  return { receipt, server: app.listen(port, '0.0.0.0') };
}
if (require.main === module) start().catch(() => {
  // Do not print a driver/import exception which may contain credentials.
  process.stderr.write('gateway preparation guard rejected\n'); process.exitCode = 2;
});
module.exports = { start, assertNoDotenv, lockCriticalEnvironment };
