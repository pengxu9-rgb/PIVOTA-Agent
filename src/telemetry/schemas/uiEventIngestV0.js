const { z } = require('zod');

const UiEventV0Schema = z
  .object({
    event_name: z.string().min(1).max(120),
    brief_id: z.string().min(1).max(120),
    trace_id: z.string().min(1).max(120),
    timestamp: z.number().min(0),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const UiEventIngestV0Schema = z
  .object({
    source: z.string().min(1).max(120),
    events: z.array(UiEventV0Schema).min(1).max(50),
  })
  .strict();

module.exports = {
  UiEventIngestV0Schema,
};

