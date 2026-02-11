#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { _internals } = require('../src/services/productGroundingResolver');

function parseArgs(argv) {
  const out = { seed: 42, repeat: 200, candidates: 350, fixture: '', out: '' };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--seed' && args[i + 1]) {
      out.seed = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (a === '--repeat' && args[i + 1]) {
      out.repeat = Math.max(1, Math.min(5000, Math.trunc(Number(args[i + 1])) || out.repeat));
      i += 1;
      continue;
    }
    if (a === '--candidates' && args[i + 1]) {
      out.candidates = Math.max(10, Math.min(5000, Math.trunc(Number(args[i + 1])) || out.candidates));
      i += 1;
      continue;
    }
    if (a === '--fixture' && args[i + 1]) {
      out.fixture = String(args[i + 1]);
      i += 1;
      continue;
    }
    if (a === '--out' && args[i + 1]) {
      out.out = String(args[i + 1]);
      i += 1;
      continue;
    }
  }
  return out;
}

function makeRng(seed) {
  let s = Number.isFinite(seed) ? seed >>> 0 : 0x12345678;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick(rng, arr) {
  if (!arr.length) return null;
  return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(rng() * arr.length)))];
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const clamped = Math.max(0, Math.min(1, Number(p)));
  const idx = Math.floor((sorted.length - 1) * clamped);
  return sorted[idx];
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function loadGoldenFixture(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  const cases = Array.isArray(parsed?.cases) ? parsed.cases : [];
  const queries = cases
    .map((c) => String(c?.query || '').trim())
    .filter(Boolean)
    .slice(0, 200);
  return { cases, queries };
}

function buildSyntheticCandidates({ seed, n, goldenCases }) {
  const rng = makeRng(seed);

  const base = [];
  for (const c of goldenCases || []) {
    const cand = Array.isArray(c?.candidates) ? c.candidates : [];
    for (const p of cand) {
      if (!p || typeof p !== 'object') continue;
      const productId = String(p.product_id || p.productId || p.id || '').trim();
      const merchantId = String(p.merchant_id || p.merchantId || '').trim();
      const title = String(p.title || p.name || '').trim();
      const vendor = String(p.vendor || p.brand || '').trim();
      if (!productId || !merchantId || !title) continue;
      base.push({ product_id: productId, merchant_id: merchantId, title, vendor });
      if (base.length >= 200) break;
    }
    if (base.length >= 200) break;
  }

  if (base.length < 10) {
    base.push(
      { merchant_id: 'm_demo', product_id: 'p_demo_1', vendor: 'Winona', title: 'Winona Moisturizer 50ml' },
      { merchant_id: 'm_demo', product_id: 'p_demo_2', vendor: 'CeraVe', title: 'CeraVe Hydrating Cleanser 355ml' },
      { merchant_id: 'm_demo', product_id: 'p_demo_3', vendor: 'La Roche-Posay', title: 'La Roche-Posay Anthelios SPF50' },
      { merchant_id: 'm_demo', product_id: 'p_demo_4', vendor: 'The Ordinary', title: 'Niacinamide 10% + Zinc 1%' },
      { merchant_id: 'm_demo', product_id: 'p_demo_5', vendor: 'SK-II', title: 'Facial Treatment Essence 230ml' },
    );
  }

  const adjectives = ['Ultra', 'Gentle', 'Daily', 'Intensive', 'Light', 'Rich', 'Soothing', 'Repair', 'Barrier'];
  const suffixes = ['Gel', 'Cream', 'Lotion', 'Serum', 'Cleanser', 'Toner', 'Essence', 'SPF 50', 'Mask'];
  const sizes = ['15ml', '30ml', '50ml', '100ml', '200ml', '355ml'];

  const out = [];
  for (let i = 0; i < n; i += 1) {
    const b = pick(rng, base);
    const adj = pick(rng, adjectives);
    const suf = pick(rng, suffixes);
    const size = pick(rng, sizes);
    const id = `${b.merchant_id}::${b.product_id}::${i}`;
    const title = `${b.vendor} ${adj} ${b.title} ${suf} ${size}`.replace(/\s+/g, ' ').trim();
    out.push({
      merchant_id: b.merchant_id,
      product_id: `p_syn_${Buffer.from(id).toString('base64').replace(/[^a-z0-9]+/gi, '').slice(0, 18)}`,
      vendor: b.vendor,
      title,
    });
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const fixturePath = args.fixture
    ? path.resolve(process.cwd(), args.fixture)
    : path.resolve(__dirname, '..', 'tests', 'fixtures', 'product_grounding', 'golden_v1.json');

  const { cases, queries } = loadGoldenFixture(fixturePath);
  const candidateProducts = buildSyntheticCandidates({ seed: args.seed, n: args.candidates, goldenCases: cases });

  // Warm-up (JIT / caches)
  for (let i = 0; i < Math.min(20, queries.length); i += 1) {
    _internals.scoreAndRankCandidates({ query: queries[i], lang: 'en', products: candidateProducts, options: {} });
  }

  const durs = [];
  const startAll = nowMs();
  let ops = 0;
  for (let r = 0; r < args.repeat; r += 1) {
    for (const q of queries) {
      const t0 = nowMs();
      _internals.scoreAndRankCandidates({ query: q, lang: 'en', products: candidateProducts, options: {} });
      const t1 = nowMs();
      durs.push(t1 - t0);
      ops += 1;
    }
  }
  const totalMs = nowMs() - startAll;

  const sorted = durs.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const mean = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : 0;

  const report = {
    schema_version: 'pivota.product_grounding.bench.v1',
    ts: new Date().toISOString(),
    params: {
      seed: args.seed,
      repeat: args.repeat,
      queries: queries.length,
      candidates: candidateProducts.length,
      fixture: path.relative(process.cwd(), fixturePath),
    },
    summary: {
      n: sorted.length,
      total_ms: Number(totalMs.toFixed(3)),
      mean_ms: Number(mean.toFixed(4)),
      p50_ms: Number(p50.toFixed(4)),
      p95_ms: Number(p95.toFixed(4)),
      p99_ms: Number(p99.toFixed(4)),
      throughput_ops_per_sec: totalMs > 0 ? Number(((ops * 1000) / totalMs).toFixed(2)) : 0,
    },
  };

  console.error('== bench-product-grounding ==');
  console.error(
    `ops=${ops} queries=${queries.length} candidates=${candidateProducts.length} repeat=${args.repeat} total_ms=${report.summary.total_ms} p50_ms=${report.summary.p50_ms} p95_ms=${report.summary.p95_ms} thr=${report.summary.throughput_ops_per_sec}/s`,
  );

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(`wrote: ${path.relative(process.cwd(), outPath)}`);
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main();

