const {
  extractUpstreamErrorCode,
} = require('../../src/commerce/shared/extractUpstreamErrorCode');

describe('extractUpstreamErrorCode', () => {
  test('prefers unified pivota error envelopes', () => {
    expect(
      extractUpstreamErrorCode({
        message: 'Request failed with status code 422',
        response: {
          data: {
            status: 'error',
            error: {
              code: 'VALIDATION_FAILED',
              message: 'VALIDATION_FAILED',
              details: {
                error: 'QUOTE_EXPIRED',
                message: 'Quote expired',
              },
            },
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        code: 'QUOTE_EXPIRED',
        message: 'Quote expired',
      }),
    );
  });

  test('falls back to legacy detail/error fields', () => {
    expect(
      extractUpstreamErrorCode({
        response: {
          data: {
            detail: {
              error: 'TEMPORARY_UNAVAILABLE',
              message: 'Try again later',
            },
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        code: 'TEMPORARY_UNAVAILABLE',
        message: 'Try again later',
      }),
    );
  });

  test('returns transport message when no structured envelope exists', () => {
    expect(
      extractUpstreamErrorCode({
        message: 'socket hang up',
      }),
    ).toEqual({
      code: null,
      message: 'socket hang up',
      data: null,
      detail: null,
    });
  });
});
