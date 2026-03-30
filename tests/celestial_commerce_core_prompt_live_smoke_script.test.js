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
      } catch (_error) {
        resolve({});
      }
    });
  });
}

describe('Celestial commerce-core prompt live smoke script', () => {
  test('validates prompt-intent and conversation-progress meta on /v1/chat chatcards responses', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prompt-smoke-'));
    const casesPath = path.join(outDir, 'prompt-smoke.json');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'probe_celestial_commerce_core_prompt_live_smoke.sh',
    );

    const fixture = {
      prompt_cases: [
        {
          id: 'prompt_case',
          family: 'prompt_clarify',
          request: {
            message: '有什么适合今晚约会的',
          },
          correctness: {
            expect_http_status: 200,
            min_assistant_message_length: 4,
          },
          observability: {
            must_have_paths: [
              'meta.prompt_intent',
              'meta.conversation_progress',
              'meta.early_decision',
              'meta.decision_owner',
            ],
            must_equal_paths: {
              'meta.prompt_intent': 'shopping_request',
              'meta.conversation_progress': 'new_request',
              'meta.early_decision': 'delegate_to_decisioning',
              'meta.decision_owner': 'aurora_orchestration',
            },
          },
        },
        {
          id: 'resume_case',
          family: 'conversation_progress_resume',
          request: {
            message: '约会',
            messages: [
              { role: 'user', content: '帮我买一款 serum' },
              { role: 'assistant', content: '你更偏哪种场景？' },
            ],
          },
          correctness: {
            expect_http_status: 200,
            min_assistant_message_length: 4,
          },
          observability: {
            must_equal_paths: {
              'meta.prompt_intent': 'follow_up_refinement',
              'meta.conversation_progress': 'follow_up',
              'meta.early_decision': 'resume_prior_goal',
              'meta.decision_owner': 'aurora_orchestration',
            },
          },
        },
      ],
    };
    fs.writeFileSync(casesPath, JSON.stringify(fixture, null, 2));

    const server = http.createServer(async (req, res) => {
      if (req.url !== '/v1/chat') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      const body = await readJsonBody(req);
      const content = String(body?.message || '');

      expect(String(req.headers['x-aurora-uid'] || '')).toContain('commerce_prompt_smoke_');

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      if (content === '约会') {
        res.end(
          JSON.stringify({
            assistant_text: '好的，我按约会场景继续给你筛选。',
            assistant_message: {
              role: 'assistant',
              content: '好的，我按约会场景继续给你筛选。',
            },
            meta: {
              prompt_intent: 'follow_up_refinement',
              conversation_progress: 'follow_up',
              early_decision: 'resume_prior_goal',
              decision_owner: 'aurora_orchestration',
            },
          }),
        );
        return;
      }

      res.end(
        JSON.stringify({
          assistant_text: '我先帮你理解需求，再继续推荐。',
          assistant_message: {
            role: 'assistant',
            content: '我先帮你理解需求，再继续推荐。',
          },
          meta: {
            prompt_intent: 'shopping_request',
            conversation_progress: 'new_request',
            early_decision: 'delegate_to_decisioning',
            decision_owner: 'aurora_orchestration',
          },
        }),
      );
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
          ENDPOINT: '/v1/chat',
          CASES_PATH: casesPath,
          OUT_DIR: outDir,
          TIMEOUT_MS: '5000',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
      const markdown = fs.readFileSync(payload.markdown_path, 'utf8');

      expect(payload.ok).toBe(true);
      expect(report.summary.case_count).toBe(2);
      expect(report.summary.pass_count).toBe(2);
      expect(report.summary.fail_count).toBe(0);
      expect(markdown).toContain('# Celestial Commerce Core Prompt Live Smoke');
      expect(markdown).toContain('prompt_case');
      expect(markdown).toContain('resume_case');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('retries transient prompt request failures before failing the live smoke', async () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-prompt-smoke-retry-'));
    const casesPath = path.join(outDir, 'prompt-smoke-retry.json');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'probe_celestial_commerce_core_prompt_live_smoke.sh',
    );

    fs.writeFileSync(
      casesPath,
      JSON.stringify(
        {
          prompt_cases: [
            {
              id: 'retry_case',
              family: 'prompt_clarify',
              request: {
                message: '有什么适合今晚约会的',
              },
              correctness: {
                expect_http_status: 200,
                min_assistant_message_length: 4,
              },
              observability: {
                must_equal_paths: {
                  'meta.prompt_intent': 'shopping_request',
                  'meta.conversation_progress': 'new_request',
                  'meta.early_decision': 'delegate_to_decisioning',
                  'meta.decision_owner': 'aurora_orchestration',
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    let requestCount = 0;
    const server = http.createServer(async (req, res) => {
      if (req.url !== '/v1/chat') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      await readJsonBody(req);
      requestCount += 1;

      if (requestCount === 1) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'upstream_temporarily_unavailable' }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          assistant_text: '我先帮你理解需求，再继续推荐。',
          meta: {
            prompt_intent: 'shopping_request',
            conversation_progress: 'new_request',
            early_decision: 'delegate_to_decisioning',
            decision_owner: 'aurora_orchestration',
          },
        }),
      );
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
          ENDPOINT: '/v1/chat',
          CASES_PATH: casesPath,
          OUT_DIR: outDir,
          TIMEOUT_MS: '5000',
          RETRIES: '1',
          RETRY_BACKOFF_MS: '0',
        },
      });
      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.pass_count).toBe(1);
      expect(report.results[0].attempts_used).toBe(2);
      expect(requestCount).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
