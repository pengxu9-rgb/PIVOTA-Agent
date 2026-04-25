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

function beautyResponse(body) {
  const query = String(body?.payload?.search?.query || '').toLowerCase();
  const creator = String(body?.metadata?.source || '') === 'creator_agent';
  const guided = query.includes('what should i use for my skin');
  if (guided) {
    return {
      layer: 'orchestration',
      reply:
        'I need more context before narrowing products: skin type, current routine, climate, budget, and whether a skin analysis is available.',
      products: [],
      beauty_expert_v1: {
        contract_version: 'beauty_expert_v1',
        mode: 'guided_beauty_reco',
        reco_bundle: { lead_picks: [], support_picks: [] },
        compare_axes: [],
        next_actions: [{ type: 'consider_skin_analysis' }, { type: 'ask_missing_constraint' }],
        delegation_trace: { entry_layer: 'orchestration', delegated_layer: 'decisioning' },
        beauty_intent: { domain: 'beauty' },
      },
    };
  }
  const sunscreen = query.includes('sunscreen') || query.includes('spf');
  const products = sunscreen
    ? [
        {
          title: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
          why_this_one: 'Lighter serum-like sunscreen direction for oily skin under makeup.',
        },
        {
          title: 'Supergoop! Unseen Sunscreen SPF 40',
          why_this_one: 'Clear primer-like finish, but at a higher price.',
        },
        {
          title: 'SKIN1004 Hyalu-Cica Water-Fit Sun Serum SPF50+ PA++++',
          why_this_one: 'More hydrating and dewier if oily skin also feels dehydrated.',
        },
      ]
    : [
        {
          title: 'First Aid Beauty Ultra Repair Face Lotion with Colloidal Oatmeal',
          why_this_one: 'Comfort-led lotion direction for sensitive or tight-feeling skin.',
        },
        {
          title: 'Vanicream Daily Facial Moisturizer',
          why_this_one: 'Lower-cost fragrance-free moisturizer direction.',
        },
        {
          title: 'KraveBeauty Great Barrier Relief',
          why_this_one: 'Barrier-supporting serum-lotion texture for retinoid-stressed skin.',
        },
      ];
  return {
    layer: 'orchestration',
    reply: creator
      ? `${products[0].title} is the creator lead because it gives a clear audience angle. Compared with it, ${products[1].title} is the tradeoff option while ${products[2].title} gives a different content angle.`
      : `${products[0].title} is the lead because it fits the stated scenario. Compared with it, ${products[1].title} is the tradeoff option while ${products[2].title} covers a different use case.`,
    products,
    beauty_expert_v1: {
      contract_version: 'beauty_expert_v1',
      mode: 'category_compare',
      reco_bundle: {
        lead_picks: [products[0]],
        support_picks: products.slice(1),
      },
      compare_axes: [{ label: 'finish / texture' }, { label: 'price / value' }],
      next_actions: [{ type: 'compare_same_type' }, { type: 'show_alternatives' }],
      delegation_trace: { entry_layer: 'orchestration', delegated_layer: 'decisioning' },
      beauty_intent: body?.payload?.context?.normalized_need?.beauty_request || { domain: 'beauty' },
    },
  };
}

describe('Celestial commerce beauty cross-agent multi-turn live runner', () => {
  test('runs multi-turn invoke scenarios and records actual outputs', async () => {
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'run_celestial_commerce_core_beauty_cross_agent_multiturn_live.js',
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beauty-cross-agent-multiturn-live-'));

    const server = http.createServer(async (req, res) => {
      const body = await readJsonBody(req);
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer ak_live_stage_key') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
        return;
      }
      if (req.url !== '/agent/shop/v1/invoke' && req.url !== '/agent/creator/v1/invoke') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
        return;
      }
      const isBeauty = body?.metadata?.beauty_domain_hint === 'beauty';
      if (isBeauty) {
        res.statusCode = 200;
        res.end(JSON.stringify(beautyResponse(body)));
        return;
      }
      const query = String(body?.payload?.search?.query || '').toLowerCase();
      const products = query.includes('camera')
        ? [{ title: 'Sony ZV-E10 Mirrorless Camera', why_this_one: 'Beginner-friendly creator camera.' }]
        : [{ title: 'Lightweight Hardshell Carry-On Suitcase', why_this_one: 'Carry-on option under budget.' }];
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          layer: 'decisioning',
          reply: `${products[0].title} matches the non-beauty request.`,
          products,
        }),
      );
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          scriptPath,
          '--base-url',
          baseUrl,
          '--out-dir',
          outDir,
          '--rounds',
          '1',
          '--timeout-ms',
          '5000',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            STAGING_AUTH_TOKEN: 'ak_live_stage_key',
          },
        },
      );

      const payload = JSON.parse(String(stdout || '').trim());
      const report = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

      expect(payload.ok).toBe(true);
      expect(report.summary.total_runs).toBe(7);
      expect(report.summary.total_turns).toBe(19);
      expect(report.summary.failed_turns).toBe(0);
      expect(report.summary.failure_buckets).toEqual({});
      expect(fs.readFileSync(payload.markdown_path, 'utf8')).toContain('Actual Outputs');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
