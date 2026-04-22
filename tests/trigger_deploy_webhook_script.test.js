const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

describe('trigger_deploy_webhook.sh', () => {
  test('posts the expected deployment payload', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'trigger_deploy_webhook.sh');
    let receivedMethod = null;
    let receivedBody = null;

    const server = http.createServer(async (req, res) => {
      receivedMethod = req.method;
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      receivedBody = Buffer.concat(chunks).toString('utf8');
      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const webhookUrl = `http://127.0.0.1:${port}/deploy`;

    try {
      const { stdout } = await execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEPLOY_WEBHOOK_URL: webhookUrl,
          DEPLOY_REASON: 'github_push_main_promote',
          TARGET_SHA: 'abc123def456',
          TARGET_REF: 'refs/heads/main',
          TARGET_REPOSITORY: 'pengxu9-rgb/PIVOTA-Agent',
          TRIGGER_RUN_URL: 'https://github.com/pengxu9-rgb/PIVOTA-Agent/actions/runs/1',
          TRIGGER_ACTOR: 'codex',
        },
      });

      expect(stdout).toContain('PASS: production deploy webhook triggered.');
      expect(receivedMethod).toBe('POST');
      expect(JSON.parse(receivedBody)).toEqual({
        reason: 'github_push_main_promote',
        sha: 'abc123def456',
        ref: 'refs/heads/main',
        repository: 'pengxu9-rgb/PIVOTA-Agent',
        run_url: 'https://github.com/pengxu9-rgb/PIVOTA-Agent/actions/runs/1',
        actor: 'codex',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('fails loudly when deploy webhook URL is missing', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'trigger_deploy_webhook.sh');

    await expect(
      execFileAsync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          DEPLOY_WEBHOOK_URL: '',
          RAILWAY_PRODUCTION_DEPLOY_WEBHOOK_URL: '',
          PIVOTA_AGENT_PROD_DEPLOY_WEBHOOK_URL: '',
          RAILWAY_DEPLOY_WEBHOOK_URL: '',
        },
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('ERROR: production deploy webhook URL is not configured.'),
    });
  });
});
