const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { UiEventIngestV0Schema } = require('./schemas/uiEventIngestV0');
const { recordUiBehaviorEvent } = require('../auroraBff/visionMetrics');
const { recordBudgetPreferenceEventForIdentity } = require('../auroraBff/memoryStore');

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

function stableDistinctId({ auroraUid, sessionId, briefId } = {}) {
  const uid = safeString(auroraUid);
  if (uid) return `aurora:${uid}`;

  const sid = safeString(sessionId);
  if (sid) return `session:${crypto.createHash('sha256').update(sid).digest('hex').slice(0, 16)}`;

  const bid = safeString(briefId);
  if (bid) return `brief:${crypto.createHash('sha256').update(bid).digest('hex').slice(0, 16)}`;

  return 'anonymous';
}

function epochMsToIso(ms) {
  try {
    const n = Number(ms);
    if (!Number.isFinite(n)) return null;
    return new Date(n).toISOString();
  } catch {
    return null;
  }
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
  const filePath = path.join(outDir, `aurora-ui-events-${isoDateKey()}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBudgetTier(value) {
  const token = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token) return null;
  if (token === 'low' || token === 'budget' || token === 'entry') return 'low';
  if (token === 'high' || token === 'premium' || token === 'lux' || token === 'luxury') return 'high';
  if (token === 'mid' || token === 'middle' || token === 'medium') return 'mid';
  return null;
}

function shouldCollectBudgetSignal(eventName) {
  const token = String(eventName || '').trim().toLowerCase();
  if (!token) return false;
  return (
    token.includes('product_tap') ||
    token === 'ui_pdp_opened' ||
    token === 'ui_outbound_opened' ||
    token === 'pdp_click'
  );
}

function extractBudgetSignal({ eventName, props }) {
  if (!shouldCollectBudgetSignal(eventName)) return null;
  const p = props && typeof props === 'object' ? props : {};
  const tier =
    normalizeBudgetTier(p.price_tier) ||
    normalizeBudgetTier(p.priceTier) ||
    normalizeBudgetTier(p.budget_tier) ||
    normalizeBudgetTier(p.budgetTier) ||
    null;
  const price =
    toFiniteNumber(p.price) ??
    toFiniteNumber(p.price_usd) ??
    toFiniteNumber(p.priceUsd) ??
    toFiniteNumber(p.amount);
  const productId = safeString(p.product_id ?? p.productId ?? p.sku_id ?? p.skuId);
  const currency = safeString(p.currency) || 'USD';
  if (!tier && price == null) return null;
  return {
    tier,
    price,
    currency,
    productId,
    sourceEvent: String(eventName || '').trim().slice(0, 80),
  };
}

function mountUiEventRoutes(app, { logger } = {}) {
  app.post('/v1/events', async (req, res) => {
    const parsed = UiEventIngestV0Schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.format() });
    }

    const apiKey = process.env.POSTHOG_API_KEY;
    const host = process.env.POSTHOG_HOST || process.env.POSTHOG_URL;
    const sinkDir = process.env.AURORA_EVENTS_JSONL_SINK_DIR;

    const serverReceivedAt = new Date().toISOString();

    // Non-blocking: ingest happens in the background and must never affect the response.
    setImmediate(() => {
      try {
        for (const evt of parsed.data.events) {
          recordUiBehaviorEvent({ eventName: evt.event_name });
          const props = { ...(evt.data || {}) };
          const auroraUid = props.aurora_uid ?? props.auroraUid ?? null;
          const userId = props.user_id ?? props.userId ?? null;
          const sessionId = props.session_id ?? props.sessionId ?? null;
          const distinctId = stableDistinctId({ auroraUid, sessionId, briefId: evt.brief_id });
          const budgetSignal = extractBudgetSignal({ eventName: evt.event_name, props });

          if (budgetSignal && (auroraUid || userId)) {
            void recordBudgetPreferenceEventForIdentity(
              { auroraUid: auroraUid || null, userId: userId || null },
              {
                tier: budgetSignal.tier,
                price: budgetSignal.price,
                currency: budgetSignal.currency,
                sourceEvent: budgetSignal.sourceEvent,
                productId: budgetSignal.productId,
                createdAt: epochMsToIso(evt.timestamp) || serverReceivedAt,
              },
            ).catch((err) => {
              logger?.warn?.({ err: err?.message || String(err) }, 'budget preference signal ingest failed');
            });
          }

          const row = {
            source: parsed.data.source,
            event_name: evt.event_name,
            brief_id: evt.brief_id,
            trace_id: evt.trace_id,
            timestamp_ms: evt.timestamp,
            serverReceivedAt,
            properties: props,
          };

          if (apiKey && host) {
            void forwardToPostHog({
              apiKey,
              host,
              event: evt.event_name,
              properties: {
                source: parsed.data.source,
                brief_id: evt.brief_id,
                trace_id: evt.trace_id,
                ...props,
                serverReceivedAt,
              },
              timestamp: epochMsToIso(evt.timestamp),
              distinctId,
            }).catch((err) => {
              logger?.warn?.({ err: err?.message || String(err) }, 'ui event forward failed');
            });
          } else if (sinkDir) {
            try {
              appendJsonlSink({ dir: sinkDir, row });
            } catch (err) {
              logger?.warn?.({ err: err?.message || String(err) }, 'ui event jsonl sink failed');
            }
          } else {
            logger?.info?.({ event_name: evt.event_name, source: parsed.data.source }, 'ui event received');
          }
        }
      } catch (err) {
        logger?.warn?.({ err: err?.message || String(err) }, 'ui event handling failed');
      }
    });

    return res.status(204).send();
  });
}

module.exports = {
  mountUiEventRoutes,
};
