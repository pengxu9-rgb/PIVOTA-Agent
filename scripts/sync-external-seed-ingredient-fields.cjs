#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { withClient, getPool } = require('../src/db');
const {
  ENRICHMENT_SOURCE,
  SEED_ANCHOR_SOURCE_KIND,
  enrichExternalSeedRowIngredients,
} = require('../src/services/externalSeedIngredientEnrichment');

const WAVE_MODE = Object.freeze({
  audit: 'audit',
  kbReviewed: 'kb_reviewed',
  titleAnchor: 'title_anchor',
});
const TITLE_ANCHOR_ALLOWED_SOURCE_KINDS = new Set([
  SEED_ANCHOR_SOURCE_KIND.explicitTitleAnchor,
  SEED_ANCHOR_SOURCE_KIND.explicitTitleUrlAnchor,
]);

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const out = {
    seedId: '',
    externalProductId: '',
    domain: '',
    market: '',
    limit: 25,
    offset: 0,
    wave: WAVE_MODE.audit,
    missingOnly: false,
    attachedOnly: false,
    unattachedOnly: false,
    allowDomains: [],
    apply: false,
    dryRun: false,
    outPath: '',
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = normalizeNonEmptyString(argv[idx]);
    if (token === '--seed-id') {
      out.seedId = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    } else if (token === '--external-product-id') {
      out.externalProductId = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    } else if (token === '--domain') {
      out.domain = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    } else if (token === '--market') {
      out.market = normalizeNonEmptyString(argv[idx + 1]).toUpperCase();
      idx += 1;
    } else if (token === '--limit') {
      out.limit = Math.max(1, Number(argv[idx + 1]) || out.limit);
      idx += 1;
    } else if (token === '--offset') {
      out.offset = Math.max(0, Number(argv[idx + 1]) || 0);
      idx += 1;
    } else if (token === '--wave') {
      const value = normalizeNonEmptyString(argv[idx + 1]).toLowerCase();
      if (value === WAVE_MODE.kbReviewed || value === WAVE_MODE.titleAnchor || value === WAVE_MODE.audit) {
        out.wave = value;
      }
      idx += 1;
    } else if (token === '--missing-only') {
      out.missingOnly = true;
    } else if (token === '--attached-only') {
      out.attachedOnly = true;
    } else if (token === '--unattached-only') {
      out.unattachedOnly = true;
    } else if (token === '--allow-domains') {
      out.allowDomains = String(argv[idx + 1] || '')
        .split(',')
        .map((value) => normalizeNonEmptyString(value).toLowerCase())
        .filter(Boolean);
      idx += 1;
    } else if (token === '--apply') {
      out.apply = true;
    } else if (token === '--dry-run' || token === '--dryRun') {
      out.dryRun = true;
    } else if (token === '--out') {
      out.outPath = normalizeNonEmptyString(argv[idx + 1]);
      idx += 1;
    }
  }
  return out;
}

function resolvePathMaybeRelative(targetPath) {
  if (!targetPath) return '';
  return path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);
}

