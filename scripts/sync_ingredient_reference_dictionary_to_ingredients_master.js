#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { withClient } = require('../src/db');

function parseArgs(argv) {
  const out = {
    source_view: 'pci_kb.ingredient_reference_dictionary_v1',
    target_table: 'public.ingredients_master',
    out_json: '',
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--source-view' && next) {
      out.source_view = next;
      i += 1;
      continue;
    }
    if (token === '--target-table' && next) {
      out.target_table = next;
      i += 1;
      continue;
    }
    if (token === '--out-json' && next) {
      out.out_json = next;
      i += 1;
      continue;
    }
    if (token === '--apply') {
      out.apply = true;
      continue;
    }
  }
  return out;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function splitQualifiedName(input) {
  const raw = normalizeText(input);
  const parts = raw.split('.');
  if (parts.length !== 2) {
    throw new Error(`invalid_qualified_name:${raw}`);
  }
  return { schema: parts[0], name: parts[1] };
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function qualify(schemaName, objectName) {
  return `${quoteIdent(schemaName)}.${quoteIdent(objectName)}`;
}

function dedupeKeepOrder(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const token = normalizeText(value);
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function joinPipe(values) {
  const tokens = dedupeKeepOrder(values);
  return tokens.length ? tokens.join('|') : null;
}

function joinNotes(values) {
  const tokens = dedupeKeepOrder(values);
  return tokens.length ? tokens.join(' | ') : null;
}

function mapSourceRow(row) {
  const synonyms = dedupeKeepOrder([
    row.canonical_display_name !== row.canonical_inci_name ? row.canonical_display_name : '',
    row.us_label_name !== row.canonical_inci_name ? row.us_label_name : '',
    row.eu_label_name !== row.canonical_inci_name ? row.eu_label_name : '',
    ...(Array.isArray(row.aliases_common_list) ? row.aliases_common_list : []),
    ...(Array.isArray(row.deprecated_aliases_list) ? row.deprecated_aliases_list : []),
  ]);

  return {
    ingredient_id: normalizeText(row.normalized_key),
    inci_name: normalizeText(row.canonical_inci_name) || null,
    zh_name: null,
    synonyms: joinPipe(synonyms),
    categories: joinPipe(row.all_buckets_list),
    primary_benefits: joinPipe(row.benefit_tags_list),
    evidence_grade: normalizeText(row.confidence) || null,
    market_presence_notes: joinNotes([row.cross_market_notes, row.regulatory_bucket]),
    social_buzz_notes: null,
    representative_products: null,
  };
}

function shouldBackfillEmpty(existingValue, mappedValue) {
  return !normalizeText(existingValue) && Boolean(normalizeText(mappedValue));
}

function diffControlledFields(existing, mapped) {
  const changed = [];
  if (normalizeText(existing.inci_name) !== normalizeText(mapped.inci_name) && normalizeText(mapped.inci_name)) {
    changed.push('inci_name');
  }
  for (const field of ['synonyms', 'categories', 'primary_benefits', 'evidence_grade', 'market_presence_notes']) {
    if (shouldBackfillEmpty(existing[field], mapped[field])) changed.push(field);
  }
  return changed;
}

async function ensureTableExists(client, schemaName, tableName, relkind) {
  const res = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = $2
          AND c.relkind = $3
      ) AS exists
    `,
    [schemaName, tableName, relkind],
  );
  return Boolean(res.rows[0] && res.rows[0].exists);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRef = splitQualifiedName(args.source_view);
  const targetRef = splitQualifiedName(args.target_table);
  const qualifiedSource = qualify(sourceRef.schema, sourceRef.name);
  const qualifiedTarget = qualify(targetRef.schema, targetRef.name);

  const payload = {
    source_view: `${sourceRef.schema}.${sourceRef.name}`,
    target_table: `${targetRef.schema}.${targetRef.name}`,
    apply: Boolean(args.apply),
    source_row_count: 0,
    target_row_count_before: 0,
    planned: {
      insert_count: 0,
      update_count: 0,
      unchanged_count: 0,
    },
    field_change_counts: {},
    sample_inserts: [],
    sample_updates: [],
    sample_unchanged: [],
    apply_result: null,
  };

  await withClient(async (client) => {
    const sourceExists = await ensureTableExists(client, sourceRef.schema, sourceRef.name, 'v');
    const targetExists = await ensureTableExists(client, targetRef.schema, targetRef.name, 'r');
    if (!sourceExists) throw new Error(`missing_source_view:${payload.source_view}`);
    if (!targetExists) throw new Error(`missing_target_table:${payload.target_table}`);

    const sourceRes = await client.query(
      `
        SELECT
          normalized_key,
          canonical_inci_name,
          canonical_display_name,
          us_label_name,
          eu_label_name,
          aliases_common_list,
          deprecated_aliases_list,
          all_buckets_list,
          benefit_tags_list,
          confidence,
          cross_market_notes,
          regulatory_bucket
        FROM ${qualifiedSource}
        ORDER BY normalized_key ASC
      `,
    );
    const sourceRows = sourceRes.rows || [];
    payload.source_row_count = sourceRows.length;

    const targetRes = await client.query(
      `
        SELECT
          ingredient_id,
          inci_name,
          zh_name,
          synonyms,
          categories,
          primary_benefits,
          evidence_grade,
          market_presence_notes,
          social_buzz_notes,
          representative_products
        FROM ${qualifiedTarget}
      `,
    );
    const targetRows = targetRes.rows || [];
    payload.target_row_count_before = targetRows.length;
    const existingById = new Map(targetRows.map((row) => [normalizeText(row.ingredient_id), row]));

    const plannedRows = [];
    for (const sourceRow of sourceRows) {
      const mapped = mapSourceRow(sourceRow);
      if (!mapped.ingredient_id || !mapped.inci_name) continue;

      const existing = existingById.get(mapped.ingredient_id);
      if (!existing) {
        payload.planned.insert_count += 1;
        if (payload.sample_inserts.length < 10) payload.sample_inserts.push(mapped);
        plannedRows.push({ action: 'insert', mapped });
        continue;
      }

      const changedFields = diffControlledFields(existing, mapped);
      if (!changedFields.length) {
        payload.planned.unchanged_count += 1;
        if (payload.sample_unchanged.length < 10) {
          payload.sample_unchanged.push({
            ingredient_id: mapped.ingredient_id,
            inci_name: mapped.inci_name,
          });
        }
        continue;
      }

      payload.planned.update_count += 1;
      for (const field of changedFields) {
        payload.field_change_counts[field] = Number(payload.field_change_counts[field] || 0) + 1;
      }
      if (payload.sample_updates.length < 10) {
        payload.sample_updates.push({
          ingredient_id: mapped.ingredient_id,
          changed_fields: changedFields,
          current: {
            inci_name: existing.inci_name,
            synonyms: existing.synonyms,
            categories: existing.categories,
            primary_benefits: existing.primary_benefits,
            evidence_grade: existing.evidence_grade,
            market_presence_notes: existing.market_presence_notes,
          },
          mapped,
        });
      }
      plannedRows.push({ action: 'update', mapped });
    }

    if (!args.apply) return;

    let applied = 0;
    for (const row of plannedRows) {
      await client.query(
        `
          INSERT INTO ${qualifiedTarget} (
            ingredient_id,
            inci_name,
            zh_name,
            synonyms,
            categories,
            primary_benefits,
            evidence_grade,
            market_presence_notes,
            social_buzz_notes,
            representative_products,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            NOW(), NOW()
          )
          ON CONFLICT (ingredient_id) DO UPDATE SET
            inci_name = CASE
              WHEN COALESCE(EXCLUDED.inci_name, '') <> '' THEN EXCLUDED.inci_name
              ELSE ${qualifiedTarget}.inci_name
            END,
            synonyms = CASE
              WHEN COALESCE(${qualifiedTarget}.synonyms, '') = '' AND COALESCE(EXCLUDED.synonyms, '') <> '' THEN EXCLUDED.synonyms
              ELSE ${qualifiedTarget}.synonyms
            END,
            categories = CASE
              WHEN COALESCE(${qualifiedTarget}.categories, '') = '' AND COALESCE(EXCLUDED.categories, '') <> '' THEN EXCLUDED.categories
              ELSE ${qualifiedTarget}.categories
            END,
            primary_benefits = CASE
              WHEN COALESCE(${qualifiedTarget}.primary_benefits, '') = '' AND COALESCE(EXCLUDED.primary_benefits, '') <> '' THEN EXCLUDED.primary_benefits
              ELSE ${qualifiedTarget}.primary_benefits
            END,
            evidence_grade = CASE
              WHEN COALESCE(${qualifiedTarget}.evidence_grade, '') = '' AND COALESCE(EXCLUDED.evidence_grade, '') <> '' THEN EXCLUDED.evidence_grade
              ELSE ${qualifiedTarget}.evidence_grade
            END,
            market_presence_notes = CASE
              WHEN COALESCE(${qualifiedTarget}.market_presence_notes, '') = '' AND COALESCE(EXCLUDED.market_presence_notes, '') <> '' THEN EXCLUDED.market_presence_notes
              ELSE ${qualifiedTarget}.market_presence_notes
            END,
            updated_at = NOW()
        `,
        [
          row.mapped.ingredient_id,
          row.mapped.inci_name,
          row.mapped.zh_name,
          row.mapped.synonyms,
          row.mapped.categories,
          row.mapped.primary_benefits,
          row.mapped.evidence_grade,
          row.mapped.market_presence_notes,
          row.mapped.social_buzz_notes,
          row.mapped.representative_products,
        ],
      );
      applied += 1;
    }

    const afterRes = await client.query(`SELECT COUNT(*)::int AS count FROM ${qualifiedTarget}`);
    payload.apply_result = {
      applied_row_count: applied,
      target_row_count_after: Number(afterRes.rows[0] && afterRes.rows[0].count ? afterRes.rows[0].count : 0),
    };
  });

  const rendered = JSON.stringify(payload, null, 2);
  if (args.out_json) fs.writeFileSync(path.resolve(args.out_json), rendered + '\n');
  console.log(rendered);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
