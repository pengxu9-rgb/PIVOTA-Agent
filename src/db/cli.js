const logger = require('../logger');
const { runMigrations } = require('./migrate');
const { runSeeds } = require('./seed');

async function main() {
  const cmd = process.argv[2] || 'migrate';
  if (cmd !== 'migrate' && cmd !== 'seed' && cmd !== 'all') {
    throw new Error(`Unknown command: ${cmd} (expected: migrate|seed|all)`);
  }

  if (cmd === 'migrate' || cmd === 'all') {
    logger.info('Running DB migrations...');
    await runMigrations();
    logger.info('DB migrations complete.');
  }

  if (cmd === 'seed' || cmd === 'all') {
    logger.info('Running DB seeds...');
    await runSeeds();
    logger.info('DB seeds complete.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err.message }, 'DB CLI failed');
    process.exit(1);
  });