async function fetchRows(client, args) {
  const where = [`status = 'active'`];
  const params = [];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (args.seedId) where.push(`id::text = ${push(args.seedId)}`);
  if (args.externalProductId) where.push(`external_product_id = ${push(args.externalProductId)}`);
  if (args.domain) where.push(`domain = ${push(args.domain)}`);
  if (args.market) where.push(`upper(coalesce(market, '')) = ${push(args.market)}`);
  if (args.attachedOnly && !args.unattachedOnly) {
    where.push(`coalesce(attached_product_key, '') <> ''`);
  } else if (args.unattachedOnly && !args.attachedOnly) {
    where.push(`coalesce(attached_product_key, '') = ''`);
  }
  params.push(args.limit);
  const limitBind = `$${params.length}`;
  params.push(args.offset);
  const offsetBind = `$${params.length}`;
  const res = await client.query(
    `
      SELECT
        id,
        external_product_id,
        market,
        tool,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

function mergeCounter(target, key) {
  const normalized = normalizeNonEmptyString(key || 'none') || 'none';
  target[normalized] = Number(target[normalized] || 0) + 1;
}

function resolveWaveDisposition(row, enrichment, args) {
  const attached = Boolean(normalizeNonEmptyString(row?.attached_product_key));
  const domain = normalizeNonEmptyString(row?.domain).toLowerCase();
  const beforeStatus = normalizeNonEmptyString(enrichment?.seed_structured_ingredient_status_before || 'missing');
  const enrichmentSource = normalizeNonEmptyString(enrichment?.enrichment_source || 'none');
  const anchorSourceKind = normalizeNonEmptyString(enrichment?.seed_anchor_source_kind || 'none');
  let quarantineReason = normalizeNonEmptyString(enrichment?.quarantine_reason) || '';

  if (args.missingOnly && beforeStatus === 'present') {
    return { eligible: false, quarantineReason: 'already_present', attached };
  }
  if (args.attachedOnly && !attached) {
    return { eligible: false, quarantineReason: 'attachedness_filtered', attached };
  }
  if (args.unattachedOnly && attached) {
    return { eligible: false, quarantineReason: 'attachedness_filtered', attached };
  }
  if (args.wave === WAVE_MODE.kbReviewed) {
    if (enrichmentSource !== ENRICHMENT_SOURCE.kbReviewed) {
      return { eligible: false, quarantineReason: 'not_kb_reviewed', attached };
    }
  } else if (args.wave === WAVE_MODE.titleAnchor) {
    if (enrichmentSource !== ENRICHMENT_SOURCE.titleUrlAnchor) {
      return { eligible: false, quarantineReason: 'not_title_anchor', attached };
    }
    if (!TITLE_ANCHOR_ALLOWED_SOURCE_KINDS.has(anchorSourceKind)) {
      quarantineReason = quarantineReason || 'url_only_anchor';
    }
    if (!quarantineReason && Array.isArray(args.allowDomains) && args.allowDomains.length > 0) {
      if (!args.allowDomains.includes(domain)) quarantineReason = 'non_beauty_domain';
    }
  }
  return {
    eligible: !quarantineReason,
    quarantineReason: quarantineReason || null,
    attached,
  };
}

function summarize(items, mode, wave) {
  const summary = {
    mode,
    wave,
    scanned: Array.isArray(items) ? items.length : 0,
    changed: 0,
    unchanged: 0,
    updated: 0,
    eligible_for_wave_apply: 0,
    skipped_guardrail: 0,
    seed_kb_sync_status: {},
    ingredient_writeback_source: {},
    seed_anchor_source_kind: {},
    quarantine_reason: {},
    attached_state: {},
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (item.changed) summary.changed += 1;
    else summary.unchanged += 1;
    if (item.status === 'updated') summary.updated += 1;
    if (item.eligible_for_wave_apply === true) summary.eligible_for_wave_apply += 1;
    if (item.status === 'skipped_guardrail') summary.skipped_guardrail += 1;
    const syncKey = normalizeNonEmptyString(item.seed_kb_sync_status || 'missing_both');
    const sourceKey = normalizeNonEmptyString(item.ingredient_writeback_source || 'none');
    mergeCounter(summary.seed_kb_sync_status, syncKey);
    mergeCounter(summary.ingredient_writeback_source, sourceKey);
    mergeCounter(summary.seed_anchor_source_kind, item.seed_anchor_source_kind || 'none');
    mergeCounter(summary.quarantine_reason, item.quarantine_reason || 'none');
    mergeCounter(summary.attached_state, item.attached_state || 'unknown');
  }
  return summary;
}

async function runWithDb(args, mode) {
  return withClient(async (client) => {
    const rows = await fetchRows(client, args);
    const items = [];
    if (mode === 'apply') await client.query('BEGIN');
    try {
      for (const row of rows) {
        const enrichment = await enrichExternalSeedRowIngredients({ row });
        const disposition = resolveWaveDisposition(row, enrichment, args);
        const nextRow = enrichment?.row && typeof enrichment.row === 'object' ? enrichment.row : row;
        const shouldWrite = mode === 'apply' && enrichment?.changed === true && disposition.eligible === true;
        const item = {
          seed_id: normalizeNonEmptyString(row.id),
          external_product_id: normalizeNonEmptyString(row.external_product_id),
          changed: enrichment?.changed === true,
          status:
            enrichment?.changed === true
              ? shouldWrite
                ? 'updated'
                : disposition.eligible
                  ? 'would_update'
                  : 'skipped_guardrail'
              : 'unchanged',
          eligible_for_wave_apply: disposition.eligible === true,
          ingredient_writeback_source: enrichment?.enrichment_source || 'none',
          seed_structured_ingredient_status_before:
            enrichment?.seed_structured_ingredient_status_before || 'missing',
          seed_structured_ingredient_status_after:
            enrichment?.seed_structured_ingredient_status_after || 'missing',
          seed_kb_sync_status: enrichment?.seed_kb_sync_status || 'missing_both',
          runtime_ingredient_evidence_source:
            enrichment?.runtime_ingredient_evidence_source || 'none',
          seed_anchor_source_kind: enrichment?.seed_anchor_source_kind || 'none',
          seed_anchor_conflict_status: enrichment?.seed_anchor_conflict_status || 'none',
          url_anchor_conflict: enrichment?.url_anchor_conflict === true,
          quarantine_reason: disposition.quarantineReason || null,
          attached_state: disposition.attached ? 'attached' : 'unattached',
          domain: normalizeNonEmptyString(row.domain) || null,
        };
        if (shouldWrite) {
          await client.query(
            `
              UPDATE external_product_seeds
              SET seed_data = $2::jsonb, updated_at = now()
              WHERE id = $1
            `,
            [row.id, JSON.stringify(nextRow.seed_data || {})],
          );
        }
        items.push(item);
      }
      if (mode === 'apply') await client.query('COMMIT');
      return items;
    } catch (error) {
      if (mode === 'apply') await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? 'apply' : 'dry_run';
  if (args.apply && args.wave === WAVE_MODE.audit) {
    throw new Error('wave=audit is dry-run only; use --wave kb_reviewed or --wave title_anchor for apply');
  }
  if (args.wave === WAVE_MODE.titleAnchor && (!Array.isArray(args.allowDomains) || args.allowDomains.length === 0)) {
    throw new Error('wave=title_anchor requires --allow-domains domain1,domain2');
  }
  const databaseAvailable = Boolean(getPool());
  if (!databaseAvailable) {
    const error = new Error('DATABASE_URL not configured or pg driver unavailable');
    error.code = 'NO_DATABASE';
    throw error;
  }
  const items = await runWithDb(args, mode);
  const output = {
    generated_at: new Date().toISOString(),
    mode,
    filters: {
      seed_id: args.seedId || null,
      external_product_id: args.externalProductId || null,
      domain: args.domain || null,
      market: args.market || null,
      wave: args.wave,
      missing_only: args.missingOnly,
      attached_only: args.attachedOnly,
      unattached_only: args.unattachedOnly,
      allow_domains: Array.isArray(args.allowDomains) ? args.allowDomains.slice() : [],
      limit: args.limit,
      offset: args.offset,
    },
    summary: summarize(items, mode, args.wave),
    items,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(serialized);
  if (args.outPath) {
    const outPath = resolvePathMaybeRelative(args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serialized, 'utf8');
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
