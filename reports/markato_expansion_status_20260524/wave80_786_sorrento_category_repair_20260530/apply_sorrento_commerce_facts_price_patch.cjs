#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require(path.join(process.cwd(), 'src/db'));
const {
  buildAgentSafeCommerceFacts,
  normalizeCommerceFactsV1,
  validateCommerceFactsGateForSeedRow,
} = require(path.join(process.cwd(), 'src/commerce/commerceFacts'));

const EXTERNAL_PRODUCT_ID = 'ext_55b774d3c57906a77a7167f0';
const CONFIRM_TOKEN = 'APPLY_SORRENTO_COMMERCE_FACTS_PRICE_PATCH';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !String(value).startsWith('--') ? String(value) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function readBackfillEvidence(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  const nextRow = asObject(asObject(result).payload).next_row;
  const facts = asObject(asObject(nextRow).seed_data).commerce_facts_v1;
  if (!nextRow || !facts?.contract_version) {
    throw new Error('missing_commerce_facts_evidence');
  }
  return {
    priceAmount: Number(nextRow.price_amount),
    priceCurrency: String(nextRow.price_currency || 'USD').toUpperCase(),
    availability: String(nextRow.availability || 'in_stock'),
    facts,
  };
}

function summarizeSeedData(seedData) {
  const snapshot = asObject(seedData.snapshot);
  return {
    price_amount: seedData.price_amount ?? null,
    price_currency: seedData.price_currency ?? null,
    availability: seedData.availability ?? null,
    snapshot_price_amount: snapshot.price_amount ?? null,
    snapshot_price_currency: snapshot.price_currency ?? null,
    snapshot_availability: snapshot.availability ?? null,
    commerce_facts_price: asObject(seedData.commerce_facts_v1).regional_price?.amount ?? null,
    snapshot_commerce_facts_price: asObject(snapshot.commerce_facts_v1).regional_price?.amount ?? null,
    agent_safe_price: asObject(seedData.agent_safe_commerce_facts).price?.amount ?? null,
    variant_count: Array.isArray(seedData.variants) ? seedData.variants.length : 0,
    first_variant_label:
      Array.isArray(seedData.variants) && seedData.variants[0]
        ? seedData.variants[0].display_label || seedData.variants[0].title || seedData.variants[0].option_value || ''
        : '',
    first_variant_price:
      Array.isArray(seedData.variants) && seedData.variants[0]
        ? seedData.variants[0].price_amount ?? seedData.variants[0].price ?? null
        : null,
  };
}

async function main() {
  const evidenceFile = argValue('evidence-file');
  const outFile = argValue('out');
  const apply = hasFlag('apply');
  const confirm = argValue('confirm');
  if (!evidenceFile) throw new Error('missing_evidence_file');
  if (apply && confirm !== CONFIRM_TOKEN) {
    throw new Error(`Refusing write without --confirm ${CONFIRM_TOKEN}`);
  }

  const evidence = readBackfillEvidence(evidenceFile);
  if (!Number.isFinite(evidence.priceAmount) || evidence.priceAmount <= 0) {
    throw new Error('invalid_evidence_price_amount');
  }
  if (evidence.priceCurrency !== 'USD') throw new Error('unexpected_evidence_currency');

  const rowRes = await query(
    `
      SELECT external_product_id, market, price_amount, price_currency, availability, seed_data
      FROM external_product_seeds
      WHERE external_product_id = $1
        AND upper(market) = 'US'
        AND status = 'active'
    `,
    [EXTERNAL_PRODUCT_ID],
  );
  const row = rowRes.rows[0];
  if (!row) throw new Error('target_row_not_found');

  const seedData = clone(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const normalizedFacts = normalizeCommerceFactsV1(evidence.facts, {
    ...row,
    price_amount: evidence.priceAmount,
    price_currency: evidence.priceCurrency,
    availability: evidence.availability,
    seed_data: seedData,
  }, { market: 'US' });
  const agentSafeCommerceFacts = buildAgentSafeCommerceFacts(normalizedFacts);
  const nextSeedData = {
    ...seedData,
    price_amount: evidence.priceAmount,
    price_currency: evidence.priceCurrency,
    availability: evidence.availability,
    commerce_facts_v1: normalizedFacts,
    agent_safe_commerce_facts: agentSafeCommerceFacts,
    snapshot: {
      ...snapshot,
      price_amount: evidence.priceAmount,
      price_currency: evidence.priceCurrency,
      availability: evidence.availability,
      commerce_facts_v1: normalizedFacts,
      agent_safe_commerce_facts: agentSafeCommerceFacts,
    },
  };
  const gate = validateCommerceFactsGateForSeedRow({
    ...row,
    price_amount: evidence.priceAmount,
    price_currency: evidence.priceCurrency,
    availability: evidence.availability,
    seed_data: nextSeedData,
  });
  nextSeedData.commerce_facts_gate = gate;
  nextSeedData.snapshot.commerce_facts_gate = gate;

  const report = {
    generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry_run',
    external_product_id: EXTERNAL_PRODUCT_ID,
    evidence: {
      price_amount: evidence.priceAmount,
      price_currency: evidence.priceCurrency,
      availability: evidence.availability,
      commerce_facts_gate: gate,
    },
    before: {
      row_price_amount: row.price_amount == null ? null : Number(row.price_amount),
      row_price_currency: row.price_currency,
      row_availability: row.availability,
      seed_data: summarizeSeedData(seedData),
    },
    after: {
      row_price_amount: evidence.priceAmount,
      row_price_currency: evidence.priceCurrency,
      row_availability: evidence.availability,
      seed_data: summarizeSeedData(nextSeedData),
    },
    updated: 0,
  };

  if (apply) {
    const updateRes = await query(
      `
        UPDATE external_product_seeds
        SET price_amount = $2,
            price_currency = $3,
            availability = $4,
            seed_data = $5::jsonb,
            updated_at = NOW()
        WHERE external_product_id = $1
          AND upper(market) = 'US'
          AND status = 'active'
      `,
      [
        EXTERNAL_PRODUCT_ID,
        evidence.priceAmount,
        evidence.priceCurrency,
        evidence.availability,
        JSON.stringify(nextSeedData),
      ],
    );
    report.updated = Number(updateRes.rowCount || 0);
  }

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, serialized, 'utf8');
  }
  process.stdout.write(serialized);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
