const { computePriority, buildLabelQueue } = require('../src/auroraBff/recoLabelQueue');

describe('aurora reco prelabel queue priority', () => {
  test('low confidence + exploration ranks higher', () => {
    const high = {
      id: 's1',
      block: 'competitors',
      confidence: 0.2,
      flags: ['exploration_slot'],
      snapshot: { candidate: { score_breakdown: { score_total: 0.52 } }, was_exploration_slot: true },
      updated_at: '2026-02-18T00:00:00Z',
    };
    const low = {
      id: 's2',
      block: 'competitors',
      confidence: 0.92,
      flags: [],
      snapshot: { candidate: { score_breakdown: { score_total: 0.9 } } },
      updated_at: '2026-02-18T00:00:01Z',
    };
    const pHigh = computePriority(high);
    const pLow = computePriority(low);
    expect(pHigh).toBeGreaterThan(pLow);
  });

  test('queue filters and ordering work', () => {
    const rows = [
      {
        id: 'a',
        block: 'dupes',
        confidence: 0.35,
        suggested_label: 'wrong_block',
        flags: ['needs_price_check'],
        snapshot: { candidate: { price: null, score_breakdown: { score_total: 0.49 } } },
        updated_at: '2026-02-18T00:00:02Z',
      },
      {
        id: 'b',
        block: 'dupes',
        confidence: 0.8,
        suggested_label: 'relevant',
        flags: [],
        snapshot: { candidate: { price: 20, score_breakdown: { score_total: 0.9 } } },
        updated_at: '2026-02-18T00:00:03Z',
      },
    ];
    const queue = buildLabelQueue(rows, {
      limit: 10,
      filters: { wrong_block_only: true },
    });
    expect(queue.length).toBe(1);
    expect(queue[0].id).toBe('a');
    expect(queue[0].priority_score).toBeGreaterThan(0);
  });
});
