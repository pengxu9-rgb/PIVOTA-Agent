#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {
    brands: [],
    market: 'US',
    limit: 200,
    outDir: '',
    apply: false,
    skipInsights: false,
  };
  for (let idx = 2; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    const next = String(argv[idx + 1] || '').trim();
    if (token === '--brands' && next) {
      out.brands = next
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      idx += 1;
    } else if (token === '--market' && next) {
      out.market = next;
      idx += 1;
    } else if (token === '--limit' && next) {
      out.limit = Math.max(1, Math.min(Number(next) || 200, 1000));
      idx += 1;
    } else if (token === '--out-dir' && next) {
      out.outDir = next;
      idx += 1;
    } else if (token === '--apply') {
      out.apply = true;
    } else if (token === '--skip-insights') {
      out.skipInsights = true;
    }
  }
  return out;
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function dedupeStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = normalizeNonEmptyString(raw);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function resolvePathMaybeRelative(targetPath) {
  const normalized = normalizeNonEmptyString(targetPath);
  if (!normalized) return '';
  return path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized);
}

function parseBrandSpecs(values) {
  return (Array.isArray(values) ? values : [])
    .map((raw) => String(raw || '').trim())
    .filter(Boolean)
    .map((raw) => {
      const [brand, domain, preferredTitlesRaw, fallbackDomainsRaw] = raw.split('|').map((item) => item.trim());
      return {
        brand,
        domain,
        preferredTitles: String(preferredTitlesRaw || '')
          .split(';')
          .map((item) => item.trim())
          .filter(Boolean),
        fallbackDomains: String(fallbackDomainsRaw || '')
          .split(';')
          .map((item) => item.trim())
          .filter(Boolean),
        key: brand.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      };
    })
    .filter((item) => item.brand && item.domain);
}

function runNodeJson(scriptPath, args, cwd) {
  const raw = execFileSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 40 * 1024 * 1024,
  });
  return JSON.parse(String(raw || '').trim());
}

function collectSeedIds(creationDoc) {
  const items = Array.isArray(creationDoc?.apply_result?.items) ? creationDoc.apply_result.items : [];
  return items
    .filter((item) => ['inserted', 'skipped_existing', 'would_insert', 'would_insert_unverified'].includes(item?.status))
    .map((item) => normalizeNonEmptyString(item.seed_id))
    .filter(Boolean);
}

function collectExternalProductIds(creationDoc) {
  const items = Array.isArray(creationDoc?.apply_result?.items) ? creationDoc.apply_result.items : [];
  return dedupeStrings(
    items
    .filter((item) => ['inserted', 'skipped_existing', 'would_insert', 'would_insert_unverified'].includes(item?.status))
    .map((item) => normalizeNonEmptyString(item.external_product_id))
    .filter(Boolean),
  );
}

function collectAppliedSeedIds(creationDoc) {
  const items = Array.isArray(creationDoc?.apply_result?.items) ? creationDoc.apply_result.items : [];
  return dedupeStrings(
    items
    .filter((item) => ['inserted', 'skipped_existing', 'would_insert', 'would_insert_unverified'].includes(item?.status))
    .map((item) => normalizeNonEmptyString(item.seed_id))
    .filter(Boolean),
  );
}

function summarizeSeedScopedAuditResults(results) {
  const summary = {
    scanned_seed_count: Array.isArray(results) ? results.length : 0,
    failed_seed_count: 0,
    finding_total: 0,
    failure_reason_counts: {},
  };
  for (const item of Array.isArray(results) ? results : []) {
    const result = item?.result || null;
    if (Array.isArray(result)) {
      const failed = result.some((entry) => Array.isArray(entry?.failure_reasons) && entry.failure_reasons.length > 0);
      if (failed) summary.failed_seed_count += 1;
      for (const entry of result) {
        for (const reason of Array.isArray(entry?.failure_reasons) ? entry.failure_reasons : []) {
          summary.failure_reason_counts[reason] = (summary.failure_reason_counts[reason] || 0) + 1;
        }
      }
      continue;
    }
    const findingCount = Math.max(0, Number(result?.summary?.findings_total || 0) || 0);
    summary.finding_total += findingCount;
    if (findingCount > 0) summary.failed_seed_count += 1;
  }
  return summary;
}

function runSeedScopedJsonBatch(scriptPath, seedIds, buildArgs, cwd) {
  const dedupedSeedIds = dedupeStrings(seedIds);
  const results = dedupedSeedIds.map((seedId) => ({
    seed_id: seedId,
    result: runNodeJson(scriptPath, buildArgs(seedId), cwd),
  }));
  return {
    summary: summarizeSeedScopedAuditResults(results),
    results,
  };
}

