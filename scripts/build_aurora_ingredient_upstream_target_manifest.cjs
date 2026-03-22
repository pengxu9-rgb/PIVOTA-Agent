#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { inputPath: '', outPath: '' };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--input') {
      out.inputPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    }
  }
  return out;
}

function normalizePath(value) {
  return String(value || '').trim();
}

const OFFICIAL_TARGETS = {
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

function buildPipelineNotes(item) {
  if (item?.seed_creation_required) {
    return [
      'Current backfill script only refreshes existing external_product_seeds rows; it does not create new rows.',
      'Run catalog extract spot-check on the official PDP target first.',
      'Create or import external seed rows upstream, then use backfill only as a refresh step.',
    ];
  }
  return [
    'Existing seed rows appear to exist for at least one explicit source.',
    'Use dry-run backfill first, then audit updated seed rows before any write.',
  ];
}

function buildManifestItem(item) {
  const targets = OFFICIAL_TARGETS[item?.ingredient_id] || [];
  return {
    ingredient_id: item?.ingredient_id || null,
    ingredient_name: item?.ingredient_name || null,
    query: item?.query || null,
    root_cause_bucket: item?.root_cause_bucket || null,
    remediation_lane: item?.remediation_lane || null,
    seed_creation_required: Boolean(item?.seed_creation_required),
    recommended_action: item?.recommended_action || null,
    source_statuses: item?.source_statuses || null,
    official_targets: targets.map((target) => ({
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
    })),
    pipeline_notes: buildPipelineNotes(item),
    candidate_hints: Array.isArray(item?.candidate_hints) ? item.candidate_hints : [],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = normalizePath(args.inputPath);
  if (!inputPath) throw new Error('Missing required --input <data-supply-backlog.json>');
  const resolvedInput = path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const items = Array.isArray(input?.items) ? input.items.map(buildManifestItem) : [];
  const outputDoc = {
    generated_at: new Date().toISOString(),
    source_backlog: resolvedInput,
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

try {
  main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
}
