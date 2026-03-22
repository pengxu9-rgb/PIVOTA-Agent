#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { inputPath: '', outPath: '', extractAuditPath: '' };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--input') {
      out.inputPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--extract-audit') {
      out.extractAuditPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

const OFFICIAL_TARGETS = {
  squalane: [
    {
      brand: 'The Ordinary',
      domain: 'theordinary.com',
      product_name: '100% Plant-Derived Squalane',
      pdp_url: 'https://theordinary.com/en-us/100-plant-derived-squalane-face-oil-100398.html',
      market: 'US',
      target_step_family: 'oil',
      rationale: 'Official PDP with explicit squalane naming and oil step alignment.',
    },
  ],
  centella_asiatica: [
    {
      brand: 'SKIN1004',
      domain: 'skin1004.com',
      product_name: 'Madagascar Centella Ampoule',
      pdp_url: 'https://www.skin1004.com/products/skin1004-madagascar-centella-ampoule',
      market: 'US',
      target_step_family: 'serum',
      rationale: 'Official PDP with centella-led ampoule naming and serum-family fit.',
    },
  ],
  tranexamic_acid: [
    {
      brand: 'Good Molecules',
      domain: 'goodmolecules.com',
      product_name: 'Discoloration Correcting Serum',
      pdp_url: 'https://www.goodmolecules.com/products/discoloration-correcting-serum',
      market: 'US',
      target_step_family: 'serum',
      rationale: 'Official PDP with tranexamic-acid-led brightening serum positioning; currently needs extractor viability check.',
    },
  ],
  lactic_acid: [
    {
      brand: 'The Ordinary',
      domain: 'theordinary.com',
      product_name: 'Lactic Acid 10% + HA',
      pdp_url: 'https://theordinary.com/en-us/lactic-acid-10-ha-exfoliator-100426.html',
      market: 'US',
      target_step_family: 'serum',
      rationale: 'Official PDP with explicit lactic-acid naming and leave-on exfoliant serum fit.',
    },
  ],
  alpha_arbutin: [
    {
      brand: 'The Ordinary',
      domain: 'theordinary.com',
      product_name: 'Alpha Arbutin 2% + HA',
      pdp_url: 'https://theordinary.com/en-ge/alpha-arbutin-2-ha-serum-769915233674.html',
      market: 'US',
      target_step_family: 'serum',
      rationale: 'Official PDP with explicit alpha-arbutin serum naming and ingredient callout.',
    },
  ],
  mandelic_acid: [
    {
      brand: 'The Ordinary',
      domain: 'theordinary.com',
      product_name: 'Mandelic Acid 10% + HA',
      pdp_url: 'https://theordinary.com/en-au/mandelic-acid-10-ha-exfoliator-100429.html',
      market: 'US',
      target_step_family: 'serum',
      rationale: 'Official PDP with explicit mandelic-acid serum naming and ingredient callout.',
    },
  ],
  benzoyl_peroxide: [
    {
      brand: 'La Roche-Posay',
      domain: 'laroche-posay.us',
      product_name: 'Effaclar Duo Acne Spot Treatment',
      pdp_url: 'https://www.laroche-posay.us/our-products/face/acne-products/effaclar-duo-acne-spot-treatment-effaclarduoacnespottreatment.html',
      market: 'US',
      target_step_family: 'treatment',
      rationale: 'Official PDP with explicit 5.5% benzoyl peroxide active ingredient.',
    },
    {
      brand: 'Neutrogena',
      domain: 'neutrogena.com',
      product_name: 'Rapid Clear Stubborn Acne Spot Gel',
      pdp_url: 'https://www.neutrogena.com/products/skincare/rapid-clear-stubborn-acne-spot-gel/6802461%3Fcgid%3Dallproducts%26tilePosition%3D26%26bvstate%3Dpg%3A17/ct%3Ar',
      market: 'US',
      target_step_family: 'treatment',
      rationale: 'Official PDP with explicit benzoyl peroxide acne spot gel positioning.',
    },
  ],
};

function buildCommandHints(target) {
  const domain = String(target?.domain || '').trim();
  const market = String(target?.market || 'US').trim() || 'US';
  const brand = String(target?.brand || '').trim();
  const commands = [];
  if (domain) {
    commands.push(
      `npm run external-seeds:backfill:catalog -- --market ${market} --domain ${domain} --limit 20 --dry-run`,
    );
  }
  if (brand) {
    commands.push(`npm run external-seeds:backfill:catalog -- --market ${market} --brand "${brand}" --limit 20 --dry-run`);
  }
  return commands;
}

function indexExtractAuditRows(doc) {
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  return rows.reduce((acc, row) => {
    const ingredientId = String(row?.ingredient_id || '').trim();
    if (!ingredientId) return acc;
    if (!Array.isArray(acc[ingredientId])) acc[ingredientId] = [];
    acc[ingredientId].push(row);
    return acc;
  }, {});
}

