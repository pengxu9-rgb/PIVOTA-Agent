const { scanServingLabels } = require('../../src/services/relationshipGraphServingScan');
const { isRelationshipEdgeServingSafe } = require('../../src/auroraBff/productRelationshipGraph');
const mode = process.argv[2];
const n = 20000;
const pad = 'x'.repeat(8 * 1024);
const row = (i) => ({ id: String(i).padStart(6, '0'), anchor_type: 'product', anchor_ref: `product:a${i}`,
  candidate_product_ref: `product:c${i}`, relation_type: 'related_product', label_state: 'ai_approved',
  anchor_snapshot: { brand: 'Brand', title: 'Daily Face Foundation - 100 Light', description: pad },
  candidate_snapshot: { brand: 'Brand', title: 'Daily Face Foundation - 200 Dark', description: pad } });
let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().heapUsed); };
global.gc(); const baseline = process.memoryUsage().heapUsed;
(async () => {
  let suppressed;
  if (mode === 'before') {
    const rows = Array.from({ length: n }, (_, i) => JSON.parse(JSON.stringify(row(i)))); sample();
    suppressed = rows.filter((r) => !isRelationshipEdgeServingSafe(r)).map((r) => r.id); sample();
  } else {
    const result = await scanServingLabels({ collectSuppressedIds: true,
      queryFn: async (_sql, [, cursor, limit]) => {
        const start = cursor === null ? 0 : Number(cursor) + 1;
        const rows = Array.from({ length: Math.max(0, Math.min(limit, n - start)) }, (_, i) => JSON.parse(JSON.stringify(row(start + i)))); sample();
        return { rows };
      }, onBatch: () => { sample(); global.gc(); } });
    suppressed = result.suppressedIds;
  }
  sample();
  console.log(JSON.stringify({ mode, rows: n, snapshotKB: 8, suppressed: suppressed.length,
    baselineMB: baseline / 1e6, peakMB: peak / 1e6, peakDeltaMB: (peak - baseline) / 1e6 }));
})();
