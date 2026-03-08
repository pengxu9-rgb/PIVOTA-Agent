const express = require('express');
const request = require('supertest');

const { mountUiEventRoutes } = require('../../src/telemetry/uiEvents');

describe('ui event ingestion', () => {
  const originalPosthogApiKey = process.env.POSTHOG_API_KEY;
  const originalPosthogHost = process.env.POSTHOG_HOST;
  const originalPosthogUrl = process.env.POSTHOG_URL;
  const originalSinkDir = process.env.AURORA_EVENTS_JSONL_SINK_DIR;

  afterEach(() => {
    process.env.POSTHOG_API_KEY = originalPosthogApiKey;
    process.env.POSTHOG_HOST = originalPosthogHost;
    process.env.POSTHOG_URL = originalPosthogUrl;
    process.env.AURORA_EVENTS_JSONL_SINK_DIR = originalSinkDir;
  });

  test('logs traceable identifiers when ui events arrive without a durable sink', async () => {
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
    delete process.env.POSTHOG_URL;
    delete process.env.AURORA_EVENTS_JSONL_SINK_DIR;

    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
    };

    const app = express();
    app.use(express.json());
    mountUiEventRoutes(app, { logger });

    const res = await request(app)
      .post('/v1/events')
      .send({
        source: 'pivota-aurora-chatbox',
        events: [
          {
            event_name: 'ui_card_render_failed',
            brief_id: 'brief_test_ui_events',
            trace_id: 'trace_test_ui_events',
            timestamp: Date.now(),
            data: {
              card_type: 'product_analysis',
              card_id: 'analyze_test_card',
            },
          },
        ],
      });

    expect(res.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: 'set AURORA_EVENTS_JSONL_SINK_DIR to persist /v1/events payloads',
      }),
      'ui event sink is not configured; /v1/events currently has no durable sink',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'ui_card_render_failed',
        source: 'pivota-aurora-chatbox',
        brief_id: 'brief_test_ui_events',
        trace_id: 'trace_test_ui_events',
        card_type: 'product_analysis',
        card_id: 'analyze_test_card',
      }),
      'ui event received',
    );
  });
});
