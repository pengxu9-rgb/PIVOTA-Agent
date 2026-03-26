function registerGlobalErrorHandler({
  app,
  logger,
  serviceName = 'pivota-agent-gateway',
} = {}) {
  app.use((err, req, res, next) => {
    if (err.message === 'Invalid JSON') {
      if (res.headersSent) return next(err);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    if (res.headersSent) {
      return next(err);
    }

    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      service: serviceName,
    });
  });
}

function registerRecommendRoute({ app, recommendHandler } = {}) {
  app.post('/recommend', async (req, res) => recommendHandler(req, res));
}

async function runPdpCorePrewarmPass({
  targets,
  gatewayUrl,
  port,
  timeoutMs,
  intervalMs,
  axios,
  logger,
  nowMs = () => Date.now(),
} = {}) {
  const normalizedTargets = Array.isArray(targets) ? targets : [];
  if (!normalizedTargets.length) {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  const invokeUrl =
    String(gatewayUrl || '').trim() ||
    `http://127.0.0.1:${port}/agent/shop/v1/invoke`;

  let succeeded = 0;
  let failed = 0;
  const startedAt = nowMs();

  for (const target of normalizedTargets) {
    const merchantId = String(target?.merchant_id || '').trim();
    const productId = String(target?.product_id || '').trim();
    if (!merchantId || !productId) continue;

    const reqBody = {
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          merchant_id: merchantId,
          product_id: productId,
        },
        include: ['offers'],
        options: {
          debug: false,
        },
      },
      metadata: {
        source: 'pdp_core_prewarm',
      },
    };

    const reqStartedAt = nowMs();
    try {
      const resp = await axios.post(invokeUrl, reqBody, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
      });
      succeeded += 1;
      logger.info(
        {
          product_id: productId,
          merchant_id: merchantId,
          status: resp.status,
          latency_ms: Math.max(0, nowMs() - reqStartedAt),
          request_id: resp?.data?.request_id || null,
        },
        'PDP core prewarm request complete',
      );
    } catch (err) {
      failed += 1;
      const status = err?.response?.status || null;
      logger.warn(
        {
          product_id: productId,
          merchant_id: merchantId,
          status,
          latency_ms: Math.max(0, nowMs() - reqStartedAt),
          err: err?.message || String(err),
        },
        'PDP core prewarm request failed',
      );
    }
  }

  const attempted = succeeded + failed;
  logger.info(
    {
      attempted,
      succeeded,
      failed,
      duration_ms: Math.max(0, nowMs() - startedAt),
      timeout_ms: timeoutMs,
      interval_ms: intervalMs,
    },
    'PDP core prewarm pass summary',
  );

  return { attempted, succeeded, failed };
}

module.exports = {
  registerGlobalErrorHandler,
  registerRecommendRoute,
  runPdpCorePrewarmPass,
};
