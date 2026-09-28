'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateCrawlManifest } = require('../src/services/commerceIndexCrawlManifest');

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : '';
  return value && !value.startsWith('--') ? value : '';
}

function usage() {
  return 'Usage: node scripts/validate-commerce-index-crawl-manifest.js --manifest <manifest.json>';
}

function main(argv = process.argv.slice(2)) {
  const manifestPath = argValue(argv, 'manifest');
  if (!manifestPath) throw new Error(usage());
  const absolutePath = path.resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read crawl manifest: ${error.message}`);
  }
  const result = validateCrawlManifest(manifest);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { argValue, main, usage };
