const {
  deriveTaskBaseFromGatewayUrl,
  pollCreatorTaskUntilComplete,
  callPivotaToolViaGateway,
} = require('../src/uiGatewayClient');

describe('uiGatewayClient', () => {
  test('deriveTaskBaseFromGatewayUrl strips trailing invoke suffix', () => {
    expect(
      deriveTaskBaseFromGatewayUrl('http://localhost:3000/agent/shop/v1/invoke'),
    ).toBe('http://localhost:3000/agent/shop/v1');
  });

  test('pollCreatorTaskUntilComplete returns result once task succeeds', async () => {
    const axiosClient = {
      get: jest
        .fn()
        .mockResolvedValueOnce({ data: { status: 'running' } })
        .mockResolvedValueOnce({ data: { status: 'succeeded', result: { ok: true } } }),
    };
    const sleep = jest.fn(() => Promise.resolve());

    await expect(
      pollCreatorTaskUntilComplete({
        taskId: 'task_1',
        baseUrl: 'http://localhost:3000/agent/shop/v1',
        axiosClient,
        maxAttempts: 3,
        pollIntervalMs: 500,
        sleep,
      }),
    ).resolves.toEqual({ ok: true });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(axiosClient.get).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3000/agent/shop/v1/creator/tasks/task_1',
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  test('callPivotaToolViaGateway returns direct response when not pending', async () => {
    const axiosClient = {
      post: jest.fn().mockResolvedValue({ data: { status: 'ok', result: { products: [] } } }),
    };

    await expect(
      callPivotaToolViaGateway({
        args: { operation: 'find_products_multi' },
        gatewayUrl: 'http://localhost:3000/agent/shop/v1/invoke',
        axiosClient,
        logger: { info: jest.fn() },
        maxTaskPollAttempts: 5,
        taskPollIntervalMs: 500,
      }),
    ).resolves.toEqual({ status: 'ok', result: { products: [] } });
  });

  test('callPivotaToolViaGateway polls pending task responses', async () => {
    const axiosClient = {
      post: jest.fn().mockResolvedValue({ data: { status: 'pending', task_id: 'task_42' } }),
    };
    const pollCreatorTaskUntilCompleteFn = jest.fn().mockResolvedValue({ done: true });
    const logger = { info: jest.fn() };

    await expect(
      callPivotaToolViaGateway({
        args: { operation: 'find_products_multi' },
        gatewayUrl: 'http://localhost:3000/agent/shop/v1/invoke',
        axiosClient,
        logger,
        maxTaskPollAttempts: 10,
        taskPollIntervalMs: 500,
        pollCreatorTaskUntilCompleteFn,
      }),
    ).resolves.toEqual({ done: true });

    expect(logger.info).toHaveBeenCalledWith(
      { taskId: 'task_42', base: 'http://localhost:3000/agent/shop/v1' },
      'Received pending tool result, polling creator task status',
    );
    expect(pollCreatorTaskUntilCompleteFn).toHaveBeenCalledWith({
      taskId: 'task_42',
      baseUrl: 'http://localhost:3000/agent/shop/v1',
      axiosClient,
      maxAttempts: 10,
      pollIntervalMs: 500,
      timeoutMs: 15000,
    });
  });
});