function writeSeedIdFile(outDir, brandKey, seedIds) {
  const outPath = path.join(outDir, `${brandKey}-seed-ids.jsonl`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = seedIds.map((seedId) => JSON.stringify({ seed_id: seedId })).join('\n');
  fs.writeFileSync(outPath, `${body}\n`, 'utf8');
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv);
  const specs = parseBrandSpecs(args.brands);
  if (!specs.length) {
    throw new Error('Missing required --brands "Brand|https://brand.example,Other Brand|https://other.example"');
  }
  const rootDir = process.cwd();
  const outDir = resolvePathMaybeRelative(args.outDir || `reports/beauty_alternatives_authority_rollout/${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    generated_at: new Date().toISOString(),
    market: normalizeNonEmptyString(args.market).toUpperCase() || 'US',
    apply: args.apply === true,
    out_dir: outDir,
    brands: [],
  };

  for (const spec of specs) {
    const brandDir = path.join(outDir, spec.key);
    fs.mkdirSync(brandDir, { recursive: true });
    const manifestPath = path.join(brandDir, 'brand-manifest.json');
    const creationPath = path.join(brandDir, 'seed-creation-summary.json');
    const brandReport = {
      brand: spec.brand,
      domain: spec.domain,
      fallback_domains: spec.fallbackDomains,
      paths: {
        manifest: manifestPath,
        seed_creation: creationPath,
      },
    };

    brandReport.manifest = runNodeJson(
      path.join(rootDir, 'scripts', 'build_beauty_brand_external_seed_manifest.cjs'),
      [
        '--brand',
        spec.brand,
        '--domain',
        spec.domain,
        '--market',
        report.market,
        '--limit',
        String(args.limit),
        ...(spec.preferredTitles.length > 0
          ? ['--preferred-titles', spec.preferredTitles.join(';;')]
          : []),
        ...(spec.fallbackDomains.length > 0
          ? ['--fallback-domains', spec.fallbackDomains.join(';;')]
          : []),
        '--out',
        manifestPath,
      ],
      rootDir,
    );

    brandReport.seed_creation = runNodeJson(
      path.join(rootDir, 'scripts', 'run_aurora_external_seed_creation_pipeline.cjs'),
      [
        '--manifest',
        manifestPath,
        '--out',
        creationPath,
        ...(args.apply ? ['--apply'] : []),
      ],
      rootDir,
    );

    const seedIds = collectSeedIds(brandReport.seed_creation);
    const externalProductIds = collectExternalProductIds(brandReport.seed_creation);
    const appliedSeedIds = collectAppliedSeedIds(brandReport.seed_creation);
    brandReport.seed_ids = seedIds;
    brandReport.external_product_ids = externalProductIds;
    brandReport.applied_seed_ids = appliedSeedIds;

    if (seedIds.length && args.apply) {
      const seedIdFile = writeSeedIdFile(brandDir, spec.key, seedIds);
      brandReport.paths.seed_id_file = seedIdFile;
      brandReport.recall_docs = runNodeJson(
        path.join(rootDir, 'scripts', 'backfill-external-seed-recall-docs.js'),
        [
          '--market',
          report.market,
          '--seed-id-file',
          seedIdFile,
        ],
        rootDir,
      );
      brandReport.seed_audit = runSeedScopedJsonBatch(
        path.join(rootDir, 'scripts', 'audit-external-product-seeds-content.js'),
        appliedSeedIds,
        (seedId) => ['--market', report.market, '--seed-id', seedId, '--format', 'json'],
        rootDir,
      );
      brandReport.live_pdp_quality = runSeedScopedJsonBatch(
        path.join(rootDir, 'scripts', 'audit-external-product-pdp-quality.js'),
        appliedSeedIds,
        (seedId) => ['--market', report.market, '--seed-id', seedId, '--format', 'json'],
        rootDir,
      );
      if (!args.skipInsights && externalProductIds.length) {
        brandReport.insights_coverage = runNodeJson(
          path.join(rootDir, 'scripts', 'pivota_insights_coverage_batch.js'),
          [
            '--product-ids',
            externalProductIds.join(','),
            '--out-dir',
            path.join(brandDir, 'pivota-insights'),
          ],
          rootDir,
        );
      }
    }

    report.brands.push(brandReport);
  }

  const outPath = path.join(outDir, 'rollout-summary.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseBrandSpecs,
  collectSeedIds,
  collectExternalProductIds,
  collectAppliedSeedIds,
  summarizeSeedScopedAuditResults,
  runSeedScopedJsonBatch,
};
