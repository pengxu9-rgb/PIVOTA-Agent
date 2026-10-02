'use strict';

// A seed's explicit attachment owns its listing identity. Raw platform IDs can be
// recycled across merchants; only the legacy external namespace/global ext_ IDs
// may bind an unattached seed. Callers supply fixed SQL aliases, never user input.
function externalSeedCatalogBindingSql(seedAlias, cpAlias) {
  for (const alias of [seedAlias, cpAlias]) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(alias || '')) throw new Error('invalid_seed_binding_sql_alias');
  }
  return `(${seedAlias}.attached_product_key = ${cpAlias}.product_key
    OR (NULLIF(btrim(${seedAlias}.attached_product_key), '') IS NULL
      AND ${seedAlias}.external_product_id = ${cpAlias}.source_product_id
      AND (${cpAlias}.merchant_id = 'external_seed' OR ${cpAlias}.source_product_id ~* '^ext_')))`;
}

module.exports = { externalSeedCatalogBindingSql };