function summarizeExtractAudit(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    safe_to_backfill: row.safe_to_backfill === true,
    http_status: Number.isFinite(row.http_status) ? row.http_status : null,
    product_count: Math.max(0, Number(row.product_count || 0)),
    first_title: String(row.first_title || '').trim() || null,
    representative_url: String(row.representative_url || '').trim() || null,
    discovery_strategy: String(row.discovery_strategy || '').trim() || null,
    failure_category: String(row.failure_category || '').trim() || null,
    block_provider: String(row?.diagnostics?.block_provider || '').trim() || null,
  };
}

function resolveTargetExtractAudit(target, extractAuditIndex, ingredientId) {
  const rows = Array.isArray(extractAuditIndex?.[ingredientId]) ? extractAuditIndex[ingredientId] : [];
  if (!rows.length) return null;
  const pdpUrl = String(target?.pdp_url || '').trim();
  const exact = rows.find((row) => String(row?.url || '').trim() === pdpUrl);
  return summarizeExtractAudit(exact || rows[0]);
}

function buildPipelineNotes(item, targetSummaries) {
  const blockedTargets = targetSummaries.filter(
    (target) => target?.extract_spot_check_result && target.extract_spot_check_result.safe_to_backfill === false,
  );
  if (item?.seed_creation_required) {
    return [
      'Current backfill script only refreshes existing external_product_seeds rows; it does not create new rows.',
      'Run catalog extract spot-check on the official PDP target first.',
      'Create or import external seed rows upstream, then use backfill only as a refresh step.',
    ];
  }
  if (blockedTargets.length > 0) {
    return [
      'Existing seed rows appear to exist for at least one explicit source.',
      'At least one official PDP target is not extractor-safe yet; treat that target as manual-upstream until bot protection or discovery issues are resolved.',
      'Use dry-run backfill only on targets whose extract spot-check result is safe_to_backfill=true.',
    ];
  }
  return [
    'Existing seed rows appear to exist for at least one explicit source.',
    'Use dry-run backfill first, then audit updated seed rows before any write.',
  ];
}

function buildManifestItem(item, extractAuditIndex) {
  const targets = OFFICIAL_TARGETS[item?.ingredient_id] || [];
  const officialTargets = targets.map((target) => ({
    ...target,
    extract_spot_check: {
      method: 'POST',
      endpoint: 'https://pivota-catalog-intelligence-production.up.railway.app/api/extract',
      body: {
        brand: target.brand,
        domain: target.pdp_url,
        market: target.market,
        limit: 50,
      },
    },
    dry_run_command_hints: buildCommandHints(target),
    extract_spot_check_result: resolveTargetExtractAudit(target, extractAuditIndex, item?.ingredient_id),
  }));
  return {
    ingredient_id: item?.ingredient_id || null,
    ingredient_name: item?.ingredient_name || null,
    query: item?.query || null,
    root_cause_bucket: item?.root_cause_bucket || null,
    remediation_lane: item?.remediation_lane || null,
    seed_creation_required: Boolean(item?.seed_creation_required),
    recommended_action: item?.recommended_action || null,
    source_statuses: item?.source_statuses || null,
    official_targets: officialTargets,
    pipeline_notes: buildPipelineNotes(item, officialTargets),
    candidate_hints: Array.isArray(item?.candidate_hints) ? item.candidate_hints : [],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = normalizePath(args.inputPath);
  if (!inputPath) throw new Error('Missing required --input <data-supply-backlog.json>');
  const resolvedInput = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const extractAuditPath = normalizePath(args.extractAuditPath);
  const resolvedExtractAudit = extractAuditPath
    ? (path.isAbsolute(extractAuditPath) ? extractAuditPath : path.join(process.cwd(), extractAuditPath))
    : '';
  const extractAuditDoc = resolvedExtractAudit ? JSON.parse(fs.readFileSync(resolvedExtractAudit, 'utf8')) : null;
  const extractAuditIndex = indexExtractAuditRows(extractAuditDoc);
  const items = Array.isArray(input?.items) ? input.items.map((item) => buildManifestItem(item, extractAuditIndex)) : [];
  const outputDoc = {
    generated_at: new Date().toISOString(),
    source_backlog: resolvedInput,
    extract_audit: resolvedExtractAudit || null,
    x_service_commit: input?.x_service_commit || null,
    items,
  };
  const output = `${JSON.stringify(outputDoc, null, 2)}\n`;
  process.stdout.write(output);
  if (args.outPath) {
    const resolvedOut = path.isAbsolute(args.outPath) ? args.outPath : path.join(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, output, 'utf8');
  }
}

if (require.main === module) {
  try {
    main();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  _internals: {
    buildManifestItem,
    buildPipelineNotes,
    indexExtractAuditRows,
    parseArgs,
    resolveTargetExtractAudit,
    summarizeExtractAudit,
  },
};
