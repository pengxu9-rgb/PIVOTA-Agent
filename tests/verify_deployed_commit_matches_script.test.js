const http = require('http');
const path = require('path');
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
      } catch (_error) {
        resolve({});
      }
    });
  });
}

describe('verify_deployed_commit_matches.sh', () => {
  test('passes when invoke body exposes metadata.service_version.commit', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'verify_deployed_commit_matches.sh');
    const targetCommit = 'abc123def456';

    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/agent/shop/v1/invoke') {
        const body = await readJsonBody(req);
        if (req.headers['x-agent-api-key'] !== 'test-key') {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
          return;
        }
        expect(body?.operation).toBe('find_products_multi');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            products: [{ title: 'Test Serum' }],
            metadata: {
              service_version: {
                commit: targetCommit,
              },
            },
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          INVOKE_BASE_URL: baseUrl,
          GATEWAY_ENDPOINT: '',
          ALT_GATEWAY_ENDPOINT: '/agent/shop/v1/invoke',
          AGENT_API_KEY: 'test-key',
          TARGET_COMMIT: targetCommit,
          MAX_ATTEMPTS: '1',
          SLEEP_SECONDS: '0',
        },
      });

      expect(stdout).toContain(`deployed_commit=${targetCommit}`);
      expect(stdout).toContain('PASS: deployed commit matches target.');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('fails when invoke body omits metadata.service_version.commit even if same-host header matches', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'verify_deployed_commit_matches.sh');
    const targetCommit = 'abc123def456';

    const server = http.createServer(async (req, res) => {
      if (req.method === 'HEAD' && req.url === '/') {
        res.statusCode = 200;
        res.setHeader('X-Service-Commit', targetCommit);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/agent/shop/v1/invoke') {
        await readJsonBody(req);
        if (req.headers['x-agent-api-key'] !== 'test-key') {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            products: [{ title: 'Test Serum' }],
            metadata: {},
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await expect(
        execFileAsync('bash', [scriptPath], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            BASE_URL: baseUrl,
            INVOKE_BASE_URL: baseUrl,
            GATEWAY_ENDPOINT: '',
            ALT_GATEWAY_ENDPOINT: '/agent/shop/v1/invoke',
            AGENT_API_KEY: 'test-key',
            TARGET_COMMIT: targetCommit,
            MAX_ATTEMPTS: '1',
            SLEEP_SECONDS: '0',
          },
        }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('deployed_commit=missing'),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
