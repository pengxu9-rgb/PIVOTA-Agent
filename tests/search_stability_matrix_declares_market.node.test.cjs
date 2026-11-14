'use strict';

// THE SEARCH STABILITY MATRIX IS A SYNTHETIC BUYER AND SAYS SO. Every find_products_multi it
// sends carries `metadata.market` (the gate's declared market, or the case's own) and
// `metadata.invoked_by`, so the purchasability gate has a market to decide on and the census
// never reads this gate as a market-less buyer (2026-10-09: it WAS the market-less majority).
// Runs the real script as a child process against a local server that records the bodies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'search_stability_matrix.js');

function runMatrix({ cases, env = {}, responseFor = () => ({ ok: true, data: { products: [] } }), failOnGateFailures = false }) {
  return new Promise((resolve, reject) => {
    const bodies = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        bodies.push({ path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseFor(body)));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-market-'));
      const queryFile = path.join(dir, 'cases.json');
      fs.writeFileSync(queryFile, JSON.stringify(cases));
      execFile(
        process.execPath,
        [SCRIPT, '--base-url', `http://127.0.0.1:${server.address().port}`, '--rounds', '1',
          '--query-file', queryFile, '--out-dir', dir, '--agent-api-key', 'test_key', '--timeout-ms', '5000',
          ...(failOnGateFailures ? ['--fail-on-gate-failures'] : [])],
        {
          cwd: REPO,
          env: {
            ...process.env,
            NO_PROXY: '*', no_proxy: '*', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
            SEARCH_MATRIX_RAIL_MODE: 'authoritative_commerce',
            ...env,
          },
          timeout: 60000,
        },
        (error, stdout, stderr) => {
          server.close();
          if (error) {
            const reportPath = fs.readdirSync(dir).find((file) => file.startsWith('search_stability_matrix_') && file.endsWith('.md'));
            const report = reportPath ? fs.readFileSync(path.join(dir, reportPath), 'utf8') : '';
            return reject(new Error(`${error.message}\n${stdout}\n${stderr}\n${report}`));
          }
          resolve(bodies);
        },
      );
    });
  });
}

const CASES = [
  'niacinamide serum',
  { id: 'jp_pack', query: 'IPSA Time Reset Aqua', request_metadata: { market: 'jp' } },
  { id: 'blank_market', query: 'Winona products', request_metadata: { market: '' } },
];

test('every request names the gate market unless the case names its own; invoked_by is set', async () => {
  const bodies = await runMatrix({ cases: CASES, env: { SEARCH_MATRIX_MARKET: 'us' } });
  const fpm = bodies.filter((b) => b.body && b.body.operation === 'find_products_multi');
  assert.equal(fpm.length, CASES.length, `one find_products_multi per case: ${JSON.stringify(bodies.map((b) => b.body.operation))}`);
  const byQuery = Object.fromEntries(fpm.map((b) => [b.body.payload.search.query, b.body.metadata]));
  assert.equal(byQuery['niacinamide serum'].market, 'US');
  assert.equal(byQuery['IPSA Time Reset Aqua'].market, 'JP', 'the case market wins over the gate market, upper-cased');
  assert.equal(byQuery['Winona products'].market, 'US', 'a blank case market is not a market');
  for (const meta of Object.values(byQuery)) {
    assert.equal(meta.invoked_by, 'ci:search_stability_matrix');
    assert.equal(meta.source, 'shopping_agent', 'source stays the behaviour profile');
  }
});

test('the environment names the gate market and who the gate is; blank env means the US catalogue', async () => {
  const sg = await runMatrix({ cases: ['niacinamide serum'], env: { SEARCH_MATRIX_MARKET: 'sg', SEARCH_MATRIX_INVOKED_BY: 'ci:nightly' } });
  const sgFpm = sg.filter((b) => b.body.operation === 'find_products_multi');
  assert.equal(sgFpm.length, 1);
  assert.equal(sgFpm[0].body.metadata.market, 'SG');
  assert.equal(sgFpm[0].body.metadata.invoked_by, 'ci:nightly');

  const blank = await runMatrix({ cases: ['niacinamide serum'], env: { SEARCH_MATRIX_MARKET: '', SEARCH_MATRIX_INVOKED_BY: '' } });
  const blankFpm = blank.filter((b) => b.body.operation === 'find_products_multi');
  assert.equal(blankFpm[0].body.metadata.market, 'US');
  assert.equal(blankFpm[0].body.metadata.invoked_by, 'ci:search_stability_matrix');
});

test('a currency-scoped result rejects a foreign currency or a missing currency on any offer', async () => {
  const runWithOffers = (products) => runMatrix({
    cases: [{ id: 'us_browse', query: 'serum', expected_offer_currency: 'USD', require_primary_path: false }],
    responseFor: () => ({ products }),
    failOnGateFailures: true,
  });

  await runWithOffers([{ title: 'First serum', currency: 'USD' }, { title: 'Second serum', currency: 'USD' }]);
  await assert.rejects(
    runWithOffers([{ title: 'First serum', currency: 'USD' }, { title: 'Second serum', currency: 'EUR' }]),
    /offer_currency_mismatch:expected=USD:actual=EUR:count=1/,
  );
  await assert.rejects(
    runWithOffers([{ title: 'First serum', currency: 'USD' }, { title: 'Second serum' }]),
    /offer_currency_mismatch:expected=USD:actual=missing:count=1/,
  );
});
