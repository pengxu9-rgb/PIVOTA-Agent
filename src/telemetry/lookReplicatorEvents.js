const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { LookReplicatorEventIngestV0Schema } = require('./schemas/lookReplicatorEventIngestV0');

function isoDateKey(d = new Date()) {
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function safeString(v) {
  const s = String(v || '').trim();
  return s || null;
}

function stableDistinctId({ distinctId, sessionId } = {}) {
  const explicit = safeString(distinctId);
  if (explicit) return explicit;
  const s = safeString(sessionId);
  if (s) return `session:${crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)}`;
  return 'anonymous';
}

async function forwardToPostHog({ apiKey, host, event, properties, timestamp, distinctId }) {
  const base = String(host || '').replace(/\/+$/, '');
  if (!base) return;
  if (typeof fetch !== 'function') return;

  const payload = {
    api_key: apiKey,
    event,
    properties: {
      distinct_id: distinctId,
      ...properties,
    },
    ...(timestamp ? { timestamp } : {}),
  };

  await fetch(`${base}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function appendJsonlSink({ dir, row }) {
  const outDir = path.resolve(dir);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `look-replicator-${isoDateKey()}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function newRequestId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return crypto.randomBytes(16).toString('hex');
}

function requiresExposureId(eventName) {
  return new Set([
    'lr_adjustments_exposed',
    'lr_more_opened',
    'lr_candidate_clicked',
    'lr_steps_viewed',
    'lr_kit_clicked',
    'lr_checkout_started',
    'lr_share_clicked',
  ]).has(String(eventName || ''));
}

function extractExperiment(properties) {
  const exp = properties?.experiment;
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) return exp;
  return null;
}

function mountLookReplicatorEventRoutes(app, { logger } = {}) {
  app.post('/v1/events/look-replicator', async (req, res) => {
    const parsed = LookReplicatorEventIngestV0Schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }

    const apiKey = process.env.POSTHOG_API_KEY;
    const host = process.env.POSTHOG_HOST || process.env.POSTHOG_URL;
    const sinkDir = process.env.LR_EVENTS_JSONL_SINK_DIR;

    const distinctId = stableDistinctId({
      distinctId: parsed.data.distinctId,
      sessionId: parsed.data.sessionId,
    });

    const requestId = newRequestId();
    const serverReceivedAt = new Date().toISOString();

    const properties = { ...(parsed.data.properties || {}) };
    if (requiresExposureId(parsed.data.event)) {
      const exposureId = safeString(properties.exposureId);
      if (!exposureId) {
        properties.missingExposureId = true;
      }

      const experiment = extractExperiment(properties);
      const variantId = safeString(experiment?.variantId) || safeString(properties.variantId);
      const explorationBucket = experiment?.explorationBucket ?? properties.explorationBucket;
      const bucketOk = explorationBucket === 0 || explorationBucket === 1 || explorationBucket === '0' || explorationBucket === '1';
      if (!variantId || !bucketOk) {
        properties.missingExperiment = true;
      }
    }
    properties.serverReceivedAt = serverReceivedAt;
    properties.requestId = requestId;

    const row = {
      event: parsed.data.event,
      properties,
      timestamp: parsed.data.timestamp || new Date().toISOString(),
      distinctId,
    };

    // Non-blocking: ingest happens in the background and must never affect the response.
    setImmediate(() => {
      try {
        if (apiKey && host) {
          void forwardToPostHog({
            apiKey,
            host,
            event: row.event,
            properties: row.properties,
            timestamp: row.timestamp,
            distinctId,
          }).catch((err) => {
            logger?.warn?.({ err: err?.message || String(err) }, 'look-replicator event forward failed');
          });
        } else if (sinkDir) {
          appendJsonlSink({ dir: sinkDir, row });
        } else {
          logger?.info?.({ event: row.event }, 'look-replicator event received');
        }
      } catch (err) {
        logger?.warn?.({ err: err?.message || String(err) }, 'look-replicator event handling failed');
      }
    });

    return res.status(204).send();
  });
}

module.exports = {
  mountLookReplicatorEventRoutes,
};
