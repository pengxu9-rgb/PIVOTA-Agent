#!/usr/bin/env node

/**
 * One-off migration script:
 *   - Reads local JSON promotions via promotionStore.loadPromotions()
 *   - Normalizes them
 *   - Upserts them into the DB-backed backend API:
 *       {PROMOTIONS_BACKEND_BASE_URL or PIVOTA_API_BASE}/agent/internal/promotions
 *
 * Usage (from pivota-agent-backend root):
 *   PROMOTIONS_BACKEND_BASE_URL=https://web-production-fedb.up.railway.app \
 *   PROMOTIONS_ADMIN_KEY=... \
 *   node scripts/migrate_promotions_to_backend.js
 *
 * Notes:
 *   - This script is idempotent: if a promotion with the same id already exists
 *     in the backend, it will be skipped.
 *   - It is intended to be run manually (e.g. from your laptop) once per
 *     environment when migrating away from local JSON storage.
 */

/* eslint-disable no-console */

const path = require('path');
const axios = require('axios');
const {
  loadPromotions,
  normalizePromotionRecord,
} = require('../src/promotionStore');

async function main() {
  const base =
    process.env.PROMOTIONS_BACKEND_BASE_URL ||
    process.env.PIVOTA_API_BASE ||
    '';
  const adminKey =
    process.env.PROMOTIONS_ADMIN_KEY || process.env.ADMIN_API_KEY || '';

  if (!base) {
    console.error(
      'ERROR: PROMOTIONS_BACKEND_BASE_URL or PIVOTA_API_BASE must be set.'
    );
    process.exit(1);
  }
  if (!adminKey) {
    console.error(
      'ERROR: PROMOTIONS_ADMIN_KEY or ADMIN_API_KEY must be set for migration.'
    );
    process.exit(1);
  }

  const baseUrl = base.replace(/\/$/, '');
  const client = axios.create({
    baseURL: baseUrl,
    timeout: 10000,
    headers: {
      'X-ADMIN-KEY': adminKey,
      'Content-Type': 'application/json',
    },
  });

  const localPromosRaw = loadPromotions();
  const localPromos = (localPromosRaw || []).map(normalizePromotionRecord);

  if (!localPromos.length) {
    console.log('No local promotions found. Nothing to migrate.');
    return;
  }

  console.log(
    `Found ${localPromos.length} local promotions in JSON store. Starting migration to ${baseUrl}...`
  );

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const promo of localPromos) {
    if (!promo || !promo.id) {
      console.warn('Skipping promotion without id:', promo);
      skipped += 1;
      continue;
    }

    const payload = {
      id: promo.id,
      merchantId: promo.merchantId,
      name: promo.name,
      type: promo.type,
      description: promo.description || '',
      startAt: promo.startAt,
      endAt: promo.endAt,
      channels: promo.channels || [],
      scope: promo.scope || {},
      config: promo.config || {},
      exposeToCreators:
        typeof promo.exposeToCreators === 'boolean'
          ? promo.exposeToCreators
          : true,
      allowedCreatorIds: promo.allowedCreatorIds || [],
    };

    try {
      // Check if it already exists in backend
      try {
        await client.get(`/agent/internal/promotions/${promo.id}`);
        console.log(`Skipping existing promotion ${promo.id}`);
        skipped += 1;
        continue;
      } catch (err) {
        if (!(err.response && err.response.status === 404)) {
          console.error(
            `Error checking promotion ${promo.id} existence:`,
            err.message
          );
          failed += 1;
          continue;
        }
        // 404 -> proceed to create
      }

      const res = await client.post(
        '/agent/internal/promotions',
        payload
      );
      const createdId = res.data?.promotion?.id || promo.id;
      console.log(`Migrated promotion ${promo.id} -> ${createdId}`);
      migrated += 1;
    } catch (err) {
      console.error(
        `Failed to migrate promotion ${promo.id}:`,
        err.response?.data || err.message
      );
      failed += 1;
    }
  }

  console.log('Migration completed.');
  console.log(
    `Summary: migrated=${migrated}, skipped=${skipped}, failed=${failed}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unexpected migration error:', err);
    process.exit(1);
  });
}

