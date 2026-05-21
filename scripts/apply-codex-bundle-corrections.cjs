#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(v) {
  return String(v || '').trim();
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

async function loadRowsByExternalId(ids) {
  if (!ids.length) return new Map();
  const res = await query(
    `SELECT external_product_id, title, canonical_url, destination_url, domain,
            seed_data
     FROM external_product_seeds
     WHERE external_product_id = ANY($1::text[]) AND status='active'`,
    [ids],
  );
  return new Map((res.rows || []).map((row) => [row.external_product_id, row]));
}

function buildReplacementRef(targetRow, sourceRef, generatedAt, reason) {
  const seedData = asObject(targetRow.seed_data);
  const snapshot = asObject(seedData.snapshot);
  return {
    merchant_id: 'external_seed',
    product_id: targetRow.external_product_id,
    external_product_id: targetRow.external_product_id,
    title: asString(targetRow.title) || asString(snapshot.title) || asString(sourceRef?.title),
    canonical_url:
      asString(targetRow.canonical_url) || asString(seedData.canonical_url) || asString(snapshot.canonical_url),
    destination_url:
      asString(targetRow.destination_url) ||
      asString(seedData.destination_url) ||
      asString(snapshot.destination_url),
    domain: asString(targetRow.domain),
    component_role: asString(sourceRef?.component_role),
    size_label: asString(sourceRef?.size_label),
    inheritance_scope: asArray(sourceRef?.inheritance_scope).length
      ? asArray(sourceRef.inheritance_scope)
      : ['how_to_use', 'ingredients_inci'],
    review_state: 'reviewed',
    source_kind: 'codex_review_correction',
    evidence_note: asString(reason),
    linked_at: generatedAt,
  };
}

function applyCorrectionsToRefs(currentRefs, corrections, targetRowsById, generatedAt) {
  const refs = currentRefs.slice();
  const applied = [];
  const skipped = [];
  for (const correction of corrections) {
    if (correction.swap_component) {
      const { from, to, reason } = correction.swap_component;
      const idx = refs.findIndex((r) => asString(r.external_product_id || r.product_id) === asString(from));
      const targetRow = targetRowsById.get(asString(to));
      if (idx === -1) {
        skipped.push({ correction, reason: 'from_not_found' });
        continue;
      }
      if (!targetRow) {
        skipped.push({ correction, reason: 'target_row_missing' });
        continue;
      }
      refs[idx] = buildReplacementRef(targetRow, refs[idx], generatedAt, reason);
      applied.push({ swap_component: { from, to } });
    } else if (correction.add_component) {
      const id = asString(
        typeof correction.add_component === 'string'
          ? correction.add_component
          : correction.add_component?.external_product_id || correction.add_component?.product_id,
      );
      const reason = asString(
        typeof correction.add_component === 'object' ? correction.add_component?.reason : '',
      ) || 'codex_review_add';
      const exists = refs.some((r) => asString(r.external_product_id || r.product_id) === id);
      if (exists) {
        skipped.push({ correction, reason: 'already_present' });
        continue;
      }
      const targetRow = targetRowsById.get(id);
      if (!targetRow) {
        skipped.push({ correction, reason: 'target_row_missing' });
        continue;
      }
      refs.push(buildReplacementRef(targetRow, null, generatedAt, reason));
      applied.push({ add_component: id });
    } else if (correction.drop_component) {
      const id = asString(
        typeof correction.drop_component === 'string'
          ? correction.drop_component
          : correction.drop_component?.external_product_id,
      );
      const idx = refs.findIndex((r) => asString(r.external_product_id || r.product_id) === id);
      if (idx === -1) {
        skipped.push({ correction, reason: 'not_present' });
        continue;
      }
      refs.splice(idx, 1);
      applied.push({ drop_component: id });
    } else {
      skipped.push({ correction, reason: 'unknown_correction_type' });
    }
  }
  return { refs, applied, skipped };
}

