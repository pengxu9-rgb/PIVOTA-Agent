const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

describe('verify_deployed_commit_matches.sh', () => {
  test('authoritative_commerce probes INVOKE_BASE_URL even when BASE_URL is a public domain', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'verify_deployed_commit_matches.sh');
    const targetCommit = 'abc123def456';

    const publicServer = http.createServer(async (_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    const invokeServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/version') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            service: 'PIVOTA-Agent',
            commit: targetCommit,
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise((resolve) => publicServer.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => invokeServer.listen(0, '127.0.0.1', resolve));
    const publicAddress = publicServer.address();
    const invokeAddress = invokeServer.address();
    const publicBaseUrl = `http://127.0.0.1:${publicAddress.port}`;
    const invokeBaseUrl = `http://127.0.0.1:${invokeAddress.port}`;

    try {
      const { stdout } = await execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          RAIL_MODE: 'authoritative_commerce',
          BASE_URL: publicBaseUrl,
          INVOKE_BASE_URL: invokeBaseUrl,
          TARGET_COMMIT: targetCommit,
          MAX_ATTEMPTS: '1',
          SLEEP_SECONDS: '0',
        },
      });

      expect(stdout).toContain(`PROBE_BASE_URL=${invokeBaseUrl}`);
      expect(stdout).toContain(`deployed_commit=${targetCommit}`);
      expect(stdout).toContain(`via=version:${invokeBaseUrl}/version`);
    } finally {
      await new Promise((resolve) => publicServer.close(resolve));
      await new Promise((resolve) => invokeServer.close(resolve));
    }
  });

  test('passes when /version exposes commit', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'verify_deployed_commit_matches.sh');
    const targetCommit = 'abc123def456';

    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/version') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            service: 'PIVOTA-Agent',
            commit: targetCommit,
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

  test('falls back to /healthz.version.commit when /version is unavailable', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'verify_deployed_commit_matches.sh');
    const targetCommit = 'abc123def456';

    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/version') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      if (req.method === 'GET' && req.url === '/healthz') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            version: {
              commit: targetCommit,
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
          TARGET_COMMIT: targetCommit,
          MAX_ATTEMPTS: '1',
          SLEEP_SECONDS: '0',
        },
      });

      expect(stdout).toContain(`deployed_commit=${targetCommit}`);
      expect(stdout).toContain(`via=health:${baseUrl}/healthz`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('fails when neither /version nor /healthz exposes commit', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'verify_deployed_commit_matches.sh');
    const targetCommit = 'abc123def456';

    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && (req.url === '/version' || req.url === '/healthz')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
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
