const { createRequireAdmin } = require('../src/adminAuth');

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('adminAuth', () => {
  test('returns 500 when admin key is not configured', () => {
    const requireAdmin = createRequireAdmin({ adminApiKey: '' });
    const res = createResponse();
    const next = jest.fn();

    requireAdmin({}, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'ADMIN_API_KEY_NOT_CONFIGURED' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when admin key does not match', () => {
    const requireAdmin = createRequireAdmin({ adminApiKey: 'secret' });
    const res = createResponse();
    const next = jest.fn();
    const req = {
      header: jest.fn((name) => (String(name).toLowerCase() === 'x-admin-key' ? 'wrong' : '')),
      get: jest.fn(() => ''),
    };

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'UNAUTHORIZED' });
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when admin key matches', () => {
    const requireAdmin = createRequireAdmin({ adminApiKey: 'secret' });
    const res = createResponse();
    const next = jest.fn();
    const req = {
      header: jest.fn((name) => (String(name).toLowerCase() === 'x-admin-key' ? 'secret' : '')),
      get: jest.fn(() => ''),
    };

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