async function main() {
  const reportPath = asString(argValue('audit-report')) || path.resolve(
    process.cwd(),
    'tmp/codex-bundle-audit-report.json',
  );
  const out = asString(argValue('out')) || path.resolve(
    process.cwd(),
    'tmp/codex-corrections-applied.json',
  );
  const write = hasFlag('write');
  const generatedAt = new Date().toISOString();

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const needs = asArray(report.findings).filter((f) => f.verdict === 'needs_correction' && asArray(f.suggested_corrections).length > 0);

  if (needs.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, message: 'No corrections to apply', count: 0 }, null, 2) + '\n');
    return;
  }

  const parentIds = needs.map((f) => f.external_product_id);
  const targetIds = needs.flatMap((f) =>
    asArray(f.suggested_corrections).flatMap((c) => {
      const ids = [];
      if (c.swap_component?.to) ids.push(c.swap_component.to);
      if (typeof c.add_component === 'string') ids.push(c.add_component);
      else if (c.add_component?.external_product_id) ids.push(c.add_component.external_product_id);
      else if (c.add_component?.product_id) ids.push(c.add_component.product_id);
      return ids;
    }),
  );
  const parentRowsById = await loadRowsByExternalId(parentIds);
  const targetRowsById = await loadRowsByExternalId([...new Set(targetIds)]);

  const results = [];
  const updates = [];

  for (const finding of needs) {
    const parentId = finding.external_product_id;
    const parentRow = parentRowsById.get(parentId);
    if (!parentRow) {
      results.push({ external_product_id: parentId, status: 'parent_not_found' });
      continue;
    }
    const seedData = asObject(parentRow.seed_data);
    const currentRefs = asArray(seedData.bundle_component_refs);
    if (currentRefs.length === 0) {
      results.push({ external_product_id: parentId, status: 'no_existing_refs' });
      continue;
    }
    const { refs: nextRefs, applied, skipped } = applyCorrectionsToRefs(
      currentRefs,
      asArray(finding.suggested_corrections),
      targetRowsById,
      generatedAt,
    );
    const changed = JSON.stringify(currentRefs) !== JSON.stringify(nextRefs);
    results.push({
      external_product_id: parentId,
      status: changed ? (write ? 'pending_apply' : 'dry_run') : 'unchanged',
      before_count: currentRefs.length,
      after_count: nextRefs.length,
      applied,
      skipped,
    });
    if (changed) {
      const snapshot = asObject(seedData.snapshot);
      const contract = {
        contract_version: 'external_seed.bundle_component_refs.v1',
        source: 'codex_review_correction',
        review_state: 'reviewed',
        evidence_source: 'codex_audit_report',
        evidence_note: asString(finding.notes),
        updated_at: generatedAt,
      };
      const nextSeedData = {
        ...seedData,
        bundle_component_refs: nextRefs,
        bundle_component_ref_contract: contract,
        snapshot: {
          ...snapshot,
          bundle_component_refs: nextRefs,
          bundle_component_ref_contract: contract,
        },
      };
      updates.push({ externalProductId: parentId, nextSeedData });
    }
  }

  let updatedRows = 0;
  if (write && updates.length) {
    await withClient(async (client) => {
      await client.query('BEGIN');
      try {
        for (const update of updates) {
          const res = await client.query(
            `UPDATE external_product_seeds
             SET seed_data = $2::jsonb, updated_at = now()
             WHERE external_product_id = $1 AND status = 'active'
               AND seed_data IS DISTINCT FROM $2::jsonb`,
            [update.externalProductId, JSON.stringify(update.nextSeedData)],
          );
          updatedRows += Number(res.rowCount || 0);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    for (const r of results) if (r.status === 'pending_apply') r.status = 'updated';
  }

  const summary = {
    dry_run: !write,
    findings_processed: needs.length,
    changed_rows: updates.length,
    updated_rows: updatedRows,
    no_existing_refs: results.filter((r) => r.status === 'no_existing_refs').length,
    parent_not_found: results.filter((r) => r.status === 'parent_not_found').length,
    skipped_total: results.reduce((sum, r) => sum + (asArray(r.skipped).length), 0),
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generated_at: generatedAt, summary, results }, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main()
  .catch((err) => {
    process.stderr.write(
      JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2) + '\n',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
