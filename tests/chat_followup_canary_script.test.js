const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function buildMetricsBody({ catalog = 0, repeatedSkinType = 0, claims = 0 } = {}) {
  return [
    `catalog_availability_shortcircuit_total ${catalog}`,
    `repeated_clarify_field_total{field="skinType"} ${repeatedSkinType}`,
    `claims_violation_total ${claims}`,
  ].join('\n');
}

function createCanaryServer({ chatPayload, chatResponses, metricsBodies }) {
  let metricsIndex = 0;
  let chatIndex = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      const body = metricsBodies[Math.min(metricsIndex, metricsBodies.length - 1)] || '';
      metricsIndex += 1;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat') {
      const responseConfig = Array.isArray(chatResponses)
        ? chatResponses[Math.min(chatIndex, chatResponses.length - 1)] || {}
        : { status: 200, payload: chatPayload };
      chatIndex += 1;
      res.statusCode = Number(responseConfig.status || 200);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responseConfig.payload || {}));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return server;
}

async function runCanary(server) {
  const repoRoot = path.join(__dirname, '..');
  const scriptPath = path.join(repoRoot, 'scripts', 'chat_followup_canary.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-followup-canary-'));
  const reportPath = path.join(tmpDir, 'report.md');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const { stdout } = await execFileAsync('node', [scriptPath, '--base', baseUrl, '--uid', 'test-canary', '--out', reportPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return {
      summary: JSON.parse(stdout.trim()),
      report: fs.readFileSync(reportPath, 'utf8'),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('chat_followup_canary.mjs', () => {
  test('passes when follow-up returns grounded recommendations', async () => {
    const server = createCanaryServer({
      metricsBodies: [
        buildMetricsBody({ catalog: 10, repeatedSkinType: 4, claims: 0 }),
        buildMetricsBody({ catalog: 11, repeatedSkinType: 4, claims: 0 }),
      ],
      chatPayload: {
        assistant_message: { content: '有，这里有几款薇诺娜产品。' },
        cards: [
          {
            type: 'recommendations',
            payload: {
              recommendations: [
                { product_id: 'winona_1' },
                { product_id: 'winona_2' },
              ],
            },
          },
        ],
      },
    });

    const result = await runCanary(server);
    expect(result.summary.pass).toBe(true);
    expect(result.summary.card_checks.has_recommendations).toBe(true);
    expect(result.summary.card_checks.recommendations_count).toBe(2);
    expect(result.summary.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'cards_include_grounded_product_results',
          pass: true,
        }),
      ]),
    );
    expect(result.report).toContain('- has_recommendations: true');
    expect(result.report).toContain('- recommendations_count: 2');
  });

  test('passes when legacy product_parse + offers_resolved path is returned', async () => {
    const server = createCanaryServer({
      metricsBodies: [
        buildMetricsBody({ catalog: 20, repeatedSkinType: 1, claims: 0 }),
        buildMetricsBody({ catalog: 21, repeatedSkinType: 1, claims: 0 }),
      ],
      chatPayload: {
        assistant_message: { content: '找到薇诺娜相关商品。' },
        cards: [
          { type: 'product_parse', payload: { query: '薇诺娜' } },
          { type: 'offers_resolved', payload: { offers: [{ product_id: 'winona_legacy' }] } },
        ],
      },
    });

    const result = await runCanary(server);
    expect(result.summary.pass).toBe(true);
    expect(result.summary.card_checks.has_product_parse).toBe(true);
    expect(result.summary.card_checks.has_offers_resolved).toBe(true);
    expect(result.summary.card_checks.recommendations_count).toBe(0);
  });

  test('retries transient 429 responses and passes once grounded recommendations arrive', async () => {
    const server = createCanaryServer({
      metricsBodies: [
        buildMetricsBody({ catalog: 30, repeatedSkinType: 0, claims: 0 }),
        buildMetricsBody({ catalog: 31, repeatedSkinType: 0, claims: 0 }),
      ],
      chatResponses: [
        {
          status: 429,
          payload: {},
        },
        {
          status: 200,
          payload: {
            assistant_message: { content: '有，这里有几款薇诺娜产品。' },
            cards: [
              {
                type: 'recommendations',
                payload: {
                  recommendations: [{ product_id: 'winona_retry_1' }],
                },
              },
            ],
          },
        },
      ],
    });

    const result = await runCanary(server);
    expect(result.summary.pass).toBe(true);
    expect(result.summary.request_status).toBe(200);
    expect(result.summary.request_attempts).toBe(2);
    expect(result.summary.retry_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attempt: 1, detail: 'status=429' }),
      ]),
    );
  });
});
