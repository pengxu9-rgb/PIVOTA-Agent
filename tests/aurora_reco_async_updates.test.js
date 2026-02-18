const {
  createAsyncTicket,
  applyAsyncBlockPatch,
  getAsyncUpdates,
  registerRecoTrackingSnapshot,
  getRecoTrackingMetadata,
  __internal,
} = require('../src/auroraBff/recoAsyncUpdateStore');

describe('aurora reco async update store', () => {
  beforeEach(() => {
    __internal.tickets.clear();
    __internal.trackingSnapshots.clear();
  });

  test('create ticket and poll updates', () => {
    const created = createAsyncTicket({
      requestId: 'req_1',
      cardId: 'card_1',
      lockTopN: 2,
      initialPayload: {
        competitors: { candidates: [{ product_id: 'a' }] },
        related_products: { candidates: [] },
        dupes: { candidates: [] },
        provenance: {},
      },
      ttlMs: 60000,
    });
    expect(created.ticketId).toBeTruthy();
    const first = getAsyncUpdates({ ticketId: created.ticketId, sinceVersion: 1 });
    expect(first.ok).toBe(true);
    expect(first.has_update).toBe(false);
  });

  test('apply patch keeps topN lock order while allowing content updates', () => {
    const created = createAsyncTicket({
      requestId: 'req_2',
      cardId: 'card_2',
      lockTopN: 1,
      initialPayload: {
        competitors: {
          candidates: [
            { product_id: 'a', evidence_refs: [] },
            { product_id: 'b', evidence_refs: [] },
          ],
        },
        related_products: { candidates: [] },
        dupes: { candidates: [] },
        provenance: {},
      },
      ttlMs: 60000,
    });
    const patch = applyAsyncBlockPatch({
      ticketId: created.ticketId,
      block: 'competitors',
      nextCandidates: [
        { product_id: 'b', evidence_refs: [{ id: 'new_ref' }] },
        { product_id: 'a', evidence_refs: [{ id: 'new_ref' }] },
      ],
    });
    expect(patch.applied).toBe(true);
    const out = getAsyncUpdates({ ticketId: created.ticketId, sinceVersion: 1 });
    expect(out.ok).toBe(true);
    expect(out.has_update).toBe(true);
    const ids = out.payload_patch.competitors.candidates.map((x) => x.product_id);
    expect(ids[0]).toBe('a');
  });

  test('tracking snapshot supports explicit trackingByBlock metadata', () => {
    registerRecoTrackingSnapshot({
      requestId: 'req_3',
      sessionId: 'sess_3',
      anchorProductId: 'anchor_3',
      blocks: {
        competitors: [{ product_id: 'c1' }],
        related_products: [],
        dupes: [],
      },
      trackingByBlock: {
        competitors: {
          c1: {
            rank_position: 2,
            attribution: 'A',
            was_exploration_slot: true,
          },
        },
      },
      ttlMs: 60000,
    });
    const meta = getRecoTrackingMetadata({
      requestId: 'req_3',
      sessionId: 'sess_3',
      block: 'competitors',
      candidateProductId: 'c1',
    });
    expect(meta).toBeTruthy();
    expect(meta.rank_position).toBe(2);
    expect(meta.attribution).toBe('A');
    expect(meta.was_exploration_slot).toBe(true);
  });
});
