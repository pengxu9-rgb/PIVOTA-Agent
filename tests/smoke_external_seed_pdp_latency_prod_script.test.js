const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_err) {
        resolve({});
      }
    });
  });
}

function createSuccessBody({ operation, commit, similarCount }) {
  if (operation === 'find_similar_products') {
    return {
      status: 'success',
      products: Array.from({ length: similarCount }, (_, index) => ({
        product_id: `sim_${index + 1}`,
        merchant_id: 'external_seed',
        title: `Similar ${index + 1}`,
      })),
      metadata: {
        service_version: { commit },
        underfill: 0,
      },
    };
  }
  return {
    status: 'success',
    metadata: {
      service_version: { commit },
    },
  };
}

describe('external seed PDP latency prod smoke script', () => {
  test('passes healthy external PDP latency samples and writes a report file', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'smoke_external_seed_pdp_latency_prod.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-pdp-latency-pass-'));
    const casesFile = path.join(tmpDir, 'cases.json');
    const reportFile = path.join(tmpDir, 'report.json');

    fs.writeFileSync(
      casesFile,
      JSON.stringify(
        {
          rounds: 2,
          timeout_ms: 5000,
          thresholds: {
            cold_pdp_max_ms: 250,
            warm_pdp_max_ms: 120,
            cold_similar_max_ms: 250,
            warm_similar_max_ms: 150,
            min_similar_count: 4,
          },
          cases: [
            {
              key: 'ext_case',
              merchant_id: 'external_seed',
              product_id: 'ext_case',
              title: 'Latency Gate Sample',
            },
          ],
        },
        null,
        2,
      ),
    );

    const counters = { get_pdp_v2: 0, find_similar_products: 0 };
    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      const operation = body?.operation;
      counters[operation] = (counters[operation] || 0) + 1;
      const round = counters[operation];
      const delayMs =
        operation === 'get_pdp_v2'
          ? round === 1
            ? 80
            : 25
          : round === 1
            ? 90
            : 40;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(createSuccessBody({ operation, commit: 'abc123', similarCount: 5 })));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    try {
      const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--cases-file', casesFile, '--report-file', reportFile], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PDP_EXTERNAL_LATENCY_GATEWAY: `http://127.0.0.1:${address.port}`,
        },
      });
      const report = JSON.parse(String(stdout || '').trim());
      const persisted = JSON.parse(fs.readFileSync(reportFile, 'utf8'));

      expect(report.ok).toBe(true);
      expect(report.summary.stable_commit).toBe('abc123');
      expect(report.cases[0].rounds).toHaveLength(2);
      expect(report.cases[0].rounds[1].similar.similar_count).toBe(5);
      expect(persisted.ok).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('fails when warm similar latency exceeds the configured threshold', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'smoke_external_seed_pdp_latency_prod.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-pdp-latency-fail-'));
    const casesFile = path.join(tmpDir, 'cases.json');

    fs.writeFileSync(
      casesFile,
      JSON.stringify(
        {
          rounds: 2,
          timeout_ms: 5000,
          thresholds: {
            cold_pdp_max_ms: 250,
            warm_pdp_max_ms: 120,
            cold_similar_max_ms: 250,
            warm_similar_max_ms: 120,
            min_similar_count: 4,
          },
          cases: [
            {
              key: 'ext_case',
              merchant_id: 'external_seed',
              product_id: 'ext_case',
            },
          ],
        },
        null,
        2,
      ),
    );

    const counters = { get_pdp_v2: 0, find_similar_products: 0 };
    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      const operation = body?.operation;
      counters[operation] = (counters[operation] || 0) + 1;
      const round = counters[operation];
      const delayMs =
        operation === 'find_similar_products' && round === 2 ? 180 : 30;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(createSuccessBody({ operation, commit: 'abc123', similarCount: 5 })));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    try {
      await expect(
        execFileAsync(process.execPath, [scriptPath, '--cases-file', casesFile], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PDP_EXTERNAL_LATENCY_GATEWAY: `http://127.0.0.1:${address.port}`,
          },
        }),
      ).rejects.toMatchObject({
        stdout: expect.stringContaining('"ok": false'),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
