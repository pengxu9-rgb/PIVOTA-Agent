function deriveTaskBaseFromGatewayUrl(gatewayUrl) {
  return String(gatewayUrl || '').replace(/\/invoke\/?$/, '');
}

async function pollCreatorTaskUntilComplete({
  taskId,
  baseUrl,
  axiosClient,
  maxAttempts,
  pollIntervalMs,
  timeoutMs = 15000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const statusUrl = `${baseUrl}/creator/tasks/${taskId}`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs);
    const res = await axiosClient.get(statusUrl, {
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    });
    const body = res.data || {};
    const status = body.status;
    if (status === 'succeeded' && body.result) {
      return body.result;
    }
    if (['failed', 'cancelled', 'timeout', 'expired'].includes(status)) {
      const errMsg = body.error || `Creator task ended with status=${status}`;
      throw new Error(errMsg);
    }
  }
  throw new Error('Creator task did not complete within polling budget');
}

async function callPivotaToolViaGateway({
  args,
  gatewayUrl,
  axiosClient,
  logger,
  maxTaskPollAttempts,
  taskPollIntervalMs,
  timeoutMs = 15000,
  pollCreatorTaskUntilCompleteFn = pollCreatorTaskUntilComplete,
} = {}) {
  const res = await axiosClient.post(gatewayUrl, args, {
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
  });
  const data = res.data;

  if (data && data.status === 'pending' && data.task_id) {
    const base = deriveTaskBaseFromGatewayUrl(gatewayUrl);
    logger.info({ taskId: data.task_id, base }, 'Received pending tool result, polling creator task status');
    return pollCreatorTaskUntilCompleteFn({
      taskId: data.task_id,
      baseUrl: base,
      axiosClient,
      maxAttempts: maxTaskPollAttempts,
      pollIntervalMs: taskPollIntervalMs,
      timeoutMs,
    });
  }

  return data;
}

module.exports = {
  deriveTaskBaseFromGatewayUrl,
  pollCreatorTaskUntilComplete,
  callPivotaToolViaGateway,
};
