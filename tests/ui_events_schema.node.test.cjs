const test = require('node:test');
const assert = require('node:assert/strict');

const { UiEventIngestV0Schema } = require('../src/telemetry/schemas/uiEventIngestV0');

test('ui events ingest schema: accepts a minimal valid payload', () => {
  const parsed = UiEventIngestV0Schema.safeParse({
    source: 'pivota-aurora-chatbox',
    events: [
      {
        event_name: 'aurora_conflict_heatmap_impression',
        brief_id: 'b',
        trace_id: 't',
        timestamp: 1700000000000,
        data: { aurora_uid: 'uid_test', state: 'has_conflicts' },
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test('ui events ingest schema: rejects missing required fields', () => {
  const parsed = UiEventIngestV0Schema.safeParse({
    source: 'pivota-aurora-chatbox',
    events: [{ event_name: 'x' }],
  });
  assert.equal(parsed.success, false);
});

